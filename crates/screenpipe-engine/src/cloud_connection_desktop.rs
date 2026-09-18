// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
//! Desktop access to account-owned cloud connections. Only provider results reach the webview.
use crate::cloud_connections::{self, CustodyContext, ExecuteBody, ShareBody};
use crate::connections_api::ConnectionsState;
use axum::{
    body::{to_bytes, Body},
    extract::{Request, State},
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};
use std::time::Duration;

const ACCOUNTS: &str = "https://screenpipe.com/api/connections/accounts";
fn client() -> anyhow::Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30))
        .build()?)
}
async fn token(ctx: &CustodyContext) -> anyhow::Result<String> {
    crate::auth_key::find_cloud_token(&ctx.screenpipe_dir)
        .await
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow::anyhow!("Sign in to use cloud connections."))
}
pub async fn storage(ctx: &CustodyContext) -> String {
    if std::env::var("SCREENPIPE_CONNECTION_STORAGE")
        .ok()
        .as_deref()
        == Some("local")
    {
        return "local".into();
    }
    match tokio::fs::read(ctx.screenpipe_dir.join("connection-storage.json")).await {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => "cloud".into(),
        Ok(bytes)
            if serde_json::from_slice::<Value>(&bytes)
                .ok()
                .is_some_and(|value| value["storage"] == "cloud") =>
        {
            "cloud".into()
        }
        // An unreadable preference must never override a user's local-only choice.
        _ => "local".into(),
    }
}

