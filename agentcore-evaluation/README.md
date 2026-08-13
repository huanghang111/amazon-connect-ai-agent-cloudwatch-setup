# Connect AI Agent 日志自动评估流水线（AgentCore Evaluation / Insights / Recommendation）

在上一级 [`setup-connect-ai-agent-logs.sh`](../setup-connect-ai-agent-logs.sh) 已经把 Connect AI Agent 日志投递到 CloudWatch 日志组（默认 `/aws/connect/ai-agent-logs`）的基础上，本目录提供**一键部署**的全自动流水线：

```
/aws/connect/ai-agent-logs
        │  ① 定时拉取（默认每天一次，回看 24h）
        ▼
   格式转换（Connect 日志 → OTEL GenAI span/event）
        │  ② 写入 AgentCore Observability
        ▼
/aws/bedrock-agentcore/runtimes/<name>-DEFAULT  +  aws/spans
        │  ③ 自动调用 AgentCore
        ▼
 Evaluation（13 个内置评估器） │ Insights │ Recommendation
        │  ④ 汇总
        ▼
   S3 结果桶（JSON + CSV + PNG 图表 + index.html），客户自行下载
```

| 文件 | 说明 |
|------|------|
| [`deploy.sh`](./deploy.sh) | 一键部署（含自动开启 Transaction Search、构建出图 layer），幂等可重复执行 |
| [`run-now.sh`](./run-now.sh) | 立即手动跑一次，不等定时调度 |
| [`find-connect-log-group.sh`](./find-connect-log-group.sh) | 查出 Connect 日志实际投递到哪个日志组，用于填 `CONNECT_LOG_GROUP` |
| [`undeploy.sh`](./undeploy.sh) | 删除流水线，默认保留结果桶 |
| [`config.env.example`](./config.env.example) | 配置模板，`cp` 成 `config.env` 后按需修改 |
| [`template.yaml`](./template.yaml) | CloudFormation 模板（S3 + DynamoDB + 6 个 Lambda + Step Functions + 定时调度 + 告警）|
| [`src/`](./src) | Lambda 代码，见下方「流水线七步」|

---

## 前置条件

1. **AWS CLI v2**，凭证具备部署权限（CloudFormation / IAM / Lambda / Step Functions / S3 / DynamoDB / Logs / X-Ray / bedrock-agentcore）。
2. **python3**；如需自动出图，还需 `pip`（用于构建 matplotlib Lambda layer，失败会自动降级为只出 JSON/CSV）。
3. 上一级方案已执行，Connect 日志组里**确实有** `TRANSCRIPT_AI_AGENT_TRACE` 事件（可用 [`setup-connect-ai-agent-logs-check.sh`](../setup-connect-ai-agent-logs-check.sh) 体检）。
4. 区域需支持 Amazon Bedrock AgentCore Evaluation。Insights 目前为**公开预览**。

---

## 用法

```bash
cd agentcore-evaluation
cp config.env.example config.env      # 可选：不改也能用默认值
chmod +x deploy.sh run-now.sh undeploy.sh

./deploy.sh                           # 一键部署（会先打印参数并要求确认）
./run-now.sh --hours 48               # 立即回溯 48 小时跑一次，验证端到端
```

部署完成后会打印结果桶与下载命令，例如：

```bash
aws s3 sync s3://connect-agentcore-eval-<account>-<region>/runs ./results
open results/<runId>/index.html
```

### deploy.sh 参数

| 参数 | 说明 |
|------|------|
| `--config <file>` | 指定配置文件（默认 `./config.env`）|
| `--region <region>` / `--stack <name>` / `--bucket <name>` | 覆盖区域 / 栈名 / 结果桶 |
| `--schedule "<cron>"` | 覆盖调度表达式，如 `"cron(0 19 * * ? *)"` |
| `--no-schedule` | 只部署，不启用定时（之后用 `run-now.sh` 手动跑）|
| `--no-charts` | 跳过 matplotlib layer 构建（只出 JSON/CSV）|
| `--yes` / `-y` | 跳过确认 |

### run-now.sh 参数

