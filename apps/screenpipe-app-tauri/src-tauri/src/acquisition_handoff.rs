// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Download possession -> authenticated account. Best effort, off the
//! recording/startup path. The server owns authorization and attribution rules.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Listener};

static WAKE: tokio::sync::Notify = tokio::sync::Notify::const_new();
static RETIREMENT: Retirement = Retirement::new();
static STORAGE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

const SERVICE: &str = if cfg!(feature = "enterprise-build") {
    "com.screenpipe.enterprise.acquisition.v1"
} else { "com.screenpipe.acquisition.v1" };
const PLACEHOLDER: &str = "00000000-0000-4000-8000-000000000000";

#[derive(Clone, Serialize, Deserialize)]
struct Pending {
    grant: String,
    request_id: String,
    verifier: String,
    created: i64,
    account: Option<String>,
    claimed: bool,
    retired: bool,
}

fn uuid4(value: &str) -> bool {
    uuid::Uuid::parse_str(value)
        .map(|v| v.get_version_num() == 4 && v.get_variant() == uuid::Variant::RFC4122 && v.to_string() == value && value != PLACEHOLDER)
        .unwrap_or(false)
}

// This is only a local account boundary. The API verifies the JWT signature.
pub(crate) fn subject(token: &str) -> Option<String> {
    let bytes = URL_SAFE_NO_PAD.decode(token.split('.').nth(1)?).ok()?;
    let json: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let sub = json.get("sub")?.as_str()?;
    (sub.starts_with("user_") && sub.len() <= 105 && sub[5..].chars().all(|c| c.is_ascii_alphanumeric()))
        .then(|| sub.to_string())
}

impl Pending {
    fn new(grant: String) -> Self {
        // Two independent v4 UUIDs provide 244 random bits. Hashing keeps the
        // verifier at the API's fixed 32-byte/base64url width.
        use sha2::{Digest, Sha256};
        let entropy = format!("{}{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
        Self { grant, request_id: uuid::Uuid::new_v4().to_string(),
            verifier: URL_SAFE_NO_PAD.encode(Sha256::digest(entropy.as_bytes())),
            created: chrono::Utc::now().timestamp(), account: None, claimed: false, retired: false }
    }
    fn expired(&self, now: i64) -> bool {
        self.created > now || now - self.created >= 30 * 24 * 3600
    }
    fn crossed_account(&self, current: Option<&str>) -> bool {
        self.account.as_deref().is_some_and(|pinned| Some(pinned) != current)
    }
}

#[cfg(target_os = "macos")]
fn carrier() -> Option<String> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let executable = std::env::current_exe().ok()?;
    let bundle = executable.ancestors().find(|p| p.extension().is_some_and(|e| e == "app"))?;
    let path = CString::new(bundle.as_os_str().as_bytes()).ok()?;
    let name = CString::new("com.apple.application-instance").ok()?;
    let mut bytes = [0u8; 36];
    // Exact-size read; absent, truncated or oversized attributes are ignored.
    let size = unsafe { libc::getxattr(path.as_ptr(), name.as_ptr(), bytes.as_mut_ptr().cast(), bytes.len(), 0, 0) };
    if size != 36 { return None; }
    let grant = String::from_utf8(bytes.to_vec()).ok()?.to_ascii_lowercase();
    uuid4(&grant).then_some(grant)
}

fn storage_account(profile: &std::path::Path, origin: &str) -> String {
    use sha2::{Digest, Sha256};
    format!("profile-{:x}", Sha256::digest(format!("{}\n{}", profile.display(), origin).as_bytes()))
}

fn current_storage_account() -> String {
    storage_account(crate::config::app_data_dir(), &crate::web_base::screenpipe_web_base())
}

fn tombstone() -> std::path::PathBuf {
    crate::config::app_data_dir().join(format!("acquisition-retired-{}", current_storage_account()))
}

fn decode_pending(bytes: &[u8]) -> Result<Pending, ()> {
    let p: Pending = serde_json::from_slice(bytes).map_err(|_| ())?;
    if !uuid4(&p.grant) || !uuid4(&p.request_id) || p.verifier.len() != 43 { return Err(()); }
    Ok(p)
}