pub(crate) async fn settings(
    State(state): State<ConnectionsState>,
    Json(body): Json<Value>,
) -> Response {
    let mode = body["storage"].as_str().unwrap_or("");
    if !["local", "cloud"].contains(&mode) {
        return error(StatusCode::BAD_REQUEST, "Choose local or cloud storage.");
    }
    if mode == "cloud"
        && std::env::var("SCREENPIPE_CONNECTION_STORAGE")
            .ok()
            .as_deref()
            == Some("local")
    {
        return error(
            StatusCode::FORBIDDEN,
            "Your organization requires local connections.",
        );
    }
    // Preference affects new connections only. It never uploads existing secrets.
    let path = state.screenpipe_dir.join("connection-storage.json");
    let temporary = state
        .screenpipe_dir
        .join(format!("connection-storage-{}.tmp", uuid::Uuid::new_v4()));
    let saved = async {
        tokio::fs::write(&temporary, json!({"storage":mode}).to_string()).await?;
        tokio::fs::rename(&temporary, &path).await
    }
    .await;
    if saved.is_err() {
        let _ = tokio::fs::remove_file(&temporary).await;
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Could not save the connection preference.",
        );
    }
    Json(json!({"storage":mode})).into_response()
}
pub async fn references(ctx: &CustodyContext) -> Vec<Value> {
    let Ok(token) = token(ctx).await else {
        return vec![];
    };
    let owner = cloud_connections::jwt_subject(&token);
    let Some(store) = &ctx.secret_store else {
        return vec![];
    };
    let mut refs = vec![];
    for key in store.list("cloud-ref:").await.unwrap_or_default() {
        if let Ok(Some(row)) = store.get_json::<Value>(&key).await {
            if owner.is_some() && row["owner"].as_str() == owner.as_deref() {
                refs.push(row);
            }
        }
    }
    refs
}
pub async fn sync_accounts(ctx: &CustodyContext) -> anyhow::Result<()> {
    anyhow::ensure!(
        std::env::var("SCREENPIPE_CONNECTION_STORAGE")
            .ok()
            .as_deref()
            != Some("local"),
        "Local connections required."
    );
    let auth = token(ctx).await?;
    let owner = cloud_connections::jwt_subject(&auth)
        .ok_or_else(|| anyhow::anyhow!("Sign in required."))?;
    let response = client()?.get(ACCOUNTS).bearer_auth(auth).send().await?;
    anyhow::ensure!(
        response.status().is_success(),
        "Cloud connections unavailable."
    );
    let body: Value = response.json().await?;
    let accounts = body["accounts"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("Invalid cloud inventory."))?;
    let store = ctx
        .secret_store
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("Vault unavailable."))?;
    let old = references(ctx).await;
    let mcp = screenpipe_connect::mcp_servers::McpServerStore::new(
        ctx.screenpipe_dir.clone(),
        ctx.secret_store.clone(),
    );
    let local_mcp = mcp.list().await?;
    let local = screenpipe_core::connections::sync::build_local_manifest(
        &ctx.screenpipe_dir,
        "cloud-status",
        Some(store),
    )
    .await;
    let mut seen = std::collections::HashSet::new();
    for account in accounts.iter().filter(|account| account["ready"] == true) {
        let Some(key) = account["source_key"].as_str() else {
            continue;
        };
        let Some(id) = account["id"]
            .as_str()
            .filter(|id| uuid::Uuid::parse_str(id).is_ok())
        else {
            continue;
        };
        // An existing local account is never silently replaced by a cloud account.
        if (local.connections.contains_key(key)
            || local_mcp.iter().any(|cfg| format!("mcp:{}", cfg.id) == key))
            && !old.iter().any(|r| r["local_key"] == key)
        {
            continue;
        }
        let previous = old.iter().find(|r| r["account_id"] == id);
        let row = json!({"account_id":id,"owner":owner,"local_key":key,"label":account["label"],"kind":account["metadata"]["kind"],"integration_id":account["integration_id"],"instance":account["metadata"]["instance"],"mcp_config":previous.map(|r| r["mcp_config"].clone()).unwrap_or(Value::Null)});
        store.set_json(&format!("cloud-ref:{}", key), &row).await?;
        seen.insert(id.to_owned());
    }
    for row in old {
        if let (Some(id), Some(key)) = (row["account_id"].as_str(), row["local_key"].as_str()) {
            if !seen.contains(id) {
                store.delete(&format!("cloud-ref:{}", key)).await?;
            }
        }
    }
    Ok(())
}
/** Called only after a new credential is saved, never by an inventory/background scan. */
pub async fn complete_new_connection(ctx: CustodyContext, key: &str, existed: bool) -> Value {
    if existed || storage(&ctx).await == "local" {
        return json!({"storage":"local"});
    }
    let Ok(auth) = token(&ctx).await else {
        return json!({"storage":"local"});
    };
    if !key.starts_with("mcp:")
        && !cloud_connections::native_available(key.split(':').next().unwrap_or(""))
    {
        return json!({"storage":"local"});
    }
    if let Some(id) = key.strip_prefix("mcp:") {
        let mcp = screenpipe_connect::mcp_servers::McpServerStore::new(
            ctx.screenpipe_dir.clone(),
            ctx.secret_store.clone(),
        );
        if !matches!(mcp.get(id).await, Ok(Some(cfg)) if cloud_connections::mcp_cloud_available(&cfg))
        {
            return json!({"storage":"local"});
        }
    }
    // Deployment, identity and enterprise policy are checked before transferring anything.
    if sync_accounts(&ctx).await.is_err() {
        return json!({"storage":"local","cloud_pending":true});
    }
    let (status, Json(result)) = cloud_connections::share_with_context(
        ctx,
        ShareBody {
            key: key.into(),
            license_id: String::new(),
            token: auth,
            allow_cloud: true,
        },
    )
    .await;
    if status.is_success() && result["moved"] == true {
        json!({"storage":"cloud"})
    } else {
        json!({"storage":"local","cloud_pending":true})
    }
}
pub async fn disconnect(ctx: &CustodyContext, reference: &Value) -> anyhow::Result<()> {
    let id = reference["account_id"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Invalid connection."))?;
    let result = client()?
        .delete(ACCOUNTS)
        .query(&[("id", id)])
        .bearer_auth(token(ctx).await?)
        .send()
        .await?;
    anyhow::ensure!(
        result.status().is_success(),
        "Could not disconnect cloud account."
    );
    if let Some(store) = &ctx.secret_store {
        store
            .delete(&format!(
                "cloud-ref:{}",
                reference["local_key"].as_str().unwrap_or("")
            ))
            .await?;
    }
    Ok(())
}
pub(crate) fn error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({"error":message}))).into_response()
}
pub(crate) async fn run(
    state: ConnectionsState,
    reference: &Value,
    request: Value,
) -> anyhow::Result<Value> {
    let ctx = CustodyContext::from(&state);
    anyhow::ensure!(
        std::env::var("SCREENPIPE_CONNECTION_STORAGE")
            .ok()
            .as_deref()
            != Some("local"),
        "Cloud connections are disabled on this device."
    );
    let auth = token(&ctx).await?;
    let id = reference["account_id"]
        .as_str()
        .filter(|id| uuid::Uuid::parse_str(id).is_ok())
        .ok_or_else(|| anyhow::anyhow!("Invalid connection."))?;
    let url = format!("{}/{}/runtime", ACCOUNTS, id);
    let client = client()?;
    let checkout = client
        .post(&url)
        .bearer_auth(&auth)
        .json(&json!({"operation":"checkout"}))
        .send()
        .await?;
    anyhow::ensure!(
        checkout.status().is_success(),
        "Cloud connection is busy, unavailable, or needs reconnection."
    );
    let checked: Value = checkout.json().await?;
    // On timeout/ambiguous failure the lease stays locked. Never retry an old rotating token.
    let result = tokio::time::timeout(
        Duration::from_secs(90),
        cloud_connections::execute_inner(
            state,
            ExecuteBody {
                connection: serde_json::from_value(checked["connection"].clone())?,
                request,
            },
        ),
    )
    .await??;
    let committed = client.post(&url).bearer_auth(&auth).json(&json!({"operation":"commit", "lease_id":checked["lease_id"],"revision":checked["revision"],"connection":result["connection"]})).send().await?;
    anyhow::ensure!(
        committed.status().is_success(),
        "Cloud credential update could not be confirmed. Reconnect before retrying."
    );
    anyhow::ensure!(
        result["successful"] == true,
        "The provider could not complete the request."
    );
    Ok(result["data"].clone())
}

