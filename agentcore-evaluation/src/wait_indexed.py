"""Step 3: block until the ingested data is visible to Logs Insights.

Batch evaluation reads BOTH halves of the ingested data through the Logs Insights
index, and each half has its own lag. Starting a job before either one is
queryable fails every session in it, so both are gated here:

Note the two halves are also indexed under DIFFERENT timestamps, so each needs
its own query window: a log event lands at the time PutLogEvents ran, but a span
document lands at the span's own startTimeUnixNano, which for a replayed session
is in the past. ingest.py records that range as `spanTimeRange`.

  * span documents in "aws/spans" (written via the X-Ray OTLP endpoint). If these
    are not indexed yet, the job fails with
        ValidationException: Provided input contains N log event(s) but no span
        documents. Log events alone cannot be evaluated
  * log events in the runtime log group (written via PutLogEvents). If these are
    not indexed yet, the job fails per session with
        LogEventMissingException: Span with ID <id> ... is missing a
        corresponding log event
    The FIRST batch written to a freshly created stream can stay invisible for
    well over 15 minutes even though GetLogEvents returns it immediately
    (recordsScanned: 0.0). Re-writing the identical messages under fresh
    timestamps reliably makes them queryable in ~90s.

So the gate is: poll both indexes -> if the events are still missing when the
budget runs out, re-write them with current timestamps -> let Step Functions
retry -> only start evaluation once both sides are visible.

Failing loudly here is much cheaper than a job that reports 0 completed sessions.
"""

import json
import os
import time

import boto3

from logbatch import put_events

REGION = os.environ.get("AWS_REGION", "us-east-1")
BUCKET = os.environ["RESULTS_BUCKET"]
RUNTIME_NAME = os.environ["OBSERVABILITY_RUNTIME_NAME"]
LOG_GROUP = f"/aws/bedrock-agentcore/runtimes/{RUNTIME_NAME}-DEFAULT"
EVENT_STREAM = "otel-rt-logs"
SPANS_LOG_GROUP = "aws/spans"

POLL_SECONDS = int(os.environ.get("INDEX_POLL_SECONDS", "20"))
# one Lambda invocation stays well inside its own timeout; Step Functions retries
BUDGET_SECONDS = int(os.environ.get("INDEX_BUDGET_SECONDS", "180"))

s3 = boto3.client("s3", region_name=REGION)
logs = boto3.client("logs", region_name=REGION)


def indexed_span_ids(log_group, start_epoch, end_epoch):
    """spanIds visible to Logs Insights in `log_group` over [start, end]."""
    qid = logs.start_query(
        logGroupName=log_group, startTime=start_epoch, endTime=end_epoch,
        queryString="fields spanId | filter ispresent(spanId) | limit 10000",
    )["queryId"]
    while True:
        r = logs.get_query_results(queryId=qid)
        if r["status"] in ("Complete", "Failed", "Cancelled", "Timeout"):
            break
        time.sleep(2)
    if r["status"] != "Complete":
        return set()
    found = set()
    for row in r["results"]:
        for f in row:
            if f["field"] == "spanId":
                found.add(f["value"])
    return found


def rewrite_events(missing):
    """Re-emit only the still-unindexed events under current timestamps.

    This is the documented workaround for the stuck-first-batch case: identical
    message bodies, new timestamps, which reliably become queryable in ~90s.

    Only the spans in `missing` are re-emitted. The stream is shared by every run,
    and a rewrite is itself part of the stream, so re-emitting everything found
    would double the stream on each attempt (and re-send events that are already
    indexed). Deduplicating by spanId keeps a retry the same size as the gap.
    """
    seen, events, token = set(), [], None
    while True:
        kw = {"logGroupName": LOG_GROUP, "logStreamName": EVENT_STREAM,
              "startFromHead": True}
        if token:
            kw["nextToken"] = token
        r = logs.get_log_events(**kw)
        batch = r["events"]
        for e in batch:
            msg = e["message"]
            try:
                span_id = json.loads(msg).get("spanId")
            except (json.JSONDecodeError, AttributeError):
                continue
            if span_id in missing and span_id not in seen:
                seen.add(span_id)
                events.append(msg)
        if not batch or r.get("nextForwardToken") == token:
            break
        token = r["nextForwardToken"]
    if not events:
        return 0
    # event bodies carry whole transcripts, so a gap of any size can exceed the
    # 1 MB PutLogEvents limit; logbatch splits it into legal calls
    base = int(time.time() * 1000)
    sent, oversized = put_events(
        logs, LOG_GROUP, EVENT_STREAM,
        [{"timestamp": base + i, "message": m} for i, m in enumerate(events)])
    if oversized:
        print(f"WARNING: {len(oversized)} event(s) exceed the 256 KB single-event "
              "limit and could not be rewritten")
    return sent


def handler(event, context):
    run_id = event["runId"]
    ingest = json.loads(s3.get_object(
        Bucket=BUCKET, Key=f"runs/{run_id}/ingest.json")["Body"].read())
    wanted = set(ingest.get("spanIds", []))
    attempt = int(event.get("indexAttempt", 0))

    if not wanted:
        return {"runId": run_id, "indexed": True, "missing": 0,
                "note": "no spans ingested"}

    # Two different clocks, so two different query windows (see docstring):
    #   * log events were written by PutLogEvents just now, so they sit at
    #     ingest time
    #   * span documents are indexed by X-Ray under each span's OWN start time,
    #     which for replayed or unshifted sessions is hours or days in the past.
    #     Querying "the last 2 hours" then finds none of them and the gate fails
    #     with every span missing even though all of them arrived.
    rng = ingest.get("spanTimeRange") or {}
    ingested_at = rng.get("ingestedAtEpoch") or int(time.time())
    span_start = min(rng.get("startEpoch") or ingested_at, ingested_at) - 600
    event_start = ingested_at - 600

    deadline = time.time() + BUDGET_SECONDS
    missing_events, missing_spans = wanted, wanted
    while time.time() < deadline:
        now = int(time.time())
        # both sides must be queryable; see module docstring for each failure mode
        missing_events = wanted - indexed_span_ids(LOG_GROUP, event_start, now + 600)
        missing_spans = wanted - indexed_span_ids(SPANS_LOG_GROUP, span_start, now + 600)
        if not missing_events and not missing_spans:
            print(f"all {len(wanted)} spans indexed in both {SPANS_LOG_GROUP} "
                  f"and {LOG_GROUP}")
            return {"runId": run_id, "indexed": True, "missing": 0,
                    "indexAttempt": attempt}
        print(f"waiting to index: {len(missing_spans)}/{len(wanted)} span "
              f"documents, {len(missing_events)}/{len(wanted)} log events")
        time.sleep(POLL_SECONDS)

    # Only the PutLogEvents side can be nudged by rewriting; span documents are
    # owned by X-Ray, so for those the only option is to wait and retry.
    rewritten = rewrite_events(missing_events) if missing_events else 0
    print(f"index budget exhausted on attempt {attempt}; "
          f"{len(missing_spans)} span documents and {len(missing_events)} log "
          f"events still missing; rewrote {rewritten} events")
    return {"runId": run_id, "indexed": False,
            "missing": len(missing_events | missing_spans),
            "missingSpanDocuments": len(missing_spans),
            "missingLogEvents": len(missing_events),
            "indexAttempt": attempt + 1, "rewrittenEvents": rewritten}
