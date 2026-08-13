"""Convert Amazon Connect AI Agent logs to OTEL GenAI spans for AgentCore Evaluation.

Input : Connect AI Agent log records (CloudWatch export - CSV or raw JSON events)
Output: per-session sessionSpans list (spans + events) compatible with
        bedrock-agentcore Evaluate API / OTEL gen_ai semantic conventions.

Only TRANSCRIPT_AI_AGENT_TRACE events are needed - they carry the complete span
tree (invoke_agent / inference / execute_tool) with messages and token usage.
"""

import csv
import hashlib
import json
import re
import sys
from collections import defaultdict

SCOPE = {"name": "strands.telemetry.tracer", "version": ""}
SERVICE_NAME = "connect-ai-agent"


# ---------------------------------------------------------------- parsing

def _fix_newlines(s: str) -> str:
    # CloudWatch CSV export renders "\n" inside JSON strings as backslash+LF
    return s.replace("\\\n", "\\n")


_DECODER = json.JSONDecoder(strict=False)


def parse_csv(path):
    """Yield parsed Connect log message dicts from a CloudWatch CSV export."""
    with open(path) as f:
        for row in csv.DictReader(f):
            yield _DECODER.decode(_fix_newlines(row["message"]))


def parse_span_field(s: str) -> dict:
    """Parse Connect's `{k=v, k=v, ...}` span serialization (values may contain
    nested JSON arrays/objects), returning a flat dict of raw string values."""
    body = s.strip()[1:-1]
    parts, depth, cur, inq, prev = [], 0, "", False, ""
    for ch in body:
        if inq:
            cur += ch
            if ch == '"' and prev != "\\":
                inq = False
        else:
            if ch == '"':
                inq, cur = True, cur + ch
            elif ch in "[{(":
                depth, cur = depth + 1, cur + ch
            elif ch in "]})":
                depth, cur = depth - 1, cur + ch
            elif ch == "," and depth == 0:
                parts.append(cur)
                cur = ""
            else:
                cur += ch
        prev = ch
    if cur.strip():
        parts.append(cur)
    out = {}
    for p in parts:
        k, _, v = p.strip().partition("=")
        out[k.strip()] = v
    return out


# ---------------------------------------------------------------- id mapping

def otel_span_id(uuid_str: str, salt: str = "") -> str:
    return hashlib.md5(("span:" + salt + uuid_str).encode()).hexdigest()[:16]


def otel_trace_id(root_uuid: str, salt: str = "") -> str:
    return hashlib.md5(("trace:" + salt + root_uuid).encode()).hexdigest()


# ---------------------------------------------------------------- messages

def connect_messages_to_otel(raw: str, direction: str):
    """Connect input_messages/output_messages JSON -> Strands-style gen_ai
    messages. direction: 'input' | 'output' (controls content shape)."""
    if not raw:
        return []
    try:
        msgs = json.loads(raw, strict=False)
    except json.JSONDecodeError:
        return []
    out = []
    for m in msgs:
        role = "user" if m.get("participant") == "CUSTOMER" else "assistant"
        # Strands-native content blocks. Recommendation's tool matching only
        # recognizes toolUse blocks in this exact shape (Evaluate is laxer).
        blocks, has_tool = [], False
        for v in m.get("values", []):
            if "text" in v:
                txt = v["text"].get("value", "").strip()
                if txt:
                    blocks.append({"text": txt})
            elif "toolUse" in v:
                tu = v["toolUse"]
                inp = tu.get("input")
                if isinstance(inp, str):
                    try:
                        inp = json.loads(inp, strict=False)
                    except json.JSONDecodeError:
                        pass
                blocks.append({"toolUse": {"toolUseId": tu.get("toolUseId"),
                                           "name": tu.get("name"), "input": inp}})
                has_tool = True
            elif "toolResult" in v:
                tr_ = v["toolResult"]
                role = "tool"
                # Connect uses either "content" (blocks) or "value" (string)
                content = tool_result_blocks(tr_)
                blocks.append({"toolResult": {"toolUseId": tr_.get("toolUseId"),
                                              "status": "success",
                                              "content": content}})
                has_tool = True
        if not blocks:
            blocks = [{"text": "<EMPTY_USER_INPUT>" if role == "user"
                       else "<NO_RESPONSE>"}]
        text = "\n".join(b["text"] for b in blocks if "text" in b).strip()
        # mirror the shapes emitted by strands.telemetry.tracer
        if direction == "output" and role == "assistant":
            content = {"message": json.dumps(blocks, ensure_ascii=False) if has_tool else text,
                       "finish_reason": "tool_use" if has_tool else "end_turn"}
        elif role in ("user", "tool") or has_tool:
            content = {"content": json.dumps(blocks, ensure_ascii=False)}
        else:
            content = text
        out.append({"role": role, "content": content})
    return out


