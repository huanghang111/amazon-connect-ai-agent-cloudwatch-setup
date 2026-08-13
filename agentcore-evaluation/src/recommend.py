"""Step 6: AgentCore Recommendation - optimized system prompt + tool descriptions.

Uses the inline `sessionSpans` form of `agentTraces` (verified end to end), not
the batchEvaluationArn form. The current system prompt and the current per-tool
descriptions are both extracted from the Connect logs themselves, so no manual
input is needed.

API constraints verified 2026-07-15 against the live service:
  * SYSTEM_PROMPT_RECOMMENDATION requires evaluationConfig with EXACTLY 1
    evaluator (builtin ARN form arn:aws:bedrock-agentcore:::evaluator/Builtin.X).
  * TOOL_DESCRIPTION_RECOMMENDATION takes no evaluationConfig, and FAILS if any
    listed tool never appears as a toolUse in the sampled traces - so tools that
    were never invoked are dropped rather than sent.
  * sessionSpans is capped at 1000 items, so whole sessions are kept, newest
    first, until the cap is reached.
"""

import json
import os
import re
import time

import boto3

REGION = os.environ.get("AWS_REGION", "us-east-1")
BUCKET = os.environ["RESULTS_BUCKET"]
EVALUATOR_ARN = "arn:aws:bedrock-agentcore:::evaluator/Builtin.{}"
GUIDING_EVALUATOR = os.environ.get("RECOMMENDATION_EVALUATOR", "Helpfulness")
MAX_SPANS = 1000
POLL_SECONDS = int(os.environ.get("REC_POLL_SECONDS", "20"))
BUDGET_SECONDS = int(os.environ.get("REC_BUDGET_SECONDS", "780"))

agentcore = boto3.client("bedrock-agentcore", region_name=REGION)
s3 = boto3.client("s3", region_name=REGION)


# ------------------------------------------------- extract current artifacts

def load_system_prompt(manifest):
    """The full system prompt, as captured by the collect step.

    Deliberately NOT read back from the converted spans: the copy embedded in
    the event body is truncated to 4000 chars, which cuts off the
    <tools><toolConfigurationList> section that tool-description recommendation
    depends on.
    """
    key = manifest.get("systemPromptKey")
    if not key:
        return None
    try:
        return s3.get_object(Bucket=BUCKET, Key=key)["Body"].read().decode()
    except s3.exceptions.NoSuchKey:
        return None


def extract_tool_descriptions(system_prompt):
    """Parse per-tool instructions from the <tools><toolConfigurationList>
    section that Connect embeds in the system prompt."""
    tools = {}
    if not system_prompt:
        return tools
    for block in re.findall(r"<toolConfiguration>(.*?)</toolConfiguration>",
                            system_prompt, re.S):
        name_m = re.search(r"<toolName>(.*?)</toolName>", block, re.S)
        if not name_m:
            continue
        # innermost <instruction> text (Connect double-wraps the tag)
        instrs = re.findall(r"<instruction>\s*([^<]+?)\s*</instruction>", block, re.S)
        desc = " ".join(i.strip() for i in instrs if i.strip())
        if desc:
            tools[name_m.group(1).strip()] = desc
    return tools


def tools_invoked_in(spans):
    """Tool names that actually have execute_tool spans in the traces."""
    return {s["attributes"].get("gen_ai.tool.name")
            for s in spans if "name" in s
            and s["attributes"].get("aws.genai.span_kind") == "TOOL"}


def trim_to_limit(sessions):
    """Keep whole sessions, newest first, within the sessionSpans cap."""
    def newest(kv):
        return -max((s.get("endTimeUnixNano") or s.get("timeUnixNano") or 0)
                    for s in kv[1])

    kept, total, dropped = [], 0, []
    for sid, spans in sorted(sessions.items(), key=newest):
        if total + len(spans) > MAX_SPANS:
            dropped.append(sid)
            continue
        kept.extend(spans)
        total += len(spans)
    return kept, dropped


# ------------------------------------------------------------- job plumbing

def wait_jobs(job_ids):
    pending, done = dict(job_ids), {}
    deadline = time.time() + BUDGET_SECONDS
    while pending and time.time() < deadline:
        for jid in list(pending):
            r = agentcore.get_recommendation(recommendationId=jid)
            if r["status"] in ("COMPLETED", "FAILED"):
                r.pop("ResponseMetadata", None)
                print(f"{pending.pop(jid)}: {r['status']}")
                done[jid] = r
        if pending:
            time.sleep(POLL_SECONDS)
    for jid, label in pending.items():
        print(f"{label}: TIMEOUT (job {jid} still running)")
        done[jid] = {"recommendationId": jid, "status": "TIMEOUT", "type": label}
    return done


