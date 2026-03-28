---
schedule: manual
enabled: true
template: true
title: Time Breakdown
description: "Where your time went — by app, project, and category"
icon: "⏱"
featured: false
---

Analyze my app usage from today (last 12 hours). Use limit=10 per search, max 4 searches. Prefer /raw_sql with COUNT/GROUP BY queries.

Read screenpipe skill first.

Use this exact format with durations and percentages:

## By Application
- List each app with duration and percentage, sorted by time (e.g. "VS Code: 2h 15min (28%)")

## By Category
- Group into: coding, meetings, browsing, writing, communication, other
- Show hours and percentage per category

## By Project
- Group related activities by project/topic. Name specific repos or tasks.

## Productivity Score
- Calculate: focused_work_hours / total_hours as a percentage
- Focused = coding + writing. Unfocused = browsing + switching.

End with: "**Suggestion:** [one specific change to improve tomorrow's productivity]"
