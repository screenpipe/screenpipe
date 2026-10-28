# Shared pseudonyms and frame redaction status

<!-- doc-covers: crates/screenpipe-redact/src/pseudonym.rs, crates/screenpipe-core/src/pii_removal.rs, crates/screenpipe-db/src/db/redaction_status.rs, crates/screenpipe-engine/src/routes/search.rs, crates/screenpipe-engine/src/routes/frames.rs -->
<!-- doc-verified: a7f07fbd2 -->

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

## Read stored frame processing evidence

`GET /frames/:id/metadata` includes a `redaction` object alongside the frame ID
and capture timestamp. `GET /search?include_redaction=true` adds the same object
to screen (`OCR`) result rows. Search status is opt-in and bypasses the response
cache. The status describes the current stored frame, not an atomic certification
of the search response, and does not cover elements, input events, or audio.

`fields` exposes existing processing timestamps for `full_text`,
`accessibility_text`, `accessibility_tree_json`, `window_name`, `browser_url`,
`text_json`, and `image`. Timestamps are Unix seconds. A timestamp means a worker
visited that field. It does not establish detector success or that PII was found.
`processed: null` means the historical evidence cannot distinguish unprocessed
content from inline processing without a recorded timestamp. `method`, `result`,
and `pseudonymized` remain null when no per-field provenance was stored.

`receipts.frames` and `receipts.image` expose separate current-policy completion
states and source revisions. New completion times are saved atomically with the
existing release receipt. Old receipts have unknown completion times. Editing
source content or changing policy invalidates completion, including its reported
time. Neither legacy timestamps nor the presence of a placeholder grants release
permission. A text receipt does not certify an image or associated elements.

Use the existing `--require-pii-completion` mode and release/export APIs when
consuming only content certified under the configured policy. These status
fields are diagnostic evidence, not a replacement for that enforcement.

## Remaining audit work

This change exposes existing evidence and records new receipt completion times.
It does not yet persist detailed per-field inline/async method, fallback,
pseudonymization, detection/no-match/skipped outcomes, or provide a per-request
fully-redacted-only search filter. Those require provenance to travel with every
capture and worker write, including hybrid storage and structured copies. The API
returns unknown values rather than attributing historical work from current flags.
