// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Provider-independent cloud custody bridge. Secrets go directly between the
//! native vault and authenticated control plane, never through a webview response.
use crate::connections_api::{provider_routes, ConnectionsState};
use axum::{
    body::Body,
    extract::State,
    http::{HeaderMap, Request, StatusCode},
    routing::{get, post},
    Json, Router,
};
use base64::Engine as _;
use screenpipe_connect::{
    connections::{all_integrations, ConnectionManager},
    mcp_servers::{McpHeader, McpServerConfig, McpServerStore, McpTransport},
};
use screenpipe_core::connections::sync::{
    self, ConnectionSyncAction, ConnectionSyncManifest, SyncedConnection,
};
use screenpipe_secrets::SecretStore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
use tokio::sync::Mutex;
use tower::ServiceExt;

type Reply = (StatusCode, Json<Value>);
fn failure(code: StatusCode, message: &str) -> Reply {
    (code, Json(json!({"error": message})))
}
fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}
pub(crate) fn native_available(id: &str) -> bool {
    ![
        "obsidian",
        "obsidian-memories",
        "logseq",
        "claude-code",
        "codex",
        "openclaw",
        "hermes",
        "granola",
        "whatsapp",
        "browser",
        "user-browser",
    ]
    .contains(&id)
        && all_integrations()
            .iter()
            .any(|integration| integration.def().id == id)
}
pub(crate) fn mcp_cloud_available(config: &McpServerConfig) -> bool {
    if config.transport != McpTransport::Http {
        return false;
    }
    let Ok(url) = reqwest::Url::parse(&config.url) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    if !matches!(url.scheme(), "http" | "https")
        || host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
    {
        return false;
    }
    match url.host() {
        Some(url::Host::Ipv4(ip)) => {
            !ip.is_private() && !ip.is_loopback() && !ip.is_link_local() && !ip.is_unspecified()
        }
        Some(url::Host::Ipv6(ip)) => {
            !ip.is_loopback()
                && !ip.is_unspecified()
                && !ip.is_unique_local()
                && !ip.is_unicast_link_local()
                && ip.to_ipv4_mapped().is_none()
        }
        _ => true,
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Snapshot {
    kind: String,
    integration_id: String,
    label: String,
    payload: Value,
}
fn validate(snapshot: &Snapshot) -> Result<(), ()> {
    if snapshot.label.is_empty() || snapshot.label.len() > 160 {
        return Err(());
    }
    match snapshot.kind.as_str() {
        "native" => {
            let row: SyncedConnection =
                serde_json::from_value(snapshot.payload.clone()).map_err(|_| ())?;
            let expected = match row.instance.as_deref() {
                Some(instance)
                    if !instance.is_empty()
                        && instance.len() <= 160
                        && instance
                            .bytes()
                            .all(|c| c.is_ascii_alphanumeric() || b"_@.+-".contains(&c)) =>
                {
                    format!("{}:{}", row.integration_id, instance)
                }
                None => row.integration_id.clone(),
                _ => return Err(()),
            };
            if !native_available(&snapshot.integration_id)
                || row.integration_id != snapshot.integration_id
                || row.key != expected
                || !row.enabled
            {
                return Err(());
            }
            if (row.is_oauth && !row.oauth_token.as_ref().is_some_and(Value::is_object))
                || (!row.is_oauth && row.credentials.is_none())
            {
                return Err(());
            }
        }
        "mcp" => {
            let cfg: McpServerConfig =
                serde_json::from_value(snapshot.payload["config"].clone()).map_err(|_| ())?;
            let headers: Vec<McpHeader> =
                serde_json::from_value(snapshot.payload["headers"].clone()).map_err(|_| ())?;
            if cfg.header_names.iter().any(|name| {
                !headers
                    .iter()
                    .any(|header| header.name == *name && !header.value.is_empty())
            }) {
                return Err(());
            }
            if cfg.auth_mode == screenpipe_connect::mcp_servers::McpAuthMode::OAuth
                && !snapshot.payload["oauth_token"]["access_token"]
                    .as_str()
                    .is_some_and(|token| !token.is_empty())
            {
                return Err(());
            }
            if !identifier(&cfg.id)
                || snapshot.integration_id != "custom-mcp"
                || !mcp_cloud_available(&cfg)
                || !cfg.enabled
                || cfg.command.is_some()
                || cfg.env.is_some()
            {
                return Err(());
            }
        }
        _ => return Err(()),
    }
    Ok(())
}
#[derive(Clone)]
pub struct CustodyContext {
    pub screenpipe_dir: std::path::PathBuf,
    pub secret_store: Option<Arc<SecretStore>>,
}
impl From<&ConnectionsState> for CustodyContext {
    fn from(state: &ConnectionsState) -> Self {
        Self {
            screenpipe_dir: state.screenpipe_dir.clone(),
            secret_store: state.secret_store.clone(),
        }
    }
}

pub fn routes() -> Router<ConnectionsState> {
    Router::new()
        .route("/cloud", get(inventory))
        .route(
            "/cloud/settings",
            axum::routing::put(crate::cloud_connection_desktop::settings),
        )
        .route("/cloud/share", post(share))
        .route("/cloud/execute", post(execute))
}
async fn inventory(State(state): State<ConnectionsState>, headers: HeaderMap) -> Json<Value> {
    let context = CustodyContext::from(&state);
    let cloud = crate::cloud_connection_desktop::sync_accounts(&context).await;
    let manifest = sync::build_local_manifest(
        &state.screenpipe_dir,
        "cloud-export",
        state.secret_store.as_deref(),
    )
    .await;
    let mut connections = Vec::new();
    if let Some(store) = state.secret_store.as_ref() {
        for key in store.list("cloud-move-pending:").await.unwrap_or_default() {
            if let Ok(Some(pending)) = store.get_json::<Value>(&key).await {
                let token = crate::auth_key::find_cloud_token(&state.screenpipe_dir).await;
                if pending["owner"].as_str() != token.as_deref().and_then(jwt_subject).as_deref() {
                    continue;
                }
                connections.push(json!({"key": format!("pending:{}", pending["account_id"].as_str().unwrap_or("")), "name": format!("Finish moving {}", pending["label"].as_str().unwrap_or("connection")), "cloud_available": true, "pending": true}));
            }
        }
    }

    for row in manifest.connections.values().filter(|row| row.enabled) {
        let name = all_integrations()
            .iter()
            .find(|item| item.def().id == row.integration_id)
            .map(|item| item.def().name.to_string())
            .unwrap_or_else(|| row.integration_id.clone());
        connections.push(json!({"key": row.key, "name": name, "instance": row.instance, "cloud_available": native_available(&row.integration_id), "kind": "native", "rotating_credentials": row.is_oauth}));
    }
    let mcp = McpServerStore::new(state.screenpipe_dir.clone(), state.secret_store.clone());
    if let Ok(servers) = mcp.list().await {
        for cfg in servers.into_iter().filter(|cfg| cfg.enabled) {
            connections.push(json!({"key": format!("mcp:{}", cfg.id), "name": cfg.name, "cloud_available": mcp_cloud_available(&cfg), "kind": "mcp", "rotating_credentials": cfg.auth_mode == screenpipe_connect::mcp_servers::McpAuthMode::OAuth}));
        }
    }
    Json(
        json!({"connections": connections, "cloud_accounts": crate::cloud_connection_desktop::references(&context).await, "cloud_available": cloud.is_ok(), "storage": crate::cloud_connection_desktop::storage(&context).await, "snapshot_schema": 1, "runtime_available": runtime_authorized(&state, &headers)}),
    )
}
#[derive(Deserialize)]
pub(crate) struct ShareBody {
    pub key: String,
    #[serde(default)]
    pub license_id: String,
    #[serde(default)]
    pub token: String,
    pub allow_cloud: bool,
}
async fn share(State(state): State<ConnectionsState>, Json(mut body): Json<ShareBody>) -> Reply {
    let context = CustodyContext::from(&state);
    body.token = crate::auth_key::find_cloud_token(&context.screenpipe_dir)
        .await
        .unwrap_or_default();
    if let (Some(id), Some(store)) = (body.key.strip_prefix("pending:"), &context.secret_store) {
        if let Ok(Some(pending)) = store
            .get_json::<Value>(&format!("cloud-move-pending:{}", id))
            .await
        {
            if pending["owner"].as_str() != jwt_subject(&body.token).as_deref() {
                return failure(
                    StatusCode::FORBIDDEN,
                    "Sign into the account that started this connection.",
                );
            }
            body.license_id = pending["license_id"].as_str().unwrap_or("").to_owned();
        }
    }
    share_with_context(context, body).await
}
pub(crate) async fn share_with_context(state: CustodyContext, body: ShareBody) -> Reply {
    let Some(store) = state.secret_store.as_ref() else {
        return failure(
            StatusCode::CONFLICT,
            "A local credential vault is required to move connections.",
        );
    };
    let connection_key = if let Some(id) = body.key.strip_prefix("pending:") {
        match store
            .get_json::<Value>(&format!("cloud-move-pending:{}", id))
            .await
        {
            Ok(Some(row)) if row["owner"].as_str() == jwt_subject(&body.token).as_deref() => {
                row["local_key"].as_str().unwrap_or("").to_owned()
            }
            _ => return failure(StatusCode::FORBIDDEN, "Connection handoff not found."),
        }
    } else {
        body.key.clone()
    };
    let key = if let Some(id) = connection_key.strip_prefix("mcp:") {
        format!("cloud-custody:mcp:{}", id)
    } else {
        format!("cloud-custody:oauth:{}", connection_key)
    };
    let owner = uuid::Uuid::new_v4().to_string();
    if !store
        .try_acquire_refresh_lease(&key, &owner, 120)
        .await
        .unwrap_or(false)
    {
        return failure(
            StatusCode::CONFLICT,
            "This connection is refreshing. Retry after it finishes.",
        );
    }
    let result = share_inner(state.clone(), body).await;
    let _ = store.release_refresh_lease(&key, &owner).await;
    result
}

async fn share_inner(state: CustodyContext, body: ShareBody) -> Reply {
    if !body.allow_cloud
        || (!body.license_id.is_empty() && uuid::Uuid::parse_str(&body.license_id).is_err())
        || body.token.is_empty()
    {
        return failure(
            StatusCode::BAD_REQUEST,
            "Explicit cloud consent and a signed-in workspace are required.",
        );
    }
    // Only the account already signed into this device can receive its vault.
    // The control plane independently verifies the supplied JWT before storing.
    if crate::cloud_connection_desktop::storage(&state).await == "local" {
        return failure(
            StatusCode::FORBIDDEN,
            "Connections are configured to stay on this device.",
        );
    }
    let local_token = crate::auth_key::find_cloud_token(&state.screenpipe_dir).await;
    if jwt_subject(&body.token).is_none()
        || jwt_subject(&body.token) != local_token.as_deref().and_then(jwt_subject)
    {
        return failure(
            StatusCode::FORBIDDEN,
            "Sign into the same account in this app before moving connections.",
        );
    }
    if let Some(id) = body.key.strip_prefix("pending:") {
        let store = state.secret_store.as_ref().unwrap();
        let pending = store
            .get_json::<Value>(&format!("cloud-move-pending:{}", id))
            .await
            .ok()
            .flatten();
        if pending
            .as_ref()
            .and_then(|value| value["license_id"].as_str())
            != Some(&body.license_id)
        {
            return failure(
                StatusCode::BAD_REQUEST,
                "Select the original workspace to finish this move.",
            );
        }
        return finish_move(&state, &body, id).await;
    }
    let manifest = sync::build_local_manifest(
        &state.screenpipe_dir,
        "cloud-export",
        state.secret_store.as_deref(),
    )
    .await;
    let mcp = McpServerStore::new(state.screenpipe_dir.clone(), state.secret_store.clone());
    let snapshot = if let Some(id) = body.key.strip_prefix("mcp:") {
        let Ok(Some(cfg)) = mcp.get(id).await else {
            return failure(StatusCode::NOT_FOUND, "Connection not found.");
        };
        let token = if let Some(store) = state.secret_store.as_ref() {
            store
                .get_json::<Value>(&format!("mcp-oauth:{}", id))
                .await
                .ok()
                .flatten()
        } else {
            None
        };
        Snapshot {
            kind: "mcp".into(),
            integration_id: "custom-mcp".into(),
            label: cfg.name.clone(),
            payload: json!({"config": cfg, "headers": mcp.get_headers(id).await, "oauth_token": token}),
        }
    } else {
        let Some(row) = manifest.connections.get(&body.key) else {
            return failure(StatusCode::NOT_FOUND, "Connection not found.");
        };
        Snapshot {
            kind: "native".into(),
            integration_id: row.integration_id.clone(),
            label: row.key.clone(),
            payload: json!(row),
        }
    };
    if validate(&snapshot).is_err() {
        return failure(
            StatusCode::CONFLICT,
            "This connection requires its local environment. Use a device-targeted task.",
        );
    }
    // The destination is fixed; caller-controlled URLs must never receive vault contents.
    let client = match reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30))
        .build()
    {
        Ok(client) => client,
        Err(_) => return failure(StatusCode::SERVICE_UNAVAILABLE, "Cloud unavailable."),
    };
    // Persist only an opaque attempt ID before the request, so an uncertain import
    // can be retried without creating an unreachable inactive cloud account.
    let attempt_key = format!(
        "cloud-import-attempt:{}:{}",
        jwt_subject(&body.token).unwrap_or_default(),
        body.key
    );
    let store = state.secret_store.as_ref().unwrap();
    let attempt = match store.get_json::<Value>(&attempt_key).await {
        Ok(Some(value))
            if value["id"]
                .as_str()
                .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok()) =>
        {
            value["id"].as_str().unwrap().to_owned()
        }
        Ok(_) => {
            let id = uuid::Uuid::new_v4().to_string();
            if store
                .set_json(&attempt_key, &json!({"id":id}))
                .await
                .is_err()
            {
                return failure(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Could not save the connection handoff.",
                );
            }
            id
        }
        Err(_) => {
            return failure(
                StatusCode::SERVICE_UNAVAILABLE,
                "Could not read the connection handoff.",
            )
        }
    };
    let response = client
        .post(if body.license_id.is_empty() {
            "https://screenpipe.com/api/connections/accounts"
        } else {
            "https://screenpipe.com/api/enterprise/cloud-connections/import"
        })
        .bearer_auth(&body.token)
        .json(&json!({"license_id": body.license_id, "allow_cloud": true, "connection": snapshot, "account_id": if body.license_id.is_empty() {Some(&attempt)} else {None}}))
        .send()
        .await;
    let Ok(response) = response else {
        return failure(
            StatusCode::BAD_GATEWAY,
            "Cloud save could not be confirmed. The local connection was kept.",
        );
    };
    if !response.status().is_success() {
        return failure(
            StatusCode::BAD_GATEWAY,
            "Cloud save failed. The local connection was kept.",
        );
    }
    let Ok(receipt) = response.json::<Value>().await else {
        return failure(
            StatusCode::BAD_GATEWAY,
            "Cloud save could not be confirmed. The local connection was kept.",
        );
    };
    if receipt["account_id"]
        .as_str()
        .and_then(|id| uuid::Uuid::parse_str(id).ok())
        .is_none()
    {
        return failure(
            StatusCode::BAD_GATEWAY,
            "Invalid cloud receipt. The local connection was kept.",
        );
    }
    let id = receipt["account_id"].as_str().unwrap();
    if state
        .secret_store
        .as_ref()
        .unwrap()
        .set_json(
            &format!("cloud-move-pending:{}", id),
            &json!({"account_id": id, "license_id": body.license_id, "owner": jwt_subject(&body.token), "local_key": body.key, "label": snapshot.label, "kind": snapshot.kind, "integration_id": snapshot.integration_id, "instance": snapshot.payload["instance"], "mcp_config": if snapshot.kind == "mcp" { snapshot.payload["config"].clone() } else { Value::Null }}),
        )
        .await
        .is_err()
    {
        return failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "Connection was saved in the cloud but activation is incomplete.",
        );
    }
    let _ = store.delete(&attempt_key).await;
    // A move, not two independent refreshers racing on a rotating OAuth token.
    let removed = if let Some(id) = body.key.strip_prefix("mcp:") {
        mcp.delete(id).await.is_ok()
    } else {
        let errors = sync::apply_manifest_to_disk(
            &manifest,
            &[ConnectionSyncAction::Deleted(body.key.clone())],
            &state.screenpipe_dir,
            state.secret_store.as_deref(),
        )
        .await;
        if errors.is_empty() {
            sync::record_connection_tombstone(&state.screenpipe_dir, &body.key);
        }
        errors.is_empty()
    };
    if !removed {
        return (
            StatusCode::OK,
            Json(
                json!({"account_id": receipt["account_id"], "moved": false, "local_cleanup_required": true}),
            ),
        );
    }
    finish_move(&state, &body, id).await
}
#[derive(Deserialize)]
pub(crate) struct ExecuteBody {
    pub connection: Snapshot,
    pub request: Value,
}
async fn execute(
    State(state): State<ConnectionsState>,
    headers: HeaderMap,
    Json(body): Json<ExecuteBody>,
) -> Reply {
    // This credential-bearing response exists only on an authenticated organization runner.
    if !runtime_authorized(&state, &headers) {
        return failure(StatusCode::FORBIDDEN, "Cloud runner required.");
    }
    if validate(&body.connection).is_err() {
        return failure(StatusCode::BAD_REQUEST, "Invalid cloud connection.");
    }
    match tokio::time::timeout(Duration::from_secs(90), execute_inner(state, body)).await {
        Ok(Ok(value)) => (StatusCode::OK, Json(value)),
        _ => failure(
            StatusCode::BAD_GATEWAY,
            "Connection execution could not be confirmed. Reconnect before retrying.",
        ),
    }
}
fn runtime_authorized(state: &ConnectionsState, headers: &HeaderMap) -> bool {
    let key = state.api_auth_key.as_deref().filter(|key| !key.is_empty());
    std::env::var("SCREENPIPE_CLOUD_RUNNER").ok().as_deref() == Some("1")
        && key.is_some()
        && headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            == key.map(|key| format!("Bearer {}", key)).as_deref()
}
pub(crate) async fn execute_inner(
    mut state: ConnectionsState,
    body: ExecuteBody,
) -> anyhow::Result<Value> {
    anyhow::ensure!(
        validate(&body.connection).is_ok(),
        "Invalid cloud connection."
    );
    let dir = tempfile::tempdir()?;
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await?;
    let secrets = Arc::new(SecretStore::new(pool.clone(), None).await?);
    state.screenpipe_dir = dir.path().to_path_buf();
    state.secret_store = Some(secrets.clone());
    state.cm = Arc::new(Mutex::new(ConnectionManager::new(
        state.screenpipe_dir.clone(),
        Some(secrets.clone()),
    )));
    let mut updated = body.connection.clone();
    let result: anyhow::Result<Value> = if body.connection.kind == "mcp" {
        let cfg: McpServerConfig =
            serde_json::from_value(body.connection.payload["config"].clone())?;
        let headers: Vec<McpHeader> =
            serde_json::from_value(body.connection.payload["headers"].clone())?;
        let mcp = McpServerStore::new(state.screenpipe_dir.clone(), Some(secrets.clone()));
        mcp.upsert(cfg.clone(), Some(headers)).await?;
        let token = &body.connection.payload["oauth_token"];
        if !token.is_null() {
            secrets
                .set_json(&format!("mcp-oauth:{}", cfg.id), token)
                .await?;
        }
        let result = match body.request["operation"].as_str() {
            Some("tools") | Some("describe") => mcp
                .probe_tools(&cfg.id)
                .await
                .and_then(|value| Ok(serde_json::to_value(value)?)),
            Some("execute") => {
                mcp.call_tool(
                    &cfg.id,
                    body.request["tool"].as_str().unwrap_or(""),
                    body.request["arguments"].clone(),
                )
                .await
            }
            _ => Err(anyhow::anyhow!("invalid operation")),
        };
        updated.payload["oauth_token"] = secrets
            .get_json::<Value>(&format!("mcp-oauth:{}", cfg.id))
            .await?
            .unwrap_or(Value::Null);
        result
    } else {
        let row: SyncedConnection = serde_json::from_value(body.connection.payload.clone())?;
        let mut manifest = ConnectionSyncManifest::empty("cloud-runner");
        manifest.connections.insert(row.key.clone(), row.clone());
        let errors = sync::apply_manifest_to_disk(
            &manifest,
            &[ConnectionSyncAction::Imported(row.key.clone())],
            &state.screenpipe_dir,
            Some(&secrets),
        )
        .await;
        anyhow::ensure!(errors.is_empty(), "connection import failed");
        let result = if matches!(
            body.request["operation"].as_str(),
            Some("describe") | Some("tools")
        ) {
            Ok(
                json!({"instructions": screenpipe_connect::connections::render_context(&state.screenpipe_dir, 3030, Some(&secrets)).await}),
            )
        } else {
            execute_native_request(state.clone(), &row, &body.request).await
        };
        let after =
            sync::build_local_manifest(&state.screenpipe_dir, "cloud-runner", Some(&secrets)).await;
        if let Some(current) = after.connections.get(&row.key) {
            updated.payload = json!(current);
        }
        result
    };
    pool.close().await;
    // Even an upstream failure commits refreshed tokens. Error details may include secrets.
    Ok(match result {
        Ok(data) => json!({"connection": updated, "successful": true, "data": data}),
        Err(_) => {
            json!({"connection": updated, "successful": false, "error": "The provider could not complete the operation."})
        }
    })
}
async fn execute_native_request(
    state: ConnectionsState,
    row: &SyncedConnection,
    input: &Value,
) -> anyhow::Result<Value> {
    let path = input["path"].as_str().unwrap_or("");
    anyhow::ensure!(
        allowed_path(&row.integration_id, path),
        "invalid provider path"
    );
    let method = input["method"].as_str().unwrap_or("GET");
    anyhow::ensure!(
        ["GET", "POST", "PUT", "PATCH", "DELETE"].contains(&method),
        "invalid method"
    );
    let mut url = reqwest::Url::parse(&format!("http://localhost{}", path))?;
    if let Some(instance) = row.instance.as_deref() {
        url.query_pairs_mut().append_pair("instance", instance);
    }
    let uri = format!(
        "{}{}",
        url.path(),
        url.query()
            .map(|query| format!("?{}", query))
            .unwrap_or_default()
    );
    let request = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_vec(&input["body"])?))?;
    let response = provider_routes().with_state(state).oneshot(request).await?;
    anyhow::ensure!(response.status().is_success(), "provider request failed");
    let bytes = axum::body::to_bytes(response.into_body(), 2 * 1024 * 1024).await?;
    Ok(serde_json::from_slice(&bytes)?)
}
fn allowed_path(id: &str, path: &str) -> bool {
    if !path.starts_with(&format!("/{}/", id)) || path.contains('\\') || path.contains('#') {
        return false;
    }
    let Ok(url) = reqwest::Url::parse(&format!("http://localhost{}", path)) else {
        return false;
    };
    let raw_path = path.split('?').next().unwrap_or("");
    // Query values may be URL-encoded (dates, search text); account selection may not be overridden.
    !raw_path.contains("..")
        && !raw_path.contains('%')
        && url.path().starts_with(&format!("/{}/", id))
        && !url.path().starts_with(&format!("/{}/instances", id))
        && !url.path().starts_with(&format!("/{}/test", id))
        && !url.query_pairs().any(|(key, _)| key == "instance")
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn provider_queries_allow_encoded_values_but_not_account_overrides() {
        assert!(allowed_path("slack", "/slack/proxy/search?q=hello%20world"));
        assert!(!allowed_path(
            "slack",
            "/slack/proxy/search?%69nstance=another"
        ));
        assert!(!allowed_path("slack", "/slack/proxy/../instances"));
    }
    #[test]
    fn execution_cannot_leave_its_provider_or_choose_another_account() {
        assert!(allowed_path("notion", "/notion/proxy/v1/search"));
        for path in [
            "/slack/proxy/test",
            "/notion/../cloud/share",
            "/notion/proxy/%2e%2e/test",
            "/notion/proxy/test?instance=other",
            "/notion/instances/account",
            "/cloud/execute",
        ] {
            assert!(!allowed_path("notion", path));
        }
    }
    #[test]
    fn local_environment_connections_are_explicitly_unavailable() {
        for id in [
            "obsidian",
            "logseq",
            "claude-code",
            "whatsapp",
            "user-browser",
        ] {
            assert!(!native_available(id));
        }
        for id in ["notion", "slack", "stripe", "imap", "github"] {
            assert!(native_available(id));
        }
    }
    #[test]
    fn incomplete_mcp_credentials_cannot_be_moved_or_executed() {
        let mut snapshot = Snapshot {
            kind: "mcp".into(),
            integration_id: "custom-mcp".into(),
            label: "Research".into(),
            payload: json!({
                "config": {"id":"research", "name":"Research", "url":"https://mcp.example.com", "auth_mode":screenpipe_connect::mcp_servers::McpAuthMode::OAuth, "created_at":1},
                "headers": [], "oauth_token": null,
            }),
        };
        assert!(validate(&snapshot).is_err());
        snapshot.payload["oauth_token"] = json!({"access_token":"fixture"});
        assert!(validate(&snapshot).is_ok());
        let public = snapshot.payload["config"]["url"].clone();
        for url in [
            "http://localhost:3000/mcp",
            "http://127.0.0.1/mcp",
            "http://192.168.1.3/mcp",
            "http://[::1]/mcp",
        ] {
            snapshot.payload["config"]["url"] = json!(url);
            assert!(validate(&snapshot).is_err());
        }
        snapshot.payload["config"]["url"] = public;
        snapshot.payload["config"]["header_names"] = json!(["Authorization"]);
        assert!(validate(&snapshot).is_err());
    }
}