def system_prompt_text(raw):
    """Extract the system prompt from a span's system_instructions field.

    Connect serializes it as a list of MESSAGE objects, i.e.
    [{"messageId", "participant", "timestamp", "values": [{"text": {"value": ...}}]}]
    - the prompt text sits two levels down, not directly on the list items.
    """
    if not raw:
        return ""
    try:
        parsed = json.loads(raw, strict=False)
    except json.JSONDecodeError:
        return ""
    if isinstance(parsed, str):
        return parsed
    chunks = []
    for m in parsed if isinstance(parsed, list) else [parsed]:
        if not isinstance(m, dict):
            chunks.append(str(m))
            continue
        for v in m.get("values", []):
            if isinstance(v, dict) and "text" in v:
                chunks.append(v["text"].get("value", ""))
        if "value" in m:  # tolerate a flatter shape too
            chunks.append(str(m["value"]))
    return "\n".join(c for c in chunks if c).strip()


def tool_result_text(tr):
    """Tool output as a non-empty string, across both shapes Connect emits.

    Two shapes seen in the wild:
      * {"toolUseId", "value": "<json string>"}  - MCP-backed tools
      * {"toolUseId", "content": [...]}           - content-block form
    Returning "" here is not an option: the evaluator raises
    ToolSpanMappingException ("Failed to parse tool_output from tool-span")
    when the output is an empty JSON string, which fails the whole session.
    """
    if not isinstance(tr, dict):
        return ""
    if tr.get("value") not in (None, ""):
        v = tr["value"]
        return v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)
    if tr.get("content") not in (None, "", []):
        return json.dumps(tr["content"], ensure_ascii=False)
    return ""


def tool_result_blocks(tr):
    """Tool output as a content-block LIST, ready to be JSON-serialized.

    The evaluator json-parses tool_output and raises ToolSpanMappingException if
    that fails. Connect's `value` string cannot be forwarded as-is: MCP tools
    embed inner JSON inside it without escaping, e.g.
        {"status": "success", "output": "{"woNumber": "9926972953"}"}
    which is not valid JSON. So a raw string is always wrapped in a text block,
    which is also the shape that evaluated successfully end to end.
    """
    if isinstance(tr, dict) and isinstance(tr.get("content"), list) and tr["content"]:
        return tr["content"]
    txt = tool_result_text(tr)
    return [{"text": txt}] if txt else [{"text": "OK"}]


def tool_event_messages(s):
    """Build execute_tool event body messages in the Strands tool shape:
    input = tool arguments, output = tool result. Connect only logs the
    toolUse request (and sometimes a toolResult) in input_messages."""
    tool_use, tool_result = None, None
    for field in ("input_messages", "output_messages"):
        raw = s.get(field, "")
        if not raw:
            continue
        try:
            msgs = json.loads(raw, strict=False)
        except json.JSONDecodeError:
            continue
        for m in msgs:
            for v in m.get("values", []):
                if "toolUse" in v and tool_use is None:
                    tool_use = v["toolUse"]
                elif "toolResult" in v and tool_result is None:
                    tool_result = v["toolResult"]
    if tool_use is None:
        return [], []
    tid = tool_use.get("toolUseId", "")
    in_msgs = [{"role": "tool", "content": {
        "content": tool_use.get("input", "{}"), "role": "tool", "id": tid}}]
    # always valid JSON, never empty: see tool_result_blocks
    result_txt = json.dumps(tool_result_blocks(tool_result), ensure_ascii=False)
    out_msgs = [{"role": "assistant", "content": {
        "message": result_txt, "id": tid}}]
    return in_msgs, out_msgs