| 参数 | 说明 |
|------|------|
| `--hours <n>` | 本次回看小时数，覆盖栈默认值（首次回溯建议用它）|
| `--force` | 忽略去重台账，重新评估已评估过的会话（**会重复产生评估费用**）|
| `--no-wait` | 只触发不等待 |

---

## 定时运行

调度由 CloudFormation 里的 `AWS::Scheduler::Schedule`（EventBridge Scheduler）管理，**跟着栈一起创建**，不需要单独操作。默认**每天 03:00 UTC 跑一次、回看 24 小时**。

### 三个参数

| 配置项（`config.env`）| 默认值 | 说明 |
|------|--------|------|
| `SCHEDULE_EXPRESSION` | `cron(0 3 * * ? *)` | 调度表达式，**时区固定为 UTC** |
| `SCHEDULE_ENABLED_CONF` | `true` | `false` 则完全不创建调度资源，只能用 `run-now.sh` 手动跑 |
| `LOOKBACK_HOURS` | `24` | 每次运行回看多少小时。**要和调度频率匹配**，见下 |

表达式支持 `cron(...)` 和 `rate(...)` 两种（EventBridge Scheduler 语法，cron 是 6 字段、含年）：

```bash
SCHEDULE_EXPRESSION="cron(0 3 * * ? *)"      # 每天 03:00 UTC（默认）
SCHEDULE_EXPRESSION="cron(0 19 * * ? *)"     # 每天 19:00 UTC = 北京时间次日 03:00
SCHEDULE_EXPRESSION="cron(0 */6 * * ? *)"    # 每 6 小时一次
SCHEDULE_EXPRESSION="cron(0 4 ? * MON *)"    # 每周一 04:00 UTC
SCHEDULE_EXPRESSION="rate(12 hours)"         # 每 12 小时
```

> **`LOOKBACK_HOURS` 必须 ≥ 调度间隔**，否则两次运行之间会有一段日志谁都不读，形成盲区。改成每 6 小时跑就把 `LOOKBACK_HOURS` 设为 `6`（或更大，重叠不会重复计费，见「定时拉取会不会重/漏？」）。反过来把间隔放大到一周则要设 `LOOKBACK_HOURS="168"`。

### 三种配置方式

优先级：**命令行参数 > 环境变量 > `config.env`**。

```bash
# 方式 1（推荐）：写进 config.env，deploy.sh 每次都读它
SCHEDULE_EXPRESSION="cron(0 19 * * ? *)"
SCHEDULE_ENABLED_CONF="true"
LOOKBACK_HOURS="24"

# 方式 2：命令行临时覆盖
./deploy.sh --schedule "cron(0 19 * * ? *)"
./deploy.sh --no-schedule          # 只部署，不定时

# 方式 3：用另一个配置文件（多环境）
./deploy.sh --config ./config.prod.env
```

> ⚠️ **不要用 `SCHEDULE_ENABLED_CONF=true ./deploy.sh` 这种前置环境变量的写法**——`deploy.sh` 是先解析命令行、再 `source config.env`，所以 `config.env` 里的同名值会把它覆盖掉。要临时改就用 `--schedule` / `--no-schedule`，或换 `--config`。

### 改调度 / 开关调度

都通过重新部署完成，`deploy.sh` 幂等，可反复执行：

```bash
./deploy.sh --schedule "cron(0 19 * * ? *)" --yes   # 改时间
./deploy.sh --no-schedule --yes                     # 关掉定时（删除调度资源）
./deploy.sh --yes                                   # 恢复到 config.env 里的设置
```

也可以不重新部署、只临时暂停（栈下次部署会覆盖回去）：

```bash
aws scheduler update-schedule --name connect-agentcore-eval-daily \
  --region us-east-1 --state DISABLED \
  --schedule-expression "cron(0 3 * * ? *)" --flexible-time-window Mode=OFF \
  --target "$(aws scheduler get-schedule --name connect-agentcore-eval-daily \
              --region us-east-1 --query Target --output json)"
```

### 确认调度生效

