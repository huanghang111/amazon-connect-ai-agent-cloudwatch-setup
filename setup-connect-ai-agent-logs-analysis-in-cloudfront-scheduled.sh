#!/usr/bin/env bash
#
# setup-connect-ai-agent-logs-analysis-in-cloudfront-scheduled.sh
#
# 用途:
#   在 setup-connect-ai-agent-logs-analysis-in-cloudfront.sh 的全部能力
#   (S3 日志桶 + 云端拆分 Lambda + Cognito 登录 + CloudFront 站点)之上，
#   新增「定时按天」采集: 部署一个由 Amazon EventBridge 定时(默认每天 01:00 UTC)
#   触发的采集 Lambda，每次处理「昨天(UTC)一整天」的日志:
#
#     1) 采集 Lambda 从 CloudWatch 拉取昨天 [00:00, 次日00:00) UTC 的全部事件，
#        以 NDJSON 流式归档到日志桶的按日期分区前缀:
#          s3://ai-agent-logs<suffix>/daily/<YYYY-MM-DD>/raw/connect.ndjson
#        随后写触发对象 trigger/daily-<date>.json;
#     2) 该触发对象命中日志桶已有的 S3 事件通知，触发「拆分 Lambda」在云端按
#        Contact 拆分，把 index.json 与 logs/*.log 写到 daily/<date>/ 下;
#     3) CloudFront 站点(经 Cognito 登录)在页面顶部新增「日期」控件，
#        选择某一天即加载并展示当天的 Contact 列表与会话日志。
#
#   全程不在本地处理任何日志文件(采集/拆分均在云端)。
#
# 用法:
#   ./setup-connect-ai-agent-logs-analysis-in-cloudfront-scheduled.sh \
#       [--connect-arn <arn>] [--gateway-arn <arn>] [--connect-instance-arn <arn>] \
#       [--email <addr>] [--suffix <s>] [--region <r>] [--profile <p>] \
#       [--schedule-cron <expr>] [--backfill-days <n>] \
#       [--out-dir <dir>] [--keep] [--lambda-memory <MB>] [--csat-attr <key>] [-h|--help]
#
# 参数(未提供的必选项会交互式询问):
#   --connect-arn <arn>  Connect AI Agent 日志组 ARN            [必选]
#   --gateway-arn <arn>  Bedrock AgentCore Gateway 日志组 ARN    [可选]
#   --connect-instance-arn <arn>  Amazon Connect 实例 ARN       [必选]
#   --email <addr>       登录用户邮箱(接收一次性密码)             [必选]
#   --suffix <s>         桶名后缀; 日志桶为 ai-agent-logs<suffix> [必选]
#   --region <r>         部署区域; 默认取自 connect-arn
#   --schedule-cron <e>  EventBridge 定时表达式(UTC); 默认每天 01:00:
#                        "cron(0 1 * * ? *)"(UTC 01:00 = 北京 09:00)。
#                        改为 UTC 每天 9 点则用 "cron(0 9 * * ? *)"。
#   --backfill-days <n>  部署后立即回补最近 n 天(不含今天)的数据; 默认 1(仅昨天);
#                        0 表示不回补(等定时任务首次运行)。
#   --profile <p>        AWS CLI profile
#   --out-dir <dir>      放临时部署产物的目录; 默认系统临时目录(/tmp)
#   --keep               保留临时产物目录(默认结束后自动清理)
#   --lambda-memory <MB> 拆分/采集 Lambda 内存; 默认 3008; 日志量大时调大
#   --csat-attr <key>    CSAT 满意度评分对应的联系人属性键名; 默认 botevaluation
#   -h, --help           显示帮助
#
# 依赖: aws cli v2(已配置凭证)、python3。
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/lib"
WEB_DIR="${LIB_DIR}/web"
WEB_CF_DIR="${LIB_DIR}/web-cloudfront"
LAMBDA_HANDLER="${LIB_DIR}/lambda/handler.py"
COLLECTOR_HANDLER="${LIB_DIR}/lambda/collector.py"
PARSER_MODULE="${LIB_DIR}/parse-connect-ai-logs.py"

# ---------------------------------------------------------------------------
# 默认值
# ---------------------------------------------------------------------------
CONNECT_ARN=""
GATEWAY_ARN=""
CONNECT_INSTANCE_ARN=""
EMAIL=""
SUFFIX=""
REGION=""
PROFILE=""
OUT_DIR=""
KEEP="false"
LAMBDA_MEMORY="3008"
SCHEDULE_CRON="cron(0 1 * * ? *)"   # 每天 01:00 UTC
BACKFILL_DAYS="1"                    # 部署后立即回补昨天
DAILY_PREFIX="daily/"

CSAT_ATTRIBUTE_KEY="${CSAT_ATTRIBUTE_KEY:-botevaluation}"

CF_CACHE_POLICY_ID="658327ea-f89d-4fab-a63d-7e88639e58f6"
AWS_SDK_URL="https://sdk.amazonaws.com/js/aws-sdk-2.1691.0.min.js"

usage() { sed -n '2,58p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

# ---------------------------------------------------------------------------
# 解析参数
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --connect-arn) CONNECT_ARN="$2"; shift 2;;
    --gateway-arn) GATEWAY_ARN="$2"; shift 2;;
    --connect-instance-arn) CONNECT_INSTANCE_ARN="$2"; shift 2;;
    --email)       EMAIL="$2"; shift 2;;
    --suffix)      SUFFIX="$2"; shift 2;;
    --region)      REGION="$2"; shift 2;;
    --schedule-cron) SCHEDULE_CRON="$2"; shift 2;;
    --backfill-days) BACKFILL_DAYS="$2"; shift 2;;
    --profile)     PROFILE="$2"; shift 2;;
    --out-dir)     OUT_DIR="$2"; shift 2;;
    --keep)        KEEP="true"; shift;;
    --lambda-memory) LAMBDA_MEMORY="$2"; shift 2;;
    --csat-attr)   CSAT_ATTRIBUTE_KEY="$2"; shift 2;;
    -h|--help)     usage; exit 0;;
    *) echo "未知参数: $1" >&2; usage; exit 1;;
  esac
done

# aws CLI 包装(带上可选 profile)
awscli() {
  if [[ -n "${PROFILE}" ]]; then
    aws --profile "${PROFILE}" "$@"
  else
    aws "$@"
  fi
}

