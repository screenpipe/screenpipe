<!-- screenpipe — AI that knows everything you've seen, said, or heard -->
<!-- https://screenpipe.com -->

# Optional Workflows chat sharing

<!-- doc-covers: none -->

Sharing is off by default. The existing Workflows scheduled-task dialog offers
an independent optional switch. Settings → Privacy offers the same control,
a separate training permission, and deletion. Enabling scheduled tasks alone
never grants sharing permission.

Only `desktopAssistant.ask` captures a completed future user question and final
assistant text. No prompt, history array, workflow document, tool result,
attachment, screenshot, audio, or main Chat conversation is added to the payload.
The answer may quote private context; the notice says so. Saved conversations
are never backfilled. Cancelled/failed turns are excluded.

An opt-in saves server consent plus a local account/epoch binding, sets the
existing `piiBackend` preference to Tinfoil, and remembers the previous backend.
Turning off stops pending uploads, clears the local binding before calling the
server, and restores the previous backend. An unconfirmed server update is
shown as such. Other devices cannot upload after server revocation, even with
an old local setting. Changing the cloud backend is blocked while a local
binding exists. This does not turn on the recording text/image workers or
change their selected categories. Shared chats always use all sensitive classes.

The contribution redactor pins the production Tinfoil enclave and attestation
repository. Every message, including very short names, reaches its AI filter.
No regex-only fallback is permitted. Redaction/attestation failure, timeout,
account change, consent-epoch change or rollout unavailability drops the turn.
This is best-effort data minimization, not a guarantee of anonymization.

V1 intentionally skips an entire turn if either message exceeds 1,800 UTF-8
bytes. It never truncates text or splits through identifiers to fit the filter.
Only two contributions can be pending at once. Raw text is never queued on disk,
logged by this collector, or retried. The redaction command has a 25-second
budget per message; upload requests include bounded response-body reads.

The companion website PR defines `/api/workflow-contributions`: authenticated
consent, upload and deletion; service-role-only Postgres tables; account/epoch
checks and deduplication under the consent row lock; a 100-turn/account/day cap;
30-day expiry and hourly cleanup. Small text rows live in Supabase Postgres so
consent, ingestion and deletion remain one transaction without Storage orphans.

Model-training permission is recorded separately. All rows are currently
`training_eligible = false`: neither consent nor PII redaction proves rights or
provenance. No training/export/Langfuse integration is included. Unknown or
Google-derived content must not be exported for generalized model training.
Managed desktop deployments and known organization accounts are excluded.

## Deployment and review

Apply the companion migration and deploy the backend before enabling the
`WORKFLOW_CONTRIBUTIONS_ENABLED` server flag. It defaults off. The desktop control
is unavailable if the backend/migration cannot be reached. Review the versioned
in-app collection notice against the existing privacy policy and data processor
terms before activation; this PR does not establish legal approval or alter the
published policy. No production migration, deployment, model training, real-chat
collection, app restart, or release is part of this PR.

Native unit tests use fictional text and a fake redactor. UI/transport tests
mock external services. They do not establish the live enclave's redaction
accuracy or an installed-app end-to-end result.
