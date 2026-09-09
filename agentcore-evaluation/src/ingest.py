"""Step 2: write converted sessions into AgentCore Observability.

AgentCore batch evaluation does not read arbitrary log groups. It discovers
sessions through the X-Ray / Transaction Search indexed path and then re-reads
the matching log events from the runtime log group. Both halves must be present
or the job fails per session with LogEventMissingException.

The recipe below was established by trial against the live API (us-east-1,
2026-08-03); each rule cost real debugging time, so do not "simplify" it:

  * SPANS  -> OTLP POST https://xray.<region>.amazonaws.com/v1/traces
             (SigV4 service name "xray"). This is what makes the session
             discoverable, and it lands the spans in the "aws/spans" log group.
  * EVENTS -> logs:PutLogEvents into
             /aws/bedrock-agentcore/runtimes/<runtime>-DEFAULT, stream
             "otel-rt-logs". The OTLP logs endpoint (/v1/logs) must NOT be used:
             it flattens the nested "body" object into a JSON string, and the
             evaluator then cannot match the event to its span.
  * NAMING - serviceNames must be exactly ["<runtime>.DEFAULT"] and
             logGroupNames must include "aws/spans" alongside the runtime log
             group, or session discovery returns totalNumberOfSessions: 0.
  * AGE    - PutLogEvents rejects events older than 14 days. Connect logs being
             evaluated are usually a day old, but timestamps are shifted forward
             when SHIFT_TIMESTAMPS is enabled so that replays of archived data
             still ingest.
"""

import json
import os
import time
import urllib.error
import urllib.request

import boto3
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest

from logbatch import put_events

REGION = os.environ.get("AWS_REGION", "us-east-1")
BUCKET = os.environ["RESULTS_BUCKET"]
RUNTIME_NAME = os.environ["OBSERVABILITY_RUNTIME_NAME"]
SERVICE_NAME = f"{RUNTIME_NAME}.DEFAULT"
LOG_GROUP = f"/aws/bedrock-agentcore/runtimes/{RUNTIME_NAME}-DEFAULT"
SPAN_STREAM = "spans"
EVENT_STREAM = "otel-rt-logs"
SPANS_LOG_GROUP = "aws/spans"
# replay support: shift archived sessions into the PutLogEvents 14-day window
SHIFT_TIMESTAMPS = os.environ.get("SHIFT_TIMESTAMPS", "true").lower() == "true"
MAX_AGE_DAYS = 14
OTLP_BATCH_SPANS = int(os.environ.get("OTLP_BATCH_SPANS", "100"))

s3 = boto3.client("s3", region_name=REGION)
logs = boto3.client("logs", region_name=REGION)

RESOURCE_ATTRS = {
    "service.name": SERVICE_NAME,
    "aws.local.service": SERVICE_NAME,
    "aws.log.group.names": LOG_GROUP,
    "cloud.provider": "aws",
    "cloud.platform": "aws_bedrock_agentcore",
    "cloud.region": REGION,
    "aws.service.type": "gen_ai_agent",
    "telemetry.sdk.name": "opentelemetry",
    "telemetry.sdk.language": "python",
}


def ensure_targets():
    for fn, kw in ((logs.create_log_group, {"logGroupName": LOG_GROUP}),
                   (logs.create_log_stream, {"logGroupName": LOG_GROUP,
                                             "logStreamName": EVENT_STREAM})):
        try:
            fn(**kw)
        except logs.exceptions.ResourceAlreadyExistsException:
            pass


def otlp_value(v):
    if isinstance(v, bool):
        return {"boolValue": v}
    if isinstance(v, int):
        return {"intValue": str(v)}
    if isinstance(v, float):
        return {"doubleValue": v}
    return {"stringValue": str(v)}


def post_spans(otlp_spans):
    """SigV4-signed OTLP JSON POST to the X-Ray traces endpoint.

    -> (rejected span count, error message). OTLP reports per-request partial
    failures INSIDE a 200 response (`partialSuccess`), so a call that accepted
    only 2 of 30 spans still looks like success from the status code alone. That
    is indistinguishable, from the outside, from "the index is slow": the gate
    keeps waiting for span documents that were never accepted and will never
    appear, and the run dies 25 minutes later on a timeout that says nothing
    about why. So the body is read and the count reported back.

    OTLP only gives a count, not which spans, so the caller can only report it.
    """
    url = f"https://xray.{REGION}.amazonaws.com/v1/traces"
    creds = boto3.Session().get_credentials().get_frozen_credentials()
    resource = dict(RESOURCE_ATTRS, **{"aws.log.stream.names": SPAN_STREAM})
    body = json.dumps({"resourceSpans": [{
        "resource": {"attributes": [{"key": k, "value": otlp_value(v)}
                                    for k, v in resource.items()]},
        "scopeSpans": [{"scope": {"name": "strands.telemetry.tracer"},
                        "spans": otlp_spans}]}]}).encode()
    req = AWSRequest(method="POST", url=url, data=body,
                     headers={"Content-Type": "application/json"})
    SigV4Auth(creds, "xray", REGION).add_auth(req)
    try:
        with urllib.request.urlopen(
                urllib.request.Request(url, data=body, headers=dict(req.headers),
                                       method="POST"), timeout=60) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"OTLP traces POST failed {e.code}: "
                           f"{e.read().decode()[:500]}") from e
    try:
        ps = (json.loads(raw or b"{}") or {}).get("partialSuccess") or {}
    except json.JSONDecodeError:
        return 0, ""
    rejected = int(ps.get("rejectedSpans") or 0)
    if rejected:
        print(f"WARNING: X-Ray OTLP endpoint rejected {rejected} of "
              f"{len(otlp_spans)} spans: {str(ps.get('errorMessage'))[:500]}")
    return rejected, str(ps.get("errorMessage") or "")