# ---------------------------------------------------------------------------
# 依赖检查
# ---------------------------------------------------------------------------
command -v aws >/dev/null 2>&1 || { echo "错误: 未找到 aws CLI(需 v2 且已配置凭证)。" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "错误: 未找到 python3。" >&2; exit 1; }
[[ -f "${LAMBDA_HANDLER}" ]] || { echo "错误: 找不到拆分 Lambda 代码 ${LAMBDA_HANDLER}" >&2; exit 1; }
[[ -f "${COLLECTOR_HANDLER}" ]] || { echo "错误: 找不到采集 Lambda 代码 ${COLLECTOR_HANDLER}" >&2; exit 1; }
[[ -f "${PARSER_MODULE}" ]] || { echo "错误: 找不到解析模块 ${PARSER_MODULE}" >&2; exit 1; }
[[ -f "${WEB_CF_DIR}/auth-scheduled.js" ]] || { echo "错误: 找不到 ${WEB_CF_DIR}/auth-scheduled.js" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 交互式补全必选参数
# ---------------------------------------------------------------------------
if [[ -z "${CONNECT_ARN}" ]]; then
  echo "请输入 Connect AI Agent 日志组 ARN(必选):"
  echo "  例如: arn:aws:logs:us-west-2:111122223333:log-group:/aws/connect/ai-agent-logs:*"
  printf "CONNECT_AI_AGENT_LOG_ARN: "
  read -r CONNECT_ARN
fi
CONNECT_ARN="$(echo "${CONNECT_ARN}" | tr -d '[:space:]')"
[[ -n "${CONNECT_ARN}" ]] || { echo "错误: 必须提供 CONNECT_AI_AGENT_LOG_ARN。" >&2; exit 1; }

if [[ -z "${GATEWAY_ARN}" ]]; then
  echo "请输入 Bedrock AgentCore Gateway 日志组 ARN(可选，直接回车跳过):"
  printf "BEDROCK_AGENTCORE_GATEWAY_LOG_ARN: "
  read -r GATEWAY_ARN
fi
GATEWAY_ARN="$(echo "${GATEWAY_ARN}" | tr -d '[:space:]')"

if [[ -z "${CONNECT_INSTANCE_ARN}" ]]; then
  echo "请输入 Amazon Connect 实例 ARN(必选):"
  echo "  例如: arn:aws:connect:us-west-2:111122223333:instance/2ff5674e-de94-4714-bc6d-d7f2cebeee9d"
  printf "CONNECT_INSTANCE_ARN: "
  read -r CONNECT_INSTANCE_ARN
fi
CONNECT_INSTANCE_ARN="$(echo "${CONNECT_INSTANCE_ARN}" | tr -d '[:space:]')"
[[ -n "${CONNECT_INSTANCE_ARN}" ]] || { echo "错误: 必须提供 CONNECT_INSTANCE_ARN。" >&2; exit 1; }
if [[ ! "${CONNECT_INSTANCE_ARN}" =~ ^arn:aws:connect:[a-z0-9-]+:[0-9]+:instance/[0-9a-fA-F-]+$ ]]; then
  echo "错误: Connect 实例 ARN 格式不正确: ${CONNECT_INSTANCE_ARN}" >&2
  echo "      期望形如 arn:aws:connect:<region>:<account>:instance/<instanceId>" >&2
  exit 1
fi
CONNECT_INSTANCE_REGION="$(echo "${CONNECT_INSTANCE_ARN}" | cut -d: -f4)"
CONNECT_INSTANCE_ID="${CONNECT_INSTANCE_ARN##*/}"

RECORDINGS_BUCKET="$(awscli connect list-instance-storage-configs \
  --instance-id "${CONNECT_INSTANCE_ID}" \
  --resource-type CALL_RECORDINGS \
  --region "${CONNECT_INSTANCE_REGION}" \
  --query 'StorageConfigs[0].S3Config.BucketName' \
  --output text 2>/dev/null || true)"
if [[ "${RECORDINGS_BUCKET}" == "None" ]]; then RECORDINGS_BUCKET=""; fi
if [[ -n "${RECORDINGS_BUCKET}" ]]; then
  echo "==> 通话录音/分析结果存储桶: ${RECORDINGS_BUCKET}(用于读取自动交互摘要)"
else
  echo "==> 未能解析通话录音存储桶; CloudFront 版的「通话摘要」列将显示 N/A。" >&2
fi

if [[ -z "${EMAIL}" ]]; then
  echo "请输入登录用户邮箱(将接收一次性密码，必选):"
  printf "EMAIL: "
  read -r EMAIL
fi
EMAIL="$(echo "${EMAIL}" | tr -d '[:space:]')"
[[ "${EMAIL}" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] \
  || { echo "错误: 邮箱格式不正确: ${EMAIL}" >&2; exit 1; }

if [[ -z "${SUFFIX}" ]]; then
  echo "请输入存储桶名后缀(日志桶将命名为 ai-agent-logs<suffix>，必选):"
  echo "  只能包含小写字母、数字和连字符(-)。例如: -demo 或 20260709"
  printf "SUFFIX: "
  read -r SUFFIX
fi
SUFFIX="$(echo "${SUFFIX}" | tr -d '[:space:]' | tr 'A-Z' 'a-z')"

# ---------------------------------------------------------------------------
# 从 ARN 解析 region / account / 日志组名
# ---------------------------------------------------------------------------
arn_region()    { echo "$1" | cut -d: -f4; }
arn_account()   { echo "$1" | cut -d: -f5; }
arn_log_group() { local rest="${1#*:log-group:}"; rest="${rest%:\*}"; echo "${rest}"; }

CONNECT_REGION="$(arn_region "${CONNECT_ARN}")"
ACCOUNT_ID="$(arn_account "${CONNECT_ARN}")"
CONNECT_LG="$(arn_log_group "${CONNECT_ARN}")"
[[ -n "${REGION}" ]] || REGION="${CONNECT_REGION}"

if [[ -z "${REGION}" || -z "${ACCOUNT_ID}" || -z "${CONNECT_LG}" ]]; then
  echo "错误: 无法从 CONNECT_AI_AGENT_LOG_ARN 解析出 region/account/日志组名。" >&2
  echo "      期望形如 arn:aws:logs:<region>:<account>:log-group:<name>[:*]" >&2
  exit 1
fi

GATEWAY_REGION=""; GATEWAY_LG=""
if [[ -n "${GATEWAY_ARN}" ]]; then
  GATEWAY_REGION="$(arn_region "${GATEWAY_ARN}")"
  GATEWAY_LG="$(arn_log_group "${GATEWAY_ARN}")"
fi

# ---------------------------------------------------------------------------
# 资源命名
# ---------------------------------------------------------------------------
LOGS_BUCKET="ai-agent-logs${SUFFIX}"
WEB_BUCKET="ai-agent-logs${SUFFIX}-web"
USER_POOL_NAME="connect-ai-agent-logs${SUFFIX}"
IDENTITY_POOL_NAME="connect_ai_agent_logs${SUFFIX//-/_}"
AUTH_ROLE_NAME="connect-ai-logs${SUFFIX}-auth-role"
LAMBDA_NAME="connect-ai-logs${SUFFIX}-splitter"
LAMBDA_ROLE_NAME="connect-ai-logs${SUFFIX}-lambda-role"
COLLECTOR_NAME="connect-ai-logs${SUFFIX}-collector"
COLLECTOR_ROLE_NAME="connect-ai-logs${SUFFIX}-collector-role"
SCHEDULE_RULE_NAME="connect-ai-logs${SUFFIX}-daily"

validate_bucket() {
  local b="$1"
  if [[ ! "${b}" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]]; then
    echo "错误: 生成的桶名不合法: ${b}" >&2
    echo "      请调整 --suffix(只用小写字母、数字、连字符)。" >&2
    exit 1
  fi
}
validate_bucket "${LOGS_BUCKET}"
validate_bucket "${WEB_BUCKET}"

echo "==================================================================="
echo " 部署配置(定时按天版)"
echo "   区域(region)      : ${REGION}"
echo "   账号(account)     : ${ACCOUNT_ID}"
echo "   Connect 日志组    : ${CONNECT_LG} (${CONNECT_REGION})"
if [[ -n "${GATEWAY_ARN}" ]]; then
echo "   Gateway 日志组    : ${GATEWAY_LG} (${GATEWAY_REGION})"
else
echo "   Gateway 日志组    : (未提供)"
fi
echo "   Connect 实例      : ${CONNECT_INSTANCE_ID} (${CONNECT_INSTANCE_REGION})"
echo "   日志存储桶        : ${LOGS_BUCKET}"
echo "   Web 存储桶        : ${WEB_BUCKET}"
echo "   拆分 Lambda 内存  : ${LAMBDA_MEMORY} MB"
echo "   定时表达式(UTC)   : ${SCHEDULE_CRON}"
echo "   部署后回补天数    : ${BACKFILL_DAYS}"
echo "   登录邮箱          : ${EMAIL}"
echo "==================================================================="

if [[ -z "${OUT_DIR}" ]]; then
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/connect-ai-cf-sched.XXXXXX")"
else
  WORK="${OUT_DIR}"
  mkdir -p "${WORK}"
fi
cleanup() { [[ "${KEEP}" == "true" ]] || rm -rf "${WORK}" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# S3 桶辅助函数
bucket_exists() { awscli s3api head-bucket --bucket "$1" >/dev/null 2>&1; }

create_bucket() {
  local b="$1"
  echo "==> 创建 S3 桶: ${b}"
  if [[ "${REGION}" == "us-east-1" ]]; then
    awscli s3api create-bucket --bucket "${b}" --region "${REGION}" >/dev/null
  else
    awscli s3api create-bucket --bucket "${b}" --region "${REGION}" \
      --create-bucket-configuration LocationConstraint="${REGION}" >/dev/null
  fi
  awscli s3api put-public-access-block --bucket "${b}" \
    --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true >/dev/null
}

# ---------------------------------------------------------------------------
# 1. 日志存储桶 + CORS
# ---------------------------------------------------------------------------
if bucket_exists "${LOGS_BUCKET}"; then
  echo "==> 日志桶已存在，复用: ${LOGS_BUCKET}"
else
  create_bucket "${LOGS_BUCKET}"
fi

CORS_JSON="${WORK}/_cors.json"
cat > "${CORS_JSON}" <<'JSON'
{
  "CORSRules": [
    {
      "AllowedOrigins": ["*"],
      "AllowedMethods": ["GET", "HEAD"],
      "AllowedHeaders": ["*"],
      "ExposeHeaders": ["ETag"],
      "MaxAgeSeconds": 3000
    }
  ]
}
JSON
echo "==> 配置日志桶 CORS ..."
awscli s3api put-bucket-cors --bucket "${LOGS_BUCKET}" --cors-configuration "file://${CORS_JSON}" >/dev/null

if [[ -n "${RECORDINGS_BUCKET}" ]]; then
  echo "==> 合并录音/分析结果桶 CORS(用于读取自动交互摘要): ${RECORDINGS_BUCKET}"
  EXISTING_CORS="$(awscli s3api get-bucket-cors --bucket "${RECORDINGS_BUCKET}" --output json 2>/dev/null || echo '{}')"
  MERGED_CORS_JSON="${WORK}/_rec_cors.json"
  if EXISTING_CORS="${EXISTING_CORS}" python3 - "${MERGED_CORS_JSON}" <<'PYEOF'
import json, os, sys
existing = {}
try:
    existing = json.loads(os.environ.get("EXISTING_CORS") or "{}")
except ValueError:
    existing = {}
rules = existing.get("CORSRules") or []
def allows_get_star(r):
    methods = r.get("AllowedMethods") or []
    origins = r.get("AllowedOrigins") or []
    return "GET" in methods and "*" in origins
if not any(allows_get_star(r) for r in rules):
    rules.append({
        "AllowedOrigins": ["*"],
        "AllowedMethods": ["GET", "HEAD"],
        "AllowedHeaders": ["*"],
        "ExposeHeaders": ["ETag"],
        "MaxAgeSeconds": 3000,
    })
    with open(sys.argv[1], "w", encoding="utf-8") as f:
        json.dump({"CORSRules": rules}, f)
    sys.exit(0)
sys.exit(3)
PYEOF
  then
    awscli s3api put-bucket-cors --bucket "${RECORDINGS_BUCKET}" \
      --cors-configuration "file://${MERGED_CORS_JSON}" >/dev/null \
      && echo "    已追加 GET/HEAD CORS 规则。" \
      || echo "    警告: 写入录音桶 CORS 失败(可能无权限); 摘要列可能显示 N/A。" >&2
  else
    echo "    录音桶已有可用的 GET CORS 规则, 保持不变。"
  fi
fi

# ---------------------------------------------------------------------------
# 2. 拆分 Lambda(与一次性版一致): 执行角色 + 部署包 + 函数 + S3 触发权限 + 桶事件通知
# ---------------------------------------------------------------------------
LAMBDA_TRUST_JSON="${WORK}/_lambda_trust.json"
cat > "${LAMBDA_TRUST_JSON}" <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Principal": { "Service": "lambda.amazonaws.com" },
      "Action": "sts:AssumeRole" }
  ]
}
JSON