pub(crate) fn jwt_subject(token: &str) -> Option<String> {
    let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(token.split('.').nth(1)?)
        .ok()?;
    let json: Value = serde_json::from_slice(&payload).ok()?;
    json["sub"]
        .as_str()
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

async fn finish_move(state: &CustodyContext, body: &ShareBody, id: &str) -> Reply {
    let store = state.secret_store.as_ref().unwrap();
    let pending = store
        .get_json::<Value>(&format!("cloud-move-pending:{}", id))
        .await
        .ok()
        .flatten();
    let local_key = pending.as_ref().and_then(|row| row["local_key"].as_str());
    let removed = if let Some(key) = local_key {
        if let Some(mcp_id) = key.strip_prefix("mcp:") {
            let mcp = McpServerStore::new(state.screenpipe_dir.clone(), state.secret_store.clone());
            matches!(mcp.get(mcp_id).await, Ok(None))
                && matches!(store.get(&format!("mcp:{}", mcp_id)).await, Ok(None))
                && matches!(store.get(&format!("mcp-oauth:{}", mcp_id)).await, Ok(None))
        } else {
            let current =
                sync::build_local_manifest(&state.screenpipe_dir, "cloud-export", Some(store))
                    .await;
            !current.connections.contains_key(key)
                && matches!(store.get(&format!("cred:{}", key)).await, Ok(None))
                && matches!(store.get(&format!("oauth:{}", key)).await, Ok(None))
        }
    } else {
        false
    };
    if !removed {
        return failure(StatusCode::CONFLICT, "The local connection must be removed before cloud activation. Disconnect it locally, then retry this pending move.");
    }
    let result = async {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(20))
            .build()?;
        let response = client
            .patch(if body.license_id.is_empty() {
                "https://screenpipe.com/api/connections/accounts"
            } else {
                "https://screenpipe.com/api/enterprise/cloud-connections/import"
            })
            .bearer_auth(&body.token)
            .json(&json!({"license_id": body.license_id, "account_id": id, "local_removed": true}))
            .send()
            .await?;
        anyhow::ensure!(response.status().is_success(), "activation failed");
        Ok::<_, anyhow::Error>(())
    }
    .await;
    if result.is_err() {
        return failure(StatusCode::SERVICE_UNAVAILABLE, "Cloud move saved. Refresh connections and select Finish cloud move to retry activation.");
    }
    if let Some(reference) = pending {
        if store
            .set_json(
                &format!(
                    "cloud-ref:{}",
                    reference["local_key"].as_str().unwrap_or(&body.key)
                ),
                &reference,
            )
            .await
            .is_err()
        {
            return failure(
                StatusCode::SERVICE_UNAVAILABLE,
                "Connection saved. Refresh connections to restore its desktop reference.",
            );
        }
    }
    let _ = state
        .secret_store
        .as_ref()
        .unwrap()
        .delete(&format!("cloud-move-pending:{}", id))
        .await;
    (
        StatusCode::OK,
        Json(json!({"account_id": id, "moved": true, "local_cleanup_required": false})),
    )
}
