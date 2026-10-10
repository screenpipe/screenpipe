# Semantic triggers for Pipes

In a Pipe's Config tab, choose **Add trigger → Semantic trigger**, describe a
condition, and opt in to cloud detection. The authenticated gateway holds the
Jev credential; the desktop uses the existing Screenpipe session.

The desktop checks recent captured screen text every two seconds and submits
all enabled semantic conditions on that device in one Jev request when the
observations change. There is no request when observations are unchanged or
empty. A single account may register three conditions across its Pipes and
devices, including disabled Pipes. Removing a condition releases its slot;
replacing conditions is an atomic quota operation. Saving requires connectivity.

The observation parser retains text and provenance and drops layout geometry.
The initial bound is six captures from the last 30 seconds, with at most 4,000
UTF-8 bytes of text per capture, marked when truncated. These are bounded screen
observations, not full recording history, screenshots, or audio. Flat text does
not prove visibility. Each question receives observations filtered using its
Pipe's app, window, content and capture-time permissions; configured PII filtering
uses the existing search endpoint.

A supported match fires on the transition into true. A clear non-match rearms
it; unknown evidence and provider errors do not. Pending deliveries retain an
immutable evidence snapshot and ID, survive restart, and use the existing Pipe
scheduler's completion and retry path. Source events wake the scheduler
immediately. Concurrent runs remain subject to its existing limits. Startup
establishes a baseline before evaluating changed observations.

## Service configuration

Before this can be used in a released desktop build:

- Configure the gateway's `JEV_API_KEY` Worker secret for the TypeSafe account.
- Apply `migrations/0009_semantic_triggers.sql`; the normal required-migration
  script includes it. The D1 registry stores only account and trigger IDs.
- Deploy the gateway and ship the desktop changes through the normal release
  process. No production deployment or desktop publication was performed here.

`POST /v1/semantic-triggers` accepts `register`, `release`, and `evaluate`.
Registration/evaluation use the paid hosted-AI boundary. Release requires account
authentication but can free slots after hosted-AI entitlement ends. Evaluation
uses the background cost lane and the existing reservation/settlement ledger.
Failures emit a sanitized cause and `outcome=no_decisions` through the existing
support telemetry; captured content and credentials are excluded.

## Verification

Focused Rust tests cover batching, per-Pipe evidence filtering, the fourth
trigger, persistent match state, failure/restart delivery, and immediate scheduler
wake-up. Gateway tests exercise actual local D1 transactions, concurrent devices,
quota persistence, replacement, request validation, and the collected redacted
Sentry envelope after a provider failure. UI tests and the browser mock cover
consent, saving, quota feedback and retained input after a failed save.

A live Jev smoke request using the implementation's question builder returned
all three expected choices (supported, contradicted, unknown) in one 220 ms
request. This used explicitly synthetic observations to validate API behavior;
it is not a new accuracy benchmark or proof of released native-app operation.