LAMBDA_POLICY_JSON="${WORK}/_lambda_policy.json"
cat > "${LAMBDA_POLICY_JSON}" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
      "Resource": ["arn:aws:s3:::${LOGS_BUCKET}", "arn:aws:s3:::${LOGS_BUCKET}/*"]
    },
    {
      "Effect": "Allow",
      "Action": ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
      "Resource": "arn:aws:logs:*:*:*"
    }
  ]
}
JSON

if awscli iam get-role --role-name "${LAMBDA_ROLE_NAME}" >/dev/null 2>&1; then
  echo "==> 复用拆分 Lambda 执行角色: ${LAMBDA_ROLE_NAME}"
  awscli iam update-assume-role-policy --role-name "${LAMBDA_ROLE_NAME}" \
    --policy-document "file://${LAMBDA_TRUST_JSON}" >/dev/null
  LAMBDA_ROLE_ARN="$(awscli iam get-role --role-name "${LAMBDA_ROLE_NAME}" \
    --query 'Role.Arn' --output text)"
else
  echo "==> 创建拆分 Lambda 执行角色: ${LAMBDA_ROLE_NAME}"
  LAMBDA_ROLE_ARN="$(awscli iam create-role --role-name "${LAMBDA_ROLE_NAME}" \
    --assume-role-policy-document "file://${LAMBDA_TRUST_JSON}" \
    --query 'Role.Arn' --output text)"
fi
awscli iam put-role-policy --role-name "${LAMBDA_ROLE_NAME}" \
  --policy-name "logs-bucket-rw" \
  --policy-document "file://${LAMBDA_POLICY_JSON}" >/dev/null

LAMBDA_ZIP="${WORK}/lambda.zip"
python3 - "${LAMBDA_ZIP}" "${LAMBDA_HANDLER}" "${PARSER_MODULE}" <<'PYEOF'
import sys, zipfile
zp, handler, parser = sys.argv[1], sys.argv[2], sys.argv[3]
with zipfile.ZipFile(zp, "w", zipfile.ZIP_DEFLATED) as z:
    z.write(handler, "handler.py")
    z.write(parser, "connect_parser.py")