/// Metadata-only tool instructions; credentials remain in the native request bridge.
pub async fn render_context(ctx: &CustodyContext, port: u16) -> String {
    if std::env::var("SCREENPIPE_CONNECTION_STORAGE")
        .ok()
        .as_deref()
        == Some("local")
    {
        return String::new();
    }
    // A new device may start a chat or pipe before opening Connections. Refresh
    // metadata with a short bound; offline context still uses its cached references.
    let _ = tokio::time::timeout(Duration::from_secs(2), sync_accounts(ctx)).await;
    let integrations = screenpipe_connect::connections::all_integrations();
    let mut output = String::new();
    for reference in references(ctx).await {
        if reference["kind"] == "mcp" {
            let id = reference["local_key"]
                .as_str()
                .unwrap_or("")
                .trim_start_matches("mcp:");
            let escaped = url::form_urlencoded::byte_serialize(id.as_bytes()).collect::<String>();
            output.push_str(&format!("\nCloud MCP connection {}: GET http://localhost:{}/mcp-servers/{}/tools to discover tools; POST http://localhost:{}/mcp-servers/{}/call with {{\"tool\":\"name\",\"arguments\":{{}}}}. Credentials stay in the native bridge.\n",reference["label"],port,escaped,port,escaped));
        } else if let Some(integration) = integrations
            .iter()
            .find(|integration| reference["integration_id"] == integration.def().id)
        {
            let id = integration.def().id;
            let instance = reference["instance"].as_str();
            let suffix = instance
                .map(|value| {
                    format!(
                        "?{}",
                        url::form_urlencoded::Serializer::new(String::new())
                            .append_pair("instance", value)
                            .finish()
                    )
                })
                .unwrap_or_default();
            output.push_str(&format!(
                "\nCloud connection {} (instance {}): {}\n",
                id,
                reference["instance"],
                integration.def().description
            ));
            if integration.webhook_proxy_config().is_some() {
                output.push_str(&format!(
                    "POST http://localhost:{}/connections/{}/proxy{} with JSON body.\n",
                    port, id, suffix
                ));
            } else if integration.proxy_config().is_some() {
                output.push_str(&format!(
                    "Use http://localhost:{}/connections/{}/proxy/<api-path>{}.\n",
                    port, id, suffix
                ));
            }
            if let Some(note) = integration.context_note() {
                output.push_str(note);
            }
            output.push_str(&format!("Non-secret settings: GET http://localhost:{}/connections/{}/config{}. Never request raw credentials.\n",port,id,suffix));
        }
    }
    output
}

