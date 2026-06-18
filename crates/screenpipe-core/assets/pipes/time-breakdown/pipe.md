---
schedule: manual
enabled: true
template: true
title: Time Breakdown
description: "Where your time went — by app, project, and category"
icon: "⏱"
featured: true
---

Analyze my app usage from today (last 12 hours). Read the screenpipe skill first. Use limit=10 per search, max 4 searches. Prefer /raw_sql with COUNT(*) and GROUP BY app_name over the frames table — query the API only, do not write or run code.

Use this exact format with durations and percentages:

## By Application
- Each app with duration and percentage, sorted by time (e.g. "VS Code: 2h 15min (28%)").

## By Category
- Group into: coding, meetings, browsing, writing, communication, other. Show hours and % per category.

## By Project
- Group related activity by project/topic. Name specific repos or tasks.

## Focus Score
- focused / total as a percentage. Focused = coding + writing; unfocused = browsing + app-switching.

End with: "**Suggestion:** [one specific change to improve tomorrow]"