PYEOF

sleep 8

if awscli lambda get-function --function-name "${LAMBDA_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "==> 更新拆分 Lambda: ${LAMBDA_NAME}"
  awscli lambda update-function-code --function-name "${LAMBDA_NAME}" --region "${REGION}" \
    --zip-file "fileb://${LAMBDA_ZIP}" >/dev/null
  awscli lambda wait function-updated --function-name "${LAMBDA_NAME}" --region "${REGION}" 2>/dev/null || sleep 5
  awscli lambda update-function-configuration --function-name "${LAMBDA_NAME}" --region "${REGION}" \
    --runtime python3.12 --role "${LAMBDA_ROLE_ARN}" --handler handler.handler \
    --timeout 900 --memory-size "${LAMBDA_MEMORY}" >/dev/null
  awscli lambda wait function-updated --function-name "${LAMBDA_NAME}" --region "${REGION}" 2>/dev/null || sleep 5
else
  echo "==> 创建拆分 Lambda: ${LAMBDA_NAME}"
  n=0
  until awscli lambda create-function --function-name "${LAMBDA_NAME}" --region "${REGION}" \
      --runtime python3.12 --role "${LAMBDA_ROLE_ARN}" --handler handler.handler \
      --timeout 900 --memory-size "${LAMBDA_MEMORY}" --zip-file "fileb://${LAMBDA_ZIP}" >/dev/null 2>&1; do
    n=$((n + 1))
    if [[ ${n} -ge 6 ]]; then
      echo "错误: 创建拆分 Lambda 失败(执行角色可能尚未生效)。请稍后重跑本脚本。" >&2
      exit 1
    fi
    echo "    等待执行角色生效，重试 (${n}/6) ..."
    sleep 5
  done
fi
LAMBDA_ARN="$(awscli lambda get-function --function-name "${LAMBDA_NAME}" --region "${REGION}" \
  --query 'Configuration.FunctionArn' --output text)"

awscli lambda put-function-event-invoke-config --function-name "${LAMBDA_NAME}" \
  --region "${REGION}" --maximum-retry-attempts 0 >/dev/null 2>&1 || true

awscli lambda remove-permission --function-name "${LAMBDA_NAME}" --region "${REGION}" \
  --statement-id s3invoke >/dev/null 2>&1 || true
awscli lambda add-permission --function-name "${LAMBDA_NAME}" --region "${REGION}" \
  --statement-id s3invoke --action "lambda:InvokeFunction" \
  --principal s3.amazonaws.com \
  --source-arn "arn:aws:s3:::${LOGS_BUCKET}" \
  --source-account "${ACCOUNT_ID}" >/dev/null

NOTIF_JSON="${WORK}/_notif.json"
cat > "${NOTIF_JSON}" <<JSON
{
  "LambdaFunctionConfigurations": [
    {
      "Id": "process-raw-logs",
      "LambdaFunctionArn": "${LAMBDA_ARN}",
      "Events": ["s3:ObjectCreated:*"],
      "Filter": {
        "Key": {
          "FilterRules": [
            { "Name": "prefix", "Value": "trigger/" },
            { "Name": "suffix", "Value": ".json" }
          ]
        }
      }
    }
  ]
}
JSON
echo "==> 配置日志桶事件通知 -> 拆分 Lambda"
awscli s3api put-bucket-notification-configuration --bucket "${LOGS_BUCKET}" \
  --notification-configuration "file://${NOTIF_JSON}" >/dev/null

# ---------------------------------------------------------------------------
# 3. 采集 Lambda(定时) + EventBridge 定时规则
# ---------------------------------------------------------------------------
# 3.1 采集 Lambda 执行角色: 读 CloudWatch 日志 + 读写日志桶 + 写自身日志
COLLECTOR_POLICY_JSON="${WORK}/_collector_policy.json"
LOGS_RESOURCES="\"${CONNECT_ARN}\""
if [[ -n "${GATEWAY_ARN}" ]]; then
  LOGS_RESOURCES="${LOGS_RESOURCES}, \"${GATEWAY_ARN}\""
fi
cat > "${COLLECTOR_POLICY_JSON}" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["logs:FilterLogEvents", "logs:GetLogEvents", "logs:DescribeLogStreams"],
      "Resource": [${LOGS_RESOURCES}]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:AbortMultipartUpload", "s3:ListBucket", "s3:ListBucketMultipartUploads"],
      "Resource": ["arn:aws:s3:::${LOGS_BUCKET}", "arn:aws:s3:::${LOGS_BUCKET}/*"]
    },
    {
      "Effect": "Allow",
      "Action": ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
      "Resource": "arn:aws:logs:*:*:*"
    }
  ]
}
JSON

if awscli iam get-role --role-name "${COLLECTOR_ROLE_NAME}" >/dev/null 2>&1; then
  echo "==> 复用采集 Lambda 执行角色: ${COLLECTOR_ROLE_NAME}"
  awscli iam update-assume-role-policy --role-name "${COLLECTOR_ROLE_NAME}" \
    --policy-document "file://${LAMBDA_TRUST_JSON}" >/dev/null
  COLLECTOR_ROLE_ARN="$(awscli iam get-role --role-name "${COLLECTOR_ROLE_NAME}" \
    --query 'Role.Arn' --output text)"
else
  echo "==> 创建采集 Lambda 执行角色: ${COLLECTOR_ROLE_NAME}"
  COLLECTOR_ROLE_ARN="$(awscli iam create-role --role-name "${COLLECTOR_ROLE_NAME}" \
    --assume-role-policy-document "file://${LAMBDA_TRUST_JSON}" \
    --query 'Role.Arn' --output text)"
fi
awscli iam put-role-policy --role-name "${COLLECTOR_ROLE_NAME}" \
  --policy-name "collector-perms" \
  --policy-document "file://${COLLECTOR_POLICY_JSON}" >/dev/null

# 3.2 打包并创建/更新采集 Lambda
COLLECTOR_ZIP="${WORK}/collector.zip"
python3 - "${COLLECTOR_ZIP}" "${COLLECTOR_HANDLER}" <<'PYEOF'
import sys, zipfile
zp, handler = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(zp, "w", zipfile.ZIP_DEFLATED) as z:
    z.write(handler, "collector.py")
PYEOF

# 采集 Lambda 的环境变量
COLLECTOR_ENV="Variables={LOGS_BUCKET=${LOGS_BUCKET},CONNECT_REGION=${CONNECT_REGION},CONNECT_LOG_GROUP=${CONNECT_LG},DAILY_PREFIX=${DAILY_PREFIX}"
if [[ -n "${GATEWAY_ARN}" ]]; then
  COLLECTOR_ENV="${COLLECTOR_ENV},GATEWAY_REGION=${GATEWAY_REGION},GATEWAY_LOG_GROUP=${GATEWAY_LG}"
fi
COLLECTOR_ENV="${COLLECTOR_ENV}}"

sleep 8

