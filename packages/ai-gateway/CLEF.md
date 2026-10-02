# Clef decisions for Screenpipe

`POST https://api.screenpi.pe/v1/decisions` runs Clef directly through the
existing Workers AI binding. It uses Screenpipe bearer authentication, paid-plan
eligibility, request rate limits, and cost reservations. Backend runners can
use their existing service credential. Never put that credential or a Cloudflare
token in a desktop client.

```ts
const response = await fetch('https://api.screenpi.pe/v1/decisions', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${screenpipeSessionToken}`,
    'Content-Type': 'application/json',
    'x-device-id': deviceId,
    'x-screenpipe-workload': 'pipe', // omit for interactive calls
  },
  body: JSON.stringify({
    model: 'clef', // or 'clef-flash'
    state: 'The screen shows a video meeting with three participants.',
    questions: {
      meeting: { type: 'noul', instructions: 'Is the user in a meeting?' },
      activity: {
        type: 'choice', instructions: 'What is the user doing?',
        criteria: { meeting: 'In a meeting', coding: 'Writing software', email: 'Reading email' },
      },
      relevance: {
        type: 'score', instructions: 'How strong is the evidence of a meeting?',
        criteria: ['No evidence', 'Weak evidence', 'Strong evidence'],
      },
    },
  }),
});
if (!response.ok) throw new Error(`Decision request failed: ${response.status} ${await response.text()}`);
const decision = await response.json();
// answers.meeting.noul is a probability, not a boolean.
// answers.activity.choice selects an option, with per-option probabilities.
// answers.relevance.score is weighted over zero-based rubric levels.
```

State can be text, an object, or an array. Accepts 1–64 questions and at most
13 MiB of JSON. Optional `images` accepts up to four PNG/JPEG/WebP base64 data
URLs or `{content_type, base64}` objects. Cloudflare validates its 4 MiB / 16
megapixel per-image and 8 MiB aggregate decoded limits. Remote image URLs are
rejected. Cloudflare's context window is 65,536 tokens; oversized text can be
truncated by the provider. Send only the context needed for the decision.

This enables explicit hosted inference. It does not change chat models, trigger
uploads, or send local recordings automatically. Callers must use the product's
existing consent and hosted-AI controls before sending recorded context.
Evaluate task accuracy before using probabilities for actions.

Metered cost is $0.24/M input tokens for Clef and $0.09/M for Clef-flash, with
no output-token charge. Calls bypass AI Gateway Unified Billing. Eligible startup
credits offset Workers AI invoices subject to balance, expiry, and product cap;
the endpoint does not verify the grant's remaining balance.

Invalid input returns 400, unauthenticated callers 401, unsupported plans 403
(or 503 when plan verification is unavailable), oversized bodies 413, and
capacity exhaustion 429. Provider failures use the existing request-id error
response and Sentry collection, preserving a bounded provider code without raw
state/images/provider messages. Route audits record model, workload, latency,
direct billing path, and outcome.

```sh
bun test src/test/decisions.integration.test.ts --timeout=30000
bunx tsc --noEmit
```

The integration test uses the real Worker runtime, isolated migrated D1 and
Durable Objects, and a synthetic AI binding. It checks cost settlement,
auth/body limits, the Sentry envelope after redaction, and persisted spend
enforcement after restart. Live inference is a separate acceptance check.

[Cloudflare model contract](https://developers.cloudflare.com/workers-ai/models/clef/)
