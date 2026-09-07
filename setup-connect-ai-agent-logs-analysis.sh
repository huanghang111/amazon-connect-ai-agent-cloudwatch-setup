#!/usr/bin/env bash
#
# setup-connect-ai-agent-logs-analysis.sh
#
# 用途:
#   只从「已有日志文件」构建 Amazon Connect AI Agent 日志排查页面(不连 CloudWatch)。
#   输入可以是单个日志文件，也可以是一个目录(加载该目录下的所有日志文件);
#   两者都支持本地路径与 S3 地址(s3://...)。
#   解析后按 Contact ID 关联成可视化时间线，生成静态站点并本地预览。
#
# 用法:
#   ./setup-connect-ai-agent-logs-analysis.sh <日志文件|日志目录> [选项]
#   ./setup-connect-ai-agent-logs-analysis.sh --input <日志文件|日志目录> [选项]
#
# 输入形式(4 种):
#   本地文件      ./contact-xxxx-logs.csv
#   本地目录      ./cloudwatch-logs-20260707-021617        (递归加载目录下所有日志文件)
#   S3 文件       s3://my-bucket/logs/contact-xxxx-logs.csv
#   S3 目录       s3://my-bucket/logs/                     (递归下载该前缀下所有日志文件)
#
# 选项:
#   --input <path>     同位置参数; 日志文件或目录(本地或 s3://)
#   --gateway <path>   额外的 Bedrock AgentCore Gateway 日志(文件或目录, 本地或 s3://),
#                      用于跨源关联; 不给则只展示 Connect 一路。
#   --region <r>       访问 S3 时使用的区域(可选)
#   --profile <p>      访问 S3 时使用的 AWS CLI profile(可选)
#   --out-dir <dir>    站点构建输出目录，默认 ./dist
#   --no-serve         只构建，不启动本地预览
#   --port <n>         本地预览端口，默认 8080
#   -h, --help         显示帮助
#
# 支持的日志格式(按内容自动识别, 目录模式下按扩展名筛选 .csv/.json/.log/.jsonl/.txt/.gz):
#   - 页面「下载 CSV」导出的多列 CSV(timestamp_ms,datetime,source,event_type,message,...)
#   - 简单两列 CSV(timestamp,message)
#   - aws logs filter-log-events 的 JSON
#   - load-cloudwatch-logs.sh 生成的 events.log / events.json
#   - 上述格式的 .gz 压缩文件
#   文件名中含 gateway / agentcore 的按 Gateway 日志处理; CSV 若带 source 列则以该列为准。
#
# 依赖: python3；输入为 s3:// 时还需 aws cli v2(已配置凭证)。
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/lib"
WEB_DIR="${LIB_DIR}/web"
PARSER="${LIB_DIR}/parse-connect-ai-logs.py"

# ---------------------------------------------------------------------------
# 默认值
# ---------------------------------------------------------------------------
INPUT=""
GATEWAY_INPUT=""
REGION=""
PROFILE=""
OUT_DIR="${SCRIPT_DIR}/dist"
SERVE="true"
PORT="8080"

usage() { sed -n '3,41p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

# ---------------------------------------------------------------------------
# 解析参数(位置参数等价于 --input)
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --input|--log-file|--file|--dir)  INPUT="$2"; shift 2;;
    --gateway|--gateway-file)         GATEWAY_INPUT="$2"; shift 2;;
    --region)   REGION="$2"; shift 2;;
    --profile)  PROFILE="$2"; shift 2;;
    --out-dir)  OUT_DIR="$2"; shift 2;;
    --no-serve) SERVE="false"; shift;;
    --port)     PORT="$2"; shift 2;;
    -h|--help)  usage; exit 0;;
    -*) echo "未知参数: $1" >&2; usage; exit 1;;
    *)  if [[ -z "${INPUT}" ]]; then INPUT="$1"; shift
        else echo "多余的位置参数: $1(如需第二路日志请用 --gateway)" >&2; exit 1; fi;;
  esac
done

# ---------------------------------------------------------------------------
# 依赖检查(aws CLI 仅在输入是 s3:// 时才需要)
# ---------------------------------------------------------------------------
if ! command -v python3 >/dev/null 2>&1; then
  echo "错误: 未找到 python3。" >&2; exit 1
