// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use crate::server::AppState;
use axum::{
    extract::{Request, State},
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use std::sync::Arc;

pub(crate) fn pending() -> Response {
    (StatusCode::SERVICE_UNAVAILABLE,[("retry-after","5")],Json(serde_json::json!({"error":"Privacy processing is pending","code":"privacy_pending","retryable":true}))).into_response()
}

pub(crate) async fn release_middleware(
    State(state): State<Arc<AppState>>,
    request: Request,
    next: Next,
) -> Response {
    if !state.db.protected_reads_enabled() {
        return next.run(request).await;
    }
    let path = request.uri().path();
    // Meeting/audio streams are exempt; /ws/events filters other content.
    // These endpoints expose raw containers, files, or unverified
    // derivatives. They cannot borrow a frame-text receipt as authorization.
    if matches!(path, "/raw_sql" | "/export" | "/chats/search")
        || path.starts_with("/frames/preview-media/")
        || path.starts_with("/artifacts")
        || path == "/data/backup"
        || path == "/stream/frames"
        || (request.method() == axum::http::Method::POST
            && path.starts_with("/frames/")
            && (path.ends_with("/ocr") || path.ends_with("/text")))
    {
        return (StatusCode::SERVICE_UNAVAILABLE,Json(serde_json::json!({"error":"This surface has no privacy release adapter","code":"privacy_surface_unavailable","retryable":false}))).into_response();
    }
    let before = match state.db.release_revocation().await {
        Ok(epoch) => epoch,
        Err(_) => return pending(),
    };
    let response = next.run(request).await;
    match state.db.release_revocation().await {
        Ok(epoch) if epoch == before => {
            let mut response = response;
            response.headers_mut().insert(
                "x-screenpipe-privacy-completeness",
                "unknown".parse().unwrap(),
            );
            response.headers_mut().insert(
                "x-screenpipe-privacy-status",
                "/privacy/status".parse().unwrap(),
            );
            response
        }
        _ => pending(),
    }
}

pub(crate) async fn status(State(state): State<Arc<AppState>>) -> Response {
    match state.db.release_queue_status().await {
        Ok(status) => Json(status).into_response(),
        Err(_) => pending(),
    }
}

#[derive(serde::Deserialize)]
pub(crate) struct ReadyQuery {
    #[serde(default)]
    after: i64,
    cutoff: String,
    end: Option<String>,
    #[serde(default = "page_limit")]
    limit: u32,
}
fn page_limit() -> u32 {
    500
}
pub(crate) async fn ready_page(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(kind): axum::extract::Path<String>,
    axum::extract::Query(query): axum::extract::Query<ReadyQuery>,
) -> Response {
    match state
        .db
        .release_export_range_page(
            &kind,
            query.after,
            &query.cutoff,
            query.end.as_deref(),
            query.limit,
        )
        .await
    {
        Ok(page) => Json(page).into_response(),
        Err(_) => pending(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use screenpipe_db::{privacy_release::ReleasePolicy, DatabaseManager};
    use screenpipe_redact::{RedactError, RedactionOutput, Redactor};
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Detector(Arc<AtomicUsize>);
    #[async_trait::async_trait]
    impl Redactor for Detector {
        fn name(&self) -> &str {
            "synthetic-model"
        }
        fn version(&self) -> u32 {
            1
        }
        fn provides_model_detection(&self) -> bool {
            true
        }
        async fn redact_batch(
            &self,
            texts: &[String],
        ) -> Result<Vec<RedactionOutput>, RedactError> {
            self.0.fetch_add(texts.len(), Ordering::SeqCst);
            Ok(texts
                .iter()
                .map(|text| RedactionOutput {
                    input: text.clone(),
                    redacted: text.replace("SYNTHETIC_SECRET", "[PRIVATE]"),
                    spans: vec![],
                })
                .collect())
        }
    }

    struct ImageDetector;
    #[async_trait::async_trait]
    impl screenpipe_redact::ImageRedactor for ImageDetector {
        fn name(&self) -> &str {
            "synthetic-image-model"
        }
        fn version(&self) -> u32 {
            1
        }
        async fn detect(
            &self,
            _path: &std::path::Path,
        ) -> Result<Vec<screenpipe_redact::ImageRegion>, RedactError> {
            Ok(vec![screenpipe_redact::ImageRegion {
                bbox: [0, 0, 16, 16],
                label: screenpipe_redact::SpanLabel::Secret,
                score: 1.0,
            }])
        }
    }

    async fn run_http_case(hybrid: bool) {
        let root = tempfile::tempdir().unwrap();
        let db = Arc::new(if hybrid {
            DatabaseManager::new_hybrid(root.path(), Default::default(), Default::default())
                .await
                .unwrap()
        } else {
            DatabaseManager::new(
                root.path().join("db.sqlite").to_str().unwrap(),
                Default::default(),
            )
            .await
            .unwrap()
        });
        db.configure_release(&ReleasePolicy {
            identity: "synthetic-v1".into(),
            text: true,
            images: true,
        })
        .await
        .unwrap();
        db.execute_raw_sql_write("INSERT INTO frames(id,timestamp,full_text,app_name,window_name) VALUES(1,'2026-10-14T10:00:00Z','SYNTHETIC_SECRET','Test','Test')").await.unwrap();
        db.execute_raw_sql_write("INSERT INTO meetings(id,meeting_start,meeting_app,title,note) VALUES(1,'2026-10-14T10:00:00Z','SYNTHETIC_SECRET','SYNTHETIC_SECRET','SYNTHETIC_SECRET')").await.unwrap();
        db.execute_raw_sql_write("INSERT INTO activity_tasks(id,task_key,kind,title,confidence,producer,user_locked) VALUES(1,'task','task','SYNTHETIC_SECRET',1,'test',1); INSERT INTO activity_intervals(id,interval_key,task_id,start_at,end_at,state,confidence,producer) VALUES(1,'interval',1,'2026-10-14T10:00:00Z','2026-10-14T10:05:00Z','final',1,'test'); INSERT INTO activity_actions(id,action_key,interval_id,occurred_at,action_type,summary,confidence,source_type,source_id) VALUES(1,'action',1,'2026-10-14T10:00:00Z','view','SYNTHETIC_SECRET',1,'frame',1)").await.unwrap();
        let audio = Arc::new(
            screenpipe_audio::audio_manager::AudioManagerBuilder::new()
                .is_disabled(true)
                .output_path(root.path().join("audio"))
                .build(db.clone())
                .await
                .unwrap(),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let mut server = crate::SCServer::new(
            db.clone(),
            address,
            root.path().to_path_buf(),
            true,
            true,
            audio,
            false,
            "balanced".into(),
        );
        server.timeline_disabled = true;
        server.advertise_mdns = false;
        let router = server.try_create_router().await.unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let serving = tokio::spawn(crate::SCServer::serve_router_with_listener_graceful(
            address,
            listener,
            router,
            async {
                let _ = stopped.await;
            },
        ));
        let client = reqwest::Client::new();
        let base = format!("http://{address}");
        let search = format!("{base}/search?content_type=ocr&limit=10");
        // Audio is available even with a pending screen privacy backlog.
        db.execute_raw_sql_write("INSERT INTO audio_chunks(id,file_path) VALUES(1,'test.wav'); INSERT INTO audio_transcriptions(id,audio_chunk_id,offset_index,timestamp,transcription,device) VALUES(1,1,0,'2026-10-14T10:00:00Z','AUDIO_EXEMPT_SECRET','test'); INSERT INTO meeting_transcript_segments(meeting_id,provider,item_id,transcript,captured_at) VALUES(1,'test','one','AUDIO_EXEMPT_SECRET','2026-10-14T10:00:00Z')").await.unwrap();
        // The real websocket routes stay available, and the shared route
        // forwards audio without leaking screen events under protection.
        use futures::StreamExt;
        for path in ["/ws/meeting-status", "/ws/meeting-overlay"] {
            let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://{address}{path}"))
                .await
                .unwrap();
            assert!(
                tokio::time::timeout(std::time::Duration::from_secs(5), socket.next())
                    .await
                    .unwrap()
                    .unwrap()
                    .is_ok()
            );
            socket.close(None).await.unwrap();
        }
        let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://{address}/ws/events"))
            .await
            .unwrap();
        let mut tick = tokio::time::interval(std::time::Duration::from_millis(20));
        let received = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                tokio::select! {
                    _ = tick.tick() => {
                        let _ = screenpipe_events::send_event("ocr_result", serde_json::json!({"text":"SCREEN_MUST_STAY_PRIVATE"}));
                        let _ = screenpipe_events::send_event("meeting_transcript_delta", serde_json::json!({"delta":"AUDIO_EXEMPT_SECRET"}));
                    }
                    message = socket.next() => {
                        let message = message.unwrap().unwrap();
                        if let tokio_tungstenite::tungstenite::Message::Text(text) = message {
                            assert!(!text.contains("SCREEN_MUST_STAY_PRIVATE"));
                            if text.contains("AUDIO_EXEMPT_SECRET") { break text; }
                        }
                    }
                }
            }
        }).await.unwrap();
        assert!(received.contains("AUDIO_EXEMPT_SECRET"));
        assert!(!received.contains("SCREEN_MUST_STAY_PRIVATE"));
        socket.close(None).await.unwrap();
        let audio = client
            .get(format!("{base}/search?content_type=audio&limit=10"))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .text()
            .await
            .unwrap();
        assert!(audio.contains("AUDIO_EXEMPT_SECRET"));
        let transcript = client
            .get(format!("{base}/meetings/1/transcript"))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .text()
            .await
            .unwrap();
        assert!(transcript.contains("AUDIO_EXEMPT_SECRET"));
        let sample = client
            .get(format!("{base}/speakers/sample/999999"))
            .send()
            .await
            .unwrap();
        assert_ne!(
            sample.status().as_u16(),
            503,
            "audio samples must not be privacy-gated"
        );

        let meeting: serde_json::Value = client
            .get(format!("{base}/meetings/1"))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        assert!(!meeting.to_string().contains("SYNTHETIC_SECRET"));
        assert!(meeting.to_string().contains("Privacy processing"));
        let response = client.get(&search).send().await.unwrap();
        assert!(
            response.status().is_success(),
            "{}",
            response.text().await.unwrap()
        );
        assert_eq!(
            response.headers()["x-screenpipe-privacy-completeness"],
            "unknown"
        );
        let body: serde_json::Value = response.json().await.unwrap();
        assert_eq!(body["privacy"]["completeness"], "unknown");
        let status: serde_json::Value = client
            .get(format!("{base}/privacy/status"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(status["enabled"], true);
        assert_eq!(status["scope"], "protected_capture_surfaces");
        assert!(status["surfaces"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["pending"].as_u64().unwrap() > 0));

        assert_eq!(body["pagination"]["total"], 0);
        assert!(!body.to_string().contains("SYNTHETIC_SECRET"));
        for path in [
            "/frames/1",
            "/frames/1/thumbnail",
            "/frames/preview-media/1",
            "/stream/frames",
            "/data/backup",
        ] {
            let response = client.get(format!("{base}{path}")).send().await.unwrap();
            assert_eq!(response.status().as_u16(), 503, "{path}");
        }
        let sql = client
            .post(format!("{base}/raw_sql"))
            .json(&serde_json::json!({"query":"SELECT * FROM main.frames LIMIT 10"}))
            .send()
            .await
            .unwrap();
        assert_eq!(sql.status().as_u16(), 503);
        let range = "start_time=2026-10-14T09:00:00Z&end_time=2026-10-14T11:00:00Z";
        for refresh in [false, true] {
            let response = client
                .get(format!(
                    "{base}/activity-ledger?{range}&depth=action&refresh={refresh}"
                ))
                .send()
                .await
                .unwrap();
            assert!(
                response.status().is_success(),
                "{}",
                response.text().await.unwrap()
            );
            let ledger: serde_json::Value = response.json().await.unwrap();
            assert_eq!(ledger["intervals"][0]["id"], 1);
            assert!(ledger["intervals"][0]["title"]
                .as_str()
                .unwrap()
                .contains("privacy processing"));
            assert!(!ledger.to_string().contains("SYNTHETIC_SECRET"));
        }
        let response = client
            .get(format!("{base}/activity-summary?{range}"))
            .send()
            .await
            .unwrap();
        assert!(
            response.status().is_success(),
            "{}",
            response.text().await.unwrap()
        );
        let summary: serde_json::Value = response.json().await.unwrap();
        assert_eq!(summary["privacy"]["completeness"], "unknown");
        assert!(!summary.to_string().contains("SYNTHETIC_SECRET"));
        let calls = Arc::new(AtomicUsize::new(0));
        let pipeline = screenpipe_redact::Pipeline::regex_then_ai(
            Arc::new(Detector(calls.clone())),
            Default::default(),
        );
        let worker = screenpipe_redact::worker::Worker::new_with_writer(
            db.pool.clone(),
            db.coordinated_writer(),
            Arc::new(pipeline),
            Default::default(),
        )
        .with_frame_storage(db.clone());
        // A scheduling turn can yield before all fixture surfaces complete.
        // Assert actual receipts rather than assuming one turn drains the queue.
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                worker.process_release_batch(7).await.unwrap();
                let ready: i64 = sqlx::query_scalar(
                    "SELECT COUNT(*) FROM _privacy_release WHERE kind IN ('frames','activity_tasks','activity_actions') AND id='1' AND policy=(SELECT receipt_key FROM _privacy_policy WHERE identity='synthetic-v1')",
                )
                .fetch_one(&db.pool)
                .await
                .unwrap();
                let local_ready: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM _privacy_exports e JOIN _privacy_release r ON r.kind='exports' AND r.id=CAST(e.id AS TEXT) JOIN _privacy_policy p ON r.policy=CAST(p.receipt_key AS TEXT) WHERE e.stream='local_meetings' AND e.source_id='1')").fetch_one(&db.pool).await.unwrap();
                if ready == 3 && local_ready {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("text worker did not certify all fixture surfaces");
        let before = calls.load(Ordering::SeqCst);
        assert!(before > 0);
        let meeting: serde_json::Value = client
            .get(format!("{base}/meetings/1"))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        assert!(meeting.to_string().contains("[PRIVATE]"), "{meeting}");
        assert!(!meeting.to_string().contains("SYNTHETIC_SECRET"));
        let body: serde_json::Value = client
            .get(&search)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(body["pagination"]["total"], 1, "{body}");
        assert!(body.to_string().contains("[PRIVATE]"));
        assert!(!body.to_string().contains("SYNTHETIC_SECRET"));
        let page: serde_json::Value = client
            .get(format!("{base}/privacy/ready/frames"))
            .query(&[("cutoff", "2026-10-14T00:00:00Z")])
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(page["rows"][0]["text"], "[PRIVATE]");
        assert_eq!(
            calls.load(Ordering::SeqCst),
            before,
            "reads must not invoke inference"
        );
        let ledger: serde_json::Value = client
            .get(format!(
                "{base}/activity-ledger?{range}&depth=action&refresh=false"
            ))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(ledger["intervals"][0]["id"], 1);
        assert_eq!(ledger["intervals"][0]["title"], "[PRIVATE]");
        assert_eq!(ledger["intervals"][0]["actions"][0]["summary"], "[PRIVATE]");
        let summary: serde_json::Value = client
            .get(format!("{base}/activity-summary?{range}"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(summary["total_frames"], 1, "{summary}");
        assert!(!summary.to_string().contains("SYNTHETIC_SECRET"));
        let pixels = root.path().join("frame.png");
        image::RgbImage::from_pixel(32, 32, image::Rgb([255, 255, 255]))
            .save(&pixels)
            .unwrap();
        db.execute_raw_sql_write(&format!(
            "UPDATE frames SET name='{}',snapshot_path='{}' WHERE id=1",
            pixels.display(),
            pixels.display()
        ))
        .await
        .unwrap();
        let image_worker = screenpipe_redact::image::worker::ImageWorker::new_with_writer(
            db.pool.clone(),
            db.coordinated_writer(),
            Arc::new(ImageDetector),
            Default::default(),
        )
        .with_release_storage(db.clone());
        let progress = image_worker.clone();
        let shutdown = Arc::new(tokio::sync::Notify::new());
        let task = image_worker.spawn_with_shutdown(shutdown.clone());
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while progress.status().await.frames_redacted_total == 0 {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("image worker did not publish a receipt");
        shutdown.notify_waiters();
        task.await.unwrap();
        let response = client.get(format!("{base}/frames/1")).send().await.unwrap();
        assert!(response.status().is_success());
        let served = image::load_from_memory(&response.bytes().await.unwrap())
            .unwrap()
            .to_rgb8();
        assert_eq!(
            served.get_pixel(5, 5).0,
            [0, 0, 0],
            "raw screenshot pixels escaped"
        );
        // Changing the certified source must not reuse a cached older path.
        let replacement = root.path().join("replacement.png");
        image::RgbImage::from_pixel(32, 32, image::Rgb([128, 128, 128]))
            .save(&replacement)
            .unwrap();
        db.execute_raw_sql_write(&format!(
            "UPDATE frames SET name='{}',snapshot_path='{}' WHERE id=1",
            replacement.display(),
            replacement.display()
        ))
        .await
        .unwrap();
        assert_eq!(
            client
                .get(format!("{base}/frames/1"))
                .send()
                .await
                .unwrap()
                .status()
                .as_u16(),
            503
        );
        let shutdown = Arc::new(tokio::sync::Notify::new());
        let image_worker = screenpipe_redact::image::worker::ImageWorker::new_with_writer(
            db.pool.clone(),
            db.coordinated_writer(),
            Arc::new(ImageDetector),
            Default::default(),
        )
        .with_release_storage(db.clone());
        let progress = image_worker.clone();
        let task = image_worker.spawn_with_shutdown(shutdown.clone());
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while progress.status().await.frames_redacted_total == 0 {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        shutdown.notify_waiters();
        task.await.unwrap();
        let response = client.get(format!("{base}/frames/1")).send().await.unwrap();
        assert!(response.status().is_success());
        let served = image::load_from_memory(&response.bytes().await.unwrap())
            .unwrap()
            .to_rgb8();
        assert_eq!(
            served.get_pixel(24, 24).0,
            [128, 128, 128],
            "old cached source path escaped"
        );
        assert_eq!(
            client
                .post(format!("{base}/frames/1/ocr?persist=false"))
                .send()
                .await
                .unwrap()
                .status()
                .as_u16(),
            503
        );
        db.configure_release(&ReleasePolicy {
            identity: "synthetic-v2".into(),
            text: true,
            images: true,
        })
        .await
        .unwrap();
        assert_eq!(
            client
                .get(format!("{base}/frames/1"))
                .send()
                .await
                .unwrap()
                .status()
                .as_u16(),
            503,
            "cached image bypassed policy change"
        );
        db.execute_raw_sql_write(
            "UPDATE frames SET full_text='SYNTHETIC_SECRET_CHANGED' WHERE id=1",
        )
        .await
        .unwrap();
        let body: serde_json::Value = client
            .get(&search)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(
            body["pagination"]["total"], 0,
            "warm cache must not bypass revocation: {body}"
        );
        db.execute_raw_sql_write("INSERT INTO frames(id,timestamp,full_text) VALUES(2,'2026-10-14T10:01:00Z','recording still works')").await.unwrap();
        assert_eq!(db.release_pending("frames", 10).await.unwrap().len(), 2);
        let _ = stop.send(());
        serving.await.unwrap().unwrap();
        db.close().await;
    }
    #[tokio::test]
    async fn sqlite_http_privacy_release_e2e() {
        run_http_case(false).await;
    }
    #[tokio::test]
    async fn hybrid_http_privacy_release_e2e() {
        run_http_case(true).await;
    }
}
