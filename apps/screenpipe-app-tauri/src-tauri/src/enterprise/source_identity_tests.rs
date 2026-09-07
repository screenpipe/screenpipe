// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use super::*;
use std::sync::Mutex;
use wiremock::{
    matchers::{body_json, method, path},
    Mock, MockServer, ResponseTemplate,
};

const DEVICE: &str = "sp_device_v1_0123456789abcdef0123456789abcdef";
const FIRST: &str = "11111111-1111-4111-8111-111111111111";
const RESET: &str = "22222222-2222-4222-8222-222222222222";

struct Local {
    source: Mutex<String>,
    reads: Mutex<Vec<(Option<String>, u32)>>,
    reset_during_read: bool,
    fail_settings_save: Mutex<bool>,
    saved_device: Mutex<String>,
}
impl Local {
    fn new() -> Self {
        Self {
            source: Mutex::new(FIRST.into()),
            reads: Mutex::new(Vec::new()),
            reset_during_read: false,
            fail_settings_save: Mutex::new(false),
            saved_device: Mutex::new(FIRST.into()),
        }
    }
}
#[async_trait::async_trait]
impl LocalApiClient for Local {
    async fn initialized_upload_source_id(&self) -> Option<String> {
        Some(self.source.lock().unwrap().clone())
    }
    async fn device_identity_migration(
        &self,
        _: &str,
        _: &std::path::Path,
    ) -> Result<Option<(String, String)>, EnterpriseSyncError> {
        Ok(Some((DEVICE.into(), self.source.lock().unwrap().clone())))
    }
    async fn commit_device_identity(
        &self,
        _: &str,
        stable: &str,
    ) -> Result<(), EnterpriseSyncError> {
        if *self.fail_settings_save.lock().unwrap() {
            return Err(EnterpriseSyncError::Configuration(
                "simulated settings failure".into(),
            ));
        }
        *self.saved_device.lock().unwrap() = stable.into();
        Ok(())
    }
    async fn upload_source_id(&self) -> Result<String, EnterpriseSyncError> {
        Ok(self.source.lock().unwrap().clone())
    }
    async fn fetch_frames_since(
        &self,
        since: Option<&str>,
        offset: u32,
        _: u32,
    ) -> Result<Vec<FrameRow>, EnterpriseSyncError> {
        self.reads
            .lock()
            .unwrap()
            .push((since.map(str::to_string), offset));
        if self.reset_during_read {
            *self.source.lock().unwrap() = RESET.into();
        }
        Ok(vec![FrameRow {
            frame_id: 1,
            timestamp: chrono::Utc::now().to_rfc3339(),
            app_name: None,
            window_name: None,
            browser_url: None,
            text: Some("roadmap".into()),
        }])
    }
    async fn fetch_audio_since(
        &self,
        _: Option<&str>,
        _: u32,
        _: u32,
    ) -> Result<Vec<AudioRow>, EnterpriseSyncError> {
        Ok(Vec::new())
    }
}
fn config(server: &MockServer, dir: &tempfile::TempDir) -> EnterpriseSyncConfig {
    EnterpriseSyncConfig {
        license_key: "test".into(),
        device_id: DEVICE.into(),
        stable_device_id: None,
        device_label: "Test laptop".into(),
        ingest_url: format!("{}/api/enterprise/ingest", server.uri()),
        cursor_path: dir.path().join("cursor.json"),
        upload_mode: EnterpriseUploadMode::HostedIngest,
        log_dirs: Vec::new(),
    }
}
async fn registration(server: &MockServer, source: &str) {
    Mock::given(method("POST"))
        .and(path("/api/enterprise/device-sources"))
        .and(body_json(
            serde_json::json!({ "source_id": source, "device_id": DEVICE }),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(
            serde_json::json!({ "version": 1, "source_id": source, "device_id": DEVICE }),
        ))
        .mount(server)
        .await;
}

#[tokio::test]
async fn existing_device_migration_preserves_every_cursor_and_retries_failed_settings_save() {
    let server = MockServer::start().await;
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = config(&server, &dir);
    cfg.device_id = FIRST.into();
    let local = Local::new();
    let http = reqwest::Client::new();
    let mut cursor: Cursor = serde_json::from_value(serde_json::json!({
        "last_frame_ts":"2026-01-01T00:00:00Z", "last_audio_ts":"2026-01-02T00:00:00Z",
        "last_ui_ts":"2026-01-03T00:00:00Z", "last_memory_ts":"2026-01-04T00:00:00Z",
        "last_parsed_ts":"2026-01-05T00:00:00Z", "last_feedback_ts":"2026-01-06T00:00:00Z",
        "boundary":{"frames":5,"audio":3,"ui":2,"memories":4,"parsed":8,"activity_ts":"2026-01-07T00:00:00Z","feedback_id":"last"}
    })).unwrap();
    let mut expected = serde_json::to_value(&cursor).unwrap();
    expected["source_id"] = serde_json::json!(FIRST);
    *local.fail_settings_save.lock().unwrap() = true;
    Mock::given(method("POST")).and(path("/api/enterprise/device-identity-migration"))
        .and(body_json(serde_json::json!({"migrate_from":FIRST,"source_id":FIRST,"device_id":DEVICE})))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"version":2,"migrate_from":FIRST,"source_id":FIRST,"device_id":DEVICE})))
        .mount(&server).await;
    assert!(
        migrate_device_identity(&mut cfg, &mut cursor, &local, &http)
            .await
            .is_err()
    );
    assert_eq!(cfg.device_id, FIRST);
    assert_eq!(
        serde_json::to_value(Cursor::load(&cfg.cursor_path)).unwrap(),
        expected
    );
    assert_eq!(*local.saved_device.lock().unwrap(), FIRST);
    // Simulate restarting between the cursor save and the settings save.
    cursor = Cursor::load(&cfg.cursor_path);
    *local.fail_settings_save.lock().unwrap() = false;
    migrate_device_identity(&mut cfg, &mut cursor, &local, &http)
        .await
        .unwrap();
    assert_eq!(cfg.device_id, DEVICE);
    assert_eq!(*local.saved_device.lock().unwrap(), DEVICE);
    assert_eq!(serde_json::to_value(&cursor).unwrap(), expected);
    migrate_device_identity(&mut cfg, &mut cursor, &local, &http)
        .await
        .unwrap();
    assert_eq!(server.received_requests().await.unwrap().len(), 2);
    assert!(local.reads.lock().unwrap().is_empty());
}