fi
if [[ ! -f "${PARSER}" ]]; then
  echo "错误: 找不到解析脚本 ${PARSER}" >&2; exit 1
fi

# 未给输入时交互式询问
if [[ -z "${INPUT}" ]]; then
  echo "请输入日志文件或日志目录(本地路径或 s3:// 地址)。"
  echo "  单个文件: ./contact-xxxx-logs.csv   或  s3://my-bucket/logs/contact-xxxx-logs.csv"
  echo "  整个目录: ./cloudwatch-logs-2026    或  s3://my-bucket/logs/"
  printf "日志文件/目录: "
  read -r INPUT
  if [[ -z "${INPUT}" ]]; then
    echo "错误: 未提供日志文件或目录。" >&2; exit 1
  fi
fi

AWS_ARGS=()
[[ -n "${REGION}" ]]  && AWS_ARGS+=(--region "${REGION}")
[[ -n "${PROFILE}" ]] && AWS_ARGS+=(--profile "${PROFILE}")
# 注意: bash 3.2(macOS 自带) + set -u 下，展开空数组会报 unbound variable，
# 所以用 ${arr[@]+"${arr[@]}"} 的写法兼容 --region/--profile 都没给的情况。
awscli() { aws ${AWS_ARGS[@]+"${AWS_ARGS[@]}"} "$@"; }