if awscli lambda get-function --function-name "${COLLECTOR_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "==> 更新采集 Lambda: ${COLLECTOR_NAME}"
  awscli lambda update-function-code --function-name "${COLLECTOR_NAME}" --region "${REGION}" \
    --zip-file "fileb://${COLLECTOR_ZIP}" >/dev/null
  awscli lambda wait function-updated --function-name "${COLLECTOR_NAME}" --region "${REGION}" 2>/dev/null || sleep 5
  awscli lambda update-function-configuration --function-name "${COLLECTOR_NAME}" --region "${REGION}" \
    --runtime python3.12 --role "${COLLECTOR_ROLE_ARN}" --handler collector.handler \
    --timeout 900 --memory-size "${LAMBDA_MEMORY}" --environment "${COLLECTOR_ENV}" >/dev/null
  awscli lambda wait function-updated --function-name "${COLLECTOR_NAME}" --region "${REGION}" 2>/dev/null || sleep 5
else
  echo "==> 创建采集 Lambda: ${COLLECTOR_NAME}"
  n=0
  until awscli lambda create-function --function-name "${COLLECTOR_NAME}" --region "${REGION}" \
      --runtime python3.12 --role "${COLLECTOR_ROLE_ARN}" --handler collector.handler \
      --timeout 900 --memory-size "${LAMBDA_MEMORY}" --environment "${COLLECTOR_ENV}" \
      --zip-file "fileb://${COLLECTOR_ZIP}" >/dev/null 2>&1; do
    n=$((n + 1))
    if [[ ${n} -ge 6 ]]; then
      echo "错误: 创建采集 Lambda 失败(执行角色可能尚未生效)。请稍后重跑本脚本。" >&2
      exit 1
    fi
    echo "    等待执行角色生效，重试 (${n}/6) ..."
    sleep 5
  done
fi
COLLECTOR_ARN="$(awscli lambda get-function --function-name "${COLLECTOR_NAME}" --region "${REGION}" \
  --query 'Configuration.FunctionArn' --output text)"

# 3.3 EventBridge 定时规则 -> 采集 Lambda
echo "==> 创建/更新 EventBridge 定时规则: ${SCHEDULE_RULE_NAME} (${SCHEDULE_CRON})"
RULE_ARN="$(awscli events put-rule --name "${SCHEDULE_RULE_NAME}" --region "${REGION}" \
  --schedule-expression "${SCHEDULE_CRON}" --state ENABLED \
  --description "每天定时采集 Connect AI Agent 昨天(UTC)整天日志" \
  --query 'RuleArn' --output text)"

# 允许 EventBridge 调用采集 Lambda(幂等)
awscli lambda remove-permission --function-name "${COLLECTOR_NAME}" --region "${REGION}" \
  --statement-id eventbridge-invoke >/dev/null 2>&1 || true
awscli lambda add-permission --function-name "${COLLECTOR_NAME}" --region "${REGION}" \
  --statement-id eventbridge-invoke --action "lambda:InvokeFunction" \
  --principal events.amazonaws.com --source-arn "${RULE_ARN}" >/dev/null

# 绑定 target(不带 Input -> 采集 Lambda 默认处理"昨天 UTC")
awscli events put-targets --rule "${SCHEDULE_RULE_NAME}" --region "${REGION}" \
  --targets "Id=collector,Arn=${COLLECTOR_ARN}" >/dev/null

# ---------------------------------------------------------------------------
# 4. Amazon Cognito: 用户池 + 应用客户端 + 身份池 + 鉴权角色
# ---------------------------------------------------------------------------
find_user_pool() {
  awscli cognito-idp list-user-pools --max-results 60 \
    --region "${REGION}" \
    --query "UserPools[?Name=='${USER_POOL_NAME}'].Id | [0]" --output text 2>/dev/null
}
USER_POOL_ID="$(find_user_pool || true)"
if [[ -z "${USER_POOL_ID}" || "${USER_POOL_ID}" == "None" ]]; then
  echo "==> 创建 Cognito 用户池: ${USER_POOL_NAME}"
  USER_POOL_ID="$(awscli cognito-idp create-user-pool \
    --pool-name "${USER_POOL_NAME}" \
    --region "${REGION}" \
    --username-attributes email \
    --auto-verified-attributes email \
    --admin-create-user-config 'AllowAdminCreateUserOnly=true' \
    --policies 'PasswordPolicy={MinimumLength=8,RequireUppercase=true,RequireLowercase=true,RequireNumbers=true,RequireSymbols=false}' \
    --query 'UserPool.Id' --output text)"
else
  echo "==> 复用已存在的用户池: ${USER_POOL_ID}"
fi

CLIENT_ID="$(awscli cognito-idp list-user-pool-clients \
  --user-pool-id "${USER_POOL_ID}" --region "${REGION}" --max-results 60 \
  --query "UserPoolClients[?ClientName=='${USER_POOL_NAME}-web'].ClientId | [0]" \
  --output text 2>/dev/null || true)"
if [[ -z "${CLIENT_ID}" || "${CLIENT_ID}" == "None" ]]; then
  echo "==> 创建用户池应用客户端"
  CLIENT_ID="$(awscli cognito-idp create-user-pool-client \
    --user-pool-id "${USER_POOL_ID}" --region "${REGION}" \
    --client-name "${USER_POOL_NAME}-web" \
    --no-generate-secret \
    --explicit-auth-flows ALLOW_USER_PASSWORD_AUTH ALLOW_REFRESH_TOKEN_AUTH \
    --query 'UserPoolClient.ClientId' --output text)"
else
  echo "==> 复用已存在的应用客户端: ${CLIENT_ID}"
fi

PROVIDER_NAME="cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}"
IDENTITY_POOL_ID="$(awscli cognito-identity list-identity-pools --max-results 60 \
  --region "${REGION}" \
  --query "IdentityPools[?IdentityPoolName=='${IDENTITY_POOL_NAME}'].IdentityPoolId | [0]" \
  --output text 2>/dev/null || true)"
if [[ -z "${IDENTITY_POOL_ID}" || "${IDENTITY_POOL_ID}" == "None" ]]; then
  echo "==> 创建 Cognito 身份池: ${IDENTITY_POOL_NAME}"
  IDENTITY_POOL_ID="$(awscli cognito-identity create-identity-pool \
    --region "${REGION}" \
    --identity-pool-name "${IDENTITY_POOL_NAME}" \
    --no-allow-unauthenticated-identities \
    --cognito-identity-providers "ProviderName=${PROVIDER_NAME},ClientId=${CLIENT_ID},ServerSideTokenCheck=false" \
    --query 'IdentityPoolId' --output text)"
else
  echo "==> 复用已存在的身份池: ${IDENTITY_POOL_ID}"
  awscli cognito-identity update-identity-pool \
    --region "${REGION}" \
    --identity-pool-id "${IDENTITY_POOL_ID}" \
    --identity-pool-name "${IDENTITY_POOL_NAME}" \
    --no-allow-unauthenticated-identities \
    --cognito-identity-providers "ProviderName=${PROVIDER_NAME},ClientId=${CLIENT_ID},ServerSideTokenCheck=false" >/dev/null
fi

