"""Step 1: collect finished Connect AI Agent sessions from CloudWatch Logs.

Reads the Connect delivery log group (default /aws/connect/ai-agent-logs) over a
lookback window, converts each session with converter.py, and hands the ones that
are ready for evaluation to the next step.

Three correctness rules make a daily 24h schedule safe to run unattended:

  1. OVERLAP  - the window is (hours + OVERLAP_MINUTES) wide, so a session that
                straddles midnight, or whose last events were still being
                delivered when the previous run's window closed, is picked up by
                the next run instead of being silently truncated or lost.
  2. SETTLED  - a session is only evaluated once its newest event is older than
                SETTLE_MINUTES. An in-flight call would otherwise be scored on
                half a transcript, which produces a wrong score, not a missing one.
  3. LEDGER   - every evaluated sessionId is recorded in DynamoDB with a TTL.
                Overlap and manual re-runs therefore cost nothing: already-done
                sessions are skipped. Set FORCE=true to re-evaluate anyway.

Output (to S3, so later steps and the customer both read the same artifacts):
  runs/<runId>/sessions/<sessionId>.json   converted sessionSpans
  runs/<runId>/collect.json                manifest consumed by the next step
"""

import json
import os
import time

import boto3

from converter import (convert, eval_session_id, parse_span_field,
                       system_prompt_text, _fix_newlines, _DECODER)

REGION = os.environ.get("AWS_REGION", "us-east-1")
BUCKET = os.environ["RESULTS_BUCKET"]
LEDGER_TABLE = os.environ["LEDGER_TABLE"]
CONNECT_LOG_GROUP = os.environ.get("CONNECT_LOG_GROUP", "/aws/connect/ai-agent-logs")

# window widening / readiness thresholds (see module docstring)
OVERLAP_MINUTES = int(os.environ.get("OVERLAP_MINUTES", "30"))
SETTLE_MINUTES = int(os.environ.get("SETTLE_MINUTES", "10"))
# put_log_events rejects events older than 14 days. Raising this is only safe
# because ingest.py shifts such sessions forward into the window (SHIFT_TIMESTAMPS);
# with shifting off, anything over 14 days can never be ingested. Useful for
# backfilling or for validating a deployment against archived logs.
MAX_AGE_DAYS = int(os.environ.get("MAX_AGE_DAYS", "14"))
LEDGER_TTL_DAYS = int(os.environ.get("LEDGER_TTL_DAYS", "30"))
QUERY_LIMIT = int(os.environ.get("QUERY_LIMIT", "10000"))

logs = boto3.client("logs", region_name=REGION)
s3 = boto3.client("s3", region_name=REGION)
ddb = boto3.client("dynamodb", region_name=REGION)

QUERY = """fields @message
| filter event_type in ["TRANSCRIPT_AI_AGENT_TRACE", "TRANSCRIPT_CREATE_SESSION"]
| sort @timestamp asc
| limit {limit}"""


def run_query(start, end):
    """Pull raw Connect AI Agent log messages via Logs Insights."""
    qid = logs.start_query(logGroupName=CONNECT_LOG_GROUP, startTime=start,
                           endTime=end,
                           queryString=QUERY.format(limit=QUERY_LIMIT))["queryId"]
    while True:
        r = logs.get_query_results(queryId=qid)
        if r["status"] in ("Complete", "Failed", "Cancelled", "Timeout"):
            break
        time.sleep(2)
    if r["status"] != "Complete":
        raise RuntimeError(f"Logs Insights query {r['status']} for {CONNECT_LOG_GROUP}")
    out = []
    for row in r["results"]:
        for f in row:
            if f["field"] == "@message":
                try:
                    out.append(_DECODER.decode(_fix_newlines(f["value"])))
                except json.JSONDecodeError:
                    pass  # a truncated record must not abort the whole run
    return out, r["statistics"]


def already_evaluated(session_id):
    r = ddb.get_item(TableName=LEDGER_TABLE,
                     Key={"sessionId": {"S": session_id}},
                     ConsistentRead=True)
    return "Item" in r


def session_end_ns(spans):
    return max((s.get("endTimeUnixNano") or s.get("timeUnixNano") or 0)
               for s in spans)


