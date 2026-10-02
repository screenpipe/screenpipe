---
name: screenpipe-workflow-discovery
description: "Identify repeated work from recorded activity or starred examples and assess which steps could be automated."
---

# workflow discovery

Resolve the work area and review period. Use screenpipe-api to find multiple distinct occurrences of a candidate workflow. Describe the trigger, inputs, observed steps, outputs, exceptions, and human decisions with source pointers.

Count independent occurrences, not repeated frames or repeated discussion of one occurrence. Separate observed steps from inferred steps. If timing matters, use authoritative active time where available and label missing coverage; frame counts are not effort.

Assess a small automation candidate by its available tools, permissions, reversible boundaries, and observable completion criterion. Identify the decisions that still require a person. Do not claim time savings without a baseline or create a schedule, integration, or external action merely from discovering a pattern.

For starred work, retrieve captured evidence directly with screenpipe-api's starred-only search and a bounded time range. For broader workflow review, use the activity summary's starred intervals to prioritize existing evidence; retrieve missing steps only when needed. A star indicates intent, not repetition, completion or time savings. Do not add interval history to standing prompts.