#[cfg(target_os = "macos")]
async fn load_saved() -> Result<Option<Pending>, ()> {
    tauri::async_runtime::spawn_blocking(|| {
        match security_framework::passwords::get_generic_password(SERVICE, &current_storage_account()) {
            Ok(bytes) => decode_pending(&bytes).map(Some),
            Err(e) if e.code() == -25300 => Ok(None),
            Err(_) => Err(()), // A locked Keychain is not an empty one.
        }
    }).await.map_err(|_| ())?
}

#[cfg(target_os = "macos")]
async fn save(pending: &Pending) -> Result<(), ()> {
    let bytes = serde_json::to_vec(pending).map_err(|_| ())?;
    tauri::async_runtime::spawn_blocking(move || {
        security_framework::passwords::set_generic_password(SERVICE, &current_storage_account(), &bytes).map_err(|_| ())
    }).await.map_err(|_| ())?
}

// Windows/Linux reuse the application's credential store and encryption policy.
// This is a separate credential DB, never the recording database.
async fn credential_store_at(profile: &std::path::Path, key: Option<[u8; 32]>) -> Result<screenpipe_secrets::SecretStore, ()> {
    screenpipe_secrets::SecretStore::open_for_data_dir(profile, key).await.map_err(|_| ())
}

#[cfg(not(target_os = "macos"))]
async fn credential_store() -> Result<screenpipe_secrets::SecretStore, ()> {
    let key = match crate::secrets::get_key_if_encryption_enabled() {
        crate::secrets::KeyResult::Found(k) => Some(k),
        crate::secrets::KeyResult::NotFound | crate::secrets::KeyResult::Unavailable => None,
        crate::secrets::KeyResult::AccessDenied => return Err(()),
    };
    credential_store_at(crate::config::app_data_dir(), key).await
}

#[cfg(not(target_os = "macos"))]
async fn load_saved() -> Result<Option<Pending>, ()> {
    let store = credential_store().await?;
    store.get(&format!("{SERVICE}.{}", current_storage_account())).await.map_err(|_| ())?
        .map(|bytes| decode_pending(&bytes)).transpose()
}

#[cfg(not(target_os = "macos"))]
async fn save(pending: &Pending) -> Result<(), ()> {
    let store = credential_store().await?;
    store.set(&format!("{SERVICE}.{}", current_storage_account()), &serde_json::to_vec(pending).map_err(|_| ())?)
        .await.map_err(|_| ())
}

async fn persist(pending: &Pending) -> Result<(), ()> {
    let _guard = STORAGE.lock().await;
    if (RETIREMENT.disabled(&tombstone()) || load_saved().await?.is_some_and(|old| old.retired || old.grant != pending.grant)) && !pending.retired { return Err(()); }
    save(pending).await
}

/// Download filenames carry only a random capability, never a user/source ID.
fn grant_from_filename(name: &str, extension: &str) -> Option<String> {
    let grant = name.strip_prefix("screenpipe-")?.strip_suffix(extension)?;
    uuid4(grant).then(|| grant.to_owned())
}

#[cfg(target_os = "windows")]
fn carrier() -> Option<String> {
    carrier_from(std::env::current_exe().ok()?.parent()?)
}

#[cfg(target_os = "windows")]
fn carrier_from(directory: &std::path::Path) -> Option<String> {
    // The installer writes this once. Keep the read bounded so an untrusted or
    // corrupt install directory cannot turn startup into an unbounded read.
    let path = directory.join("acquisition-grant");
    let metadata = std::fs::metadata(&path).ok()?;
    if metadata.len() != 36 { return None; }
    use std::io::Read;
    let mut bytes = Vec::with_capacity(37);
    std::fs::File::open(path).ok()?.take(37).read_to_end(&mut bytes).ok()?;
    if bytes.len() != 36 { return None; }
    let grant = String::from_utf8(bytes).ok()?;
    uuid4(&grant).then_some(grant)
}

