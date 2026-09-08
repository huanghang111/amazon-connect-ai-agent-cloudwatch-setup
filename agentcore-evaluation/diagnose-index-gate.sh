#!/usr/bin/env bash
#
# diagnose-index-gate.sh
#
# 只读诊断: 状态机以 LogEventsNotIndexed 失败时，回答三个问题
#   1. 部署的是哪个版本的 wait_indexed(有没有带 parse 判定的修复)
#   2. 卡住的是哪一半——aws/spans 的 span 文档，还是运行时日志组的 log event
#   3. 数据到底是「没到」还是「到了但查询看不见」
#
# 用法:
#   ./diagnose-index-gate.sh [--stack <name>] [--region <region>] [--run-id <runId>]
#
#   --run-id 省略时自动取状态机最近一次失败执行的 runId。
#
# 不修改任何资源: 只做 describe / get / Logs Insights 查询。
#
set -uo pipefail

STACK_NAME=""
REGION=""
RUN_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --stack)   STACK_NAME="$2"; shift 2 ;;
    --region)  REGION="$2"; shift 2 ;;
    --run-id)  RUN_ID="$2"; shift 2 ;;
    -h|--help) sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "${SCRIPT_DIR}/config.env" ]]; then
  # shellcheck disable=SC1090
  source "${SCRIPT_DIR}/config.env"
fi
STACK_NAME="${STACK_NAME:-${STACK_NAME_CONF:-connect-agentcore-eval}}"
REGION="${REGION:-${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || echo us-east-1)}}}"

echo "==> 诊断对象: stack=${STACK_NAME} region=${REGION}"

out() { aws cloudformation describe-stacks --stack-name "${STACK_NAME}" --region "${REGION}" \
  --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue|[0]" --output text 2>/dev/null; }

BUCKET="$(out ResultsBucket)"
RT_LOG_GROUP="$(out ObservabilityLogGroup)"
SM_ARN="$(out StateMachineArn)"
SPANS_LOG_GROUP="aws/spans"

if [[ -z "${BUCKET}" || "${BUCKET}" == "None" ]]; then
  echo "错误: 读不到栈 ${STACK_NAME} 的输出，确认 --stack / --region 是否正确" >&2
  exit 1
fi
echo "    结果桶      : ${BUCKET}"
echo "    运行时日志组: ${RT_LOG_GROUP}"

# ---------------------------------------------------------------------------
# 1. 部署的是哪个版本
# ---------------------------------------------------------------------------
echo ""
echo "==> 1. wait_indexed 版本"
ENV_JSON="$(aws lambda get-function-configuration \
  --function-name "${STACK_NAME}-wait-indexed" --region "${REGION}" \
  --query 'Environment.Variables' --output json 2>/dev/null || echo '{}')"
echo "    环境变量: ${ENV_JSON}"
if grep -q "REQUIRE_SPAN_INDEX" <<<"${ENV_JSON}"; then
  echo "    ✅ 带索引门修复(parse @message 判定 + REQUIRE_SPAN_INDEX 开关)"
else
  echo "    ❌ 仍是修复前的版本: 判定用 filter ispresent(spanId)。"
  echo "       在某些区域这个查询对 aws/spans 恒返回 0 条，索引门永远打不开,"
  echo "       每次运行都必然以 LogEventsNotIndexed 结束。请先更新代码再重新部署。"
fi
echo "    预算/轮次: INDEX_BUDGET_SECONDS=$(grep -oE '"INDEX_BUDGET_SECONDS": *"[0-9]+"' <<<"${ENV_JSON}" | grep -oE '[0-9]+' || echo '默认 180')，状态机最多 5 次 attempt"

# ---------------------------------------------------------------------------
# 2. 卡住的是哪一半
# ---------------------------------------------------------------------------
echo ""
echo "==> 2. 最近一次失败执行"
if [[ -z "${RUN_ID}" && -n "${SM_ARN}" && "${SM_ARN}" != "None" ]]; then
  RUN_ID="$(aws stepfunctions list-executions --state-machine-arn "${SM_ARN}" \
    --status-filter FAILED --max-items 1 --region "${REGION}" \
    --query 'executions[0].name' --output text 2>/dev/null)"
fi
if [[ -z "${RUN_ID}" || "${RUN_ID}" == "None" ]]; then
  echo "    没有找到失败执行，用 --run-id 手工指定"; exit 0
fi
echo "    runId: ${RUN_ID}"

echo ""
echo "    wait_indexed 的判定过程(每轮两半各缺多少):"
aws logs filter-log-events --log-group-name "/aws/lambda/${STACK_NAME}-wait-indexed" \
  --start-time "$(( ($(date +%s) - 3 * 86400) * 1000 ))" --region "${REGION}" \
  --query 'events[].message' --output text 2>/dev/null \
  | tr '\t' '\n' | grep -E "waiting to index|budget exhausted|all .* spans indexed|query on" | tail -24 \
  | sed 's/^/      /'
echo "      (span documents 一直是满值 = span 那半没通过; log events 一直是满值 = 事件那半没通过;"
echo "       两半都归零那一行出现过，就说明门开过，失败在别处)"

# ---------------------------------------------------------------------------
# 3. 数据没到，还是到了但查不到
# ---------------------------------------------------------------------------
echo ""
echo "==> 3. 取一个本次注入的 spanId 实测三种查询"
ING="$(aws s3 cp "s3://${BUCKET}/runs/${RUN_ID}/ingest.json" - --region "${REGION}" 2>/dev/null)"
if [[ -z "${ING}" ]]; then
  echo "    读不到 runs/${RUN_ID}/ingest.json，跳过"; exit 0
fi
SID="$(python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print((d.get('spanIds') or [''])[0])" <<<"${ING}")"
N_SPANS="$(python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(len(d.get('spanIds') or []))" <<<"${ING}")"
FAILURES="$(python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(json.dumps(d.get('failures') or [], ensure_ascii=False))" <<<"${ING}")"
START_EPOCH="$(python3 -c "import json,sys; d=json.loads(sys.stdin.read()); r=d.get('spanTimeRange') or {}; print(r.get('startEpoch') or r.get('ingestedAtEpoch') or 0)" <<<"${ING}")"
echo "    注入 span 数: ${N_SPANS}   ingest 失败的会话: ${FAILURES}"
echo "    抽样 spanId : ${SID}"
[[ -z "${SID}" ]] && { echo "    ingest.json 里没有 spanId，说明第 2 步(Ingest)就没写进去"; exit 0; }