TRUST_JSON="${WORK}/_trust.json"
cat > "${TRUST_JSON}" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Federated": "cognito-identity.amazonaws.com" },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": { "cognito-identity.amazonaws.com:aud": "${IDENTITY_POOL_ID}" },
        "ForAnyValue:StringLike": { "cognito-identity.amazonaws.com:amr": "authenticated" }
      }
    }
  ]
}
JSON

S3_POLICY_JSON="${WORK}/_s3policy.json"
REC_STMT=""
if [[ -n "${RECORDINGS_BUCKET}" ]]; then
  REC_STMT=",
    {
      \"Effect\": \"Allow\",
      \"Action\": [\"s3:GetObject\"],
      \"Resource\": \"arn:aws:s3:::${RECORDINGS_BUCKET}/Analysis/*\"
    },
    {
      \"Effect\": \"Allow\",
      \"Action\": [\"s3:ListBucket\"],
      \"Resource\": \"arn:aws:s3:::${RECORDINGS_BUCKET}\"
    }"
fi
cat > "${S3_POLICY_JSON}" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject"],
      "Resource": "arn:aws:s3:::${LOGS_BUCKET}/*"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::${LOGS_BUCKET}"
    }${REC_STMT}
  ]
}
JSON

CONNECT_POLICY_JSON="${WORK}/_connectpolicy.json"
cat > "${CONNECT_POLICY_JSON}" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["connect:DescribeContact", "connect:GetContactAttributes"],
      "Resource": [
        "${CONNECT_INSTANCE_ARN}",
        "${CONNECT_INSTANCE_ARN}/contact/*"
      ]
    }
  ]
}
JSON

if awscli iam get-role --role-name "${AUTH_ROLE_NAME}" >/dev/null 2>&1; then
  echo "==> 复用鉴权角色: ${AUTH_ROLE_NAME}"
  awscli iam update-assume-role-policy --role-name "${AUTH_ROLE_NAME}" \
    --policy-document "file://${TRUST_JSON}" >/dev/null
  AUTH_ROLE_ARN="$(awscli iam get-role --role-name "${AUTH_ROLE_NAME}" \
    --query 'Role.Arn' --output text)"
else
  echo "==> 创建鉴权角色: ${AUTH_ROLE_NAME}"
  AUTH_ROLE_ARN="$(awscli iam create-role --role-name "${AUTH_ROLE_NAME}" \
    --assume-role-policy-document "file://${TRUST_JSON}" \
    --query 'Role.Arn' --output text)"
fi
awscli iam put-role-policy --role-name "${AUTH_ROLE_NAME}" \
  --policy-name "read-logs-bucket" \
  --policy-document "file://${S3_POLICY_JSON}" >/dev/null
awscli iam put-role-policy --role-name "${AUTH_ROLE_NAME}" \
  --policy-name "connect-describe-contact" \
  --policy-document "file://${CONNECT_POLICY_JSON}" >/dev/null

sleep 8
echo "==> 关联身份池与鉴权角色"
awscli cognito-identity set-identity-pool-roles \
  --region "${REGION}" \
  --identity-pool-id "${IDENTITY_POOL_ID}" \
  --roles "authenticated=${AUTH_ROLE_ARN}" >/dev/null

if awscli cognito-idp admin-get-user --user-pool-id "${USER_POOL_ID}" \
     --username "${EMAIL}" --region "${REGION}" >/dev/null 2>&1; then
  echo "==> 用户已存在，跳过创建: ${EMAIL}"
  echo "    如需重新发送一次性密码，可在登录页点击「忘记密码」，或删除该用户后重跑。"
else
  echo "==> 创建登录用户并发送一次性密码到: ${EMAIL}"
  awscli cognito-idp admin-create-user \
    --user-pool-id "${USER_POOL_ID}" --region "${REGION}" \
    --username "${EMAIL}" \
    --user-attributes Name=email,Value="${EMAIL}" Name=email_verified,Value=true \
    --desired-delivery-mediums EMAIL >/dev/null
fi

# ---------------------------------------------------------------------------
# 5. 发布 Web 站点(登录门禁 + 日期控件版) -> Web 桶
# ---------------------------------------------------------------------------
if bucket_exists "${WEB_BUCKET}"; then
  echo "==> Web 桶已存在，复用: ${WEB_BUCKET}"
else
  create_bucket "${WEB_BUCKET}"
fi

echo "==> 发布站点到 s3://${WEB_BUCKET}/ ..."
JS_CT="application/javascript; charset=utf-8"
awscli s3 cp "${WEB_DIR}/app.js"          "s3://${WEB_BUCKET}/app.js"          --content-type "${JS_CT}" >/dev/null
awscli s3 cp "${WEB_DIR}/i18n.js"         "s3://${WEB_BUCKET}/i18n.js"         --content-type "${JS_CT}" >/dev/null
awscli s3 cp "${WEB_DIR}/site-config.js"  "s3://${WEB_BUCKET}/site-config.js"  --content-type "${JS_CT}" >/dev/null
awscli s3 cp "${WEB_CF_DIR}/auth-scheduled.js" "s3://${WEB_BUCKET}/auth-scheduled.js" --content-type "${JS_CT}" >/dev/null

if [[ -f "${WEB_DIR}/connect-enrich.js" ]]; then
  awscli s3 cp "${WEB_DIR}/connect-enrich.js" "s3://${WEB_BUCKET}/connect-enrich.js" --content-type "${JS_CT}" >/dev/null
else
  printf 'window.__CONNECT_CONTACT_ENRICH__ = {};\n' | \
    awscli s3 cp - "s3://${WEB_BUCKET}/connect-enrich.js" --content-type "${JS_CT}" >/dev/null
fi

# 生成运行时配置 aws-config.js(含 dailyPrefix，供按日期加载)
awscli s3 cp - "s3://${WEB_BUCKET}/aws-config.js" --content-type "${JS_CT}" >/dev/null <<JSCFG
/* 由 setup-connect-ai-agent-logs-analysis-in-cloudfront-scheduled.sh 自动生成，请勿手工编辑 */
window.__AWS_CONFIG__ = {
  region: "${REGION}",
  userPoolId: "${USER_POOL_ID}",
  clientId: "${CLIENT_ID}",
  identityPoolId: "${IDENTITY_POOL_ID}",
  logsBucket: "${LOGS_BUCKET}",
  logsPrefix: "",
  dailyPrefix: "${DAILY_PREFIX}",
  connectInstanceId: "${CONNECT_INSTANCE_ID}",
  connectInstanceArn: "${CONNECT_INSTANCE_ARN}",
  connectRegion: "${CONNECT_INSTANCE_REGION}",
  recordingsBucket: "${RECORDINGS_BUCKET}",
  csatAttribute: "${CSAT_ATTRIBUTE_KEY}"
};
JSCFG

# 由 lib/web/index.html 生成登录门禁版 index.html 并直传:
#   - 去掉静态 data.js(数据改为登录后按日期从 S3 加载)
#   - 用 SDK + aws-config.js + auth-scheduled.js 取代静态 app.js(app.js 由 auth 动态加载)
AWS_SDK_URL="${AWS_SDK_URL}" python3 - "${WEB_DIR}/index.html" <<'PYEOF' \
  | awscli s3 cp - "s3://${WEB_BUCKET}/index.html" --content-type "text/html; charset=utf-8" >/dev/null
