<!-- screenpipe — AI that knows everything you've seen, said, or heard -->
<!-- https://screenpipe.com -->

# Connection credential custody

> **Proposal, not implemented.** Preserve device execution and existing sync;
> add explicit cloud custody only for a connection that a cloud worker will use.
> This document does not change storage, migrate credentials, or enable a service.

<!-- doc-covers: crates/screenpipe-secrets, crates/screenpipe-connect/src/oauth.rs, crates/screenpipe-connect/src/oauth_refresh_scheduler.rs, crates/screenpipe-core/src/connections/sync.rs, crates/screenpipe-core/src/sync, crates/screenpipe-engine/src/sync_api.rs -->
<!-- doc-verified: b063e71c1d59693fe899192682071138769c2c79 -->

## Problem and decision

A connection that runs on a laptop cannot perform work while that laptop is
unavailable. Moving its token into a database does not solve execution or network
reachability. Conversely, sharing a connection between devices does not require
granting a cloud worker access to its credentials.

Choose credential custody together with execution location. Keep existing
connections unchanged. Introduce cloud connections through a separate, explicit
authorization flow, with one authoritative refresh owner per OAuth grant.

## Existing implementation

- [`screenpipe-secrets`](../crates/screenpipe-secrets/src/lib.rs) stores credentials
  in `secrets.sqlite`, separate from capture storage. With an encryption key,
  values use AES-256-GCM and the key is held in the OS keychain. The store also
  supports an unencrypted mode; do not describe every local installation as
  encrypted without checking its runtime configuration.
- [`oauth.rs`](../crates/screenpipe-connect/src/oauth.rs) reads and writes the
  secret store and supports legacy file migration and a no-store CLI fallback.
  Its refresh path preserves provider fields omitted from refresh responses.
- [`connections/sync.rs`](../crates/screenpipe-core/src/connections/sync.rs)
  already exchanges manual credentials and OAuth token JSON in a
  `ConnectionSyncManifest`, including rotation generations and deletion tombstones.
- [`sync_api.rs`](../crates/screenpipe-engine/src/sync_api.rs) uploads those
  manifests through [`SyncManager`](../crates/screenpipe-core/src/sync/manager.rs),
  which encrypts blob contents before upload. This is an existing credential-sync
  mechanism, not a cloud execution API. Encryption alone does not establish
  zero-knowledge custody; key derivation, recovery, and server access require
  separate verification before making that claim.

## Deployment choices

| Mode | Secret authority and execution | Benefit | Constraint |
| --- | --- | --- | --- |
| Device | Existing local store and local runner | Local network access; no new cloud custody | Runner must be available; device loss may require reconnecting |
| Device with sync | Existing encrypted sync and device runners | Connection availability across devices | Provider rotation and concurrent device refresh still need coordination |
| Managed cloud | Restricted cloud secret store and backend worker | Background jobs independent of a laptop; centralized administration | Greater breach impact, cloud availability dependency, and credential-custody responsibility |
| Customer environment | Customer secret manager and runner | Customer controls region, network, and keys | Customer deployment, upgrades, monitoring, and recovery work |

Existing:

```text
device credential store -> device runner -> provider
          |
          +-> encrypted connection sync -> another device
```

Proposed additional path:

```text
explicit cloud authorization -> backend secret store -> cloud runner -> provider
                                      ^                     ^
                                      +--- owner/policy checks
desktop / web UI <--------------- connection status and permitted results
```

## Storage and API boundary

Store non-secret connection metadata in an authenticated database: opaque
connection ID, provider, account identity, owner user or organization, granted
scopes, expiry, custody, execution location, status, and credential version.
Account names and scopes are still private metadata, not public catalog data.

Keep access tokens, refresh tokens, client secrets, and sensitive session data
in a separate backend-only secret store. Supabase Vault is a possible managed
adapter, not a requirement for every deployment. Restrict access to decrypted
views and functions; encrypting rows does not prevent an authorized database
role from reading them. For customer-controlled keys, select an adapter backed
by the customer's KMS or secret manager and verify its recovery requirements.

Every operation must resolve the authenticated principal and check connection
ownership and current organization policy. Database row policies protect
client-visible metadata; a privileged backend must perform its own authorization.
Do not expose an arbitrary secret-read or arbitrary-URL proxy endpoint. Provider
adapters enforce allowed destinations, operations, and scopes, including redirect
handling and protection against requests into unintended internal networks.

