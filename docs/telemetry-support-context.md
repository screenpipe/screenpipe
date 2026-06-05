# Telemetry Support Context

Customers who embed the Screenpipe CLI can attach a stable, non-PII support
identity to Screenpipe's existing telemetry pipeline. This lets Screenpipe support
filter Sentry errors and PostHog events by customer, deployment, or host app.

```bash
export SCREENPIPE_SUPPORT_ID="spcust_acme_123"
export SCREENPIPE_CUSTOMER_ID="acme"
export SCREENPIPE_DEPLOYMENT_ID="prod-laptop-fleet-01"
export SCREENPIPE_EMBEDDER="acme-agent"
export SCREENPIPE_EMBEDDER_VERSION="2026.6.4"

npx screenpipe record
```

## Environment Variables

| Variable | Purpose |
| --- | --- |
| `SCREENPIPE_SUPPORT_ID` | Stable support ID for this customer/user/deployment. Used as the CLI PostHog `distinct_id` when `SCREENPIPE_ANALYTICS_ID` is not set, and attached to Sentry/PostHog as `screenpipe_support_id`. |
| `SCREENPIPE_CUSTOMER_ID` | Customer or organization key, attached as `screenpipe_customer_id`. |
| `SCREENPIPE_DEPLOYMENT_ID` | Fleet, endpoint group, device, or environment key, attached as `screenpipe_deployment_id`. |
| `SCREENPIPE_EMBEDDER` | Name of the app embedding or launching Screenpipe, attached as `screenpipe_embedder`. |
| `SCREENPIPE_EMBEDDER_VERSION` | Version of the embedding app, attached as `screenpipe_embedder_version`. |

Aliases are also accepted for easier integration with existing deployments:

| Canonical variable | Accepted aliases |
| --- | --- |
| `SCREENPIPE_SUPPORT_ID` | `SCREENPIPE_TELEMETRY_ID` |
| `SCREENPIPE_CUSTOMER_ID` | `SCREENPIPE_ORG_ID`, `SCREENPIPE_TELEMETRY_CUSTOMER_ID` |
| `SCREENPIPE_DEPLOYMENT_ID` | `SCREENPIPE_TELEMETRY_DEPLOYMENT_ID` |
| `SCREENPIPE_EMBEDDER` | `SCREENPIPE_HOST_APP`, `SCREENPIPE_TELEMETRY_HOST_APP` |
| `SCREENPIPE_EMBEDDER_VERSION` | `SCREENPIPE_HOST_VERSION`, `SCREENPIPE_TELEMETRY_HOST_VERSION` |

`SCREENPIPE_ANALYTICS_ID` remains the highest-priority explicit PostHog
`distinct_id`. Use it only when you intentionally want to control the exact
person identity. Otherwise prefer `SCREENPIPE_SUPPORT_ID`.

## Privacy Boundary

These variables should contain opaque IDs, not emails or names. Screenpipe
telemetry still follows the normal telemetry settings: `--disable-telemetry`
turns it off, and telemetry does not include screen content, audio, transcripts,
or file contents.

The JavaScript/Swift SDK does not send first-party Screenpipe telemetry on its
own. If an SDK host wants Screenpipe support correlation, it should set the same
environment variables when launching the Screenpipe CLI/engine, and may also add
the same fields to the host application's own Sentry/PostHog reports.