# ---------------------------------------------------------------- conversion

SESSION_SALT_SEP = "--run-"


def eval_session_id(session_id, salt=""):
    """The session.id written into Observability, unique per run.

    Batch evaluation collects a session's spans by session.id out of the shared
    runtime log group, so a Connect session that is ingested twice would be
    evaluated over BOTH copies - including any spans an older, buggier converter
    produced. Scoping the id to the run keeps each run's evaluation self-contained.
    Use connect_session_id() to get the original id back for reporting.
    """
    return f"{session_id}{SESSION_SALT_SEP}{salt}" if salt else session_id


def connect_session_id(eval_id):
    """Inverse of eval_session_id: the Connect sessionId, for reports/ledger."""
    return (eval_id or "").split(SESSION_SALT_SEP)[0]


def build_session_spans(trace_events, session_id, salt=""):
    """Convert one session's TRANSCRIPT_AI_AGENT_TRACE records into a
    sessionSpans list (OTEL spans + matching log events).

    `salt` makes the derived span/trace/session ids unique per run. Without it the
    ids are a pure function of the Connect UUIDs, so re-ingesting a session adds a
    second set of spans under the SAME ids to the shared runtime log group, and
    batch evaluation then scores this run's session over stale spans too - which
    makes converter fixes look like they had no effect.
    """
    session_id = eval_session_id(session_id, salt)
    raw_spans = [parse_span_field(e["span"]) for e in trace_events]
    by_id = {s["span_id"]: s for s in raw_spans}

    def find_root(s):
        seen = set()
        while s.get("parent_span_id") and s["parent_span_id"] in by_id \
                and s["span_id"] not in seen:
            seen.add(s["span_id"])
            s = by_id[s["parent_span_id"]]
        return s

    resource_attrs = {
        "service.name": SERVICE_NAME,
        "aws.local.service": SERVICE_NAME,
        "telemetry.sdk.name": "opentelemetry",
        "telemetry.sdk.language": "python",
        "aws.service.type": "gen_ai_agent",
        "cloud.provider": "aws",
    }

    # a span that never gets a log event cannot be evaluated: batch evaluation
    # raises LogEventMissingException for it, and it never appears in the runtime
    # log group's index, so the indexing gate waits for it forever. Connect emits
    # such spans for non-conversational internals (barge_in, for example). A leaf
    # one carries nothing evaluable and is dropped; one with children has to stay
    # to keep the parent chain intact, and gets a placeholder event instead.
    parents = {s.get("parent_span_id") for s in raw_spans if s.get("parent_span_id")}

    out = []
    for s in raw_spans:
        root = find_root(s)
        trace_id = otel_trace_id(root["span_id"], salt)
        span_id = otel_span_id(s["span_id"], salt)
        parent = s.get("parent_span_id")
        start_ns = int(s["start_timestamp"]) * 1_000_000
        end_ns = max(int(s["end_timestamp"]) * 1_000_000, start_ns + 1_000_000)
        op = s["operation_name"]

        attrs = {
            "session.id": session_id,
            "gen_ai.operation.name": op,
            "gen_ai.system": "strands-agents",
            "gen_ai.provider.name": "strands-agents",
            "gen_ai.agent.name": s.get("ai_agent_name", "connect-agent"),
        }
        if op == "inference":
            attrs["gen_ai.operation.name"] = "chat"
            attrs["aws.genai.span_kind"] = "LLM"
            attrs["gen_ai.request.model"] = s.get("request_model", "")
            for k_src, k_dst in [("usage_input_tokens", "gen_ai.usage.input_tokens"),
                                 ("usage_output_tokens", "gen_ai.usage.output_tokens"),
                                 ("usage_total_tokens", "gen_ai.usage.total_tokens")]:
                if s.get(k_src):
                    attrs[k_dst] = int(s[k_src])
        elif op == "execute_tool":
            tool_name = ""
            m = re.search(r'"name":"([^"]+)"', s.get("input_messages", ""))
            if m:
                tool_name = m.group(1)
            attrs["gen_ai.tool.name"] = tool_name
            attrs["aws.genai.span_kind"] = "TOOL"
        elif op == "invoke_agent":
            attrs["aws.genai.span_kind"] = "AGENT"
            attrs["gen_ai.request.model"] = s.get("request_model", "")

        span_name = {"invoke_agent": "invoke_agent " + s.get("ai_agent_name", "agent"),
                     "inference": "chat " + s.get("request_model", ""),
                     "execute_tool": "execute_tool " + attrs.get("gen_ai.tool.name", ""),
                     "escalate_agent": "escalate_agent"}.get(op, op)

        otel_span = {
            "spanId": span_id,
            "traceId": trace_id,
            "name": span_name,
            "kind": "INTERNAL",
            "startTimeUnixNano": start_ns,
            "endTimeUnixNano": end_ns,
            "durationNano": end_ns - start_ns,
            "scope": SCOPE,
            "attributes": attrs,
            "status": {"code": "OK" if s.get("status") == "OK" else "UNSET"},
            "resource": {"attributes": resource_attrs},
        }
        if parent and parent in by_id:
            otel_span["parentSpanId"] = otel_span_id(parent, salt)
        out.append(otel_span)

        # matching log event (body carries input/output messages)
        if op == "execute_tool":
            in_msgs, out_msgs = tool_event_messages(s)
        else:
            in_msgs = connect_messages_to_otel(s.get("input_messages", ""), "input")
            out_msgs = connect_messages_to_otel(s.get("output_messages", ""), "output")

        # invoke_agent spans carry no messages in Connect logs; synthesize the
        # turn-level user query / agent answer from the child inference span
        if op == "invoke_agent" and not in_msgs:
            children = [c for c in raw_spans
                        if c.get("parent_span_id") == s["span_id"]
                        and c["operation_name"] == "inference"]
            if children:
                c = children[-1]
                in_msgs = connect_messages_to_otel(c.get("input_messages", ""), "input")
                out_msgs = connect_messages_to_otel(c.get("output_messages", ""), "output")
                sys_txt = system_prompt_text(c.get("system_instructions"))
                if sys_txt:
                    in_msgs = [{"role": "system",
                                "content": sys_txt[:4000]}] + in_msgs

        if not in_msgs and not out_msgs:
            if s["span_id"] not in parents:
                out.pop()                       # leaf, nothing to evaluate
                continue
            # keep the chain, but give it something matchable
            in_msgs = [{"role": "user", "content": {"content": json.dumps(
                [{"text": "<EMPTY_USER_INPUT>"}], ensure_ascii=False)}}]

        if in_msgs or out_msgs:
            out.append({
                "spanId": span_id,
                "traceId": trace_id,
                "scope": SCOPE,
                "body": {"output": {"messages": out_msgs},
                         "input": {"messages": in_msgs}},
                "attributes": {"event.name": SCOPE["name"],
                               "session.id": session_id},
                "resource": {"attributes": resource_attrs},
                "flags": 1,
                "severityNumber": 9,
                "severityText": "",
                "timeUnixNano": end_ns,
                "observedTimeUnixNano": end_ns,
            })
    return out


def convert(records, salt=""):
    """records: iterable of parsed Connect log dicts -> {session_id: sessionSpans}

    Pass a per-run `salt` (e.g. the runId) when the output will be ingested into a
    shared log group; see build_session_spans.
    """
    traces = defaultdict(list)
    for r in records:
        if r.get("event_type") == "TRANSCRIPT_AI_AGENT_TRACE":
            traces[r["session_id"]].append(r)
    return {sid: build_session_spans(evts, sid, salt)
            for sid, evts in traces.items()}


if __name__ == "__main__":
    src = sys.argv[1] if len(sys.argv) > 1 else "connect_ai_agent_log.csv"
    sessions = convert(parse_csv(src))
    for sid, spans in sessions.items():
        fn = f"out/session_{sid}.json"
        with open(fn, "w") as f:
            json.dump(spans, f, ensure_ascii=False, indent=1)
        n_spans = sum(1 for x in spans if "name" in x)
        n_events = len(spans) - n_spans
        print(f"{sid}: {n_spans} spans + {n_events} events -> {fn}")