#[cfg(target_os = "linux")]
fn carrier() -> Option<String> {
    // AppImages execute from a temporary mount; APPIMAGE is the original file.
    let path = std::path::PathBuf::from(std::env::var_os("APPIMAGE")?);
    grant_from_filename(path.file_name()?.to_str()?, ".AppImage")
}

// Retirement never waits for the optional credential store. A late credential
// write cannot remove this separate marker or revive the process-local latch.
struct Retirement {
    retired: AtomicBool,
    cancel: tokio::sync::Notify,
}

impl Retirement {
    const fn new() -> Self {
        Self { retired: AtomicBool::new(false), cancel: tokio::sync::Notify::const_new() }
    }

    fn is_retired(&self) -> bool { self.retired.load(Ordering::SeqCst) }

    fn disabled(&self, marker: &std::path::Path) -> bool {
        self.is_retired() || marker.exists()
    }

    fn retire(&self, marker: &std::path::Path) -> std::io::Result<()> {
        self.retired.store(true, Ordering::SeqCst);
        self.cancel.notify_waiters();
        // Independent of STORAGE and Keychain, including when either is stalled.
        // A failed marker write still fails closed for this process.
        let file = std::fs::File::create(marker)?;
        file.sync_all()
    }

    async fn until_retired<T>(&self, work: impl std::future::Future<Output = T>) -> Option<T> {
        let cancellation = self.cancel.notified();
        tokio::pin!(cancellation);
        cancellation.as_mut().enable();
        if self.is_retired() { return None; }
        tokio::select! {
            biased;
            _ = &mut cancellation => None,
            value = work => if self.is_retired() { None } else { Some(value) },
        }
    }
}

pub fn wake() { WAKE.notify_one(); }

pub fn retire() {
    if RETIREMENT.retire(&tombstone()).is_err() {
        tracing::warn!("acquisition retirement marker unavailable; disabled for this process");
    }
}

fn watch_settings<R: tauri::Runtime>(
    app: &AppHandle<R>,
    store_path: std::path::PathBuf,
    retire: impl Fn() + Send + Sync + 'static,
) {
    // Store.set emits synchronously for both frontend and managed-policy writes.
    // Inspect the event itself: rereading the store here would deadlock its lock,
    // and a deferred read could miss a fast false -> true transition.
    app.listen("store://change", move |event| {
        let Ok(change) = serde_json::from_str::<serde_json::Value>(event.payload()) else { return; };
        if change["key"] == "settings"
            && change["path"].as_str().is_some_and(|path| std::path::Path::new(path) == store_path)
            && change["value"]["analyticsEnabled"] == false {
            retire();
        }
    });
}

pub fn spawn(app: AppHandle) {
    watch_settings(&app, crate::config::app_data_dir().join("store.bin"), retire);
    tauri::async_runtime::spawn(async move {
        // Keychain/settings can be temporarily unavailable during startup.
        for _ in 0..240 {
            if run(app.clone()).await.is_ok() { return; }
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(30)) => {},
                _ = WAKE.notified() => {},
            }
        }
    });
}