```bash
aws scheduler list-schedules --region us-east-1 \
  --query "Schedules[?contains(Name,'connect-agentcore')].{name:Name,state:State}" --output table

# 最近几次自动运行（source 为 schedule 的即定时触发）
aws stepfunctions list-executions \
  --state-machine-arn arn:aws:states:us-east-1:<account>:stateMachine:connect-agentcore-eval-pipeline \
  --region us-east-1 --max-items 10 \
  --query "executions[].{name:name,status:status,start:startDate}" --output table
```

怎么区分定时运行和手动运行：调度传入的是 `{"source": "schedule"}`，不带 runId，所以 Step Functions 的执行名是一串自动生成的 UUID，S3 里的 runId 形如 `20260804T030000Z`（**纯时间戳、无前缀**）；`run-now.sh` 则会显式传 `manual-<时间戳>`，两者一眼可辨。定时运行的回看小时数取栈里的 `LOOKBACK_HOURS`（`run-now.sh --hours` 只影响那一次手动运行）。

失败时 EventBridge Scheduler 的 `RetryPolicy` 会自动重试 2 次。

> ⚠️ 栈里的 `PipelineFailureAlarm` 目前**只进 ALARM 状态、不发通知**（没有配 `AlarmActions`）。要让定时任务坏掉时能收到消息，得自己挂一个 SNS 主题，否则只能靠翻 S3 或 Step Functions 控制台才发现：
>
> ```bash
> TOPIC=$(aws sns create-topic --name connect-agentcore-eval-alerts \
>          --region us-east-1 --query TopicArn --output text)
> aws sns subscribe --topic-arn "$TOPIC" --protocol email \
>          --notification-endpoint you@example.com --region us-east-1
> aws cloudwatch put-metric-alarm --alarm-name connect-agentcore-eval-pipeline-failed \
>          --region us-east-1 --alarm-actions "$TOPIC" \
>          --namespace AWS/States --metric-name ExecutionsFailed \
>          --dimensions Name=StateMachineArn,Value=<StateMachineArn> \
>          --statistic Sum --period 3600 --evaluation-periods 1 \
>          --threshold 1 --comparison-operator GreaterThanOrEqualToThreshold \
>          --treat-missing-data notBreaching
> ```
>
> 注意这是栈外的手工改动，下次 `deploy.sh` 会把告警覆盖回没有通知的状态。

---

## 从零复现一次端到端测试

用一通**新的** Connect 通话验证整条链路。顺序很关键：**日志投递配置不会回溯**，所以先确保投递已就绪，再打电话。

> ⚠️ **先用下面第 0 步确认投递是否已存在，只有查不到时才运行上一级的 `setup-connect-ai-agent-logs.sh`。** 该脚本会把日志投递到**硬编码**的 `/aws/connect/ai-agent-logs`；如果这个 Connect 实例已经有人配过投递（可能是控制台配的，日志组形如 `/aws/connect/wisdom/<assistantId>`，也可能同时投到 S3），再跑一次就会给同一个投递源多加一条投递关系，造成日志重复与双份投递费用。这种情况下直接把已有的日志组填进 `CONNECT_LOG_GROUP` 即可，本流水线读哪个日志组都一样。

```bash
# 0. 确认投递已存在，并直接得到该填进 config.env 的日志组名
./find-connect-log-group.sh --region us-east-1
# 多个 Connect 实例时可收窄：--instance-id <connect-instance-id>
```

输出形如：

```
==> 投递源: connect-assistant-delivery-source
    assistant: arn:aws:wisdom:us-east-1:<acct>:assistant/<assistantId>
    [S3] arn:aws:s3:::connect-ai-agent-logs-<acct>   (本流水线不使用，只读 CloudWatch)
    [CloudWatch] 日志组: /aws/connect/wisdom/<assistantId>
==> 检查日志组近 24 小时是否有 TRANSCRIPT_AI_AGENT_TRACE ...
    有 trace 事件，可以直接跑流水线。

把这一行写进 config.env:
CONNECT_LOG_GROUP="/aws/connect/wisdom/<assistantId>"
```

