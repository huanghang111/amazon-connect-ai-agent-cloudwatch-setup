#!/usr/bin/env python3
"""
collector.py — 定时(EventBridge)触发的 Lambda: 归档"某一天(UTC)整天"的 CloudWatch
日志到日志桶的按日期分区前缀，并写触发对象让拆分 Lambda(handler.py)在云端解析。

设计背景:
  setup-connect-ai-agent-logs-analysis-in-cloudfront.sh 是"一次性"部署: 在本地用
  fetch-to-s3.py 拉全部/最近 N 小时日志到 raw/，再触发拆分 Lambda 写 index.json。
  本函数把"拉取"这一步搬到云端并按天运行:

  触发方式:
    - EventBridge 定时规则(默认每天 01:00 UTC)按 cron 触发，无 payload -> 处理"昨天(UTC)"。
    - 也可手动带 payload 触发指定某天:  {"date": "2026-08-13"}  (处理该 UTC 日 00:00~次日 00:00)

  处理逻辑(全部在云端，本地不落文件):
    1) 计算目标日期的 UTC 起止毫秒 [00:00:00, 次日00:00:00);
    2) 用 CloudWatch Logs filter-log-events 分页拉取该时间窗内的全部事件，
       以 NDJSON(每行 {timestamp, message})流式(分片 multipart)上传到:
         s3://<LOGS_BUCKET>/<DAILY_PREFIX><date>/raw/connect.ndjson
       (可选)Gateway 日志同理写到 .../raw/gateway.ndjson;
    3) 写触发对象到 s3://<LOGS_BUCKET>/trigger/daily-<date>.json，内容形如
         {"connect":"daily/<date>/raw/connect.ndjson",
          "gateway":"daily/<date>/raw/gateway.ndjson",   # 仅当配置了 Gateway
          "prefix":"daily/<date>/"}
       该对象命中日志桶已有的 S3 事件通知(trigger/ 前缀 + .json 后缀)，触发拆分
       Lambda(handler.py)按 Contact 拆分并把 index.json / logs/*.log 写到同一个
       按日期分区的 prefix 下。前端据此按天加载对应的 Contact 列表。

环境变量:
  LOGS_BUCKET        必填  日志桶名(ai-agent-logs<suffix>)
  CONNECT_REGION     必填  Connect AI Agent 日志组所在区域
  CONNECT_LOG_GROUP  必填  Connect AI Agent 日志组名
  GATEWAY_REGION     选填  Gateway 日志组区域(缺省用 CONNECT_REGION)
  GATEWAY_LOG_GROUP  选填  Gateway 日志组名(为空则跳过 Gateway)
  DAILY_PREFIX       选填  按日期分区的根前缀，默认 "daily/"

依赖: Lambda 运行时自带 boto3。
"""
import datetime
import json
import os
import re

import boto3
from botocore.config import Config

# 上传分片大小(≥5MB 才能作为 multipart 的非末尾分片;这里用 8MB 兼顾内存与调用次数)
PART_SIZE = 8 * 1024 * 1024

_s3_cfg = Config(retries={"max_attempts": 5, "mode": "adaptive"})
s3 = boto3.client("s3", config=_s3_cfg)

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class _MultipartWriter:
    """把逐行 bytes 以 S3 multipart 流式上传(内存占用受单个分片大小约束)。

    小数据(< 一个分片)时退化为一次 put_object，避免 multipart 的额外往返。
    """

    def __init__(self, bucket, key):
        self.bucket = bucket
        self.key = key
        self.buf = bytearray()
        self.parts = []
        self.upload_id = None
        self.part_no = 0

    def _ensure_upload(self):
        if self.upload_id is None:
            resp = s3.create_multipart_upload(
                Bucket=self.bucket, Key=self.key,
                ContentType="text/plain; charset=utf-8")
            self.upload_id = resp["UploadId"]

    def _flush_part(self, size):
        self._ensure_upload()
        chunk = bytes(self.buf[:size])
        del self.buf[:size]
        self.part_no += 1
        resp = s3.upload_part(Bucket=self.bucket, Key=self.key,
                              PartNumber=self.part_no,
                              UploadId=self.upload_id, Body=chunk)
        self.parts.append({"ETag": resp["ETag"], "PartNumber": self.part_no})

    def write(self, data):
        self.buf.extend(data)
        while len(self.buf) >= PART_SIZE:
            self._flush_part(PART_SIZE)

    def close(self):
        # 未触发过 multipart(数据很小)-> 单次 put_object(允许空对象)
        if self.upload_id is None:
            s3.put_object(Bucket=self.bucket, Key=self.key,
                          Body=bytes(self.buf),
                          ContentType="text/plain; charset=utf-8")
            return
        if len(self.buf) > 0:
            self._flush_part(len(self.buf))  # 末尾分片可 < 5MB
        s3.complete_multipart_upload(
            Bucket=self.bucket, Key=self.key, UploadId=self.upload_id,
            MultipartUpload={"Parts": self.parts})

    def abort(self):
        if self.upload_id is not None:
            try:
                s3.abort_multipart_upload(Bucket=self.bucket, Key=self.key,
                                          UploadId=self.upload_id)
            except Exception:  # noqa: BLE001
                pass


