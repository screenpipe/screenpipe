---
name: screenpipe-team
description: Query the org's screenpipe telemetry as an enterprise admin — devices, members, recent activity, and substring search across the team's screen recordings and audio transcripts. Use when the user asks about their team, a teammate's activity, what their organization worked on, app usage across the org, or anything that requires seeing data beyond the user's own machine. The skill is only installed for enterprise admins; ordinary users won't see it.
---

# Screenpipe Team

Query the customer's team telemetry. Data lives in the customer's own Azure Blob (or our R2 bucket for hosted ingest). All reads transit our control plane today (`https://screenpi.pe/api/enterprise/v1/*`) which checks the bearer's admin role and returns matched records. The model (you) is the user's own local pi-agent — your prompts and the user's chat never leave their machine.

## Auth

The skill authenticates with an **enterprise admin API token** the admin minted once on `https://screenpi.pe/enterprise?tab=tokens` (with scopes `read:devices`, `read:search`, `read:records`) and pasted into Settings → Privacy → Admin Team API Token. The desktop stored it in `~/.screenpipe/enterprise.json` under `team_api_token`.

License-key + token are intentionally separate concerns:
- `license_key` proves *which org* this machine belongs to (deployed by IT, same on every employee's device).
- `team_api_token` proves *this user is an admin of that org* and grants the read scopes. Employees who don't have it can't query team data even though they have the same license_key.

```bash
TEAM_TOKEN=$(jq -r .team_api_token ~/.screenpipe/enterprise.json)
SP_URL="https://screenpi.pe/api/enterprise/v1"
AUTH_HEADERS=(-H "Authorization: Bearer $TEAM_TOKEN")
```

If `TEAM_TOKEN` is empty / null, tell the user verbatim:

> I need an admin API token to query team data. Open
> https://screenpi.pe/enterprise?tab=tokens, create one with the
> `read:devices`, `read:search`, `read:records` scopes, then paste it
> into Settings → Privacy → Admin Team API Token. Token can be rotated
> or revoked any time from the same page.

Then stop. Don't try to call the endpoints.

If the server returns **401** the token is invalid, expired, or revoked — tell the user to mint a new one. **403** means the token is missing a required scope — same dashboard, regenerate with the right scopes.

## Context window protection

API responses can be large (matched OCR text + audio transcripts). **Always**:
1. Write curl output to a file (`-o /tmp/sp_team_*.json`).
2. Check size (`wc -c /tmp/sp_team_*.json`).
3. If over ~5KB, extract with `jq` rather than dumping the file into context.
4. Cite results by `t` (timestamp) and `device` (hostname or pseudonym) — don't quote multi-paragraph blocks.

## Progressive disclosure

Escalate from cheap to expensive:

| Step | Endpoint | When |
|------|----------|------|
| 1 | `GET /devices` | Always start here when the user names a teammate — match the human to a `device_id`. |
| 2 | `GET /search?q=...&since_hours_ago=24` | The user has a topic (e.g. "atlas", "q3 forecast"). Default 24h, narrow further if results are noisy. |
| 3 | `GET /search?q=...&device_id=...` | Once you know whose data you want, scope to that device. |
| 4 | `GET /records?device_id=...&since_hours_ago=4` | "Walk me through what X did between Y and Z" — chronological dump. Use AFTER you know the device + window from steps 1–3. |

Default `since_hours_ago` to 24 unless the user implies otherwise. Max 720 (30d).

---

## 1. List devices

```bash
curl -s "${AUTH_HEADERS[@]}" "$SP_URL/devices" -o /tmp/sp_team_devices.json
jq '.devices[] | {device_id, label, platform, last_seen}' /tmp/sp_team_devices.json
```

Each device has:
- `device_id` — the opaque id used by `/search` and `/records`
- `label` — hostname OR pseudonym (e.g. `john-mbp` or `user_a3f201` for anonymous devices)
- `last_seen` — ISO 8601; "offline" if older than ~30min
- `platform`, `app_version` — for debugging stale clients

When the user names a person ("what's john doing"), match against `label`. If multiple devices match, ask the user which one (or query all and aggregate).

## 2. Search

```bash
curl -s "${AUTH_HEADERS[@]}" \
  "$SP_URL/search?q=atlas&since_hours_ago=24&limit=20" -o /tmp/sp_team_search.json
jq '.results[] | {t, device, app, window, snippet: (.text // .transcription // "")[0:160]}' /tmp/sp_team_search.json
```

### Parameters

| Name | Description |
|------|-------------|
| `q` | Case-insensitive substring across app_name, window_name, frame text, audio transcription, speaker, device label, browser URL. Empty = all records in window. |
| `device_id` | Restrict to one device. Get it from `/devices`. |
| `app_name` | Exact match on app_name (case-insensitive), e.g. `Excel`, `Slack`. |
| `since_hours_ago` | Default 24, max 720. Smaller = faster + cheaper. |
| `since` / `until` | ISO 8601 alternatives to `since_hours_ago`. |
| `limit` | Default 50, max 200. Keep small to protect context. |

Response includes `truncated: true` if the byte budget was hit before the full window was scanned — narrow `q` or `since_hours_ago` and re-query rather than ask for `limit=200`.

## 3. Records (chronological)

```bash
curl -s "${AUTH_HEADERS[@]}" \
  "$SP_URL/records?device_id=DEVICE&since_hours_ago=4&kind=frame&limit=100" \
  -o /tmp/sp_team_records.json
jq '.records[] | {t, app, window, text: (.text // "")[0:120]}' /tmp/sp_team_records.json
```

| Name | Description |
|------|-------------|
| `device_id` | Required-ish. Without it you get the whole org — usually noisy. |
| `kind` | `frame` (screen) / `audio` / `all`. Default `all`. |
| `since_hours_ago` / `since` / `until` | Time window. |
| `limit` | Default 50, max 200. |

Records come oldest-first so you can describe a chronological flow.

---

## Privacy & expectations

- Some devices report as `user_xxxxxx` instead of a hostname — those users chose **anonymous** visibility. You can chat about them by pseudonym but should never speculate about their real identity. If the user asks "who is `user_a3f201`", say: that user opted into anonymous visibility and identity cannot be revealed without their consent.
- Don't dump raw text in your reply when summarizing — quote short snippets, cite by timestamp + device.
- Don't volunteer data the user didn't ask for. If they ask about engineering, don't include design.

## When NOT to use this skill

- The user is asking about **their own** machine → use `screenpipe-api` (queries `localhost:3030`).
- The user isn't an admin → this skill shouldn't even be installed; if it is, the API will return 403 and you should tell them their license role doesn't permit team queries.