#[tokio::test]
async fn existing_device_migration_rejects_old_server_and_conflicts_without_changing_cursor() {
    for response in [
        ResponseTemplate::new(409),
        ResponseTemplate::new(404),
        ResponseTemplate::new(200)
            .set_body_json(serde_json::json!({"version":1,"source_id":FIRST,"device_id":DEVICE})),
    ] {
        let server = MockServer::start().await;
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = config(&server, &dir);
        cfg.device_id = FIRST.into();
        let local = Local::new();
        let mut cursor = Cursor {
            last_frame_ts: Some("2026-01-01T00:00:00Z".into()),
            ..Default::default()
        };
        let before = serde_json::to_value(&cursor).unwrap();
        Mock::given(method("POST"))
            .respond_with(response)
            .mount(&server)
            .await;
        assert!(
            migrate_device_identity(&mut cfg, &mut cursor, &local, &reqwest::Client::new())
                .await
                .is_err()
        );
        assert_eq!(cfg.device_id, FIRST);
        assert_eq!(serde_json::to_value(&cursor).unwrap(), before);
        assert!(!cfg.cursor_path.exists());
        assert!(local.reads.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn database_reset_during_pending_migration_discards_only_the_old_cursor() {
    let server = MockServer::start().await;
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = config(&server, &dir);
    cfg.device_id = FIRST.into();
    let local = Local::new();
    *local.source.lock().unwrap() = RESET.into();
    let mut cursor = Cursor {
        last_frame_ts: Some("2026-01-01T00:00:00Z".into()),
        ..Default::default()
    };
    Mock::given(method("POST")).and(body_json(serde_json::json!({"migrate_from":FIRST,"source_id":RESET,"device_id":DEVICE})))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"version":2,"migrate_from":FIRST,"source_id":RESET,"device_id":DEVICE})))
        .mount(&server).await;
    migrate_device_identity(&mut cfg, &mut cursor, &local, &reqwest::Client::new())
        .await
        .unwrap();
    assert_eq!(cfg.device_id, DEVICE);
    assert_eq!(cursor.source_id.as_deref(), Some(RESET));
    assert!(cursor.last_frame_ts.is_none());
}

#[tokio::test]
async fn unavailable_migration_keeps_existing_uploads_working_but_blocks_a_reset_namespace() {
    let server = MockServer::start().await;
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = config(&server, &dir);
    cfg.device_id = FIRST.into();
    let local = Local::new();
    let mut cursor = Cursor::default();
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(409))
        .mount(&server)
        .await;
    try_device_identity_migration(&mut cfg, &mut cursor, &local, &reqwest::Client::new())
        .await
        .unwrap();
    assert_eq!(cfg.device_id, FIRST);
    *local.source.lock().unwrap() = RESET.into();
    assert!(
        try_device_identity_migration(&mut cfg, &mut cursor, &local, &reqwest::Client::new())
            .await
            .is_err()
    );
    assert_eq!(cfg.device_id, FIRST);
}