import os, re, sys
sdk = os.environ["AWS_SDK_URL"]
html = open(sys.argv[1], encoding="utf-8").read()
html = re.sub(r'[ \t]*<script src="\./data\.js"></script>\s*\n', "", html)
replacement = (
    '<script src="%s"></script>\n'
    '<script src="./aws-config.js"></script>\n'
    '<script src="./auth-scheduled.js"></script>\n'
) % sdk
html, n = re.subn(r'[ \t]*<script src="\./app\.js"></script>\s*\n', replacement, html)
if n == 0:
    sys.stderr.write("警告: 未在 index.html 找到 app.js 脚本标签，请检查模板。\n")
sys.stdout.write(html)
PYEOF

# ---------------------------------------------------------------------------
# 6. CloudFront: OAC + 分配 + 回源桶策略
# ---------------------------------------------------------------------------
OAC_NAME="connect-ai-logs${SUFFIX}-oac"
OAC_ID="$(awscli cloudfront list-origin-access-controls \
  --query "OriginAccessControlList.Items[?Name=='${OAC_NAME}'].Id | [0]" \
  --output text 2>/dev/null || true)"
if [[ -z "${OAC_ID}" || "${OAC_ID}" == "None" ]]; then
  echo "==> 创建 CloudFront OAC: ${OAC_NAME}"
  OAC_CFG="${WORK}/_oac.json"
  cat > "${OAC_CFG}" <<JSON
{
  "Name": "${OAC_NAME}",
  "Description": "OAC for ${WEB_BUCKET}",
  "SigningProtocol": "sigv4",
  "SigningBehavior": "always",
  "OriginAccessControlOriginType": "s3"
}
JSON
  OAC_ID="$(awscli cloudfront create-origin-access-control \
    --origin-access-control-config "file://${OAC_CFG}" \
    --query 'OriginAccessControl.Id' --output text)"
else
  echo "==> 复用已存在的 OAC: ${OAC_ID}"
fi

DIST_COMMENT="connect-ai-agent-logs${SUFFIX}"
WEB_ORIGIN_DOMAIN="${WEB_BUCKET}.s3.${REGION}.amazonaws.com"
DIST_ID="$(awscli cloudfront list-distributions \
  --query "DistributionList.Items[?Comment=='${DIST_COMMENT}'].Id | [0]" \
  --output text 2>/dev/null || true)"

if [[ -z "${DIST_ID}" || "${DIST_ID}" == "None" ]]; then
  echo "==> 创建 CloudFront 分配 ..."
  DIST_CFG="${WORK}/_dist.json"
  cat > "${DIST_CFG}" <<JSON
{
  "CallerReference": "${DIST_COMMENT}-$(date +%s)",
  "Comment": "${DIST_COMMENT}",
  "Enabled": true,
  "DefaultRootObject": "index.html",
  "Origins": {
    "Quantity": 1,
    "Items": [
      {
        "Id": "s3-web",
        "DomainName": "${WEB_ORIGIN_DOMAIN}",
        "OriginAccessControlId": "${OAC_ID}",
        "S3OriginConfig": { "OriginAccessIdentity": "" }
      }
    ]
  },
  "DefaultCacheBehavior": {
    "TargetOriginId": "s3-web",
    "ViewerProtocolPolicy": "redirect-to-https",
    "CachePolicyId": "${CF_CACHE_POLICY_ID}",
    "Compress": true,
    "AllowedMethods": {
      "Quantity": 2,
      "Items": ["GET", "HEAD"],
      "CachedMethods": { "Quantity": 2, "Items": ["GET", "HEAD"] }
    }
  },
  "CustomErrorResponses": {
    "Quantity": 2,
    "Items": [
      { "ErrorCode": 403, "ResponseCode": "200", "ResponsePagePath": "/index.html", "ErrorCachingMinTTL": 10 },
      { "ErrorCode": 404, "ResponseCode": "200", "ResponsePagePath": "/index.html", "ErrorCachingMinTTL": 10 }
    ]
  }
}
JSON
  DIST_ID="$(awscli cloudfront create-distribution \
    --distribution-config "file://${DIST_CFG}" \
    --query 'Distribution.Id' --output text)"
else
  echo "==> 复用已存在的分配: ${DIST_ID}"
fi

DIST_DOMAIN="$(awscli cloudfront get-distribution --id "${DIST_ID}" \
  --query 'Distribution.DomainName' --output text)"
DIST_ARN="arn:aws:cloudfront::${ACCOUNT_ID}:distribution/${DIST_ID}"

