#!/usr/bin/env bash
#
# setup-connect-ai-agent-logs-check.sh
#
# 用法:
#   ./setup-connect-ai-agent-logs-check.sh <amazon-connect-instance-arn>
#
# 示例:
#   ./setup-connect-ai-agent-logs-check.sh \
#     arn:aws:connect:us-west-2:991727053196:instance/abcd1234-5678-90ab-cdef-1234567890ab
#
# 功能:
#   针对 "日志组建好了但 /aws/connect/ai-agent-logs 一直没有日志" 的问题，
#   做一次只读的端到端体检，逐项确认投递链是否搭对：
#     1. 解析实例 ARN，得到 region / account-id / instance-id
#     2. 列出该实例的 WISDOM_ASSISTANT 集成关联(数量 + assistant ARN)
#     3. 检查投递源(PutDeliverySource)：是否指向该 assistant、logType 是否为 EVENT_LOGS
#     4. 检查目标日志组是否存在
#     5. 检查投递目标(PutDeliveryDestination)
#     6. 检查投递关系(CreateDelivery)：源与目标是否已关联
#     7. 检查日志组里是否已有日志流 / 最近事件
#     8. 打印诊断结论与后续建议
#
# 本脚本 **只读**，不会创建或修改任何资源。
#
# 依赖: aws cli v2 （已配置好凭证），无需 jq。
#
set -euo pipefail

# ----------------------------------------------------------------------------
# 小工具：彩色输出
# ----------------------------------------------------------------------------
if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_GREEN=$'\033[32m'; C_RED=$'\033[31m'; C_YELLOW=$'\033[33m'; C_BOLD=$'\033[1m'
else
  C_RESET=""; C_GREEN=""; C_RED=""; C_YELLOW=""; C_BOLD=""
fi

# 统计各项检查结果
PASS_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0
# 收集给用户的后续建议
declare -a HINTS=()

ok()   { echo "    ${C_GREEN}[OK]${C_RESET}   $*"; PASS_COUNT=$((PASS_COUNT+1)); }
warn() { echo "    ${C_YELLOW}[WARN]${C_RESET} $*"; WARN_COUNT=$((WARN_COUNT+1)); }
fail() { echo "    ${C_RED}[FAIL]${C_RESET} $*"; FAIL_COUNT=$((FAIL_COUNT+1)); }
info() { echo "    $*"; }
add_hint() { HINTS+=("$1"); }

# ----------------------------------------------------------------------------
# 0. 参数与环境检查
# ----------------------------------------------------------------------------
INSTANCE_ARN="${1:-}"

if [[ -z "${INSTANCE_ARN}" ]]; then
  echo "请输入 Amazon Connect 客户实例 ARN" >&2
  echo "（示例: arn:aws:connect:us-west-2:111122223333:instance/<instance-id>）:" >&2
  read -r INSTANCE_ARN
fi

INSTANCE_ARN="$(echo "${INSTANCE_ARN}" | tr -d '[:space:]')"

if [[ -z "${INSTANCE_ARN}" ]]; then
  echo "错误: 未提供 Amazon Connect 客户实例 ARN。" >&2
  echo "用法: $0 <amazon-connect-instance-arn>" >&2
  exit 1
fi

if ! command -v aws >/dev/null 2>&1; then
  echo "错误: 未找到 aws CLI，请先安装并配置凭证。" >&2
  exit 1
fi

if [[ ! "${INSTANCE_ARN}" =~ ^arn:aws:connect:[a-z0-9-]+:[0-9]+:instance/[0-9a-fA-F-]+$ ]]; then
  echo "错误: 这不是合法的 Connect 实例 ARN:" >&2
  echo "  ${INSTANCE_ARN}" >&2
  echo "期望形如: arn:aws:connect:us-west-2:111122223333:instance/<instance-id>" >&2
  exit 1
fi

# ----------------------------------------------------------------------------
# 1. 解析实例 ARN
# ----------------------------------------------------------------------------
REGION="$(echo "${INSTANCE_ARN}" | cut -d: -f4)"
ACCOUNT_ID="$(echo "${INSTANCE_ARN}" | cut -d: -f5)"
INSTANCE_ID="$(echo "${INSTANCE_ARN}" | cut -d/ -f2)"