/// Intercept established cloud references; preserve local accounts of the same provider.
pub(crate) async fn broker(
    State(state): State<ConnectionsState>,
    request: Request,
    next: Next,
) -> Response {
    let path = request.uri().path().to_owned();
    let path = path
        .strip_prefix("/connections")
        .unwrap_or(&path)
        .to_owned();
    if path == "/cloud" || path.starts_with("/cloud/") {
        return next.run(request).await;
    }
    let ctx = CustodyContext::from(&state);
    if path == "/" || path.is_empty() {
        let _ = sync_accounts(&ctx).await;
        let refs = references(&ctx).await;
        let response = next.run(request).await;
        let status = response.status();
        if !status.is_success() {
            return response;
        }
        let Ok(bytes) = to_bytes(response.into_body(), 2 * 1024 * 1024).await else {
            return error(StatusCode::BAD_GATEWAY, "Connection list unavailable.");
        };
        let Ok(mut rows) = serde_json::from_slice::<Value>(&bytes) else {
            return error(StatusCode::BAD_GATEWAY, "Connection list unavailable.");
        };
        if let Some(rows) = rows.as_array_mut() {
            for row in rows {
                if refs.iter().any(|r| {
                    r["integration_id"] == row["id"]
                        || r["mcp_config"]["url"]
                            .as_str()
                            .and_then(crate::connections_api::connector_id_for_mcp_url)
                            .is_some_and(|id| row["id"] == id)
                }) {
                    row["connected"] = json!(true);
                    row["storage"] = json!("cloud");
                }
            }
        }
        return (status, Json(rows)).into_response();
    }
    let segments: Vec<_> = path.trim_matches('/').split('/').collect();
    let Some(id) = segments.first() else {
        return next.run(request).await;
    };
    let refs = references(&ctx).await;
    let candidates: Vec<_> = refs
        .iter()
        .filter(|r| r["kind"] == "native" && r["integration_id"] == *id)
        .collect();
    if candidates.is_empty() {
        return next.run(request).await;
    }
    let method = request.method().clone();
    if segments.get(1) == Some(&"instances") && segments.len() == 2 && method == "GET" {
        let response = next.run(request).await;
        let status = response.status();
        if !status.is_success() {
            return response;
        }
        let Ok(bytes) = to_bytes(response.into_body(), 2 * 1024 * 1024).await else {
            return error(StatusCode::BAD_GATEWAY, "Connection list unavailable.");
        };
        let Ok(mut data) = serde_json::from_slice::<Value>(&bytes) else {
            return error(StatusCode::BAD_GATEWAY, "Connection list unavailable.");
        };
        if let Some(instances) = data["instances"].as_array_mut() {
            for reference in candidates {
                if !instances
                    .iter()
                    .any(|row| row["instance"] == reference["instance"])
                {
                    instances.push(json!({"instance":reference["instance"],"connected":true,"storage":"cloud","display_name":reference["label"],"credentials":{}}));
                }
            }
        }
        return (status, Json(data)).into_response();
    }
    let query = request.uri().query().unwrap_or("").to_owned();
    let (parts, body) = request.into_parts();
    let Ok(bytes) = to_bytes(body, 2 * 1024 * 1024).await else {
        return error(StatusCode::PAYLOAD_TOO_LARGE, "Request is too large.");
    };
    let mut body: Value = if bytes.is_empty() {
        Value::Null
    } else {
        match serde_json::from_slice(&bytes) {
            Ok(body) => body,
            Err(_) => {
                return next
                    .run(Request::from_parts(parts, Body::from(bytes)))
                    .await
            }
        }
    };
    let mut pairs: Vec<(String, String)> = url::form_urlencoded::parse(query.as_bytes())
        .into_owned()
        .collect();
    let instance = segments
        .get(2)
        .filter(|_| segments.get(1) == Some(&"instances"))
        .map(|s| {
            url::form_urlencoded::parse(format!("i={}", s).as_bytes())
                .next()
                .map(|(_, v)| v.into_owned())
                .unwrap_or_default()
        })
        .or_else(|| {
            pairs
                .iter()
                .find(|(k, _)| k == "instance")
                .map(|(_, v)| v.clone())
        })
        .or_else(|| body["instance"].as_str().map(str::to_owned));
    let management = segments.len() == 1 || segments.get(1) == Some(&"instances");
    // Saving a new/default account should never overwrite an existing cloud reference.
    if management && (method == "PUT" || method == "POST") {
        if candidates
            .iter()
            .any(|r| r["instance"].as_str() == instance.as_deref())
        {
            return error(
                StatusCode::CONFLICT,
                "Disconnect the cloud account before changing its credentials.",
            );
        }
        return next
            .run(Request::from_parts(parts, Body::from(bytes)))
            .await;
    }
    let local = screenpipe_core::connections::sync::build_local_manifest(
        &ctx.screenpipe_dir,
        "cloud-selection",
        ctx.secret_store.as_deref(),
    )
    .await;
    let local_instances: Vec<_> = local
        .connections
        .values()
        .filter(|row| row.integration_id == *id && row.enabled)
        .map(|row| row.instance.clone())
        .collect();
    let selected = match select_account(&candidates, &local_instances, instance.as_deref()) {
        Ok(Some(reference)) => reference,
        Ok(None) => {
            return next
                .run(Request::from_parts(parts, Body::from(bytes)))
                .await
        }
        Err(()) => {
            return error(
                StatusCode::BAD_REQUEST,
                "Select one connected account using instance.",
            )
        }
    };
    if management && method == "DELETE" {
        return match disconnect(&ctx, selected).await {
            Ok(()) => Json(json!({"success":true})).into_response(),
            Err(_) => error(
                StatusCode::BAD_GATEWAY,
                "Could not disconnect cloud account.",
            ),
        };
    }
    if segments.len() == 1 && method == "GET" {
        return Json(json!({"connected":true,"storage":"cloud","credentials":{}})).into_response();
    }
    pairs.retain(|(key, _)| key != "instance");
    if let Some(body) = body.as_object_mut() {
        body.remove("instance");
    }
    let query = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(pairs)
        .finish();
    let target = format!(
        "{}{}",
        path,
        if query.is_empty() {
            String::new()
        } else {
            format!("?{}", query)
        }
    );
    match run(state,selected,json!({"operation":"execute","path":target,"method":parts.method.as_str(),"body":body})).await {
        Ok(data)=>Json(data).into_response(), Err(_)=>error(StatusCode::BAD_GATEWAY,"Cloud request could not be confirmed. Check the provider before retrying; the account may need reconnection."),
    }
}