def _yesterday_utc():
    d = datetime.datetime.now(datetime.timezone.utc).date() - datetime.timedelta(days=1)
    return d.isoformat()


def _day_bounds_ms(date_str):
    """返回该 UTC 日的 [00:00:00, 次日00:00:00) 的 epoch 毫秒。"""
    day = datetime.datetime.strptime(date_str, "%Y-%m-%d").replace(
        tzinfo=datetime.timezone.utc)
    start = int(day.timestamp() * 1000)
    end = int((day + datetime.timedelta(days=1)).timestamp() * 1000)
    return start, end


def _archive_log_group(region, log_group, bucket, key, start_ms, end_ms):
    """把某日志组在 [start_ms, end_ms) 内的事件以 NDJSON 流式归档到 s3://bucket/key。

    返回归档的事件条数。始终会写出对象(即使 0 条，也生成空对象，便于拆分 Lambda 处理)。
    """
    logs = boto3.client("logs", region_name=region, config=_s3_cfg)
    writer = _MultipartWriter(bucket, key)
    count = 0
    try:
        paginator = logs.get_paginator("filter_log_events")
        for page in paginator.paginate(
                logGroupName=log_group,
                startTime=start_ms, endTime=end_ms):
            for ev in page.get("events", []):
                ts, msg = ev.get("timestamp"), ev.get("message")
                if ts is None or msg is None:
                    continue
                line = json.dumps({"timestamp": ts, "message": msg},
                                  ensure_ascii=False) + "\n"
                writer.write(line.encode("utf-8"))
                count += 1
        writer.close()
    except Exception:
        writer.abort()
        raise
    print("archived %d events from %s (%s) -> s3://%s/%s"
          % (count, log_group, region, bucket, key))
    return count


def handler(event, context):
    event = event or {}
    bucket = os.environ["LOGS_BUCKET"]
    daily_prefix = os.environ.get("DAILY_PREFIX", "daily/")
    connect_region = os.environ["CONNECT_REGION"]
    connect_lg = os.environ["CONNECT_LOG_GROUP"]
    gateway_lg = os.environ.get("GATEWAY_LOG_GROUP", "").strip()
    gateway_region = os.environ.get("GATEWAY_REGION", "").strip() or connect_region

    date_str = str(event.get("date") or "").strip() or _yesterday_utc()
    if not _DATE_RE.match(date_str):
        raise ValueError("date 参数格式应为 YYYY-MM-DD: %r" % date_str)

    start_ms, end_ms = _day_bounds_ms(date_str)
    prefix = "%s%s/" % (daily_prefix, date_str)
    print("collecting UTC day %s [%d, %d) -> prefix %s"
          % (date_str, start_ms, end_ms, prefix))

    connect_key = prefix + "raw/connect.ndjson"
    connect_count = _archive_log_group(connect_region, connect_lg, bucket,
                                       connect_key, start_ms, end_ms)

    trig = {"connect": connect_key, "prefix": prefix}
    gateway_count = 0
    if gateway_lg:
        gateway_key = prefix + "raw/gateway.ndjson"
        gateway_count = _archive_log_group(gateway_region, gateway_lg, bucket,
                                           gateway_key, start_ms, end_ms)
        trig["gateway"] = gateway_key

    # 写触发对象 -> 命中日志桶已有的 S3 事件通知 -> 触发拆分 Lambda(handler.py)
    s3.put_object(Bucket=bucket, Key="trigger/daily-%s.json" % date_str,
                  Body=json.dumps(trig, ensure_ascii=False).encode("utf-8"),
                  ContentType="application/json")
    print("wrote trigger for %s (connect=%d gateway=%d)"
          % (date_str, connect_count, gateway_count))

    return {"date": date_str, "prefix": prefix,
            "connectEvents": connect_count, "gatewayEvents": gateway_count}