QSTART=$(( START_EPOCH - 3600 ))
QEND=$(( $(date +%s) + 600 ))

run_q() {  # $1=log group  $2=query  -> recordsMatched
  local qid matched
  qid="$(aws logs start-query --log-group-name "$1" --start-time "${QSTART}" \
    --end-time "${QEND}" --query-string "$2" --region "${REGION}" \
    --query queryId --output text 2>/dev/null)" || { echo "查询失败"; return; }
  for _ in $(seq 1 30); do
    matched="$(aws logs get-query-results --query-id "${qid}" --region "${REGION}" \
      --query '[status,statistics.recordsMatched]' --output text 2>/dev/null)"
    [[ "${matched}" == Running* || "${matched}" == Scheduled* ]] || { echo "${matched}" | awk '{print $2" (status "$1")"}'; return; }
    sleep 2
  done
  echo "超时"
}

PARSE_Q='parse @message /"spanId":\s*"(?<sid>[0-9a-fA-F]{16})"/ | filter sid = "'"${SID}"'" | limit 5'
RAW_Q='fields @message | filter @message like /'"${SID}"'/ | limit 5'
FIELD_Q='fields spanId | filter spanId = "'"${SID}"'" | limit 5'

for LG in "${SPANS_LOG_GROUP}" "${RT_LOG_GROUP}"; do
  echo ""
  echo "    ${LG}:"
  echo "      A 原始文本  (@message like)      -> $(run_q "${LG}" "${RAW_Q}")"
  echo "      B parse 判定(流水线现在用的)     -> $(run_q "${LG}" "${PARSE_Q}")"
  echo "      C 字段判定  (旧的 ispresent 路径)-> $(run_q "${LG}" "${FIELD_Q}")"
done

cat <<'HINT'

    怎么读:
      A=0            -> 数据真的没到这个日志组。span 侧查 Transaction Search(下面第 4 步)
                        与 ingest 步骤的 OTLP 返回；事件侧查 PutLogEvents 是否报错。
      A>0 且 B=0     -> 数据在，但连 parse 都匹配不到:序列化形状与预期不同,把 A 查到的
                        原始 @message 发出来，需要按实际形状调整。
      A>0 B>0 C=0    -> 这就是本次修复覆盖的情况(字段发现不生效)。若仍失败，说明部署的
                        是旧代码,见第 1 步。
      A>0 B>0 C>0    -> 数据与查询都正常，纯粹是索引还没赶上:第一次在新建日志流上写入
                        最慢，重跑一次(run-now.sh --force)通常就过了；也可以调大
                        wait-indexed 的 INDEX_BUDGET_SECONDS。
HINT

# ---------------------------------------------------------------------------
# 4. Transaction Search
# ---------------------------------------------------------------------------
echo ""
echo "==> 4. Transaction Search(决定 span 文档能不能进 aws/spans)"
aws xray get-trace-segment-destination --region "${REGION}" --output table 2>/dev/null \
  || echo "    读取失败(权限?)"
aws xray get-indexing-rules --region "${REGION}" \
  --query 'IndexingRules[].{Name:Name,SamplingPct:Rule.Probabilistic.DesiredSamplingPercentage}' \
  --output table 2>/dev/null || true
echo "    Destination 必须是 CloudWatchLogs 且 Status=ACTIVE,否则 aws/spans 永远收不到 span。"
