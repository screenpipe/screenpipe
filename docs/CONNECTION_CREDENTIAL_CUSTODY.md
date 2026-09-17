<!-- screenpipe — AI that knows everything you've seen, said, or heard -->
<!-- https://screenpipe.com -->

# Connection credential custody

<!-- doc-covers: crates/screenpipe-engine/src/cloud_connections.rs, crates/screenpipe-connect/src/oauth.rs, crates/screenpipe-connect/src/mcp_servers.rs, apps/screenpipe-app-tauri/components/settings/cloud-connection-access.tsx -->
<!-- doc-verified: 7d46b866ed5b55df83c6fa1be96e7365c6a0f8ae -->

New supported connections use cloud custody by default when signed in and the
control plane is available. This covers the native registry (OAuth and API-key
accounts) and remote HTTP MCP servers in both desktop apps. The account belongs
to the signed-in user and does not require choosing an enterprise workspace.
Composio accounts retain their existing managed custody.

The connection setup shows **New connections: This device + cloud**. Users can
choose **This device only**; the setting affects new connections, never an existing
credential. Signed-out setup and unavailable cloud service keep credentials local.
`SCREENPIPE_CONNECTION_STORAGE=local` enforces local custody and disables desktop
cloud execution for managed/offline environments. The server also checks accepted
enterprise memberships and hosted-processing policies before accepting or using
personal cloud accounts. Changing the preference does not silently move existing
cloud accounts back to a device.

Existing local accounts remain local until the user selects **Use existing
connections in the cloud** and confirms the selected credentials. A later sign-in
or background inventory refresh never migrates them. Secrets travel directly from
the native vault to the authenticated control plane; the webview receives metadata
and a receipt. A cloud failure preserves the local account and reports the fallback.

Desktop provider requests and MCP tool calls use the shared cloud account through
an authenticated native bridge. Only provider results reach the webview. Local and
cloud instances of the same service remain independently selectable. Metadata-only
references make cloud connections available to foreground chats and device pipes.
Each cloud pipe still needs an explicit workspace grant; storing an account in the
cloud does not grant every task access to it.

A confirmed cloud save precedes local deletion. The account becomes available to
cloud tasks only after local deletion is confirmed. Interrupted activation is
listed as a pending move and can be retried. Native OAuth and MCP refreshers use
the same local credential lease as the move, preventing an in-flight refresher from
racing the handoff on this device. Stop other copies of a rotating provider
authorization before moving it. Existing native connection sync propagates the
local deletion via its existing tombstone mechanism.

The companion control-plane implementation is
[website#1063](https://github.com/screenpipe/website/pull/1063). It encrypts snapshots
at rest, verifies current workspace ownership and per-task grants, and serializes
credential checkout across desktop requests and cloud tasks. Composio retains Composio tokens; native
OAuth/API-key and MCP records use the encrypted snapshot store.

The new `/connections/cloud/execute` endpoint runs only when
`SCREENPIPE_CLOUD_RUNNER=1` and the caller presents the engine's API key. One
credential snapshot is applied to a request-specific in-memory SecretStore. Native
requests run through the existing provider routes; MCP uses the existing MCP
store and OAuth refresher. The snapshot is not added to persistent runner
connections. The helper commits updated tokens before printing provider data.
Ambiguous execution leaves the cloud checkout locked until its matching commit or
an explicit reconnection, preventing automatic replay of an old refresh token.

A connection does not confer its source environment. Local desktop integrations,
browser sessions, files and stdio MCP processes remain local and appear with that
constraint. Cloud runners must have network access to remote providers. Existing
adapter capabilities and platform limits still apply; this change does not add
missing provider operations or create access to a private network.

The cloud VM remains a trusted workspace-admin boundary. Root tasks share runner
credentials; per-task grants do not provide an OS sandbox between hostile admins
or tasks. Credentials stay out of model context and normal API responses, but the
trusted runtime necessarily uses them. Provider results can be sent to the task's
AI and saved as artifacts.

Deployment requires both PRs, the cloud database migration and server encryption
key ring, and a verified engine binary containing this bridge. The existing cloud
runner version predates it. The helper probes the snapshot schema and fails before
checkout on an old runner. No production migration, runner restart, or release
publication is part of these PRs.
