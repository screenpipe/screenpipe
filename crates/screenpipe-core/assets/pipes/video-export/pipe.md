---
schedule: manual
enabled: true
template: true
title: Export Video Clip
description: "Create a video of your recent screen activity"
icon: "🎬"
featured: false
---

Export a video of my screen activity from the last 5 minutes.

Read screenpipe skill first.

Use the POST /frames/export endpoint with the time range and fps=1.0. Then show me the exported video file path as an inline code block so I can watch it.

If the export is large, suggest a lower fps or shorter time range.