WEB_POLICY_JSON="${WORK}/_webpolicy.json"
cat > "${WEB_POLICY_JSON}" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowCloudFrontOAC",
      "Effect": "Allow",
      "Principal": { "Service": "cloudfront.amazonaws.com" },
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::${WEB_BUCKET}/*",
      "Condition": { "StringEquals": { "AWS:SourceArn": "${DIST_ARN}" } }
    }
  ]
}
JSON
echo "==> 配置 Web 桶策略(仅允许 CloudFront OAC 访问)"
awscli s3api put-bucket-policy --bucket "${WEB_BUCKET}" \
  --policy "file://${WEB_POLICY_JSON}" >/dev/null

awscli cloudfront create-invalidation --distribution-id "${DIST_ID}" \
  --paths "/*" >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
# 7. 部署后回补最近 N 天(可选) + 触发拆分
# ---------------------------------------------------------------------------
LATEST_BACKFILL_DATE=""
if [[ "${BACKFILL_DAYS}" =~ ^[0-9]+$ && "${BACKFILL_DAYS}" -gt 0 ]]; then
  echo "==> 回补最近 ${BACKFILL_DAYS} 天数据(逐天调用采集 Lambda) ..."
  for ((d=1; d<=BACKFILL_DAYS; d++)); do
    DAY="$(python3 -c "import datetime,sys; print((datetime.datetime.now(datetime.timezone.utc).date()-datetime.timedelta(days=int(sys.argv[1]))).isoformat())" "${d}")"
    [[ -z "${LATEST_BACKFILL_DATE}" ]] && LATEST_BACKFILL_DATE="${DAY}"
    echo "    · 触发采集 ${DAY}(异步) ..."
    INVOKE_OUT="${WORK}/_invoke_${DAY}.json"
    # 异步调用(Event): 采集在后台运行(可能耗时较久), 不阻塞部署;
    # 采集完成后会写触发对象 -> 拆分 Lambda 生成 index.json, 由下方轮询等待。
    if awscli lambda invoke --function-name "${COLLECTOR_NAME}" --region "${REGION}" \
        --invocation-type Event --cli-binary-format raw-in-base64-out \
        --payload "{\"date\":\"${DAY}\"}" "${INVOKE_OUT}" >/dev/null 2>&1; then
      echo "      已提交采集任务。"
    else
      echo "      警告: 采集 ${DAY} 调用失败(可稍后由定时任务补齐)。" >&2
    fi
  done
fi

# 等待最新回补日的 index.json 由拆分 Lambda 生成
CONTACT_COUNT="?"
if [[ -n "${LATEST_BACKFILL_DATE}" ]]; then
  IDX_KEY="${DAILY_PREFIX}${LATEST_BACKFILL_DATE}/index.json"
  echo "==> 等待拆分 Lambda 生成 ${IDX_KEY}(最长约 16 分钟)..."
  for _ in $(seq 1 200); do
    if awscli s3api head-object --bucket "${LOGS_BUCKET}" --key "${IDX_KEY}" >/dev/null 2>&1; then
      IDX_JSON="$(awscli s3 cp "s3://${LOGS_BUCKET}/${IDX_KEY}" - 2>/dev/null || echo '')"
      CONTACT_COUNT="$(printf '%s' "${IDX_JSON}" \
        | python3 -c 'import sys,json; print(json.load(sys.stdin).get("contactCount","?"))' 2>/dev/null || echo '?')"
      break
    fi
    sleep 5
  done
  if [[ "${CONTACT_COUNT}" == "0" ]]; then
    echo "    提示: ${LATEST_BACKFILL_DATE} 未解析出任何 Contact(当天可能无日志)。"
  elif [[ "${CONTACT_COUNT}" == "?" ]]; then
    echo "    拆分仍在后台处理(或该天无数据)。index.json 生成后站点即可加载。"
  fi
fi

# ---------------------------------------------------------------------------
# 8. 等待 CloudFront 部署完成
# ---------------------------------------------------------------------------
echo "==> 等待 CloudFront 分配部署完成(通常 3~10 分钟)…"
CF_STATUS="Unknown"
WAITED=0
MAX_WAIT=1200
while [[ ${WAITED} -lt ${MAX_WAIT} ]]; do
  CF_STATUS="$(awscli cloudfront get-distribution --id "${DIST_ID}" \
    --query 'Distribution.Status' --output text 2>/dev/null || echo 'Unknown')"
  if [[ "${CF_STATUS}" == "Deployed" ]]; then
    printf "\r    CloudFront 状态: Deployed ✅ (耗时 %ds)                    \n" "${WAITED}"
    break
  fi
  printf "\r    CloudFront 状态: %s … 已等待 %ds" "${CF_STATUS}" "${WAITED}"
  sleep 15
  WAITED=$((WAITED + 15))
done
if [[ "${CF_STATUS}" != "Deployed" ]]; then
  printf "\n    CloudFront 仍在后台部署(状态: %s)。可稍后用以下命令查看:\n" "${CF_STATUS}"
  echo "      aws cloudfront get-distribution --id ${DIST_ID} --query 'Distribution.Status' --output text"
fi

# ---------------------------------------------------------------------------
# 9. 写资源清单文件(供 clear.sh 删除本次部署创建/管理的全部资源)
# ---------------------------------------------------------------------------
MANIFEST_TS="$(date -u +%Y%m%dT%H%M%SZ)"
MANIFEST_FILE="${SCRIPT_DIR}/aws-resources-${SUFFIX}-scheduled-${MANIFEST_TS}.manifest"
{
  echo "# Amazon Connect AI Agent 日志分析(定时按天版) — AWS 资源清单"
  echo "# 生成时间(UTC): $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# suffix       : ${SUFFIX}"
  echo "# 删除全部资源 : ./clear.sh \"${MANIFEST_FILE}\""
  echo "# 每行: 类型|标识符"
  echo "REGION|${REGION}"
  echo "ACCOUNT|${ACCOUNT_ID}"
  echo "CF_DISTRIBUTION|${DIST_ID}"
  echo "CF_OAC|${OAC_ID}"
  echo "EVENTBRIDGE_RULE|${SCHEDULE_RULE_NAME}"
  echo "LAMBDA|${COLLECTOR_NAME}"
  echo "LAMBDA|${LAMBDA_NAME}"
  echo "S3_BUCKET|${WEB_BUCKET}"
  echo "S3_BUCKET|${LOGS_BUCKET}"
  echo "COGNITO_IDENTITY_POOL|${IDENTITY_POOL_ID}"
  echo "COGNITO_USER_POOL|${USER_POOL_ID}"
  echo "IAM_ROLE|${COLLECTOR_ROLE_NAME}"
  echo "IAM_ROLE|${LAMBDA_ROLE_NAME}"
  echo "IAM_ROLE|${AUTH_ROLE_NAME}"
} > "${MANIFEST_FILE}"
echo "==> 已写入资源清单: ${MANIFEST_FILE}"

# ---------------------------------------------------------------------------
# 10. 汇总
# ---------------------------------------------------------------------------
echo ""
echo "==================================================================="
echo " 部署完成 🎉 (定时按天版)"
echo "-------------------------------------------------------------------"
echo " 访问地址(CloudFront):  https://${DIST_DOMAIN}"
echo " CloudFront 部署状态:   $([[ "${CF_STATUS}" == "Deployed" ]] && echo '已完成 (Deployed)' || echo "${CF_STATUS}(后台继续部署中)")"
echo " 登录邮箱:              ${EMAIL}"
echo "   · 首次登录: 使用邮件里收到的一次性密码，登录后按提示设置新密码。"
echo "   · 忘记密码: 登录页点击「忘记密码」，向该邮箱发送新的验证码后重置。"
echo ""
echo " 定时采集:"
echo "   EventBridge 规则:    ${SCHEDULE_RULE_NAME}"
echo "   定时表达式(UTC):     ${SCHEDULE_CRON}"
echo "   采集 Lambda:         ${COLLECTOR_NAME}(每次处理昨天 UTC 整天)"
echo "   数据分区前缀:        s3://${LOGS_BUCKET}/${DAILY_PREFIX}<YYYY-MM-DD>/"
if [[ -n "${LATEST_BACKFILL_DATE}" ]]; then
echo "   已回补最新日:        ${LATEST_BACKFILL_DATE}  ($([[ "${CONTACT_COUNT}" == "?" ]] && echo '拆分处理中' || echo "${CONTACT_COUNT} 个 Contact"))"
fi
echo ""
echo " 资源清单:"
echo "   CloudFront 分配 ID:  ${DIST_ID}"
echo "   日志存储桶:          s3://${LOGS_BUCKET}"
echo "   拆分 Lambda:         ${LAMBDA_NAME}"
echo "   采集 Lambda:         ${COLLECTOR_NAME}"
echo "   Web 存储桶:          s3://${WEB_BUCKET}"
echo "   Cognito 用户池:      ${USER_POOL_ID}"
echo "   Cognito 应用客户端:  ${CLIENT_ID}"
echo "   Cognito 身份池:      ${IDENTITY_POOL_ID}"
echo "   鉴权角色:            ${AUTH_ROLE_ARN}"
echo "   资源清单文件:        ${MANIFEST_FILE}"
echo "-------------------------------------------------------------------"
echo " 页面顶部「日期」控件可切换查看某一天的 Contact 列表(数据按 UTC 日期归档)。"
echo " 手动补采某天(不等定时): "
echo "   aws lambda invoke --function-name ${COLLECTOR_NAME} --region ${REGION} \\"
echo "     --cli-binary-format raw-in-base64-out --payload '{\"date\":\"YYYY-MM-DD\"}' /tmp/out.json"
echo " 删除本次部署的全部资源: ./clear.sh \"${MANIFEST_FILE}\""
echo "==================================================================="

if [[ "${KEEP}" == "true" ]]; then
  echo " 临时产物目录已保留: ${WORK}"
fi

exit 0