def longest_system_prompt(records):
    """The full system prompt, taken from the raw records.

    It cannot be read back from the converted spans: converter.py truncates the
    system message to 4000 chars for the event body, which cuts off the
    <tools><toolConfigurationList> section that tool-description recommendation
    needs. So it is captured here, at full length, and stored alongside the run.
    """
    best = ""
    for r in records:
        if r.get("event_type") != "TRANSCRIPT_AI_AGENT_TRACE":
            continue
        txt = system_prompt_text(parse_span_field(r.get("span", "{}"))
                                 .get("system_instructions"))
        if len(txt) > len(best):
            best = txt
    return best


def handler(event, context):
    # the scheduler sends no runId; derive a sortable one so every run has a prefix
    run_id = event.get("runId") or time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    hours = int(event.get("hours") or os.environ.get("LOOKBACK_HOURS", "24"))
    force = str(event.get("force", os.environ.get("FORCE", "false"))).lower() == "true"

    now = int(time.time())
    # rule 1: widen the window backwards so nothing falls between two runs
    start = now - hours * 3600 - OVERLAP_MINUTES * 60
    records, stats = run_query(start, now)
    # salt the derived span ids with the runId: the runtime log group is shared
    # across runs, and a repeated spanId lets batch evaluation read a previous
    # run's event instead of this one's (see converter.build_session_spans)
    sessions = convert(records, salt=run_id)

    settle_ns = (now - SETTLE_MINUTES * 60) * 1_000_000_000
    oldest_ns = (now - MAX_AGE_DAYS * 86400) * 1_000_000_000

    selected, skipped = [], {"unsettled": [], "already_evaluated": [], "too_old": []}
    for sid, spans in sessions.items():
        end_ns = session_end_ns(spans)
        if end_ns > settle_ns:                        # rule 2: still in flight
            skipped["unsettled"].append(sid)
            continue
        if end_ns < oldest_ns:                        # cannot be ingested at all
            skipped["too_old"].append(sid)
            continue
        if not force and already_evaluated(sid):      # rule 3: seen before
            skipped["already_evaluated"].append(sid)
            continue
        key = f"runs/{run_id}/sessions/{sid}.json"
        s3.put_object(Bucket=BUCKET, Key=key,
                      Body=json.dumps(spans, ensure_ascii=False).encode(),
                      ContentType="application/json")
        selected.append({"sessionId": sid,
                         # what the spans actually carry, and therefore what the
                         # evaluation job must filter on
                         "evalSessionId": eval_session_id(sid, run_id),
                         "key": key, "items": len(spans),
                         "endTimeUnixNano": end_ns})

    # captured at full length for the Recommendation step
    system_prompt = longest_system_prompt(records)
    if system_prompt:
        s3.put_object(Bucket=BUCKET, Key=f"runs/{run_id}/system_prompt.txt",
                      Body=system_prompt.encode(), ContentType="text/plain")

    manifest = {
        "runId": run_id,
        "region": REGION,
        "connectLogGroup": CONNECT_LOG_GROUP,
        "systemPromptChars": len(system_prompt),
        "systemPromptKey": f"runs/{run_id}/system_prompt.txt" if system_prompt else None,
        "window": {"startEpoch": start, "endEpoch": now, "hours": hours,
                   "overlapMinutes": OVERLAP_MINUTES},
        "recordsScanned": stats.get("recordsScanned"),
        "sessionsFound": len(sessions),
        "sessionsSelected": len(selected),
        "sessions": selected,
        "skipped": {k: {"count": len(v), "sessionIds": v} for k, v in skipped.items()},
        "queryLimitHit": len(records) >= QUERY_LIMIT,
    }
    s3.put_object(Bucket=BUCKET, Key=f"runs/{run_id}/collect.json",
                  Body=json.dumps(manifest, ensure_ascii=False, indent=1).encode(),
                  ContentType="application/json")

    # never let a truncated query masquerade as "nothing more to evaluate"
    if manifest["queryLimitHit"]:
        print(f"WARNING: hit QUERY_LIMIT={QUERY_LIMIT}; older events in the window "
              "were not read. Raise QUERY_LIMIT or shorten LOOKBACK_HOURS.")
    print(json.dumps({k: v for k, v in manifest.items() if k != "sessions"}))

    return {"runId": run_id,
            "sessionCount": len(selected),
            "sessionIds": [s["sessionId"] for s in selected],
            "manifestKey": f"runs/{run_id}/collect.json",
            "ledgerTtlDays": LEDGER_TTL_DAYS}