def markdown_report(resp):
    lines = [f"# {resp.get('type')} - {resp['status']}",
             f"- job: `{resp.get('recommendationId')}`",
             f"- created: {resp.get('createdAt')}", ""]
    res = resp.get("recommendationResult", {})
    sp = res.get("systemPromptRecommendationResult")
    td = res.get("toolDescriptionRecommendationResult")
    if sp:
        if sp.get("errorMessage"):
            lines.append(f"**ERROR** {sp.get('errorCode')}: {sp['errorMessage']}")
        else:
            lines += ["## Recommended system prompt", "```",
                      sp.get("recommendedSystemPrompt", ""), "```", "",
                      "## Why", sp.get("explanation", "")]
    if td:
        if td.get("errorMessage"):
            lines.append(f"**ERROR** {td.get('errorCode')}: {td['errorMessage']}")
        for t in td.get("tools", []):
            lines += [f"## Tool `{t['toolName']}`", "",
                      "**Recommended description**", "",
                      t.get("recommendedToolDescription", ""), "",
                      "**Why**", "", t.get("explanation", ""), ""]
    return "\n".join(lines)


def handler(event, context):
    run_id = event["runId"]
    manifest = json.loads(s3.get_object(
        Bucket=BUCKET, Key=f"runs/{run_id}/collect.json")["Body"].read())
    sessions = {}
    for entry in manifest["sessions"]:
        sessions[entry["sessionId"]] = json.loads(s3.get_object(
            Bucket=BUCKET, Key=entry["key"])["Body"].read())
    if not sessions:
        return {"runId": run_id, "jobs": [], "skipped": "no sessions"}

    all_spans, dropped = trim_to_limit(sessions)
    system_prompt = load_system_prompt(manifest)
    tool_descs = extract_tool_descriptions(system_prompt)
    invoked = tools_invoked_in(all_spans)
    if dropped:
        print(f"dropped {len(dropped)} session(s) to stay under the "
              f"{MAX_SPANS}-span cap: {dropped}")

    jobs, notes = {}, []
    if system_prompt:
        r = agentcore.start_recommendation(
            name=f"rec-sp-{run_id}"[:48], type="SYSTEM_PROMPT_RECOMMENDATION",
            recommendationConfig={"systemPromptRecommendationConfig": {
                "systemPrompt": {"text": system_prompt[:20000]},
                "agentTraces": {"sessionSpans": all_spans},
                "evaluationConfig": {"evaluators": [
                    {"evaluatorArn": EVALUATOR_ARN.format(GUIDING_EVALUATOR)}]}}})
        jobs[r["recommendationId"]] = "system_prompt"
        print(f"started system-prompt job {r['recommendationId']}")
    else:
        notes.append("system-prompt skipped: no system_instructions in the logs")

    usable = {n: d for n, d in tool_descs.items() if n in invoked}
    never_invoked = sorted(set(tool_descs) - set(usable))
    if never_invoked:
        notes.append(f"tools omitted (never invoked in these traces): {never_invoked}")
    # Connect only embeds <instruction> for tools configured in the AI agent
    # itself; MCP tools arrive as a bare <toolName>, so there is no description
    # to optimize even though the model calls them. Say so, or the skip note
    # below reads as though the tools were never used.
    undescribed = sorted(invoked - set(tool_descs) - {None, ""})
    if undescribed:
        notes.append("tools invoked but carrying no description in the system "
                     f"prompt (nothing to optimize): {undescribed}")
    if usable:
        r = agentcore.start_recommendation(
            name=f"rec-td-{run_id}"[:48], type="TOOL_DESCRIPTION_RECOMMENDATION",
            recommendationConfig={"toolDescriptionRecommendationConfig": {
                "toolDescription": {"toolDescriptionText": {"tools": [
                    {"toolName": n, "toolDescription": {"text": d[:20000]}}
                    for n, d in sorted(usable.items())]}},
                "agentTraces": {"sessionSpans": all_spans}}})
        jobs[r["recommendationId"]] = "tool_description"
        print(f"started tool-description job {r['recommendationId']}")
    else:
        notes.append("tool-description skipped: none of the tools described in "
                     "the system prompt were invoked in these traces")

    if not jobs:
        s3.put_object(Bucket=BUCKET, Key=f"runs/{run_id}/recommendation.json",
                      Body=json.dumps({"jobs": [], "notes": notes},
                                      indent=1).encode(),
                      ContentType="application/json")
        return {"runId": run_id, "jobs": [], "notes": notes}

    done = wait_jobs(jobs)
    out = []
    for jid, resp in done.items():
        slug = jobs.get(jid, "recommendation")
        s3.put_object(
            Bucket=BUCKET,
            Key=f"runs/{run_id}/recommendation/{slug}.md",
            Body=markdown_report(resp).encode(), ContentType="text/markdown")
        out.append({"jobId": jid, "type": slug, "status": resp["status"]})

    payload = {"runId": run_id, "jobs": out, "notes": notes,
               "droppedSessions": dropped,
               "results": {jobs.get(j, j): r for j, r in done.items()}}
    s3.put_object(Bucket=BUCKET, Key=f"runs/{run_id}/recommendation.json",
                  Body=json.dumps(payload, ensure_ascii=False, indent=1,
                                  default=str).encode(),
                  ContentType="application/json")
    return {"runId": run_id, "jobs": out, "notes": notes}