# 与 setup 脚本保持一致的命名约定
LOG_GROUP="/aws/connect/ai-agent-logs"

echo "==================================================================="
echo "${C_BOLD}Amazon Connect AI Agent 日志投递链体检${C_RESET}"
echo "==================================================================="
echo "==> [1/7] 解析实例 ARN"
info "Region      : ${REGION}"
info "Account ID  : ${ACCOUNT_ID}"
info "Instance ID : ${INSTANCE_ID}"
info "目标日志组  : ${LOG_GROUP}"

# ----------------------------------------------------------------------------
# 2. WISDOM_ASSISTANT 集成关联
# ----------------------------------------------------------------------------
echo ""
echo "==> [2/7] 检查 WISDOM_ASSISTANT 集成关联（AI agent 是否启用 + assistant ARN）"

ASSISTANT_ARNS="$(aws connect list-integration-associations \
  --instance-id "${INSTANCE_ID}" \
  --integration-type WISDOM_ASSISTANT \
  --region "${REGION}" \
  --query 'IntegrationAssociationSummaryList[].IntegrationArn' \
  --output text 2>/dev/null || true)"

ASSISTANT_ARN=""
if [[ -z "${ASSISTANT_ARNS}" || "${ASSISTANT_ARNS}" == "None" ]]; then
  fail "未找到 WISDOM_ASSISTANT 集成关联 —— 该实例可能尚未启用 AI agent / Q in Connect。"
  add_hint "在 Connect 控制台为该实例启用 AI agent / Q in Connect 后再执行 setup 脚本。"
else
  # 统计关联数量
  ASSISTANT_COUNT="$(echo "${ASSISTANT_ARNS}" | wc -w | tr -d '[:space:]')"
  # 取第一条作为 setup 脚本实际会使用的 assistant
  ASSISTANT_ARN="$(echo "${ASSISTANT_ARNS}" | awk '{print $1}')"
  if [[ "${ASSISTANT_COUNT}" -eq 1 ]]; then
    ok "找到 1 个 WISDOM_ASSISTANT 关联。"
    info "Assistant ARN: ${ASSISTANT_ARN}"
  else
    warn "找到 ${ASSISTANT_COUNT} 个 WISDOM_ASSISTANT 关联；setup 脚本只用第一个:"
    info "使用中的(第一个): ${ASSISTANT_ARN}"
    info "全部:"
    for a in ${ASSISTANT_ARNS}; do info "  - ${a}"; done
    add_hint "存在多个 assistant，请确认 setup 脚本用的第一个就是你 AI agent 实际绑定的那个；否则日志会投到别处。"
  fi
fi

# ----------------------------------------------------------------------------
# 3. 投递源 Delivery Source
# ----------------------------------------------------------------------------
echo ""
echo "==> [3/7] 检查投递源 Delivery Source（是否指向该 assistant + logType）"

SOURCE_NAME=""
if [[ -n "${ASSISTANT_ARN}" ]]; then
  SOURCE_NAME="$(aws logs describe-delivery-sources \
    --region "${REGION}" \
    --query "deliverySources[?contains(resourceArns, '${ASSISTANT_ARN}')].name | [0]" \
    --output text 2>/dev/null || true)"
fi

SOURCE_LOG_TYPE=""
if [[ -z "${SOURCE_NAME}" || "${SOURCE_NAME}" == "None" ]]; then
  SOURCE_NAME=""
  fail "未找到指向该 assistant 的投递源。"
  add_hint "先运行 ./setup-connect-ai-agent-logs.sh ${INSTANCE_ARN} 创建投递源。"
  # 顺带列出该 region 现有的全部投递源，帮助判断是否指向了别的资源
  ALL_SOURCES="$(aws logs describe-delivery-sources \
    --region "${REGION}" \
    --query "deliverySources[].{name:name,logType:logType,resourceArns:resourceArns}" \
    --output text 2>/dev/null || true)"
  if [[ -n "${ALL_SOURCES}" && "${ALL_SOURCES}" != "None" ]]; then
    info "该 region 现有的投递源(供对照，看是否指向了其它 ARN):"
    echo "${ALL_SOURCES}" | while IFS= read -r line; do info "  ${line}"; done
  fi
