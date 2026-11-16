# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com
"""Count hosted transcription gate rejections by Worker version and cause (#7888).

Read-only. Prints aggregate counts only: no identifiers, request data, or
private cost-control values. Old versions log a generic message with the thrown
error; that error is reduced to a fixed cause label before it is counted.
"""
import datetime
import json
import os
import re
import urllib.error
import urllib.request


def post(url, token, body):
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"}, data=json.dumps(body).encode())
    try:
        with urllib.request.urlopen(req) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, {}


def cause(text):
    """Map free-form error text to a fixed label. Only env var names can pass through."""
    match = re.search(r"private hosted AI cost control: (MAX_[A-Z_]+|account plan|global transcription windows|transcription plan ceilings)", text)
    if match:
        return "invalid_cost_control_config:" + match.group(1)
    if "cost accounting unavailable" in text:
        return "ledger_unavailable"
    return "unclassified"


account = os.environ["CLOUDFLARE_ACCOUNT_ID"]
token = os.environ["CLOUDFLARE_API_TOKEN"]
hours = int(os.environ.get("TRANSCRIPTION_GATE_HOURS", "6"))
now = int(datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000)
since = now - hours * 3600 * 1000
status, telemetry = post(
    f"https://api.cloudflare.com/client/v4/accounts/{account}/workers/observability/telemetry/query",
    token,
    {"queryId": "transcription-gate-7888", "dry": True, "view": "events",
     "timeframe": {"from": since, "to": now},
     "parameters": {"datasets": ["cloudflare-workers"], "filterCombination": "and", "filters": [
         {"key": "$metadata.service", "operation": "eq", "type": "string", "value": "ai-proxy"},
         {"key": "$metadata.message", "operation": "regex", "type": "string",
          "value": "transcription gate rejected|transcription cost control unavailable"}]},
     "limit": 2000},
)
print("transcription_gate_telemetry_status", status, json.dumps({"hours": hours}), flush=True)
counts = {}
events = telemetry.get("result", {}).get("events", {}).get("events", [])
for event in events:
    version = event.get("$workers", {}).get("scriptVersion", {}).get("id")
    source = event.get("source", {})
    message = source.get("message", "") if isinstance(source, dict) else str(source)
    if message.startswith("transcription gate rejected "):
        detail = json.loads(message.split(" ", 3)[3])
        key = (version, detail.get("reason"), detail.get("tier"))
    else:
        payload = json.dumps(event.get("source", {})) + json.dumps(event.get("$metadata", {}).get("error", ""))
        labeled = re.search(r'"reason":\s*"(\w+)"', message)
        key = (version, labeled.group(1) if labeled else cause(payload), None)
    counts[key] = counts.get(key, 0) + 1
print("transcription_gate_events", len(events), flush=True)
for (version, reason, tier), count in sorted(counts.items(), key=lambda item: -item[1]):
    print("transcription_gate", json.dumps({"version": version, "reason": reason, "tier": tier, "count": count}), flush=True)