async fn run(app: AppHandle) -> Result<(), ()> {
    if RETIREMENT.disabled(&tombstone()) { return Ok(()); }
    let mut p = match load_saved().await? {
        Some(p) => p,
        None => match carrier() { Some(grant) => Pending::new(grant), None => return Ok(()) },
    };
    if p.retired { return Ok(()); }
    // Persist proof BEFORE first claim, including when its HTTP response is lost.
    persist(&p).await?;
    let origin = reqwest::Url::parse(&crate::web_base::screenpipe_web_base()).map_err(|_| ())?;
    if origin.scheme() != "https" || !origin.username().is_empty() || origin.password().is_some()
        || origin.query().is_some() || origin.fragment().is_some() || origin.path() != "/" { return Err(()); }
    let client = reqwest::Client::builder().timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none()).build().map_err(|_| ())?;
    let mut retry_seconds = 30;
    loop {
        let settings = crate::store::SettingsStore::get(&app).map_err(|_| ())?.ok_or(())?;
        let token = crate::auth_token::cached_cloud_token();
        let account = token.as_deref().and_then(subject);
        let enabled = settings.recording.analytics_enabled && !screenpipe_engine::analytics::telemetry_disabled_by_env();
        if !enabled || p.expired(chrono::Utc::now().timestamp()) || p.crossed_account(account.as_deref())
            || RETIREMENT.is_retired() {
            retire();
            p.retired = true;
            persist(&p).await?;
            // Retire locally first. Failed cancellation never authorizes reuse.
            if p.claimed { let _ = send(&client, &origin, "cancel", &p, None).await; }
            return Ok(());
        }
        if p.account.is_none() && account.is_some() {
            p.account = account;
            persist(&p).await?;
        }
        let action = if !p.claimed { Some("claim") } else if token.is_some() && p.account.is_some() { Some("bind") } else { None };
        if let Some(action) = action {
            // Pin and permission reads precede EVERY request; no logged proof/JWT.
            if RETIREMENT.is_retired() { continue; }
            let latest = crate::store::SettingsStore::get(&app).map_err(|_| ())?.ok_or(())?;
            let latest_token = crate::auth_token::cached_cloud_token();
            if !latest.recording.analytics_enabled {
                retire(); p.retired = true; persist(&p).await?; return Ok(());
            }
            if latest_token.as_deref().and_then(subject) != p.account {
                // First login during persistence is progress, not an account
                // switch. Loop to durably pin it before sending anything.
                if p.account.is_none() { continue; }
                retire(); p.retired = true; persist(&p).await?; return Ok(());
            }
            let Some(outcome) = RETIREMENT.until_retired(
                send(&client, &origin, action, &p, latest_token.as_deref())
            ).await else { return Ok(()); };
            match outcome.as_deref() {
                Some("redeemed") => { p.claimed = true; persist(&p).await?; retry_seconds = 30; continue; }
                Some("bound" | "denied" | "expired" | "invalid_request") => {
                    retire(); p.retired = true; persist(&p).await?; return Ok(());
                }
                _ => { retry_seconds = (retry_seconds * 2).min(900); } // Same proof, bounded backoff.
            }
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(retry_seconds)) => {},
            _ = RETIREMENT.cancel.notified() => {},
            _ = WAKE.notified() => {},
        }
    }
}