#[tokio::test]
async fn deferred_migration_still_rejects_database_replacement_during_a_batch() {
    let _env_lock = super::tests::ENV_LOCK.lock().unwrap();
    let server = MockServer::start().await;
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = config(&server, &dir);
    cfg.device_id = FIRST.into();
    let mut local = Local::new();
    local.reset_during_read = true;
    let mut cursor = Cursor::default();
    let http = reqwest::Client::new();
    try_device_identity_migration(&mut cfg, &mut cursor, &local, &http)
        .await
        .unwrap();
    assert!(run_one_sync(&cfg, &mut cursor, &local, &http)
        .await
        .is_err());
    assert!(server
        .received_requests()
        .await
        .unwrap()
        .iter()
        .all(|r| r.url.path() == "/api/enterprise/device-identity-migration"));
}

#[tokio::test]
async fn reset_changes_upload_namespace_and_cursor_but_preserves_device_identity() {
    let _env_lock = super::tests::ENV_LOCK.lock().unwrap();
    let server = MockServer::start().await;
    let dir = tempfile::tempdir().unwrap();
    let cfg = config(&server, &dir);
    let local = Local::new();
    let http = reqwest::Client::new();
    for source in [FIRST, RESET] {
        registration(&server, source).await;
    }
    Mock::given(method("POST"))
        .and(path("/api/enterprise/ingest"))
        .respond_with(ResponseTemplate::new(202))
        .expect(2)
        .mount(&server)
        .await;
    let mut cursor = Cursor::default();
    run_one_sync_inner(&cfg, &mut cursor, &local, &http, false, None)
        .await
        .unwrap();
    assert_eq!(
        Cursor::load(&cfg.cursor_path).source_id.as_deref(),
        Some(FIRST)
    );
    // A replacement database must ignore progress left by its predecessor.
    cursor.last_frame_ts = Some("2099-01-01T00:00:00Z".into());
    cursor.boundary.frames = 900;
    *local.source.lock().unwrap() = RESET.into();
    run_one_sync_inner(&cfg, &mut cursor, &local, &http, false, None)
        .await
        .unwrap();
    assert_eq!(
        Cursor::load(&cfg.cursor_path).source_id.as_deref(),
        Some(RESET)
    );
    assert_eq!(cfg.device_id, DEVICE);
    let reads = local.reads.lock().unwrap();
    assert_eq!(reads.len(), 2);
    assert!(reads
        .iter()
        .all(|(since, offset)| since.as_deref() != Some("2099-01-01T00:00:00Z") && *offset == 0));
    let requests = server.received_requests().await.unwrap();
    let uploads: Vec<_> = requests
        .iter()
        .filter(|r| r.url.path() == "/api/enterprise/ingest")
        .collect();
    for (request, source) in uploads.iter().zip([FIRST, RESET]) {
        assert_eq!(request.headers["x-screenpipe-stable-device-id"], DEVICE);
        let record: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
        assert_eq!(record["device_id"], source);
        assert_eq!(record["frame_id"], 1);
        assert!(
            record.get("stable_device_id").is_none(),
            "JSONL contract stays unchanged"
        );
    }
}

#[tokio::test]
async fn old_control_plane_cannot_accept_new_source_uploads_without_registration() {
    let _env_lock = super::tests::ENV_LOCK.lock().unwrap();
    let server = MockServer::start().await;
    let dir = tempfile::tempdir().unwrap();
    let cfg = config(&server, &dir);
    let local = Local::new();
    let mut cursor = Cursor::default();
    assert!(
        run_one_sync_inner(&cfg, &mut cursor, &local, &reqwest::Client::new(), false, None)
            .await
            .is_err()
    );
    assert!(local.reads.lock().unwrap().is_empty());
    assert!(cursor.source_id.is_none());
    assert!(!cfg.cursor_path.exists());
}

#[tokio::test]
async fn database_replaced_during_fetch_is_not_uploaded_under_the_previous_source() {
    let _env_lock = super::tests::ENV_LOCK.lock().unwrap();
    let server = MockServer::start().await;
    let dir = tempfile::tempdir().unwrap();
    let cfg = config(&server, &dir);
    registration(&server, FIRST).await;
    let local = Local {
        reset_during_read: true,
        ..Local::new()
    };
    assert!(run_one_sync_inner(
        &cfg,
        &mut Cursor::default(),
        &local,
        &reqwest::Client::new(),
        false,
        None,
    )
    .await
    .is_err());
    assert!(!cfg.cursor_path.exists());
    assert!(server
        .received_requests()
        .await
        .unwrap()
        .iter()
        .all(|r| r.url.path() != "/api/enterprise/ingest"));
}