else
  ok "找到投递源: ${SOURCE_NAME}"
  SOURCE_INFO="$(aws logs describe-delivery-sources \
    --region "${REGION}" \
    --query "deliverySources[?name=='${SOURCE_NAME}'].{logType:logType,resourceArns:resourceArns} | [0]" \
    --output text 2>/dev/null || true)"
  SOURCE_LOG_TYPE="$(aws logs describe-delivery-sources \
    --region "${REGION}" \
    --query "deliverySources[?name=='${SOURCE_NAME}'].logType | [0]" \
    --output text 2>/dev/null || true)"
  info "logType     : ${SOURCE_LOG_TYPE}"
  info "resourceArns: ${ASSISTANT_ARN}"
  if [[ "${SOURCE_LOG_TYPE}" != "EVENT_LOGS" ]]; then
    warn "logType 不是 EVENT_LOGS（当前: ${SOURCE_LOG_TYPE}），Connect AI agent 日志应为 EVENT_LOGS。"
    add_hint "投递源 logType 期望是 EVENT_LOGS，请核对。"
  fi
fi

# ----------------------------------------------------------------------------
# 4. 日志组 Log Group
# ----------------------------------------------------------------------------
echo ""
echo "==> [4/7] 检查目标日志组: ${LOG_GROUP}"

LOG_GROUP_ARN="$(aws logs describe-log-groups \
  --log-group-name-prefix "${LOG_GROUP}" \
  --region "${REGION}" \
  --query "logGroups[?logGroupName=='${LOG_GROUP}'].arn | [0]" \
  --output text 2>/dev/null || true)"

if [[ -z "${LOG_GROUP_ARN}" || "${LOG_GROUP_ARN}" == "None" ]]; then
  fail "日志组不存在: ${LOG_GROUP}"
  add_hint "先运行 setup 脚本创建日志组。"
else
  ok "日志组已存在。"
  info "ARN: ${LOG_GROUP_ARN}"
fi

# ----------------------------------------------------------------------------
# 5. 投递目标 Delivery Destination
# ----------------------------------------------------------------------------
echo ""
echo "==> [5/7] 检查投递目标 Delivery Destination（指向该日志组）"

# 期望的目标资源 ARN(与 setup 脚本一致，结尾带 :*)
EXPECT_DEST_RESOURCE="arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:${LOG_GROUP}:*"

DEST_ARN="$(aws logs describe-delivery-destinations \
  --region "${REGION}" \
  --query "deliveryDestinations[?deliveryDestinationConfiguration.destinationResourceArn=='${EXPECT_DEST_RESOURCE}'].arn | [0]" \
  --output text 2>/dev/null || true)"

if [[ -z "${DEST_ARN}" || "${DEST_ARN}" == "None" ]]; then
  fail "未找到指向该日志组的投递目标。"
  add_hint "先运行 setup 脚本创建投递目标。"
  DEST_ARN=""
else
  ok "找到投递目标。"
  info "Destination ARN     : ${DEST_ARN}"
  info "destinationResource : ${EXPECT_DEST_RESOURCE}"
fi

# ----------------------------------------------------------------------------
# 6. 投递关系 Delivery
# ----------------------------------------------------------------------------
echo ""
echo "==> [6/7] 检查投递关系 Delivery（投递源 <-> 投递目标 是否关联）"

if [[ -n "${SOURCE_NAME}" && -n "${DEST_ARN}" ]]; then
  DELIVERY_ID="$(aws logs describe-deliveries \
    --region "${REGION}" \
    --query "deliveries[?deliverySourceName=='${SOURCE_NAME}' && deliveryDestinationArn=='${DEST_ARN}'].id | [0]" \
    --output text 2>/dev/null || true)"
  if [[ -z "${DELIVERY_ID}" || "${DELIVERY_ID}" == "None" ]]; then
    fail "投递源与投递目标之间没有投递关系(delivery)。"
    add_hint "重新运行 setup 脚本以创建投递关系(CreateDelivery)。"
  else
    ok "投递关系已存在 (id=${DELIVERY_ID})。"
  fi