fn select_account<'a>(
    cloud: &[&'a Value],
    local: &[Option<String>],
    instance: Option<&str>,
) -> Result<Option<&'a Value>, ()> {
    if let Some(instance) = instance {
        if local.iter().any(|i| i.as_deref() == Some(instance)) {
            return Ok(None);
        }
        return cloud
            .iter()
            .find(|r| r["instance"] == instance)
            .copied()
            .map(Some)
            .ok_or(());
    }
    // Match existing local semantics: default instance, otherwise a unique named account.
    if local.iter().any(Option::is_none) {
        return Ok(None);
    }
    if let Some(reference) = cloud.iter().find(|r| r["instance"].is_null()) {
        return Ok(Some(reference));
    }
    match (cloud.len(), local.len()) {
        (1, 0) => Ok(Some(cloud[0])),
        (0, _) => Ok(None),
        _ => Err(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn new_default_does_not_upload_existing_or_local_only_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let context = CustodyContext {
            screenpipe_dir: dir.path().to_path_buf(),
            secret_store: None,
        };
        assert_eq!(storage(&context).await, "cloud");
        assert_eq!(
            complete_new_connection(context.clone(), "slack", true).await["storage"],
            "local"
        );
        tokio::fs::write(
            dir.path().join("connection-storage.json"),
            br#"{"storage":"local"}"#,
        )
        .await
        .unwrap();
        assert_eq!(storage(&context).await, "local");
        assert_eq!(
            complete_new_connection(context.clone(), "slack", false).await["storage"],
            "local"
        );
        tokio::fs::write(
            dir.path().join("connection-storage.json"),
            b"interrupted-write",
        )
        .await
        .unwrap();
        assert_eq!(storage(&context).await, "local");
    }
    #[test]
    fn mixed_local_and_cloud_accounts_require_selection() {
        let cloud = json!({"instance":"cloud@example.com"});
        let refs = vec![&cloud];
        let local = vec![Some("local@example.com".into())];
        assert!(select_account(&refs, &local, None).is_err());
        assert!(select_account(&refs, &local, Some("missing")).is_err());
        assert!(select_account(&refs, &local, Some("local@example.com"))
            .unwrap()
            .is_none());
        assert_eq!(
            select_account(&refs, &local, Some("cloud@example.com")).unwrap(),
            Some(&cloud)
        );
    }
    #[test]
    fn default_local_account_remains_default() {
        let cloud = json!({"instance":"cloud@example.com"});
        assert!(select_account(&[&cloud], &[None], None).unwrap().is_none());
        assert_eq!(select_account(&[&cloud], &[], None).unwrap(), Some(&cloud));
    }
}
