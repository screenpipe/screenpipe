---
name: screenpipe-process-guide
description: "Convert a demonstrated procedure into a reusable guide with verified steps and explicit gaps."
---

# process guide

Identify the procedure and intended audience. Use screenpipe-api to recover a complete demonstration or several relevant occurrences. Follow the actual sequence and inspect the necessary frames or artifact references.

Write prerequisites, the trigger, steps with observable results, meaningful branches, and a final verification. Use exact UI labels only when visible in the source or verified in the current app. Keep unexplained gaps explicit; do not fill them with invented clicks, commands, or permissions.

Remove account-specific identifiers, secrets, and private examples. Distinguish instructions captured from a demonstration from a procedure independently tested. Return the guide in the requested destination; packaging it as a persistent skill or publishing it requires that scope to be authorized.