> 别直接用 `aws logs describe-deliveries`：它会列出账号里**全部**投递关系，而且 `deliveryDestinationArn` 只是投递目标的名字，**不含日志组名**——日志组名要再调一次 `get-delivery-destination`，从 `destinationResourceArn` 里取。上面的脚本按上游同样的锚点（`logType=EVENT_LOGS` + resourceArn 指向 wisdom assistant）筛选，然后把这层解开。注意**不能按名字猜**投递源：本账号的源叫 `connect-assistant-delivery-source`，而上游默认建的名字是 `connect-ai-agent-delivery-source`。

| 步骤 | 做什么 | 验证点 |
|------|--------|--------|
| 1 | 记下当前 UTC 时间：`date -u`（后面用它算 `--hours`）| |
| 2 | 在 Connect 里与 AI Agent 完整对话一次：**要触发工具调用**（问 FAQ、报修等），并让通话**正常结束**（不要中途挂断）| 未触发工具则 `ToolSelectionAccuracy` 无数据；未正常结束则第 1 步按 SETTLED 规则跳过 |
| 3 | 等 2-5 分钟，确认日志已投递：<br>`aws logs tail <CONNECT_LOG_GROUP> --since 10m --region us-east-1 \| grep TRANSCRIPT_AI_AGENT_TRACE \| head` | 必须看到 `TRANSCRIPT_AI_AGENT_TRACE`。只有 `TRANSCRIPT_UTTERANCE` 说明 trace 还没落盘，继续等 |
| 4 | 再等到通话结束满 `SETTLE_MINUTES`（默认 10 分钟），然后跑：<br>`./run-now.sh --hours 2` | **不要加 `--force`**：正常跑一遍就该选中这个新会话；若显示 `already_evaluated` 说明选错了会话 |
| 5 | 下载结果：<br>`aws s3 sync s3://connect-agentcore-eval-<account>-<region>/runs/<runId> ./results/<runId>`<br>`open results/<runId>/index.html` | `summary.json` 里 `sessionsSelected: 1`、评估任务 `COMPLETED`、`failedSessions: 0` |

一次成功的运行大约 8-15 分钟（索引等待 + 13 个评估器 + Insights）。中途失败不用从头来：已转换的会话仍在 `s3://<bucket>/runs/<runId>/sessions/`，直接重跑 `run-now.sh` 即可，去重台账只在**发布成功后**才写。

排查时按步骤看 S3 里对应的 JSON：`collect.json`（选中/跳过原因）→ `ingest.json`（span 数、失败数）→ `eval.json`（任务状态与逐会话错误）。Step Functions 控制台的执行图能直接定位到失败的那个 Lambda。

---

## 流水线七步

Step Functions 状态机按顺序编排以下 Lambda（`src/` 下同名文件）：

| 步骤 | 文件 | 做什么 |
|------|------|--------|
| 1. Collect | `collect.py` | Logs Insights 拉取窗口内的 Connect 日志，按会话转换，选出「已结束、未评估、未超期」的会话写入 S3；同时**完整**抽取系统提示词供第 6 步使用 |
| 2. Ingest | `ingest.py` | span 经 SigV4 签名发往 X-Ray OTLP 端点（`/v1/traces`），event 用 `PutLogEvents` 写入 AgentCore Observability 日志组 |
| 3. WaitIndexed | `wait_indexed.py` | 等待 `aws/spans` 的 span 文档与运行时日志组的事件**都**被 Logs Insights 索引（两者索引时间不同，各用各的查询窗口），必要时以新时间戳重发仍缺失的事件 |
| 4/5. Evaluate / Insights | `evaluate.py` | `StartBatchEvaluation` 并轮询；评估器超过 10 个时自动拆成多个并发任务 |
| 6. Recommend | `recommend.py` | `StartRecommendation`：系统提示词优化 + 工具描述优化（inline `sessionSpans` 形式）|
| 7. Publish | `publish.py` | 读回评估结果事件，出 CSV + 热力图/总览图 + `summary.json` + `index.html`，最后写去重台账 |

第 4/5/6 步在 `Parallel` 状态中**并发**执行（已验证同账号允许多个批量评估任务同时进行）；Insights 与 Recommendation 各自带 `Catch`，单个环节失败不会拖垮整条流水线。

