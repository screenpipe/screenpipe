<!-- screenpipe — AI that knows everything you've seen, said, or heard -->
<!-- https://screenpipe.com -->

# Enterprise AI accounting

Gateway requests retain their existing allowance actor, plan, lane, workload and trial fields.
They can additionally carry `enterprise_id_hash` and `ai_operation` for accounting.
These fields do not authorize a workspace, change spend limits, or establish training consent.

## Identity authority

Account requests use the enterprise hash from the authenticated, identity-matched website
response. The existing website contract omits a workspace hash for ambiguous multi-org accounts.
No organization is inferred from an account plan, prompt, filename or arbitrary caller header.

Backend requests authenticated with `AI_GATEWAY_SERVICE_TOKEN` may supply:

- `X-Screenpipe-Enterprise-Id-Hash`: the website's existing lowercase, 64-character HMAC label.
- `X-Screenpipe-AI-Operation`: a bounded lowercase operation slug, such as `studio-chat`.

These headers are ignored for anonymous and account-authenticated callers. The website
must derive them from its authorized workspace or authenticated runner, never unverified JSON.
The engine forwards the runner's `SCREENPIPE_ENTERPRISE_ID_HASH` on scheduled cloud-pipe calls.
The website heartbeat supplies that value using the existing training-metadata HMAC key;
accounting labels themselves carry no training permission.

## Reading usage

Group Cloudflare AI Gateway estimated inference cost by `enterprise_id_hash` and,
where present, `ai_operation`. Keep requests without a hash explicitly unattributed.
This removes the need to reconstruct organizations from runner IP addresses for tagged requests.

The companion website change emits `screenpipe.enterprise-ai-usage` receipts for direct
provider calls and Studio agent turns. They contain token/cache counts and metadata only.
Missing usage or attribution is unknown; SDK custom-model cost placeholders are not bills.
Gateway-backed receipts have `billing_source=gateway` and must not be added to Gateway
cost a second time. Direct-provider receipts require provider pricing and billing reconciliation.
Log emission is not a durable or invoice-reconciled financial ledger.

## Rollout and limits

Deploy the gateway receiver and website sender, then adopt the updated engine through the
normal CLI rollout. Old clients remain compatible but do not gain tags retroactively.
This PR does not deploy, publish an app, migrate data, add a dashboard or reconcile invoices.
Unrelated external coding-agent sessions still require an explicit customer association.