def shift_for(spans, now_ns):
    """Offset needed to bring a session inside the PutLogEvents 14-day window."""
    if not SHIFT_TIMESTAMPS:
        return 0
    newest = max((s.get("endTimeUnixNano") or s.get("timeUnixNano") or 0)
                 for s in spans)
    cutoff = now_ns - (MAX_AGE_DAYS - 1) * 86400 * 1_000_000_000
    if newest >= cutoff:
        return 0
    # land the session ~90s in the past: recent enough to ingest, already ended
    return now_ns - 90 * 1_000_000_000 - newest


def convert_session(spans, now_ns):
    """sessionSpans -> (OTLP spans, CloudWatch log events)."""
    shift = shift_for(spans, now_ns)
    otlp_spans, events = [], []
    for item in spans:
        item = json.loads(json.dumps(item))  # copy before mutating timestamps
        for k in ("startTimeUnixNano", "endTimeUnixNano", "timeUnixNano",
                  "observedTimeUnixNano"):
            if k in item and isinstance(item[k], int):
                item[k] += shift
        if "name" in item:  # a span
            span = {"traceId": item["traceId"], "spanId": item["spanId"],
                    "name": item["name"], "kind": 1,
                    "startTimeUnixNano": str(item["startTimeUnixNano"]),
                    "endTimeUnixNano": str(item["endTimeUnixNano"]),
                    "attributes": [{"key": k, "value": otlp_value(v)}
                                   for k, v in item["attributes"].items()],
                    "status": {"code": 1 if item.get("status", {}).get("code") == "OK"
                               else 0}}
            if item.get("parentSpanId"):
                span["parentSpanId"] = item["parentSpanId"]
            otlp_spans.append(span)
        else:               # the matching log event
            item["resource"] = {"attributes": dict(
                RESOURCE_ATTRS, **{"aws.log.stream.names": EVENT_STREAM})}
            events.append({"timestamp": item["timeUnixNano"] // 1_000_000,
                           "message": json.dumps(item, ensure_ascii=False)})
    return otlp_spans, events


def handler(event, context):
    run_id = event["runId"]
    manifest = json.loads(s3.get_object(
        Bucket=BUCKET, Key=event["manifestKey"])["Body"].read())
    ensure_targets()
    now_ns = int(time.time() * 1_000_000_000)

    ingested, span_ids, failures, span_epochs = [], [], [], []
    rejected_spans, rejected_msgs = 0, []
    for entry in manifest["sessions"]:
        sid = entry["sessionId"]
        try:
            spans = json.loads(s3.get_object(
                Bucket=BUCKET, Key=entry["key"])["Body"].read())
            otlp_spans, events = convert_session(spans, now_ns)
            # X-Ray indexes a span document under the span's OWN start time, not
            # the time it was posted. The index gate has to query that range, so
            # record it here rather than let the gate guess.
            for sp in otlp_spans:
                span_epochs.append(int(sp["startTimeUnixNano"]) // 1_000_000_000)
            for i in range(0, len(otlp_spans), OTLP_BATCH_SPANS):
                n_rejected, msg = post_spans(otlp_spans[i:i + OTLP_BATCH_SPANS])
                rejected_spans += n_rejected
                if n_rejected and msg and msg not in rejected_msgs:
                    rejected_msgs.append(msg[:500])
            if events:
                # a transcript-carrying session can exceed the 1 MB per-call
                # limit on its own; logbatch sorts and splits into legal calls
                _, oversized = put_events(logs, LOG_GROUP, EVENT_STREAM, events)
                if oversized:
                    raise RuntimeError(
                        f"{len(oversized)} event(s) exceed the 256 KB "
                        "single-event limit and cannot be ingested")
            # the evaluation job discovers sessions by the id inside the spans
            ingested.append(entry.get("evalSessionId") or sid)
            span_ids.extend(s["spanId"] for s in otlp_spans)
        except Exception as e:  # one bad session must not sink the run
            print(f"ingest failed for {sid}: {type(e).__name__}: {e}")
            failures.append({"sessionId": sid, "error": f"{type(e).__name__}: {e}"})

    result = {"runId": run_id,
              "connectSessionIds": [e["sessionId"] for e in manifest["sessions"]],
              "serviceName": SERVICE_NAME,
              "logGroupNames": [SPANS_LOG_GROUP, LOG_GROUP],
              "eventStream": EVENT_STREAM,
              "sessionIds": ingested,
              "sessionCount": len(ingested),
              "spanIds": span_ids,
              # the window the gate must query to see these span documents
              "spanTimeRange": {"startEpoch": min(span_epochs) if span_epochs else None,
                                "endEpoch": max(span_epochs) if span_epochs else None,
                                "ingestedAtEpoch": now_ns // 1_000_000_000},
              # spans the OTLP endpoint accepted the request for but did not keep;
              # non-zero here explains a WaitIndexed timeout that nothing else does
              "rejectedSpans": rejected_spans,
              "rejectedSpanErrors": rejected_msgs,
              "failures": failures}
    s3.put_object(Bucket=BUCKET, Key=f"runs/{run_id}/ingest.json",
                  Body=json.dumps(result, ensure_ascii=False, indent=1).encode(),
                  ContentType="application/json")
    print(json.dumps({k: v for k, v in result.items() if k != "spanIds"}))
    return {k: v for k, v in result.items() if k != "spanIds"} | {
        "spanIdSample": span_ids[:20]}
