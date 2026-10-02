---
name: screenpipe-process-guide
description: "Convert a recorded or starred procedure into a reusable guide with verified steps and explicit gaps."
---

# process guide

Identify the procedure and intended audience. Use screenpipe-api to recover a complete demonstration or several relevant occurrences. Follow the actual sequence and inspect the necessary frames or artifact references.

Write prerequisites, the trigger, steps with observable results, meaningful branches, and a final verification. Use exact UI labels only when visible in the source or verified in the current app. Keep unexplained gaps explicit; do not fill them with invented clicks, commands, or permissions.

Remove account-specific identifiers, secrets, and private examples. Distinguish instructions captured from a demonstration from a procedure independently tested. Return the guide in the requested destination; packaging it as a persistent skill or publishing it requires that scope to be authorized.

For starred work, retrieve captured evidence directly with screenpipe-api's starred-only search and a bounded time range. For broader workflow review, use the activity summary's starred intervals to prioritize existing evidence; retrieve missing steps only when needed. A star indicates intent, not repetition, completion or time savings. Do not add interval history to standing prompts.