`converter.py` 是从上一级目录参考实现移植过来的转换器，含一处修正：Connect 的 `system_instructions` 是 MESSAGE 对象列表，提示词文本位于 `values[i].text.value`，此前按列表项直接取 `value` 会得到空字符串，导致 `Builtin.InstructionFollowing` 评分失真。

---

## 结果文件

一次运行的产物都在 `s3://<bucket>/runs/<runId>/` 下：

| 路径 | 内容 |
|------|------|
| `index.html` | **从这里看起**：本次运行总览，内嵌图表与结论 |
| `summary.json` | 机器可读总览：窗口、会话数、各评估器均值、跳过的会话、意图/失败模式、任务状态 |
| `eval_scores.csv` | 每条评估的分数、标签与解释（逐会话逐评估器）|
| `charts/eval_overview.png` | 各评估器均值总览图 |
| `charts/eval_scores.png` | 会话 × 评估器 热力图 |
| `recommendation/system_prompt.md` | 推荐的系统提示词 + 理由 |
| `recommendation/tool_description.md` | 推荐的各工具描述 + 理由 |
| `collect.json` / `ingest.json` / `eval.json` / `insights.json` / `recommendation.json` | 各步骤的原始输出，排查时用 |
| `sessions/<sessionId>.json` | 转换后的 sessionSpans（喂给 AgentCore 的原始输入）|
| `system_prompt.txt` | 从日志中抽取的完整系统提示词 |

> 结果桶开启了版本控制与 `DenyInsecureTransport`，栈删除时默认 `Retain`。**日志与结果包含客户真实对话内容，请按内部数据合规要求处置。**

---

## 定时拉取会不会重/漏？

「每天一次、只读 24 小时」听起来刚好，但边界情况会既漏又重。流水线用三条规则兜住：

1. **OVERLAP**：实际窗口是 `LOOKBACK_HOURS + OVERLAP_MINUTES`（默认多读 30 分钟）。跨窗口边界的会话（23:58 接入、00:03 结束），以及窗口关闭时投递还没落盘的最后几分钟，都会被下一次运行捞回来，而不是被静默截断。
2. **SETTLED**：只有「最后一个事件已早于 `SETTLE_MINUTES`（默认 10 分钟）」的会话才评估。否则会对进行中的通话按半截对话打分——那是**错的分数**，比缺失的分数更危险。
3. **LEDGER**：每个已评估的 `sessionId` 记入 DynamoDB 台账（TTL 默认 30 天）。所以第 1 条带来的重叠、以及手动重跑，都不会重复评估、不会重复计费。台账在**发布成功之后**才写，失败的运行下次仍可重试。

另外，超过 **14 天**的会话会被显式跳过并在 `collect.json` 的 `skipped.too_old` 中列出——CloudWatch `PutLogEvents` 拒绝 14 天以前的事件，这类会话在技术上无法再被 AgentCore 发现。


## 成本提示

主要成本项是**评估本身**：`每条 trace × 每个评估器` 各一次 LLM 调用。默认开启全部 13 个内置评估器（不含需要 ground truth 的 `Trajectory*Match`），话务量大时请：

- 用 `EVALUATORS` 只保留关心的几个，例如
  `EVALUATORS="Builtin.Helpfulness,Builtin.GoalSuccessRate,Builtin.ToolSelectionAccuracy"`；
- 用 `INSIGHTS=""` 关掉 Insights；
- 下调 `INDEXING_PERCENTAGE` 控制 Transaction Search 的索引采样成本。

Lambda / Step Functions / DynamoDB / S3 的开销相对可以忽略。

---

## 卸载

```bash
./undeploy.sh                    # 删栈，保留结果桶
./undeploy.sh --delete-results   # 同时清空并删除结果桶（不可恢复）
```

不属于本栈、不会被删除的：上一级创建的 Connect 日志投递配置、账户级的 Transaction Search 设置、`aws/spans` 中已索引的 span（按保留期自然过期）、AgentCore 评估结果日志组。`undeploy.sh` 结束时会把这些连同关闭命令一起打印出来。
