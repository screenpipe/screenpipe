---
name: user-feedback
description: Query user feedback logs submitted via the app's "send logs" button. Use when debugging user-reported issues, searching for crash patterns, or reviewing feedback.
tools:
  - Bash
  - WebFetch
---

# User Feedback Logs

Query feedback and logs submitted by users through the screenpipe app's "send logs" button. Data is stored in Supabase and accessible via the admin logs API.

## Setup

The API requires a bearer token. Set `LOGS_ADMIN_SECRET` in your environment or pass it directly. Ask the project maintainer for the token if you don't have it.

```bash
export LOGS_ADMIN_SECRET="<token>"
```

## API Endpoint

```
GET https://screenpi.pe/api/admin/logs
Authorization: Bearer $LOGS_ADMIN_SECRET
```

## Query Parameters

| Param | Description | Example |
|-------|-------------|---------|
| `q` | Search feedback text (case-insensitive) | `q=crash` |
| `os` | Filter by OS | `os=darwin`, `os=windows`, `os=linux` |
| `app_version` | Exact version match | `app_version=2.2.290` |
| `identifier` | Filter by user/machine ID | |
| `screenpipe_id` | Filter by analytics ID | |
| `from` | Start date (ISO 8601) | `from=2026-03-30T00:00:00` |
| `to` | End date (ISO 8601) | `to=2026-03-31T00:00:00` |
| `limit` | Results per page (max 200) | `limit=20` |
| `offset` | Pagination offset | `offset=20` |

## Common Queries

### Recent feedback (last 24h)
```bash
curl -s "https://screenpi.pe/api/admin/logs?limit=20&from=$(date -u -v-24H '+%Y-%m-%dT%H:%M:%S' 2>/dev/null || date -u -d '24 hours ago' '+%Y-%m-%dT%H:%M:%S')" \
  -H "Authorization: Bearer $LOGS_ADMIN_SECRET" | jq '.logs[] | {created_at, os, app_version, feedback: .feedback_text}'
```

### Search for a keyword in feedback
```bash
curl -s "https://screenpi.pe/api/admin/logs?q=audio&limit=20" \
  -H "Authorization: Bearer $LOGS_ADMIN_SECRET" | jq '.logs[] | {created_at, os, app_version, feedback: .feedback_text}'
```

### Windows-only issues
```bash
curl -s "https://screenpi.pe/api/admin/logs?os=windows&limit=30" \
  -H "Authorization: Bearer $LOGS_ADMIN_SECRET" | jq '.logs[] | {created_at, os_version, app_version, feedback: .feedback_text}'
```

### Feedback for a specific version
```bash
curl -s "https://screenpi.pe/api/admin/logs?app_version=2.2.290&limit=50" \
  -H "Authorization: Bearer $LOGS_ADMIN_SECRET" | jq '.logs[] | {created_at, os, feedback: .feedback_text}'
```

### Count total feedback entries
```bash
curl -s "https://screenpi.pe/api/admin/logs?limit=1" \
  -H "Authorization: Bearer $LOGS_ADMIN_SECRET" | jq '{total: .total}'
```

## Response Shape

```json
{
  "logs": [
    {
      "id": "uuid",
      "type": "user",
      "identifier": "user_abc123",
      "os": "darwin",
      "os_version": "15.3.2",
      "app_version": "2.2.290",
      "feedback_text": "audio stopped working after update",
      "screenpipe_id": "analytics_id",
      "created_at": "2026-03-30T15:30:00Z",
      "file_path": "logs/user/abc123/2026-03-30T15:30:00.log",
      "screenshot_url": "logs/user/abc123/2026-03-30T15:30:00_screenshot.png",
      "video_url": "logs/user/abc123/2026-03-30T15:30:00_video.mp4"
    }
  ],
  "total": 1234,
  "limit": 20,
  "offset": 0
}
```

## Tips

- `file_path`, `screenshot_url`, and `video_url` are S3 keys, not direct URLs. You can't download them directly — they need signed URLs generated server-side.
- `feedback_text` can be null if the user just sent logs without writing a message.
- `identifier` is either a Clerk user ID (starts with `user_`) or a random machine UUID for anonymous users.
- Results are always sorted newest first.
- Use `from`/`to` to narrow time ranges when investigating specific incidents.
- Cross-reference `app_version` with git tags to check if the issue is fixed in a newer release.