need_aws() {
  if ! command -v aws >/dev/null 2>&1; then
    echo "错误: 输入是 S3 地址($1)，需要 aws CLI(已配置凭证)。" >&2
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# 1. 准备站点构建目录
# ---------------------------------------------------------------------------
echo "==> 准备站点构建目录: ${OUT_DIR}"
mkdir -p "${OUT_DIR}"
cp "${WEB_DIR}/index.html" "${OUT_DIR}/"
cp "${WEB_DIR}/app.js" "${OUT_DIR}/"
cp "${WEB_DIR}/i18n.js" "${OUT_DIR}/"
cp "${WEB_DIR}/site-config.js" "${OUT_DIR}/"
# 可选的 Amazon Connect 补充数据; 不存在则生成空桩, 避免页面 404
if [[ -f "${WEB_DIR}/connect-enrich.js" ]]; then
  cp "${WEB_DIR}/connect-enrich.js" "${OUT_DIR}/"
elif [[ ! -f "${OUT_DIR}/connect-enrich.js" ]]; then
  echo "window.__CONNECT_CONTACT_ENRICH__ = {};" > "${OUT_DIR}/connect-enrich.js"
fi

# S3 下载暂存目录(每次运行重建，避免残留上次的日志)
STAGE_DIR="${OUT_DIR}/_input"
rm -rf "${STAGE_DIR}"

# ---------------------------------------------------------------------------
# 2. 把输入(本地/S3, 文件/目录)解析成一批本地日志文件
# ---------------------------------------------------------------------------

# 从 s3:// 地址下载到暂存目录, 回显本地文件或目录路径
s3_fetch() {
  local url="$1" tag="$2"
  need_aws "${url}"
  local rest="${url#s3://}" bucket key
  bucket="${rest%%/*}"
  key="${rest#*/}"
  [[ "${key}" == "${bucket}" ]] && key=""      # s3://bucket 形式(整桶)
  if [[ -z "${bucket}" ]]; then
    echo "错误: S3 地址不合法: ${url}" >&2; exit 1
  fi

  local dest="${STAGE_DIR}/${tag}"
  mkdir -p "${dest}"

  # 以 / 结尾, 或 head-object 不存在 -> 当作前缀(目录)整体同步
  if [[ -n "${key}" && "${url}" != */ ]] \
     && awscli s3api head-object --bucket "${bucket}" --key "${key}" >/dev/null 2>&1; then
    local base
    base="$(basename "${key}")"
    echo "==> 下载 S3 文件: ${url}" >&2
    awscli s3 cp "${url}" "${dest}/${base}" >/dev/null
    printf '%s' "${dest}/${base}"
  else
    local prefix="s3://${bucket}/${key}"
    [[ -n "${key}" ]] && prefix="s3://${bucket}/${key%/}/"
    echo "==> 同步 S3 目录: ${prefix}" >&2
    awscli s3 sync "${prefix}" "${dest}" >/dev/null
    if [[ -z "$(find "${dest}" -type f -print -quit 2>/dev/null)" ]]; then
      echo "错误: S3 目录下没有对象: ${prefix}" >&2
      echo "      若这是单个对象, 请去掉结尾的 /; 若是前缀, 请确认前缀与权限。" >&2
      exit 1
    fi
    printf '%s' "${dest}"
  fi
}

# 把输入解析成本地路径(S3 先下载; 本地路径支持相对当前目录或相对脚本目录)
resolve_input() {
  local p="$1" tag="$2"
  if [[ "${p}" == s3://* ]]; then
    s3_fetch "${p}" "${tag}"
    return
  fi
  if [[ -e "${p}" ]]; then
    printf '%s' "${p}"
  elif [[ -e "${SCRIPT_DIR}/${p}" ]]; then
    printf '%s' "${SCRIPT_DIR}/${p}"
  else
    echo "错误: 找不到日志文件或目录: ${p}" >&2
    echo "      支持本地文件/目录(相对当前目录或脚本目录)与 s3:// 地址。" >&2
    exit 1
  fi
}

# 收集日志文件: 单个文件原样返回; 目录则递归筛选常见日志扩展名。以 NUL 分隔输出
collect_files() {
  local p="$1"
  if [[ -f "${p}" ]]; then
    printf '%s\0' "${p}"
  elif [[ -d "${p}" ]]; then
    find "${p}" -type f \
      \( -iname '*.csv' -o -iname '*.json' -o -iname '*.jsonl' \
         -o -iname '*.log' -o -iname '*.txt' -o -iname '*.gz' \) \
      ! -name '.*' -print0
  else
    echo "错误: 既不是文件也不是目录: ${p}" >&2
    exit 1
  fi
}

CONNECT_FILES=()
GATEWAY_FILES=()

RESOLVED_INPUT="$(resolve_input "${INPUT}" "main")"
if [[ -d "${RESOLVED_INPUT}" ]]; then
  echo "==> 加载日志目录: ${RESOLVED_INPUT}"
else
  echo "==> 加载日志文件: ${RESOLVED_INPUT}"
fi
while IFS= read -r -d '' f; do
  # 文件名带 gateway / agentcore 的按 Gateway 日志处理(CSV 的 source 列优先级更高)
  if [[ "$(basename "${f}" | tr '[:upper:]' '[:lower:]')" == *gateway* \
        || "$(basename "${f}" | tr '[:upper:]' '[:lower:]')" == *agentcore* ]]; then
    GATEWAY_FILES+=("${f}")
  else
    CONNECT_FILES+=("${f}")
  fi
done < <(collect_files "${RESOLVED_INPUT}")

if [[ -n "${GATEWAY_INPUT}" ]]; then
  RESOLVED_GW="$(resolve_input "${GATEWAY_INPUT}" "gateway")"
  echo "==> 加载 Gateway 日志: ${RESOLVED_GW}"
  while IFS= read -r -d '' f; do
    GATEWAY_FILES+=("${f}")
  done < <(collect_files "${RESOLVED_GW}")
fi

if [[ ${#CONNECT_FILES[@]} -eq 0 && ${#GATEWAY_FILES[@]} -eq 0 ]]; then
  echo "错误: 在 ${RESOLVED_INPUT} 下没有找到日志文件。" >&2
  echo "      目录模式只收集 .csv / .json / .jsonl / .log / .txt / .gz 文件。" >&2
  exit 1
fi
echo "    Connect 日志 ${#CONNECT_FILES[@]} 个, Gateway 日志 ${#GATEWAY_FILES[@]} 个"

# 只有 Gateway 文件时也要让解析器跑起来(--connect 为必填, 这里把它们一起传进去)
if [[ ${#CONNECT_FILES[@]} -eq 0 ]]; then
  CONNECT_FILES=("${GATEWAY_FILES[@]}")
  GATEWAY_FILES=()
fi

# ---------------------------------------------------------------------------
# 3. 解析 -> data.js
# ---------------------------------------------------------------------------
echo "==> 解析日志 -> data.js"
PARSER_ARGS=(--connect "${CONNECT_FILES[@]}")
if [[ ${#GATEWAY_FILES[@]} -gt 0 ]]; then
  PARSER_ARGS+=(--gateway "${GATEWAY_FILES[@]}")
fi
python3 "${PARSER}" "${PARSER_ARGS[@]}" --out "${OUT_DIR}/data.js"

echo "==> 站点已构建到: ${OUT_DIR}"

# 统计解析出的事件数，为 0 时给出提示
DATA_COUNT="$(python3 -c "import json,sys,re; t=open(sys.argv[1],encoding='utf-8').read(); m=re.search(r'=\s*(\[.*\]);\s*$', t, re.S); print(len(json.loads(m.group(1))) if m else 0)" "${OUT_DIR}/data.js" 2>/dev/null || echo 0)"
if [[ "${DATA_COUNT}" == "0" ]]; then
  echo ""
  echo "⚠️  提示: 未从输入解析出任何事件，页面会是空的。"
  echo "    请确认输入是页面导出的 CSV、filter-log-events 的 JSON，"
  echo "    或 load-cloudwatch-logs.sh 生成的 events.log / events.json。"
  echo ""
else
  echo "    共 ${DATA_COUNT} 条事件"
fi

# ---------------------------------------------------------------------------
# 4. 本地预览
# ---------------------------------------------------------------------------
if [[ "${SERVE}" == "true" ]]; then
  # 端口被占用时自动向后探测一个空闲端口，避免直接崩溃
  port_in_use() {
    if command -v lsof >/dev/null 2>&1; then
      lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
    else
      python3 -c "import socket,sys; s=socket.socket(); r=s.connect_ex(('127.0.0.1',int(sys.argv[1]))); s.close(); sys.exit(0 if r==0 else 1)" "$1"
    fi
  }

  TRY_PORT="${PORT}"
  ATTEMPTS=0
  while port_in_use "${TRY_PORT}" && [[ ${ATTEMPTS} -lt 20 ]]; do
    echo "    端口 ${TRY_PORT} 已被占用，尝试 $((TRY_PORT + 1)) ..."
    TRY_PORT=$((TRY_PORT + 1))
    ATTEMPTS=$((ATTEMPTS + 1))
  done

  if port_in_use "${TRY_PORT}"; then
    echo "错误: 未能在 ${PORT}~${TRY_PORT} 找到空闲端口。" >&2
    echo "      请用 --port 指定其它端口，或释放被占用的端口。" >&2
    exit 1
  fi

  echo ""
  echo "==> 启动本地预览服务器: http://localhost:${TRY_PORT}"
  echo "    (通过 lib/serve.py 提供静态站点 + /api 接口: 按需翻译、DescribeContact 实时查询)"
  echo "    按 Ctrl+C 退出。"
  SERVE_PY="${LIB_DIR}/serve.py"
  if [[ -f "${SERVE_PY}" ]]; then
    # serve.py 会在缺少 aws CLI / 凭证时自动降级(隐藏对应功能)，可安全启动
    exec python3 "${SERVE_PY}" --dir "${OUT_DIR}" --port "${TRY_PORT}"
  else
    # 兜底: 纯静态预览(无 /api 接口，翻译与 DescribeContact 实时查询不可用)
    cd "${OUT_DIR}"
    exec python3 -m http.server "${TRY_PORT}"
  fi
else
  echo ""
  echo "==================================================================="
  echo "构建完成！本地预览方式(推荐, 含 /api 接口: 翻译 + DescribeContact 实时查询):"
  echo "  python3 \"${LIB_DIR}/serve.py\" --dir \"${OUT_DIR}\" --port ${PORT}"
  echo "或纯静态预览(无 /api 接口):"
  echo "  cd \"${OUT_DIR}\" && python3 -m http.server ${PORT}"
  echo "  然后浏览器访问 http://localhost:${PORT}"
  echo "==================================================================="
fi
