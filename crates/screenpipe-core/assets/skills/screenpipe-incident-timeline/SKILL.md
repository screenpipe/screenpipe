---
name: screenpipe-incident-timeline
description: "Reconstruct a bounded incident timeline and separate observed events from suspected causes."
---

# incident timeline

Resolve the incident, affected system, and time window. Use screenpipe-api to recover relevant screens and conversations, then corroborate with available logs, monitoring, and service receipts. Normalize timestamps to one stated timezone while retaining source timestamps where needed.

List the first observed symptom, material changes, actions taken, and recovery evidence in chronological order. Distinguish when an event happened from when someone reported it. Label causal explanations as hypotheses unless directly established.

State the last verified condition and remaining uncertainty. An error disappearing from a screen does not prove recovery; cite a successful relevant operation or current health evidence. Propose follow-up investigation within scope. Do not restart services, roll back changes, or notify others without authorization.