async fn send(client: &reqwest::Client, origin: &reqwest::Url, action: &str, p: &Pending, token: Option<&str>) -> Option<String> {
    let url = origin.join(&format!("/api/attribution/download-handoff/{action}")).ok()?;
    let mut body = serde_json::json!({"request_id":p.request_id,"verifier":p.verifier});
    if action == "claim" { body["grant"] = p.grant.clone().into(); }
    let mut request = client.post(url).json(&body);
    if action == "bind" { request = request.bearer_auth(token?); }
    let mut response = request.send().await.ok()?;
    let status = response.status();
    if !status.is_success() && status.as_u16() != 409 { return None; }
    // The API's fixed response is tiny. Don't accept an unbounded body.
    if response.content_length().is_some_and(|n| n > 2048) { return None; }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if bytes.len() + chunk.len() > 2048 { return None; }
        bytes.extend_from_slice(&chunk);
    }
    let data: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let outcome = data.get("outcome")?.as_str()?;
    if !status.is_success() && matches!(outcome, "redeemed" | "bound") { return None; }
    if matches!(outcome, "redeemed" | "bound") && data.get("request_id")?.as_str()? != p.request_id { return None; }
    Some(outcome.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn portable_filenames_reject_placeholders_and_ambiguous_names() {
        let grant = "12345678-1234-4234-8234-123456789012";
        for extension in [".exe", ".AppImage"] {
            assert_eq!(grant_from_filename(&format!("screenpipe-{grant}{extension}"), extension), Some(grant.into()));
            for name in [format!("screenpipe-{PLACEHOLDER}{extension}"), format!("screenpipe-{grant}.txt{extension}"), format!("../screenpipe-{grant}{extension}"), format!("screenpipe-{grant}{extension}.exe")] {
                assert!(grant_from_filename(&name, extension).is_none());
            }
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn installed_windows_carrier_is_exact_and_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("acquisition-grant");
        let grant = "12345678-1234-4234-8234-123456789012";
        std::fs::write(&path, grant).unwrap();
        assert_eq!(carrier_from(dir.path()), Some(grant.into()));
        for invalid in [
            PLACEHOLDER,
            "12345678-1234-4234-7234-123456789012",
            "12345678-1234-4234-C234-123456789012",
            "12345678-1234-4234-8234-12345678901X",
        ] {
            std::fs::write(&path, invalid).unwrap();
            assert!(carrier_from(dir.path()).is_none());
        }
        std::fs::write(&path, format!("{grant}\n")).unwrap();
        assert!(carrier_from(dir.path()).is_none());
    }

    #[tokio::test]
    async fn credential_store_preserves_proof_and_retirement_across_restart() {
        let dir = tempfile::tempdir().unwrap();
        let account = storage_account(dir.path(), "https://screenpipe.com");
        let p = Pending::new(uuid::Uuid::new_v4().to_string());
        {
            let store = credential_store_at(dir.path(), Some([7; 32])).await.unwrap();
            store.set(&account, &serde_json::to_vec(&p).unwrap()).await.unwrap();
        }
        let store = credential_store_at(dir.path(), Some([7; 32])).await.unwrap();
        let mut saved = decode_pending(&store.get(&account).await.unwrap().unwrap()).unwrap();
        assert_eq!(saved.verifier, p.verifier);
        assert_eq!(saved.request_id, p.request_id);
        assert!(store.get(&storage_account(dir.path(), "https://preview.example")).await.unwrap().is_none());
        saved.retired = true;
        store.set(&account, &serde_json::to_vec(&saved).unwrap()).await.unwrap();
        assert!(decode_pending(&store.get(&account).await.unwrap().unwrap()).unwrap().retired);
    }

    #[test]
    fn dev_e2e_and_preview_profiles_cannot_share_production_proof() {
        let prod = storage_account(std::path::Path::new("/profile/prod"), "https://screenpipe.com");
        assert_ne!(prod, storage_account(std::path::Path::new("/profile/dev"), "https://screenpipe.com"));
        assert_ne!(prod, storage_account(std::path::Path::new("/profile/e2e"), "https://screenpipe.com"));
        assert_ne!(prod, storage_account(std::path::Path::new("/profile/prod"), "https://preview.example"));
    }
    #[test]
    fn proof_survives_restart_without_rotation() {
        let p = Pending::new(uuid::Uuid::new_v4().to_string());
        let copy: Pending = serde_json::from_slice(&serde_json::to_vec(&p).unwrap()).unwrap();
        assert_eq!(p.verifier, copy.verifier);
        assert_eq!(p.request_id, copy.request_id);
        assert_eq!(URL_SAFE_NO_PAD.decode(p.verifier).unwrap().len(), 32);
    }
    #[test]
    fn account_switch_logout_and_clock_rollback_retire() {
        let mut p = Pending::new(uuid::Uuid::new_v4().to_string());
        assert!(!p.crossed_account(None));
        p.account = Some("user_A".into());
        assert!(!p.crossed_account(Some("user_A")));
        assert!(p.crossed_account(Some("user_B")));
        assert!(p.crossed_account(None));
        assert!(p.expired(p.created - 1));
        assert!(p.expired(p.created + 30 * 24 * 3600));
    }
    #[test]
    fn no_placeholder_or_untrusted_subject() {
        assert!(!uuid4(PLACEHOLDER));
        assert!(!uuid4("not-a-grant"));
        assert!(subject("not-a-token").is_none());
    }
    async fn response_server(response: String) -> (reqwest::Client, reqwest::Url) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 4096];
            let _ = socket.read(&mut request).await;
            let _ = socket.write_all(response.as_bytes()).await;
        });
        (reqwest::Client::new(), reqwest::Url::parse(&format!("http://{address}/")).unwrap())
    }
    #[tokio::test]
    async fn retry_provisioning_and_reject_wrong_response_identity() {
        let p = Pending::new(uuid::Uuid::new_v4().to_string());
        let (client, origin) = response_server("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n".into()).await;
        assert!(send(&client, &origin, "bind", &p, Some("synthetic")).await.is_none());
        let body = r#"{"outcome":"bound","request_id":"wrong"}"#;
        let (client, origin) = response_server(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{}", body.len(), body)).await;
        assert!(send(&client, &origin, "bind", &p, Some("synthetic")).await.is_none());
    }
    #[tokio::test]
    async fn rejects_oversized_chunked_response() {
        let p = Pending::new(uuid::Uuid::new_v4().to_string());
        let response = format!("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1000\r\n{}\r\n0\r\n\r\n", "x".repeat(4096));
        let (client, origin) = response_server(response).await;
        assert!(send(&client, &origin, "claim", &p, None).await.is_none());
    }

    #[tokio::test]
    async fn retirement_does_not_wait_for_stalled_credential_storage() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("retired");
        let retirement = Retirement::new();
        let _stalled_credentials = STORAGE.lock().await;
        tokio::time::timeout(Duration::from_millis(200), async {
            retirement.retire(&marker).unwrap();
        }).await.expect("retirement must not block authentication on credentials");
        assert!(retirement.disabled(&marker));
        let store = credential_store_at(dir.path(), None).await.unwrap();
        let pending = Pending::new(uuid::Uuid::new_v4().to_string());
        store.set("late-proof", &serde_json::to_vec(&pending).unwrap()).await.unwrap();
        assert!(Retirement::new().disabled(&marker), "restart must remain retired after late persistence");
    }

    #[test]
    fn settings_event_retires_even_when_reenabled_before_worker_wakes() {
        let dir = tempfile::tempdir().unwrap();
        let store_path = dir.path().join("store.bin");
        let marker = dir.path().join("retired");
        let retirement = std::sync::Arc::new(Retirement::new());
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_store::Builder::default().build())
            .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
        let state = retirement.clone();
        let saved_marker = marker.clone();
        watch_settings(app.handle(), store_path.clone(), move || {
            state.retire(&saved_marker).unwrap();
        });
        let store = tauri_plugin_store::StoreBuilder::new(app.handle(), store_path)
            .disable_auto_save().build().unwrap();
        let other = tauri_plugin_store::StoreBuilder::new(app.handle(), dir.path().join("other.bin"))
            .disable_auto_save().build().unwrap();
        other.set("settings", serde_json::json!({"analyticsEnabled": false}));
        store.set("unrelated", serde_json::json!({"analyticsEnabled": false}));
        store.set("settings", serde_json::json!({"analyticsEnabled": true}));
        assert!(!retirement.is_retired());
        store.set("settings", serde_json::json!({"analyticsEnabled": false}));
        store.set("settings", serde_json::json!({"analyticsEnabled": true}));
        assert!(retirement.disabled(&marker));
        assert!(Retirement::new().disabled(&marker));
    }

    #[tokio::test]
    async fn retirement_cancels_stalled_http_and_prevents_another_request() {
        use tokio::io::AsyncReadExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = reqwest::Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let (received, request_received) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 4096];
            socket.read(&mut request).await.unwrap();
            received.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        let retirement = std::sync::Arc::new(Retirement::new());
        let state = retirement.clone();
        let worker = tokio::spawn(async move {
            let p = Pending::new(uuid::Uuid::new_v4().to_string());
            state.until_retired(send(&reqwest::Client::new(), &origin, "bind", &p, Some("synthetic"))).await
        });
        tokio::time::timeout(Duration::from_secs(2), request_received).await.unwrap().unwrap();
        let dir = tempfile::tempdir().unwrap();
        retirement.retire(&dir.path().join("retired")).unwrap();
        assert!(tokio::time::timeout(Duration::from_millis(200), worker).await.unwrap().unwrap().is_none());
        assert!(retirement.until_retired(async { panic!("retired proof must never start another request") }).await.is_none());
        server.abort();
    }

    #[tokio::test]
    async fn failed_marker_write_still_cancels_for_this_process() {
        let dir = tempfile::tempdir().unwrap();
        let retirement = Retirement::new();
        assert!(retirement.retire(dir.path()).is_err());
        assert!(retirement.is_retired());
        assert!(retirement.until_retired(async { "must not run" }).await.is_none());
    }

}
