// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use screenpipe_audio::audio_manager::AudioManagerBuilder;
use screenpipe_core::pipes::permissions::{parse_rules, PipePermissions};
use screenpipe_db::DatabaseManager;
use screenpipe_engine::{routes::workflows::workflow_id, SCServer};
use serde_json::{json, Value};
use std::{net::SocketAddr, sync::Arc};
use tower::ServiceExt;

async fn request(router: &axum::Router, path: &str, token: Option<&str>) -> (StatusCode, Value) {
    let mut builder = Request::builder().uri(path);
    if let Some(token) = token {
        builder = builder.header("Authorization", format!("Bearer {token}"));
    }
    let response = router
        .clone()
        .oneshot(builder.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 4 * 1024 * 1024)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[tokio::test]
async fn workflow_catalog_api_reads_desktop_store_and_enforces_access() {
    check_workflow_catalog(false).await;
}

#[tokio::test]
async fn workflow_catalog_retains_automation_evidence_after_parquet_migration() {
    check_workflow_catalog(true).await;
}

async fn check_workflow_catalog(migrate_to_parquet: bool) {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("db.sqlite");
    let mut db = Arc::new(
        DatabaseManager::new(db_path.to_str().unwrap(), Default::default())
            .await
            .unwrap(),
    );
    let captured_at = chrono::DateTime::parse_from_rfc3339("2026-01-01T12:00:30Z")
        .unwrap()
        .with_timezone(&chrono::Utc);
    db.insert_video_chunk("fixture.mp4", "fixture-monitor")
        .await
        .unwrap();
    let frame_id = db
        .insert_frame(
            "fixture-monitor",
            Some(captured_at),
            None,
            Some("Browser"),
            Some("Invoice"),
            true,
            Some(0),
        )
        .await
        .unwrap();
    let nodes = json!([
        {"role":"AXGroup","text":"","depth":0,"automation_id":"invoice-form"},
        {"role":"AXButton","text":"","depth":1,"automation_id":"approve","is_enabled":true,"bounds":{"left":0.25,"top":0.5,"width":0.125,"height":0.0625}}
    ]);
    let mut tx = db.begin_immediate_with_retry().await.unwrap();
    sqlx::query("UPDATE frames SET full_text = 'Invoice review evidence', accessibility_tree_json = ? WHERE id = ?")
        .bind(nodes.to_string())
        .bind(frame_id)
        .execute(&mut **tx.conn())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    if migrate_to_parquet {
        db.close().await;
        screenpipe_db::storage::migrate(dir.path(), Default::default(), Default::default())
            .await
            .unwrap();
        db = Arc::new(
            DatabaseManager::new(db_path.to_str().unwrap(), Default::default())
                .await
                .unwrap(),
        );
        assert_eq!(
            db.storage_mode(),
            screenpipe_db::storage::StorageMode::HybridParquetV1
        );
        let resident: Option<String> =
            sqlx::query_scalar("SELECT accessibility_tree_json FROM frames WHERE id = ?")
                .bind(frame_id)
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert!(
            resident.is_none(),
            "automation detail must come from Parquet"
        );
        db.verify_storage().await.unwrap();
    }
    let audio = Arc::new(
        AudioManagerBuilder::new()
            .is_disabled(true)
            .output_path(dir.path().join("audio"))
            .build(db.clone())
            .await
            .unwrap(),
    );
    let mut server = SCServer::new(
        db.clone(),
        SocketAddr::from(([127, 0, 0, 1], 0)),
        dir.path().to_path_buf(),
        true,
        true,
        audio,
        false,
        "balanced".into(),
    );
    server.workflow_catalog_dir = Some(dir.path().join("workflows"));
    server.api_auth = true;
    server.api_auth_key = Some("workflow-test-key".into());
    let policy = server.history_access.clone();
    let mut permission = PipePermissions {
        pipe_name: "reader".into(),
        allow_rules: vec![],
        deny_rules: parse_rules("Api(GET /frames/*)"),
        use_default_allowlist: true,
        time_range: None,
        days: None,
        pipe_token: None,
        pipe_dir: None,
        privacy_filter: false,
    };
    server
        .pipe_permissions
        .insert("sp_pipe_workflow_test".into(), Arc::new(permission.clone()));
    permission.deny_rules = parse_rules("App(Private App)");
    server
        .pipe_permissions
        .insert("sp_pipe_scoped_workflow_test".into(), Arc::new(permission));
    let router = server.try_create_router().await.unwrap();
    let (search_status, search_result) = request(
        &router,
        "/search?q=Invoice&content_type=ocr&limit=10",
        Some("workflow-test-key"),
    )
    .await;
    assert_eq!(search_status, StatusCode::OK);
    assert_eq!(
        search_result["data"][0]["content"]["text"],
        "Invoice review evidence"
    );
    assert_eq!(
        request(&router, "/workflows", None).await.0,
        StatusCode::FORBIDDEN
    );
    let (status, empty) = request(&router, "/workflows", Some("workflow-test-key")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(empty["pagination"]["total"], 0);
    let workflow = json!({"title":"Invoice review","description":"Prepare an invoice","trigger":"Order","outcome":"Reviewed","evidence":[{"timestamp":"2026-01-01T12:00:00Z","app":"Browser"}],"stages":[{"name":"Review","evidence":[{"timestamp":"2026-01-01T12:00:00Z","app":"Browser"}],"screenshot":{"frameId":frame_id,"timestamp":"2026-01-01T12:00:30Z","matchDistanceSeconds":30,"app":"Browser","dataUrl":"data:image/png;base64,private"}}]});
    tokio::fs::create_dir_all(dir.path().join("workflows"))
        .await
        .unwrap();
    let catalog_path = dir.path().join("workflows/catalog.json");
    tokio::fs::write(&catalog_path,json!({"schemaVersion":5,"analyzedAt":"2026-09-14T12:00:00Z","analysis":{"workflows":[workflow.clone()]}}).to_string()).await.unwrap();
    let (_, listed) = request(
        &router,
        "/workflows?q=invoice&limit=1",
        Some("workflow-test-key"),
    )
    .await;
    assert_eq!(listed["data"][0]["id"], workflow_id(&workflow));
    let path = format!(
        "/workflows/{}?include_automation=false",
        workflow_id(&workflow)
    );
    let (status, detail) = request(&router, &path, Some("workflow-test-key")).await;
    assert_eq!(status, StatusCode::OK);
    assert!(!detail.to_string().contains("private"));
    assert_eq!(detail["automationEvidence"][0]["matchDistanceSeconds"], 30);
    assert_eq!(detail["automationEvidence"][0]["actionTarget"], "unknown");
    assert_eq!(
        detail["automationEvidence"][0]["inputSearch"]["content_type"],
        "input"
    );
    assert_eq!(
        detail["automationEvidence"][0]["inputSearch"]["app_name"],
        "Browser"
    );
    let live_detail_path = format!("/workflows/{}", workflow_id(&workflow));
    let (_, captured) = request(&router, &live_detail_path, Some("workflow-test-key")).await;
    assert_eq!(
        captured["automationEvidence"][0]["status"],
        "historical_context"
    );
    assert_eq!(
        captured["automationEvidence"][0]["nodes"][1]["properties"]["automation_id"],
        "approve"
    );
    assert_eq!(
        captured["automationEvidence"][0]["nodes"][1]["bounds"]["left"],
        0.25
    );
    assert_eq!(
        captured["automationEvidence"][0]["nodes"][0]["properties"]["automation_id"],
        "invoice-form"
    );
    assert_eq!(
        captured["automationEvidence"][0]["boundsCoordinateSpace"],
        "normalized-monitor"
    );
    // Reused numeric frame IDs must never expose another recording's nodes.
    let mut tx = db.begin_immediate_with_retry().await.unwrap();
    sqlx::query("UPDATE frames SET timestamp = ? WHERE id = ?")
        .bind("2026-01-02T12:00:30Z")
        .bind(frame_id)
        .execute(&mut **tx.conn())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let (_, mismatch) = request(&router, &live_detail_path, Some("workflow-test-key")).await;
    assert_eq!(
        mismatch["automationEvidence"][0]["status"],
        "capture_identity_mismatch"
    );
    assert!(mismatch["automationEvidence"][0]["nodes"].is_null());
    let (_, denied) = request(&router, &path, Some("sp_pipe_workflow_test")).await;
    assert_eq!(
        denied["automationEvidence"][0]["status"],
        "capture_access_denied"
    );
    assert_eq!(
        request(&router, "/workflows", Some("sp_pipe_scoped_workflow_test"))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let (_, spec) = request(&router, "/openapi.json", Some("workflow-test-key")).await;
    assert!(spec["paths"]["/workflows"].is_object());
    policy.set_last_24_hours(true);
    assert_eq!(
        request(&router, "/workflows", Some("workflow-test-key"))
            .await
            .1["pagination"]["total"],
        0
    );
    assert_eq!(
        request(&router, &path, Some("workflow-test-key")).await.0,
        StatusCode::NOT_FOUND
    );
    policy.set_last_24_hours(false);
    let valid_catalog = tokio::fs::read(&catalog_path).await.unwrap();
    tokio::fs::write(&catalog_path, b"broken").await.unwrap();
    assert_eq!(
        request(&router, "/workflows", Some("workflow-test-key"))
            .await
            .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    tokio::fs::write(&catalog_path, valid_catalog)
        .await
        .unwrap();
    publication_outage_preserves_a_retryable_draft(&router, &catalog_path).await;
}

async fn publication_outage_preserves_a_retryable_draft(
    router: &axum::Router,
    path: &std::path::Path,
) {
    use screenpipe_core::workflows::workspace;
    let mut catalog: Value = serde_json::from_slice(&tokio::fs::read(path).await.unwrap()).unwrap();
    let mut ws = workspace::empty();
    workspace::start(&mut ws, &catalog);
    let payload = json!({"title":"Prepare project status report","description":"Review captured work","stages":[]});
    let proposal = workspace::Change {
        action: "propose".into(),
        expected_revision: workspace::revision(&ws),
        draft_id: None,
        assignee: Some("workflow-review".into()),
        payload: Some(payload.clone()),
        note: "Review this report procedure".into(),
    };
    let id = workspace::apply(&mut ws, "workflow-discover", &proposal).unwrap()["draft_id"]
        .as_str()
        .unwrap()
        .to_owned();
    catalog["agentWorkspace"] = ws.clone();
    tokio::fs::write(path, serde_json::to_vec(&catalog).unwrap())
        .await
        .unwrap();
    let post = |body: Value| {
        router.clone().oneshot(
            Request::builder()
                .method("POST")
                .uri("/workflows/workspace")
                .header("Authorization", "Bearer workflow-test-key")
                .header("Content-Type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
    };
    let response = post(json!({"task":"workflow-review","action":"publish","expected_revision":workspace::revision(&ws),"catalog_revision":catalog["revision"].as_u64().unwrap_or(0),"draft_id":id,"note":"Sources look ready"})).await.unwrap();
    // This fixture has no PipeManager: publication really fails with 503.
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let after: Value = serde_json::from_slice(&tokio::fs::read(path).await.unwrap()).unwrap();
    let saved = workspace::state(&after);
    assert_eq!(saved["drafts"][&id]["status"], "open");
    assert_eq!(saved["drafts"][&id]["payload"], payload);
    assert_eq!(saved["drafts"][&id]["publicationRetry"]["retryable"], true);
    assert_eq!(after["checkedThrough"], catalog["checkedThrough"]);
    assert_eq!(after["analysis"], catalog["analysis"]);
    let rejected = post(json!({"task":"workflow-review","action":"reject","expected_revision":workspace::revision(&saved),"draft_id":id,"note":"Save failed so reject it"})).await.unwrap();
    assert_eq!(rejected.status(), StatusCode::CONFLICT);
    let unchanged: Value = serde_json::from_slice(&tokio::fs::read(path).await.unwrap()).unwrap();
    assert_eq!(unchanged, after);
}