else
  warn "投递源或投递目标缺失，跳过投递关系检查。"
fi

# ----------------------------------------------------------------------------
# 7. 日志组中是否已有日志流 / 最近事件
# ----------------------------------------------------------------------------
echo ""
echo "==> [7/7] 检查日志组是否已产生日志"

if [[ -n "${LOG_GROUP_ARN}" && "${LOG_GROUP_ARN}" != "None" ]]; then
  STREAM_COUNT="$(aws logs describe-log-streams \
    --log-group-name "${LOG_GROUP}" \
    --region "${REGION}" \
    --query "length(logStreams)" \
    --output text 2>/dev/null || echo "0")"
  if [[ -z "${STREAM_COUNT}" || "${STREAM_COUNT}" == "None" ]]; then STREAM_COUNT=0; fi

  if [[ "${STREAM_COUNT}" -eq 0 ]]; then
    warn "日志组暂无任何日志流(尚未投递过任何事件)。"
    add_hint "投递链若正常，需在建链之后发起【全新】会话，并确保会话真正进入自助式 AI agent；首条日志通常有几分钟延迟。"
  else
    ok "日志组已有 ${STREAM_COUNT} 个日志流。"
    # 看最近 24 小时是否有事件
    START_MS=$(( ( $(date +%s) - 86400 ) * 1000 ))
    RECENT="$(aws logs filter-log-events \
      --log-group-name "${LOG_GROUP}" \
      --region "${REGION}" \
      --start-time "${START_MS}" \
      --max-items 1 \
      --query "length(events)" \
      --output text 2>/dev/null || echo "0")"
    if [[ -z "${RECENT}" || "${RECENT}" == "None" ]]; then RECENT=0; fi
    if [[ "${RECENT}" -gt 0 ]]; then
      ok "最近 24 小时内有日志事件 —— 投递链在正常工作。"
    else
      warn "有历史日志流，但最近 24 小时无新事件。"
      add_hint "近期没有触发 AI agent 会话，或交互未真正进入自助式 AI agent。"
    fi
  fi
else
  warn "日志组不存在，跳过日志检查。"
fi

# ----------------------------------------------------------------------------
# 8. 结论
# ----------------------------------------------------------------------------
echo ""
echo "==================================================================="
echo "${C_BOLD}体检结论${C_RESET}: ${C_GREEN}${PASS_COUNT} 通过${C_RESET} / ${C_YELLOW}${WARN_COUNT} 警告${C_RESET} / ${C_RED}${FAIL_COUNT} 失败${C_RESET}"
echo "==================================================================="

if [[ "${FAIL_COUNT}" -gt 0 ]]; then
  echo "${C_RED}投递链不完整${C_RESET}：上面标记 [FAIL] 的环节还没搭好，日志不可能进来。"
elif [[ "${WARN_COUNT}" -gt 0 ]]; then
  echo "${C_YELLOW}投递链基本搭好，但有需要留意的点${C_RESET}：若日志组仍为空，重点看下面的建议。"
else
  echo "${C_GREEN}投递链完整且已在产生日志${C_RESET}：配置没问题。"
fi

if [[ "${#HINTS[@]}" -gt 0 ]]; then
  echo ""
  echo "后续建议:"
  i=1
  for h in "${HINTS[@]}"; do
    echo "  ${i}. ${h}"
    i=$((i+1))
  done
fi

echo ""
echo "实时观察日志(发起新会话后):"
echo "  aws logs tail \"${LOG_GROUP}\" --region ${REGION} --follow"
echo "==================================================================="

# 有失败项时以非 0 退出，方便在 CI / 脚本里判断
if [[ "${FAIL_COUNT}" -gt 0 ]]; then
  exit 2
fi
