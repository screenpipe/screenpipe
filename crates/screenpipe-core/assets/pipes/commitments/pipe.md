---
schedule: every 30m
enabled: false
history: false
trigger:
  events:
    - meeting_ended
template: true
title: Commitments
description: Keeps promises and follow-ups current as new work context arrives
featured: true
---

Maintain one living commitments inbox from the user's recent work context.

Read the screenpipe skill first. Then call `structured_output` with `get_targets` before searching. The returned targets include exact schemas, the prior payload, user feedback, and per-item state. Treat the requested target time range as authoritative.

Search the API only. Use at most 5 bounded searches with `limit=10`, covering messages, meetings, email, documents, and issue trackers visible in Screenpipe. Prefer a recent delta, but use enough overlap to reconcile open items. Never run code or probe files in other apps.

## Reconciliation contract

- Extract only explicit promises, requests, assigned actions, waiting dependencies, deadlines, cancellations, and strong evidence of completion.
- Reuse a stable item `id` when later evidence concerns the same real-world commitment. Build IDs from durable source identity plus the normalized commitment, not list position or wording alone.
- Read the prior payload before deciding an item is new. Merge duplicates and attach the clearest current context.
- User item state is authoritative. Apply corrections. Do not return dismissed items as active. Do not return resolved items as active unless later explicit evidence clearly reopens them. Do not return an item as active while its snooze time is in the future.
- Absence of later evidence is never proof of completion. If completion is only inferred, keep the item open and label it `needs review`.
- Keep source snippets minimal. Include enough source and timing for the user to understand why the item exists.
- Never send messages, create external tasks, close issues, or change another app. The Live View's handoff button performs that separate, user-confirmed flow.

## Interactive list items

For actionable `list.v1` targets, use the optional interactive fields from the exact target schema:

- `id`: stable across runs for the same commitment;
- `title`: concise verb-first next action;
- `subtitle`: owner, dependency, or the reason it remains open;
- `status`: one of `needs review`, `due`, `open`, or `waiting`;
- `dueAt`: RFC3339 only when the timing is source-backed;
- `source`: short app + person/thread/meeting label;
- `resolveLabel`: `done`;
- `actions`: `resolve`, `snooze`, `correct`, `dismiss`, and `handoff`.

Rank the main inbox by urgency, explicitness, and recency. Keep it calm: at most 12 open items. Submit empty arrays when no item is supported instead of inventing work.

Fill every assigned target whose schema can be supported. Metrics must be calculated from the same reconciled set. The changes timeline should show only material creates, deadline/owner changes, reopened items, or source-backed completions. The context note should explain uncertainty or missing sources plainly.