The UI receives status and permitted provider results, never cloud credentials.
Keep secrets out of logs, errors, analytics, model context, process arguments,
and fixtures. Use separate production and development credentials.

## OAuth lifecycle and migration

1. Start with one provider whose OAuth application supports backend execution.
   Bind authorization state to the user, connection, destination, redirect URI,
   and a short-lived one-use flow. Use PKCE where applicable.
2. Obtain a new cloud grant when needed. Tokens can be bound to a particular
   client or device; copying an existing token is not a portable migration plan.
   Existing sync permission does not imply permission for cloud execution.
3. Make the cloud backend the only refresher for a cloud-owned grant. Exclude
   those secrets from device credential sync. Serialize refresh attempts across
   workers, persist replacement tokens atomically, and fence stale writes with
   a credential version. A per-process mutex is insufficient across replicas.
4. Treat provider refresh and database persistence as separate failure domains.
   If the provider rotates a token but persistence fails, recovery may require
   reconnecting. Do not blindly replay the previous token or report success.
5. Mark the new connection ready only after durable storage and a minimal
   provider verification. Reassign selected jobs explicitly. If a provider
   invalidates the old grant on reconnect, disclose that before migration;
   rollback cannot promise the old token still works.
6. On disconnect or offboarding, deny new work immediately, cancel queued work,
   invalidate caches and refresh leases, attempt provider revocation, and remove
   stored secrets. Fence in-flight writes so they cannot recreate a disconnected
   connection. Report revocation failures separately from local deletion.

Retain durable revocation state through backup restores. Define backup retention
and deletion behavior; deleting the live row does not erase every backup.
Audit who authorized, used, refreshed, and disconnected a connection without
recording token values. Organization-owned grants need explicit access and
offboarding rules; organization membership alone must not expose personal grants.

## Enterprise and environment constraints

- Enforce a customer's permitted custody and execution locations on the server.
  A disabled UI toggle is not policy enforcement. A cloud-only rule must reject
  local execution, and a local-only rule must reject cloud authorization.
- Verify required regions across secrets, job inputs/results, logs, backups,
  support access, and subprocessors. A database region alone is insufficient.
- Corporate providers may require admin consent or verified OAuth applications.
  Local token storage does not bypass those requirements.
- Internal services need an approved network path or a customer-side runner.
  An isolated deployment cannot call public SaaS APIs without permitted egress.
- Supabase platform certifications do not certify the application. Evaluate
  customer contractual requirements, audit controls, and applicable regulated
  workloads before enabling the managed path.
- Preserve device execution during cloud outages where policy permits it, but
  never silently copy a cloud credential to a device as a fallback.

## Delivery and acceptance

Implement one complete provider flow before generalizing the adapters. The first
implementation includes authorization, durable encrypted storage, a bounded
provider operation, refresh, disconnect, and visible failure/reconnect states.
Customer-hosted adapters follow a concrete deployment requirement, not this spec
alone. Do not add a remote fallback to the general-purpose local `SecretStore`.

Required implementation evidence:

- Cross-user and cross-organization access is denied for every operation.
- Existing device connections and sync retain their behavior; no implicit upload
  or custody migration occurs when upgrading or enabling a different feature.
- Multiple workers refreshing one grant cannot overwrite a newer token.
- Rotation followed by persistence failure yields an actionable recovery state.
- Disconnect racing a queued job or refresh cannot resurrect access.
- Revoked access stays revoked after a backup restore and account offboarding.
- Local-only policy rejects cloud setup; cloud-owned tokens never appear in
  device sync, UI responses, logs, or model-visible tool output.
- A real test account completes the cloud job while the desktop is stopped.
  If the selected provider requires user presence, state that limitation instead.

The provider, deployment region, secret-store adapter, and first supported cloud
operation remain implementation choices. This proposal supplies their boundaries;
it does not claim cloud connections are available today.

## References

- [Supabase Vault](https://supabase.com/docs/guides/database/vault)
- [Supabase shared compliance responsibilities](https://supabase.com/docs/guides/security/soc-2-compliance)
- [Supabase self-hosting](https://supabase.com/docs/guides/self-hosting)
- [OAuth security best current practice, RFC 9700](https://www.rfc-editor.org/info/rfc9700/)
- [OAuth for native apps, RFC 8252](https://www.rfc-editor.org/info/rfc8252/)
- [Microsoft user and administrator consent](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/user-admin-consent-overview)
