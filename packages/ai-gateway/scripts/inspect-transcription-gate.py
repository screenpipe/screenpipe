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
hours = int(os.environ.get("TRANSCRIPTION_GATE_HOURS", "168"))
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
by_day = {}
shape_printed = False
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
    day = datetime.datetime.fromtimestamp(event.get("timestamp", 0) / 1000, datetime.timezone.utc).strftime("%Y-%m-%d")
    by_day[(day, key[1])] = by_day.get((day, key[1]), 0) + 1
    if key[1] == "unclassified" and not shape_printed:
        shape_printed = True
        # Field names only, so the next revision can read the thrown error.
        print("transcription_gate_event_shape", json.dumps({k: sorted(v) if isinstance(v, dict) else type(v).__name__ for k, v in event.items()}), flush=True)
print("transcription_gate_events", len(events), flush=True)
for (day, reason), count in sorted(by_day.items()):
    print("transcription_gate_day", json.dumps({"day": day, "reason": reason, "count": count}), flush=True)
for (version, reason, tier), count in sorted(counts.items(), key=lambda item: -item[1]):
    print("transcription_gate", json.dumps({"version": version, "reason": reason, "tier": tier, "count": count}), flush=True)

# Route health: every transcription invocation by day, route and response status.
status, routes = post(
    f"https://api.cloudflare.com/client/v4/accounts/{account}/workers/observability/telemetry/query",
    token,
    {"queryId": "transcription-routes-7888", "dry": True, "view": "events",
     "timeframe": {"from": since, "to": now},
     "parameters": {"datasets": ["cloudflare-workers"], "filterCombination": "and", "filters": [
         {"key": "$metadata.service", "operation": "eq", "type": "string", "value": "ai-proxy"},
         {"key": "$metadata.trigger", "operation": "regex", "type": "string",
          "value": "/v1/(listen|realtime|voice/transcribe)"}]},
     "limit": 5000},
)
route_events = routes.get("result", {}).get("events", {}).get("events", [])
print("transcription_route_status", status, len(route_events), flush=True)
route_counts = {}
for event in route_events:
    meta = event.get("$metadata", {})
    if meta.get("type") not in (None, "cf-worker-event"):
        continue
    workers_event = event.get("$workers", {}).get("event", {})
    response = workers_event.get("response", {}) if isinstance(workers_event, dict) else {}
    trigger = str(meta.get("trigger", ""))
    route = re.search(r"/v1/(listen|realtime|voice/transcribe)", trigger)
    day = datetime.datetime.fromtimestamp(event.get("timestamp", 0) / 1000, datetime.timezone.utc).strftime("%Y-%m-%d")
    key = (day, route.group(0) if route else "other", response.get("status") if isinstance(response, dict) else None)
    route_counts[key] = route_counts.get(key, 0) + 1
if route_events:
    sample = route_events[0].get("$workers", {}).get("event", {})
    print("transcription_route_event_shape", json.dumps(sorted(sample) if isinstance(sample, dict) else type(sample).__name__), flush=True)
for (day, route, code), count in sorted(route_counts.items()):
    print("transcription_route", json.dumps({"day": day, "route": route, "status": code, "count": count}), flush=True)
