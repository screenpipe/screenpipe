# Shared pseudonyms and field redaction evidence

<!-- doc-covers: crates/screenpipe-config/src/redaction.rs, crates/screenpipe-redact/src/worker/audit.rs, crates/screenpipe-redact/src/pseudonym.rs, crates/screenpipe-core/src/pii_removal.rs, crates/screenpipe-db/src/db/redaction_status.rs, crates/screenpipe-engine/src/routes/search.rs, crates/screenpipe-engine/src/routes/frames.rs -->
<!-- doc-verified: c972e015b64ccd271ee855a1ed69ef458d63a0ba -->

## Shared pseudonyms

Enable `--pii-redaction-pseudonyms` and set
`SCREENPIPE_PSEUDONYM_KEY_FILE` to an existing file containing exactly 32 random
binary bytes. Provision the same private key file on installations belonging to
the same organization. Use a separate key for each organization and restrict file
access to the service user. Screenpipe reads the file once at server startup;
it does not create, copy, distribute, or rotate shared keys. Missing or invalid
requested keys fail startup instead of silently replacing values with static tags.
Do not put key bytes in command-line arguments, logs, or settings JSON.

The CLI and embedded server share the loaded pseudonymizer between inline
`--use-pii-removal` and async text redaction. Default inline redaction therefore
preserves correlation for the identifiers it detects, even when async redaction
is disabled. Detection coverage and enabled categories are unchanged. The
span-less Tinfoil adapter still cannot pseudonymize its own model detections.

Shared-key normalization v1 lowercases email addresses (including the local
part), removes phone punctuation without inferring country codes, and removes
spacing/separators in SSNs, cards, and IBANs. Case-sensitive secrets retain their
case. Identical normalized values need the same category/subtype to correlate;
this is not person matching across unrelated identifiers or detector categories.

Without the environment variable, existing per-install keys and token derivation
remain unchanged. Pseudonyms stay opt-in. Existing static redactions cannot be
reconstructed, and changing keys or opting into normalization changes future
tokens. Secure key provisioning is the embedding application's responsibility.

## Read processing evidence

`GET /frames/:id/metadata` includes a `redaction` object. Add
`include_redaction=true` to `/search` for evidence on screen (`OCR`),
accessibility (`UI`), input-event, and audio results. Evidence is read in the
same request snapshot as search results; these requests bypass the response
cache. Frame metadata includes image and associated-element evidence, including
the source frame when elements were deduplicated.

Each field exposes:

- `processed`: whether an operation was recorded. New captures explicitly track
  fields with no operation as `false` and `result: "skipped"`. Historical fields
  without evidence remain `null`; legacy timestamps are exposed without inventing
  a method or outcome.
- `processed_at`: Unix seconds when the operation ran, rather than capture time.
- `method`: `inline_regex`, `async_regex`, `async_model`, or
  `async_regex_fallback`, recorded by the path that actually ran.
- `pseudonymized`: whether a stored replacement used pseudonyms. An existing
  pseudonym remains attributed when a later pass finds no additional matches.
- `result`: `replaced`, `no_match`, or `skipped`.
- `complete`: whether the whole selected field was covered successfully. A
  model failure with regex fallback, a parsing failure, or excluded structured
  leaves keeps this false. `cause` explains partial or failed processing without
  including captured text or detector response bodies.
- `steps`: the latest persisted observation for each method on this version of
  the field. This is processing evidence, not an unlimited operation history.

Inline evidence is saved with the source write. Background evidence is saved
atomically with its transformed value after checking source and policy identity.
Source edits invalidate the evidence; archival preserves it. Deferred elements
remain explicitly pending until materialized. OCR elements retain exact per-leaf inline outcomes from the original
processing call, including no-match leaves alongside pseudonymized leaves. The
writer derives that metadata from the already allocated input/output and saves
only outcomes; it does not persist raw source or run detection again. Element
metadata also links to its source structured field and records asynchronous
processing. Structured redaction preserves keys and geometry.

Existing `receipts.frames` and `receipts.image` remain separate current-policy
release authority, including source revision and completion time. Historical
receipt times can be unknown. Legacy timestamps, current settings, and
placeholder-shaped strings never grant completion. Audio bookkeeping receipts
do not establish that a transcription was redacted; audio reports actual inline
processing, without adding AI audio processing.

## Search only fully processed records

Use `/search?fully_redacted_only=true`. This also returns redaction metadata.
Filtering happens in SQL before pagination and counts and applies only to that
request. Ordinary reads and the configured required-privacy policy are unchanged.

`fully_redacted` requires successful current-policy evidence for every present
stored field, or a valid processing receipt. Frames additionally require their
image and associated elements, including pending materialization. Fields left
out of the configured redaction columns, skipped work, and degraded fallback
cannot establish completion. Sealed hybrid payloads require explicit evidence;
cleared SQLite staging columns never count as empty content. Audio requires
actual transcription evidence even when it has an administrative receipt.

The flag means processing completed under the configured detector/category
policy; it does not assert that a detector can recognize every possible secret.
Use `--require-pii-completion` and release/export APIs where model-backed release
enforcement is required.

## Failures and authorized support diagnostics

Failed or degraded processing retains durable pending work. A temporary model
failure does not cache a successful outcome, so the same source can recover on a
later pass. Existing cloud backoff remains in force. Recording continues through
the existing writer while reconciliation is pending.

The normal authorized support report includes a dated last text/image failure
observation with record ID, field, actual method, result, retryability, and a
sanitized technical cause. These observations survive process restart and log
rotation. The collector reads only these diagnostic metadata files; it does not
read captured content or key files. A historical failure observation is evidence
of that attempt, not a claim that a device is currently failing or recovered.
