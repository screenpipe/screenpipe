// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use screenpipe_db::{privacy_release::ReleasePolicy, DatabaseManager};
use screenpipe_redact::{Pipeline, Redactor};
use std::sync::Arc;

async fn database() -> (tempfile::TempDir, Arc<DatabaseManager>) {
    let root = tempfile::tempdir().unwrap();
    let db = Arc::new(
        DatabaseManager::new(
            root.path().join("db.sqlite").to_str().unwrap(),
            Default::default(),
        )
        .await
        .unwrap(),
    );
    db.configure_release(&ReleasePolicy {
        identity: "test:model-v1".into(),
        text: true,
        images: true,
    })
    .await
    .unwrap();
    (root, db)
}

#[tokio::test]
async fn history_discovery_does_not_jump_ahead_of_new_captures() {
    let root = tempfile::tempdir().unwrap();
    let db = DatabaseManager::new(
        root.path().join("db.sqlite").to_str().unwrap(),
        Default::default(),
    )
    .await
    .unwrap();
    // History predates the policy, so discovery enrolls it after live capture.
    db.execute_raw_sql_write("WITH RECURSIVE history(id) AS (SELECT 1 UNION ALL SELECT id+1 FROM history WHERE id<512) INSERT INTO frames(id,timestamp,full_text) SELECT id,'2020-01-01','historical text' FROM history")
        .await.unwrap();
    db.configure_release(&ReleasePolicy {
        identity: "history-priority-v1".into(),
        text: true,
        images: false,
    })
    .await
    .unwrap();
    for id in [1000, 1001] {
        db.execute_raw_sql_write(&format!(
            "INSERT INTO frames(id,timestamp,full_text) VALUES({id},'2026-10-23','new capture')"
        ))
        .await
        .unwrap();
        let recent = db
            .release_pending_ordered("frames", 1, 0, false)
            .await
            .unwrap()
            .remove(0);
        assert_eq!(
            recent.id,
            id.to_string(),
            "discovering old history must not outrank a new capture"
        );
        assert!(db.publish_release(&recent, &recent.values).await.unwrap());
        let historical = db
            .release_pending_ordered("frames", 1, 0, true)
            .await
            .unwrap()
            .remove(0);
        assert!(
            historical.id.parse::<i64>().unwrap() < 1000,
            "history must also retain its processing turn"
        );
        assert!(db
            .publish_release(&historical, &historical.values)
            .await
            .unwrap());
    }
    db.close().await;
}

#[tokio::test]
async fn pending_capture_is_durable_but_not_released_and_late_completion_is_not_lost() {
    let (_root, db) = database().await;
    db.execute_raw_sql_write("INSERT INTO frames(id,timestamp,full_text) VALUES(1,'2026-10-14T10:00:00Z','SYNTHETIC_SECRET_OLDER'),(2,'2026-10-14T10:01:00Z','SYNTHETIC_SECRET_NEWER')").await.unwrap();
    let protected = db.protected_reads().await.unwrap();
    let visible: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM frames")
        .fetch_one(&protected.pool)
        .await
        .unwrap();
    assert_eq!(visible, 0);
    assert!(protected
        .query_raw_sql("SELECT * FROM main.frames")
        .await
        .is_err());
    let mut jobs = db.release_pending("frames", 10).await.unwrap();
    assert_eq!(jobs.len(), 2);
    let newer = jobs.remove(0);
    let older = jobs.remove(0);
    let mut values = newer.values.clone();
    values.insert("full_text".into(), Some("newer sanitized".into()));
    assert!(db.publish_release(&newer, &values).await.unwrap());
    let first = db.ready_changes(0, 10).await.unwrap();
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].id, "2");
    let texts: Vec<String> = sqlx::query_scalar("SELECT full_text FROM frames ORDER BY id")
        .fetch_all(&protected.pool)
        .await
        .unwrap();
    assert_eq!(texts, vec!["newer sanitized"]);
    let mut values = older.values.clone();
    values.insert("full_text".into(), Some("older sanitized".into()));
    assert!(db.publish_release(&older, &values).await.unwrap());
    let second = db.ready_changes(first[0].sequence, 10).await.unwrap();
    assert_eq!(second.len(), 1);
    assert_eq!(second[0].id, "1");
    assert!(!db.release_ready("image", "1").await.unwrap());
    protected.close().await;
    db.close().await;
}

#[tokio::test]
async fn edits_and_policy_changes_reject_stale_detection_and_revoke_ready_reads() {
    let (_root, db) = database().await;
    db.execute_raw_sql_write(
        "INSERT INTO frames(id,timestamp,full_text) VALUES(1,'2026-10-14','pending')",
    )
    .await
    .unwrap();
    let old = db.release_pending("frames", 1).await.unwrap().remove(0);
    db.execute_raw_sql_write("UPDATE frames SET full_text='new private content' WHERE id=1")
        .await
        .unwrap();
    assert!(!db.publish_release(&old, &old.values).await.unwrap());
    let current = db.release_pending("frames", 1).await.unwrap().remove(0);
    assert!(db.publish_release(&current, &current.values).await.unwrap());
    let protected = db.protected_reads().await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM frames")
            .fetch_one(&protected.pool)
            .await
            .unwrap(),
        1
    );
    db.configure_release(&ReleasePolicy {
        identity: "test:model-v2".into(),
        text: true,
        images: true,
    })
    .await
    .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM frames")
            .fetch_one(&protected.pool)
            .await
            .unwrap(),
        0
    );
    assert!(db.ready_changes(0, 10).await.unwrap().is_empty());
    protected.close().await;
    db.close().await;
}

#[tokio::test]
async fn regex_fallback_cannot_certify_required_model_processing() {
    let pipeline = Pipeline::regex_only();
    assert!(pipeline.redact_required("A").await.is_err());
    assert!(pipeline.redact_required("test@example.com").await.is_err());
}

#[tokio::test]
async fn privacy_export_admission_rejects_policy_change_but_accepts_new_completions() {
    let (_root, db) = database().await;
    db.execute_raw_sql_write(
        "INSERT INTO frames(id,timestamp,full_text) VALUES(1,'2026-10-14','pending')",
    )
    .await
    .unwrap();
    let token = db.storage_export_token().await.unwrap();
    let job = db.release_pending("frames", 1).await.unwrap().remove(0);
    assert!(db.publish_release(&job, &job.values).await.unwrap());
    assert!(
        token.admit(&db.pool).await.is_ok(),
        "new completion must not starve uploads"
    );
    db.configure_release(&ReleasePolicy {
        identity: "stricter-v2".into(),
        text: true,
        images: true,
    })
    .await
    .unwrap();
    assert!(token.admit(&db.pool).await.is_err());
    db.close().await;
}

#[tokio::test]
async fn hybrid_sealing_preserves_receipts_and_owner_close_drains_protected_pool() {
    let root = tempfile::tempdir().unwrap();
    let db = Arc::new(
        DatabaseManager::new_hybrid(root.path(), Default::default(), Default::default())
            .await
            .unwrap(),
    );
    db.configure_release(&ReleasePolicy {
        identity: "v1".into(),
        text: true,
        images: false,
    })
    .await
    .unwrap();
    db.execute_raw_sql_write(
        "INSERT INTO frames(id,timestamp,full_text) VALUES(1,'2026-10-14','safe')",
    )
    .await
    .unwrap();
    let job = db.release_pending("frames", 1).await.unwrap().remove(0);
    assert!(db.publish_release(&job, &job.values).await.unwrap());
    let protected = db.protected_reads().await.unwrap();
    assert_eq!(db.seal_frame_payloads().await.unwrap(), 1);
    assert!(db.release_ready("frames", "1").await.unwrap());
    assert!(db.release_pending("frames", 1).await.unwrap().is_empty());
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM frames")
            .fetch_one(&protected.pool)
            .await
            .unwrap(),
        1
    );
    db.close().await;
    assert!(protected.pool.is_closed());
}

#[tokio::test]
async fn image_queue_filters_age_before_limit_during_continuous_capture() {
    let (_root, db) = database().await;
    db.execute_raw_sql_write("INSERT INTO frames(id,timestamp,name) VALUES(1,'2020-01-01T00:00:00Z','old.png'); WITH RECURSIVE ids(n) AS (SELECT 2 UNION ALL SELECT n+1 FROM ids WHERE n<50) INSERT INTO frames(id,timestamp,name) SELECT n,strftime('%Y-%m-%dT%H:%M:%fZ','now'),'fresh.png' FROM ids").await.unwrap();
    let jobs = db.release_pending_aged("image", 16, 60).await.unwrap();
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0].id, "1");
    db.close().await;
}

#[tokio::test]
async fn metadata_edit_revokes_memory_and_primary_key_publication_is_indexed() {
    let (_root, db) = database().await;
    db.execute_raw_sql_write("INSERT INTO memories(content,tags,source_context) VALUES('safe','[\"email@example.com\"]','private')").await.unwrap();
    let job = db.release_pending("memory", 1).await.unwrap().remove(0);
    assert!(job.values.contains_key("tags"));
    assert!(job.values.contains_key("source_context"));
    assert!(db.publish_release(&job, &job.values).await.unwrap());
    db.execute_raw_sql_write("UPDATE memories SET tags='[]' WHERE id=1")
        .await
        .unwrap();
    assert!(!db.release_ready("memory", "1").await.unwrap());
    let plan = sqlx::query("EXPLAIN QUERY PLAN UPDATE frames SET full_text=? WHERE id=?")
        .bind("safe")
        .bind("1")
        .fetch_all(&db.pool)
        .await
        .unwrap();
    use sqlx::Row;
    assert!(plan.iter().any(|row| row
        .get::<String, _>("detail")
        .contains("INTEGER PRIMARY KEY")));
    db.close().await;
}

#[tokio::test]
async fn unavailable_model_keeps_capture_durable_and_pending_after_restart() {
    let (root, db) = database().await;
    db.execute_raw_sql_write(
        "INSERT INTO frames(id,timestamp,full_text) VALUES(1,'2026-10-14','short')",
    )
    .await
    .unwrap();
    let worker = screenpipe_redact::worker::Worker::new_with_writer(
        db.pool.clone(),
        db.coordinated_writer(),
        Arc::new(Pipeline::regex_only()),
        Default::default(),
    )
    .with_frame_storage(db.clone());
    assert_eq!(worker.process_release_batch(7).await.unwrap(), 0);
    assert!(!db.release_ready("frames", "1").await.unwrap());
    db.execute_raw_sql_write(
        "INSERT INTO frames(id,timestamp,full_text) VALUES(2,'2026-10-14','next capture')",
    )
    .await
    .unwrap();
    db.close().await;
    drop(worker);
    drop(db);
    let db = Arc::new(
        DatabaseManager::new(
            root.path().join("db.sqlite").to_str().unwrap(),
            Default::default(),
        )
        .await
        .unwrap(),
    );
    db.configure_release(&ReleasePolicy {
        identity: "test:model-v1".into(),
        text: true,
        images: true,
    })
    .await
    .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM frames")
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        2
    );
    let protected = db.protected_reads().await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM frames")
            .fetch_one(&protected.pool)
            .await
            .unwrap(),
        0
    );
    db.close().await;
}

#[tokio::test]
async fn reenabling_same_policy_discovers_captures_made_while_disabled() {
    let (_root, db) = database().await;
    for kind in ["frames", "image"] {
        assert!(db.release_pending(kind, 1).await.unwrap().is_empty());
    }
    db.configure_release(&ReleasePolicy {
        identity: "test:model-v1".into(),
        text: false,
        images: false,
    })
    .await
    .unwrap();
    db.execute_raw_sql_write("INSERT INTO frames(id,timestamp,full_text,name) VALUES(1,'2020-01-01','private','old.png')").await.unwrap();
    db.configure_release(&ReleasePolicy {
        identity: "test:model-v1".into(),
        text: true,
        images: true,
    })
    .await
    .unwrap();
    for kind in ["frames", "image"] {
        assert_eq!(
            db.release_pending(kind, 1).await.unwrap().len(),
            1,
            "{kind}"
        );
    }
    db.close().await;
}

#[tokio::test]
async fn queue_discovery_is_bounded_and_policy_retry_deletion_and_status_are_consistent() {
    let (_root, db) = database().await;
    db.configure_release(&ReleasePolicy {
        identity: "test:model-v1".into(),
        text: false,
        images: false,
    })
    .await
    .unwrap();
    db.execute_raw_sql_write("WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM ids WHERE n<300) INSERT INTO frames(id,timestamp,full_text) SELECT n,'2020-01-01','synthetic' FROM ids").await.unwrap();
    db.configure_release(&ReleasePolicy {
        identity: "test:model-v1".into(),
        text: true,
        images: false,
    })
    .await
    .unwrap();
    let job = db.release_pending("frames", 1).await.unwrap().remove(0);
    let discovered: i64 =
        sqlx::query_scalar("SELECT after_id FROM _privacy_discovery WHERE kind='frames'")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(discovered, 128);
    let status = db.release_queue_status().await.unwrap();
    assert!(
        status
            .surfaces
            .iter()
            .find(|s| s.kind == "frames")
            .unwrap()
            .discovering
    );
    assert!(db.publish_release(&job, &job.values).await.unwrap());
    db.configure_release(&ReleasePolicy {
        identity: "test:model-v2".into(),
        text: true,
        images: false,
    })
    .await
    .unwrap();
    let job = db
        .release_pending_ordered("frames", 1, 0, false)
        .await
        .unwrap()
        .remove(0);
    db.defer_release(&job).await.unwrap();
    let retry: i64 =
        sqlx::query_scalar("SELECT retry_at FROM _privacy_release WHERE kind='frames' AND id=?")
            .bind(&job.id)
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert!(retry > chrono::Utc::now().timestamp());
    assert!(!db
        .release_pending("frames", 256)
        .await
        .unwrap()
        .iter()
        .any(|j| j.id == job.id));
    db.execute_raw_sql_write(&format!("DELETE FROM frames WHERE id={}", job.id))
        .await
        .unwrap();
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM _privacy_work WHERE kind='frames' AND id=?")
            .bind(&job.id)
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(count, 0);
    db.close().await;
}

struct CountingDetector {
    calls: Arc<std::sync::atomic::AtomicUsize>,
    fail: Arc<std::sync::atomic::AtomicBool>,
    delay: std::time::Duration,
}
#[async_trait::async_trait]
impl screenpipe_redact::Redactor for CountingDetector {
    fn name(&self) -> &str {
        "synthetic-counted"
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
    ) -> Result<Vec<screenpipe_redact::RedactionOutput>, screenpipe_redact::RedactError> {
        self.calls
            .fetch_add(texts.len(), std::sync::atomic::Ordering::SeqCst);
        if !self.delay.is_zero() {
            tokio::time::sleep(self.delay).await;
        }
        if self.fail.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(screenpipe_redact::RedactError::Unexpected(
                "synthetic failure".into(),
            ));
        }
        Ok(texts
            .iter()
            .map(|text| screenpipe_redact::RedactionOutput {
                evidence: None,
                input: text.clone(),
                redacted: "[PRIVATE]".into(),
                spans: vec![],
            })
            .collect())
    }
}

#[tokio::test]
async fn audio_and_live_segments_bypass_ai_and_are_readable_before_bookkeeping() {
    check_audio_exemption(false).await;
}

#[tokio::test]
async fn hybrid_audio_and_live_segments_bypass_ai_and_are_readable_before_bookkeeping() {
    check_audio_exemption(true).await;
}

async fn check_audio_exemption(hybrid: bool) {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
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
        identity: "audio-exempt-v1".into(),
        text: true,
        images: false,
    })
    .await
    .unwrap();
    db.execute_raw_sql_write("INSERT INTO audio_chunks(id,file_path) VALUES(1,'test.wav'); INSERT INTO audio_transcriptions(id,audio_chunk_id,offset_index,timestamp,transcription,device) VALUES(1,1,0,'2026-10-14T10:00:00Z','Alice at alice@example.com','microphone'); INSERT INTO meetings(id,meeting_start,meeting_app) VALUES(1,'2026-10-14T10:00:00Z',''); INSERT INTO meeting_transcript_segments(id,meeting_id,provider,item_id,transcript,captured_at) VALUES(1,1,'test','one','Call Alice at alice@example.com','2026-10-14T10:00:00Z')").await.unwrap();
    let reader = db.protected_reads().await.unwrap();
    let audio: String =
        sqlx::query_scalar("SELECT transcription FROM audio_transcriptions WHERE id=1")
            .fetch_one(&reader.pool)
            .await
            .unwrap();
    let segment: String =
        sqlx::query_scalar("SELECT transcript FROM meeting_transcript_segments WHERE id=1")
            .fetch_one(&reader.pool)
            .await
            .unwrap();
    assert_eq!(audio, "Alice at alice@example.com");
    assert_eq!(segment, "Call Alice at alice@example.com");
    assert!(reader
        .activity_sources_ready(
            chrono::DateTime::parse_from_rfc3339("2026-10-14T09:00:00Z")
                .unwrap()
                .into(),
            chrono::DateTime::parse_from_rfc3339("2026-10-14T11:00:00Z")
                .unwrap()
                .into()
        )
        .await
        .unwrap());
    assert!(db
        .release_queue_status()
        .await
        .unwrap()
        .surfaces
        .iter()
        .all(|s| !screenpipe_db::privacy_release::is_audio_surface(&s.kind)));
    let old_job = db.release_pending("audio", 1).await.unwrap().remove(0);
    db.defer_release(&old_job).await.unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let worker = screenpipe_redact::worker::Worker::new_with_writer(
        db.pool.clone(),
        db.coordinated_writer(),
        Arc::new(CountingDetector {
            calls: calls.clone(),
            fail: Arc::new(AtomicBool::new(true)),
            delay: std::time::Duration::ZERO,
        }),
        screenpipe_redact::worker::WorkerConfig {
            resource_governor: None,
            ..Default::default()
        },
    )
    .with_frame_storage(db.clone());
    for _ in 0..4 {
        worker.process_release_batch(128).await.unwrap();
    }
    assert_eq!(
        calls.load(Ordering::SeqCst),
        0,
        "audio must never reach either AI backend"
    );
    assert!(db.release_ready("audio", "1").await.unwrap());
    assert!(db.release_ready("segments", "1").await.unwrap());
    let page = reader
        .release_export_page("audio", 0, "2020-01-01", 10)
        .await
        .unwrap();
    assert_eq!(page.rows[0]["transcription"], audio);
    db.execute_raw_sql_write("UPDATE audio_transcriptions SET transcription='Bob' WHERE id=1")
        .await
        .unwrap();
    assert!(
        !db.release_ready("audio", "1").await.unwrap(),
        "sync revisions must still revoke on edits"
    );
    let edited: String =
        sqlx::query_scalar("SELECT transcription FROM audio_transcriptions WHERE id=1")
            .fetch_one(&reader.pool)
            .await
            .unwrap();
    assert_eq!(
        edited, "Bob",
        "local reads must not wait for sync bookkeeping"
    );
    reader.close().await;
    db.close().await;
}

#[tokio::test]
async fn small_slices_remain_fair_and_resumed_json_never_exposes_partial_results() {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    let (_root, db) = database().await;
    db.execute_raw_sql_write("INSERT INTO frames(id,timestamp,full_text,text_json) VALUES(1,'2020-01-01','private','[\"one\",\"two\",\"three\"]'); INSERT INTO memories(content,tags,source) VALUES('private','[]','')").await.unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let worker = screenpipe_redact::worker::Worker::new_with_writer(
        db.pool.clone(),
        db.coordinated_writer(),
        Arc::new(CountingDetector {
            calls: calls.clone(),
            fail: Arc::new(AtomicBool::new(false)),
            delay: std::time::Duration::from_millis(3),
        }),
        screenpipe_redact::worker::WorkerConfig {
            target_batch_duration: std::time::Duration::from_millis(1),
            resource_governor: None,
            ..Default::default()
        },
    )
    .with_frame_storage(db.clone());
    assert_eq!(worker.process_release_batch(1).await.unwrap(), 0);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(!db.release_ready("frames", "1").await.unwrap());
    // A different stream progresses while a large frame is partially processed.
    worker.process_release_batch(1).await.unwrap();
    assert!(db.release_ready("memory", "1").await.unwrap());
    worker.pause();
    let before = calls.load(Ordering::SeqCst);
    assert_eq!(worker.process_release_batch(1).await.unwrap(), 0);
    assert_eq!(calls.load(Ordering::SeqCst), before);
    worker.resume();
    // Discard obsolete partial work immediately, and process the new revision.
    db.execute_raw_sql_write("UPDATE frames SET full_text='replacement',text_json='[]' WHERE id=1")
        .await
        .unwrap();
    assert_eq!(worker.process_release_batch(1).await.unwrap(), 1);
    assert_eq!(calls.load(Ordering::SeqCst), before + 1);
    assert!(db.release_ready("frames", "1").await.unwrap());
    assert_eq!(worker.status().await.redacted_total, 2);
    db.close().await;
}

#[tokio::test]
async fn recent_arrivals_do_not_starve_old_work_and_recovery_clears_worker_error() {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    let (_root, db) = database().await;
    db.execute_raw_sql_write("INSERT INTO frames(id,timestamp,full_text) VALUES(1,'2020-01-01','old'),(2,'2020-01-02','recent')").await.unwrap();
    let fail = Arc::new(AtomicBool::new(true));
    let worker = screenpipe_redact::worker::Worker::new_with_writer(
        db.pool.clone(),
        db.coordinated_writer(),
        Arc::new(CountingDetector {
            calls: Arc::new(AtomicUsize::new(0)),
            fail: fail.clone(),
            delay: std::time::Duration::ZERO,
        }),
        Default::default(),
    )
    .with_frame_storage(db.clone());
    assert_eq!(worker.process_release_batch(1).await.unwrap(), 0);
    let failure = worker.status().await.last_error.unwrap();
    assert!(failure.contains("synthetic failure"));
    assert!(failure.contains("kind=frames"));
    assert!(failure.contains("retry scheduled"));
    fail.store(false, Ordering::SeqCst);
    db.execute_raw_sql_write(
        "INSERT INTO frames(id,timestamp,full_text) VALUES(3,'2020-01-03','newest')",
    )
    .await
    .unwrap();
    assert_eq!(worker.process_release_batch(1).await.unwrap(), 1);
    assert!(
        db.release_ready("frames", "1").await.unwrap(),
        "oldest must get a turn despite new captures"
    );
    let status = worker.status().await;
    assert_eq!(status.redacted_total, 1);
    assert!(status.last_redacted_at.is_some());
    assert!(status.last_error.is_none());
    db.close().await;
}

/// Manual local measurement; deliberately excluded from normal CI.
#[tokio::test]
#[ignore = "manual synthetic database performance benchmark"]
async fn privacy_queue_benchmark() {
    use std::time::Instant;
    fn p95(mut samples: Vec<f64>) -> f64 {
        samples.sort_by(f64::total_cmp);
        samples[(samples.len() * 95 / 100).min(samples.len() - 1)]
    }
    for history in [1000, 20000] {
        let (_root, db) = database().await;
        db.configure_release(&ReleasePolicy {
            identity: "bench".into(),
            text: false,
            images: false,
        })
        .await
        .unwrap();
        db.execute_raw_sql_write(&format!("WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM ids WHERE n<{history}) INSERT INTO frames(id,timestamp,full_text) SELECT n,'2020-01-01','synthetic benchmark text' FROM ids")).await.unwrap();
        db.configure_release(&ReleasePolicy {
            identity: "bench".into(),
            text: true,
            images: false,
        })
        .await
        .unwrap();
        // Synthetic certification is fixture setup, never detector evidence.
        db.execute_raw_sql_write(&format!("INSERT INTO _privacy_release(kind,id,policy) SELECT 'frames',CAST(id AS TEXT),'bench' FROM frames; INSERT INTO _privacy_discovery(kind,policy,after_id,complete) VALUES('frames','bench',{history},1)")).await.unwrap();
        let mut legacy = Vec::new();
        let mut indexed = Vec::new();
        for _ in 0..30 {
            let start = Instant::now();
            let rows: Vec<i64>=sqlx::query_scalar("SELECT s.id FROM frames s LEFT JOIN _privacy_release r ON r.kind='frames' AND r.id=CAST(s.id AS TEXT) WHERE r.policy IS NULL OR r.policy!=(SELECT receipt_key FROM _privacy_policy WHERE identity='bench') ORDER BY s.id DESC LIMIT 16").fetch_all(&db.pool).await.unwrap();
            assert!(rows.is_empty());
            legacy.push(start.elapsed().as_secs_f64() * 1000.);
            let start = Instant::now();
            assert!(db.release_pending("frames", 16).await.unwrap().is_empty());
            indexed.push(start.elapsed().as_secs_f64() * 1000.);
        }
        let mut capture = Vec::new();
        for _ in 0..100 {
            let start = Instant::now();
            db.execute_raw_sql_write("INSERT INTO frames(timestamp,full_text) VALUES('2020-01-01','synthetic new capture')").await.unwrap();
            capture.push(start.elapsed().as_secs_f64() * 1000.);
        }
        println!("PRIVACY_BENCH history={history} idle_legacy_p95_ms={:.3} idle_indexed_p95_ms={:.3} protected_capture_p95_ms={:.3}",p95(legacy),p95(indexed),p95(capture));
        db.close().await;
    }
}

#[cfg(feature = "onnx-cpu")]
#[tokio::test]
#[ignore = "manual local real-detector benchmark; requires installed ONNX model"]
async fn privacy_real_detector_benchmark() {
    use screenpipe_redact::adapters::onnx::{OnnxConfig, OnnxRedactor};
    use std::time::{Duration, Instant};
    let (_root, db) = database().await;
    let start = Instant::now();
    let detector = Arc::new(OnnxRedactor::load(OnnxConfig::default()).unwrap());
    let load = start.elapsed();
    for n in 0..12 {
        db.execute_raw_sql_write(&format!("INSERT INTO frames(timestamp,full_text,text_json) VALUES('2020-01-01','Synthetic contact {n}: Jordan Lee, jordan{n}@example.com. Project update.','[\"Synthetic project planning\"]')")).await.unwrap();
    }
    let worker = screenpipe_redact::worker::Worker::new_with_writer(
        db.pool.clone(),
        db.coordinated_writer(),
        detector,
        Default::default(),
    )
    .with_frame_storage(db.clone());
    let monitor = worker.clone();
    let shutdown = Arc::new(tokio::sync::Notify::new());
    let start = Instant::now();
    let handle = worker.spawn_with_shutdown(shutdown.clone());
    let completed = tokio::time::timeout(Duration::from_secs(90), async {
        loop {
            if monitor.status().await.redacted_total >= 12 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    shutdown.notify_one();
    handle.await.unwrap();
    completed.expect("background processing did not drain within benchmark deadline");
    println!(
        "PRIVACY_REAL_MODEL records=12 load_ms={} governed_elapsed_ms={} records_per_second={:.2}",
        load.as_millis(),
        start.elapsed().as_millis(),
        12. / start.elapsed().as_secs_f64()
    );
    assert_eq!(db.ready_changes(0, 100).await.unwrap().len(), 12);
    db.close().await;
}

#[tokio::test]
async fn deleting_and_reusing_an_id_never_accepts_old_text_or_image_work() {
    let (_root, db) = database().await;
    db.execute_raw_sql_write("INSERT INTO frames(id,timestamp,full_text,name) VALUES(1,'2020-01-01','old private','old.png')").await.unwrap();
    let text = db.release_pending("frames", 1).await.unwrap().remove(0);
    let image = db.release_pending("image", 1).await.unwrap().remove(0);
    db.execute_raw_sql_write("DELETE FROM frames WHERE id=1; INSERT INTO frames(id,timestamp,full_text,name) VALUES(1,'2020-01-02','replacement private','replacement.png')").await.unwrap();
    assert!(!db.release_job_current(&text).await.unwrap());
    assert!(!db.publish_release(&text, &text.values).await.unwrap());
    assert!(!db.publish_image_release(&image).await.unwrap());
    let current = db.release_pending("frames", 1).await.unwrap().remove(0);
    assert!(current.revision > text.revision);
    assert_eq!(
        current.values["full_text"].as_deref(),
        Some("replacement private")
    );
    db.close().await;
}

#[tokio::test]
async fn bounded_image_traversal_moves_past_future_dated_records() {
    let (_root, db) = database().await;
    db.execute_raw_sql_write("WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM ids WHERE n<800) INSERT INTO frames(id,timestamp,name) SELECT n,CASE WHEN n=400 THEN '2020-01-01' ELSE '2099-01-01' END,'synthetic.png' FROM ids").await.unwrap();
    let mut found = false;
    for turn in 0..8 {
        let jobs = db
            .release_pending_ordered("image", 1, 60, turn % 2 == 0)
            .await
            .unwrap();
        if jobs.iter().any(|j| j.id == "400") {
            found = true;
            break;
        }
    }
    assert!(
        found,
        "future-dated images must not permanently hide mature work"
    );
    db.close().await;
}

#[tokio::test]
async fn pending_jobs_do_not_survive_source_changes_while_disabled() {
    for mutation in ["UPDATE frames SET full_text='replacement private',name='replacement.png' WHERE id=1", "DELETE FROM frames WHERE id=1; INSERT INTO frames(id,timestamp,full_text,name) VALUES(1,'2020-01-02','replacement private','replacement.png')"] {
        let (_root, db) = database().await;
        db.execute_raw_sql_write("INSERT INTO frames(id,timestamp,full_text,name) VALUES(1,'2020-01-01','old private','old.png')").await.unwrap();
        let text = db.release_pending("frames",1).await.unwrap().remove(0);
        let image = db.release_pending("image",1).await.unwrap().remove(0);
        let mut policy = db.release_policy().await.unwrap();
        policy.text=false; policy.images=false;
        db.configure_release(&policy).await.unwrap();
        assert!(!db.publish_release(&text, &text.values).await.unwrap());
        assert!(!db.publish_image_release(&image).await.unwrap());
        db.execute_raw_sql_write(mutation).await.unwrap();
        policy.text=true; policy.images=true;
        db.configure_release(&policy).await.unwrap();
        assert!(!db.release_job_current(&text).await.unwrap());
        assert!(!db.publish_release(&text,&text.values).await.unwrap());
        assert!(!db.publish_image_release(&image).await.unwrap());
        let current=db.release_pending("frames",1).await.unwrap().remove(0);
        assert!(current.revision>text.revision);
        assert_eq!(current.values["full_text"].as_deref(),Some("replacement private"));
        db.close().await;
    }
}

#[tokio::test]
async fn young_image_tail_does_not_hide_mature_backlog_or_report_retry() {
    let (_root, db) = database().await;
    db.execute_raw_sql_write("WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM ids WHERE n<600) INSERT INTO frames(id,timestamp,name) SELECT n,CASE WHEN n<=300 THEN '2020-01-01' ELSE datetime('now') END,'synthetic.png' FROM ids").await.unwrap();
    let jobs = db
        .release_pending_ordered("image", 1, 60, false)
        .await
        .unwrap();
    assert!(
        !jobs.is_empty(),
        "recent young images must not hide ready old images"
    );
    assert!(jobs[0].id.parse::<i64>().unwrap() <= 300);
    // With only young work left, maturity is normal waiting, not a failure.
    db.execute_raw_sql_write("DELETE FROM frames WHERE id<=300")
        .await
        .unwrap();
    assert!(db
        .release_pending_ordered("image", 1, 60, true)
        .await
        .unwrap()
        .is_empty());
    let status = db.release_queue_status().await.unwrap();
    let images = status.surfaces.iter().find(|s| s.kind == "image").unwrap();
    assert!(images.pending > 0);
    assert_eq!(images.deferred, 0);
    db.close().await;
}

#[tokio::test]
async fn legacy_revision_zero_can_only_be_published_once() {
    let (_root, db) = database().await;
    let mut policy = db.release_policy().await.unwrap();
    policy.text = false;
    policy.images = false;
    db.configure_release(&policy).await.unwrap();
    db.execute_raw_sql_write("INSERT INTO frames(id,timestamp,full_text,name) VALUES(1,'2020-01-01','legacy','legacy.png')").await.unwrap();
    policy.text = true;
    policy.images = true;
    db.configure_release(&policy).await.unwrap();
    let text = db.release_pending("frames", 1).await.unwrap().remove(0);
    let image = db.release_pending("image", 1).await.unwrap().remove(0);
    assert_eq!(text.revision, 0);
    assert_eq!(image.revision, 0);
    assert!(db.publish_release(&text, &text.values).await.unwrap());
    assert!(!db.publish_release(&text, &text.values).await.unwrap());
    assert!(db.publish_image_release(&image).await.unwrap());
    assert!(!db.publish_image_release(&image).await.unwrap());
    db.close().await;
}

#[tokio::test]
async fn correcting_future_image_timestamp_restores_eligibility() {
    let (_root, db) = database().await;
    db.execute_raw_sql_write(
        "INSERT INTO frames(id,timestamp,name) VALUES(1,'2099-01-01','synthetic.png')",
    )
    .await
    .unwrap();
    assert!(db
        .release_pending_aged("image", 1, 60)
        .await
        .unwrap()
        .is_empty());
    db.execute_raw_sql_write("UPDATE frames SET timestamp='2020-01-01' WHERE id=1")
        .await
        .unwrap();
    let jobs = db.release_pending_aged("image", 1, 60).await.unwrap();
    assert_eq!(
        jobs.len(),
        1,
        "corrected timestamp must not retain the 2099 deadline"
    );
    assert_eq!(jobs[0].id, "1");
    db.close().await;
}

#[tokio::test]
async fn publication_write_failure_rolls_back_receipt_and_source() {
    let (_root, db) = database().await;
    db.execute_raw_sql_write("INSERT INTO frames(id,timestamp,full_text) VALUES(1,'2020-01-01','SYNTHETIC_SECRET'); CREATE TRIGGER inject_publication_failure BEFORE INSERT ON _privacy_ready BEGIN SELECT RAISE(ABORT,'synthetic publication failure'); END;").await.unwrap();
    let job = db.release_pending("frames", 1).await.unwrap().remove(0);
    let mut clean = job.values.clone();
    clean.insert("full_text".into(), Some("[PRIVATE]".into()));
    assert!(db.publish_release(&job, &clean).await.is_err());
    assert!(!db.release_ready("frames", "1").await.unwrap());
    let raw: String = sqlx::query_scalar("SELECT full_text FROM frames WHERE id=1")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(raw, "SYNTHETIC_SECRET");
    db.execute_raw_sql_write("DROP TRIGGER inject_publication_failure; INSERT INTO frames(id,timestamp,full_text) VALUES(2,'2020-01-01','next capture')").await.unwrap();
    assert!(db.publish_release(&job, &clean).await.unwrap());
    assert_eq!(db.ready_changes(0, 10).await.unwrap().len(), 1);
    db.close().await;
}

#[tokio::test]
async fn randomized_revision_policy_delete_reinsert_sequences_never_release_stale_text() {
    for seed in [1u64, 7, 42, 20261014] {
        let (_root, db) = database().await;
        let protected = db.protected_reads().await.unwrap();
        let mut rng = seed;
        let mut jobs = Vec::new();
        let mut version = 0;
        for step in 0..500 {
            rng ^= rng << 13;
            rng ^= rng >> 7;
            rng ^= rng << 17;
            let id = 1 + rng % 24;
            match (rng >> 8) % 6 {
                0 | 1 => {
                    db.execute_raw_sql_write(&format!("INSERT INTO frames(id,timestamp,full_text) VALUES({id},'2020-01-01','SYNTHETIC_SECRET_{step}') ON CONFLICT(id) DO UPDATE SET full_text=excluded.full_text")).await.unwrap();
                }
                2 => {
                    db.execute_raw_sql_write(&format!("DELETE FROM frames WHERE id={id}"))
                        .await
                        .unwrap_or_else(|e| panic!("seed={seed} step={step} id={id}: {e}"));
                }
                3 => {
                    jobs.extend(db.release_pending("frames", 24).await.unwrap());
                }
                4 if !jobs.is_empty() => {
                    let job = jobs.swap_remove((rng as usize) % jobs.len());
                    let current = db.release_job_current(&job).await.unwrap();
                    let mut clean = job.values.clone();
                    clean.insert("full_text".into(), Some("[PRIVATE]".into()));
                    assert_eq!(
                        db.publish_release(&job, &clean).await.unwrap(),
                        current,
                        "seed={seed},step={step}"
                    );
                    if current {
                        assert!(
                            !db.publish_release(&job, &clean).await.unwrap(),
                            "duplicate completion"
                        );
                    }
                }
                5 => {
                    version += 1;
                    db.configure_release(&ReleasePolicy {
                        identity: format!("random:{version}"),
                        text: true,
                        images: true,
                    })
                    .await
                    .unwrap();
                }
                _ => {}
            }
            let leaked: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM frames WHERE full_text LIKE '%SYNTHETIC_SECRET%'",
            )
            .fetch_one(&protected.pool)
            .await
            .unwrap();
            assert_eq!(leaked, 0, "seed={seed},step={step}");
        }
        protected.close().await;
        db.close().await;
    }
}

#[tokio::test]
async fn partial_multifield_work_survives_close_reopen_sqlite_and_hybrid() {
    use std::sync::atomic::{AtomicBool, AtomicUsize};
    for hybrid in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let open = || async {
            Arc::new(if hybrid {
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
            })
        };
        let db = open().await;
        db.configure_release(&ReleasePolicy {
            identity: "restart:v1".into(),
            text: true,
            images: false,
        })
        .await
        .unwrap();
        db.execute_raw_sql_write("INSERT INTO frames(id,timestamp,full_text,text_json) VALUES(1,'2020-01-01','SYNTHETIC_SECRET','[\"SYNTHETIC_SECRET\",\"another private field\"]')").await.unwrap();
        let detector = Arc::new(CountingDetector {
            calls: Arc::new(AtomicUsize::new(0)),
            fail: Arc::new(AtomicBool::new(false)),
            delay: std::time::Duration::from_millis(3),
        });
        let worker = screenpipe_redact::worker::Worker::new_with_writer(
            db.pool.clone(),
            db.coordinated_writer(),
            detector.clone(),
            screenpipe_redact::worker::WorkerConfig {
                target_batch_duration: std::time::Duration::from_millis(1),
                resource_governor: None,
                ..Default::default()
            },
        )
        .with_frame_storage(db.clone());
        assert_eq!(worker.process_release_batch(1).await.unwrap(), 0);
        assert!(!db.release_ready("frames", "1").await.unwrap());
        db.execute_raw_sql_write(
            "INSERT INTO frames(id,timestamp,full_text) VALUES(2,'2020-01-01','SYNTHETIC_SECRET')",
        )
        .await
        .unwrap();
        drop(worker);
        db.close().await;
        drop(db);
        // Normal open discovers the persisted hybrid descriptor; new_hybrid
        // is only the initial opt-in for an empty root.
        let db = Arc::new(
            DatabaseManager::new(
                root.path().join("db.sqlite").to_str().unwrap(),
                Default::default(),
            )
            .await
            .unwrap(),
        );
        let protected = db.protected_reads().await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM frames")
                .fetch_one(&protected.pool)
                .await
                .unwrap(),
            0
        );
        let worker = screenpipe_redact::worker::Worker::new_with_writer(
            db.pool.clone(),
            db.coordinated_writer(),
            detector,
            screenpipe_redact::worker::WorkerConfig {
                resource_governor: None,
                ..Default::default()
            },
        )
        .with_frame_storage(db.clone());
        for _ in 0..20 {
            worker.process_release_batch(8).await.unwrap();
        }
        assert_eq!(db.ready_changes(0, 10).await.unwrap().len(), 2);
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM frames WHERE full_text LIKE '%SYNTHETIC_SECRET%'"
            )
            .fetch_one(&protected.pool)
            .await
            .unwrap(),
            0
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM frames")
                .fetch_one(&protected.pool)
                .await
                .unwrap(),
            2
        );
        protected.close().await;
        db.close().await;
    }
}

#[tokio::test]
async fn activity_labels_keep_structure_and_revoke_on_edit_policy_and_restart() {
    let (root, db) = database().await;
    db.execute_raw_sql_write("INSERT INTO frames(id,timestamp,full_text) VALUES(1,'2026-10-14T10:00:00Z','pending'); INSERT INTO activity_tasks(id,task_key,kind,title,confidence,producer,user_locked) VALUES(1,'task','task','SYNTHETIC_SECRET',1,'test',1); INSERT INTO activity_intervals(id,interval_key,task_id,start_at,end_at,state,confidence,producer) VALUES(1,'interval',1,'2026-10-14T10:00:00Z','2026-10-14T10:05:00Z','final',1,'test'); INSERT INTO activity_actions(id,action_key,interval_id,occurred_at,action_type,summary,confidence,source_type,source_id) VALUES(1,'action',1,'2026-10-14T10:00:00Z','view','SYNTHETIC_SECRET',1,'frame',1)").await.unwrap();
    let protected = db.protected_reads().await.unwrap();
    let start = "2026-10-14T09:00:00Z".parse().unwrap();
    let end = "2026-10-14T11:00:00Z".parse().unwrap();
    assert!(!protected.activity_sources_ready(start, end).await.unwrap());
    let pending = protected
        .list_activity_ledger(start, end, true, true)
        .await
        .unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].id, 1);
    assert!(pending[0].title.contains("privacy processing"));
    assert!(pending[0].actions[0].summary.contains("privacy processing"));
    for kind in ["activity_tasks", "activity_actions", "frames"] {
        let job = db.release_pending(kind, 1).await.unwrap().remove(0);
        let values = job
            .values
            .iter()
            .map(|(k, v)| {
                (
                    k.clone(),
                    v.as_ref()
                        .map(|v| v.replace("SYNTHETIC_SECRET", "[PRIVATE]")),
                )
            })
            .collect();
        assert!(db.publish_release(&job, &values).await.unwrap());
    }
    assert!(protected.activity_sources_ready(start, end).await.unwrap());
    let ready = protected
        .list_activity_ledger(start, end, true, true)
        .await
        .unwrap();
    assert_eq!(ready[0].id, pending[0].id);
    assert_eq!(ready[0].start_at, pending[0].start_at);
    assert_eq!(ready[0].title, "[PRIVATE]");
    assert_eq!(ready[0].actions[0].summary, "[PRIVATE]");
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT user_locked FROM activity_tasks WHERE id=1")
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        1
    );
    let before_edit = db.release_revocation().await.unwrap();
    db.execute_raw_sql_write("UPDATE activity_tasks SET title='SYNTHETIC_SECRET_EDIT' WHERE id=1")
        .await
        .unwrap();
    assert!(protected
        .list_activity_ledger(start, end, false, false)
        .await
        .unwrap()[0]
        .title
        .contains("privacy processing"));
    assert!(protected
        .reconcile_activity_ledger_checked("test", start, end, &[], &[], before_edit)
        .await
        .is_err());
    assert_eq!(
        protected
            .list_activity_ledger(start, end, false, false)
            .await
            .unwrap()
            .len(),
        1
    );
    db.configure_release(&ReleasePolicy {
        identity: "v2".into(),
        text: true,
        images: true,
    })
    .await
    .unwrap();
    assert!(protected
        .list_activity_ledger(start, end, true, false)
        .await
        .unwrap()[0]
        .actions[0]
        .summary
        .contains("privacy processing"));
    db.close().await;
    drop(protected);
    drop(db);
    let reopened = Arc::new(
        DatabaseManager::new(
            root.path().join("db.sqlite").to_str().unwrap(),
            Default::default(),
        )
        .await
        .unwrap(),
    );
    let protected = reopened.protected_reads().await.unwrap();
    assert!(protected
        .list_activity_ledger(start, end, false, false)
        .await
        .unwrap()[0]
        .title
        .contains("privacy processing"));
    assert_eq!(
        reopened
            .release_pending("activity_tasks", 1)
            .await
            .unwrap()
            .len(),
        1
    );
    reopened.close().await;
}

#[tokio::test]
async fn bulk_release_can_seal_without_revoking_and_edits_still_revoke() {
    let root = tempfile::tempdir().unwrap();
    let db = Arc::new(
        DatabaseManager::new_hybrid(root.path(), Default::default(), Default::default())
            .await
            .unwrap(),
    );
    db.configure_release(&ReleasePolicy {
        identity: "bulk-v1".into(),
        text: true,
        images: false,
    })
    .await
    .unwrap();
    db.execute_raw_sql_write("INSERT INTO frames(id,timestamp,full_text) VALUES(1,'2026-10-14T10:00:00Z','safe'); INSERT INTO audio_chunks(id,file_path) VALUES(1,'test.wav'); INSERT INTO audio_transcriptions(id,audio_chunk_id,offset_index,timestamp,transcription,device) VALUES(1,1,0,'2026-10-14T10:00:00Z','safe audio','test'); INSERT INTO ui_events(id,timestamp,event_type,text_content) VALUES(1,'2026-10-14T10:00:00Z','text','safe input'); INSERT INTO elements(id,frame_id,source,role,text) VALUES(1,1,'accessibility','AXText','safe element')").await.unwrap();
    for kind in ["frames", "audio", "input", "elements"] {
        let job = db.release_pending(kind, 1).await.unwrap().remove(0);
        assert!(db.publish_release(&job, &job.values).await.unwrap());
    }
    for table in ["audio_transcriptions", "ui_events", "elements"] {
        assert!(sqlx::query_scalar::<_, bool>(sqlx::AssertSqlSafe(format!(
            "SELECT redacted_at IS NOT NULL FROM {table} WHERE id=1"
        )))
        .fetch_one(&db.pool)
        .await
        .unwrap());
    }
    let before = db.release_revocation().await.unwrap();
    let mut sealed = 0;
    loop {
        let count = db.seal_payloads().await.unwrap();
        if count == 0 {
            break;
        }
        sealed += count;
    }
    assert_eq!(sealed, 4);
    assert_eq!(db.release_revocation().await.unwrap(), before);
    for kind in ["frames", "audio", "input", "elements"] {
        assert!(db.release_ready(kind, "1").await.unwrap(), "{kind}");
        assert!(
            db.release_pending(kind, 1).await.unwrap().is_empty(),
            "{kind}"
        );
    }
    db.execute_raw_sql_write("UPDATE audio_transcriptions SET transcription='new private audio' WHERE id=1; UPDATE ui_events SET text_content='new private input' WHERE id=1; UPDATE elements SET text='new private element' WHERE id=1").await.unwrap();
    for kind in ["audio", "input", "elements"] {
        assert!(!db.release_ready(kind, "1").await.unwrap(), "{kind}");
        assert_eq!(
            db.release_pending(kind, 1).await.unwrap().len(),
            1,
            "{kind}"
        );
    }
    let obsolete = db.release_pending("elements", 1).await.unwrap().remove(0);
    db.execute_raw_sql_write("DELETE FROM elements WHERE id=1")
        .await
        .unwrap();
    assert!(!db.release_ready("elements", "1").await.unwrap());
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM _privacy_work WHERE kind='elements'")
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        0
    );
    db.execute_raw_sql_write("INSERT INTO elements(id,frame_id,source,role,text) VALUES(1,1,'accessibility','AXText','replacement')").await.unwrap();
    assert!(!db
        .publish_release(&obsolete, &obsolete.values)
        .await
        .unwrap());
    db.close().await;
}

#[tokio::test]
async fn unchanged_configuration_keeps_receipts_but_an_older_contract_is_revoked() {
    let (_root, db) = database().await;
    db.execute_raw_sql_write("INSERT INTO frames(id,timestamp,full_text,document_path) VALUES(1,'2026-10-14','safe','/private/document')").await.unwrap();
    let job = db.release_pending("frames", 1).await.unwrap().remove(0);
    assert!(job.values.contains_key("document_path"));
    assert!(db.publish_release(&job, &job.values).await.unwrap());
    let policy = db.release_policy().await.unwrap();
    db.configure_release(&policy).await.unwrap();
    assert!(db.release_ready("frames", "1").await.unwrap());
    // Simulate a receipt produced by the earlier field contract, which did
    // not watch document paths. Startup must not reuse it for the wider gate.
    db.execute_raw_sql_write("DROP TRIGGER privacy_frames_UPDATE; CREATE TRIGGER privacy_frames_UPDATE AFTER UPDATE OF full_text ON frames BEGIN SELECT 1; END;").await.unwrap();
    db.configure_release(&policy).await.unwrap();
    assert!(!db.release_ready("frames", "1").await.unwrap());
    assert_eq!(db.release_pending("frames", 1).await.unwrap().len(), 1);
    db.close().await;
}

fn exported_activity(title: &str) -> serde_json::Value {
    serde_json::json!({"activity_id":"stable-activity", "activity_kind":"work", "meeting_id":7,
        "timestamp":"2026-10-16T10:05:00Z", "start_at":"2026-10-16T10:00:00Z", "end_at":"2026-10-16T10:05:00Z",
        "title":title, "summary":"SYNTHETIC_SECRET summary", "future_content":"SYNTHETIC_SECRET future field", "evidence":[{"kind":"frame","at":"2026-10-16T10:01:00Z","frame_id":42,"meeting_id":7,"app_name":"SYNTHETIC_SECRET app","label":"SYNTHETIC_SECRET evidence"}]})
}

async fn finish_export_jobs(db: &Arc<DatabaseManager>) {
    let worker = screenpipe_redact::worker::Worker::new_with_writer(
        db.pool.clone(),
        db.coordinated_writer(),
        Arc::new(CountingDetector {
            calls: Arc::new(Default::default()),
            fail: Arc::new(Default::default()),
            delay: Default::default(),
        }),
        screenpipe_redact::worker::WorkerConfig {
            resource_governor: None,
            ..Default::default()
        },
    )
    .with_frame_storage(db.clone());
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            worker.process_release_batch(16).await.unwrap();
            let pending: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM _privacy_work WHERE kind='exports'")
                    .fetch_one(&db.pool)
                    .await
                    .unwrap();
            if pending == 0 {
                break;
            }
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn derived_activity_outage_restart_edit_and_policy_preserve_source_and_identity() {
    let (root, db) = database().await;
    let cutoff = "2026-10-16T00:00:00Z";
    let original = exported_activity("SYNTHETIC_SECRET title");
    db.stage_activity_exports(&[original.clone()], cutoff)
        .await
        .unwrap();
    let worker = screenpipe_redact::worker::Worker::new_with_writer(
        db.pool.clone(),
        db.coordinated_writer(),
        Arc::new(Pipeline::regex_only()),
        Default::default(),
    )
    .with_frame_storage(db.clone());
    worker.process_release_batch(16).await.unwrap();
    let protected = db.protected_reads().await.unwrap();
    assert_eq!(
        protected
            .release_export_page("activities", 0, cutoff, 10)
            .await
            .unwrap()
            .rows,
        serde_json::json!([])
    );
    // Background failure never prevents new durable captures.
    db.execute_raw_sql_write("INSERT INTO frames(id,timestamp,full_text) VALUES(42,'2026-10-16T10:00:00Z','recording continues')").await.unwrap();
    protected.close().await;
    db.close().await;
    drop(worker);
    let db = Arc::new(
        DatabaseManager::new(
            root.path().join("db.sqlite").to_str().unwrap(),
            Default::default(),
        )
        .await
        .unwrap(),
    );
    db.configure_release(&ReleasePolicy {
        identity: "test:model-v1".into(),
        text: true,
        images: true,
    })
    .await
    .unwrap();
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM frames WHERE id=42")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(rows, 1);
    // Simulate the existing retry becoming due; no accepted item was discarded.
    db.execute_raw_sql_write(
        "UPDATE _privacy_work SET available_at=0; UPDATE _privacy_release SET retry_at=NULL",
    )
    .await
    .unwrap();
    finish_export_jobs(&db).await;
    let protected = db.protected_reads().await.unwrap();
    let page = protected
        .release_export_page("activities", 0, cutoff, 10)
        .await
        .unwrap();
    let row = &page.rows[0];
    assert_eq!(row["activity_id"], original["activity_id"]);
    assert_eq!(row["start_at"], original["start_at"]);
    assert_eq!(row["evidence"][0]["frame_id"], 42);
    assert_eq!(row["title"], "[PRIVATE]");
    assert!(!row.to_string().contains("SYNTHETIC_SECRET"));
    let version = db.activity_export_versions().await.unwrap();
    db.stage_activity_exports(&[original.clone()], cutoff)
        .await
        .unwrap();
    assert_eq!(db.activity_export_versions().await.unwrap(), version);
    assert_eq!(
        protected
            .release_export_page("activities", page.sequence, cutoff, 10)
            .await
            .unwrap()
            .rows,
        serde_json::json!([])
    );
    let edited = exported_activity("SYNTHETIC_SECRET edited");
    assert!(screenpipe_db::privacy_exports::validate_activity_exports(
        &version,
        &[original.clone()]
    )
    .is_ok());
    assert!(
        screenpipe_db::privacy_exports::validate_activity_exports(&version, &[edited.clone()])
            .is_err()
    );
    assert!(screenpipe_db::privacy_exports::validate_activity_exports(&version, &[]).is_err());
    db.stage_activity_exports(&[edited], cutoff).await.unwrap();
    assert_eq!(
        protected
            .release_export_page("activities", 0, cutoff, 10)
            .await
            .unwrap()
            .rows,
        serde_json::json!([])
    );
    let stale = db.release_pending("exports", 1).await.unwrap().remove(0);
    db.stage_activity_exports(
        &[exported_activity("SYNTHETIC_SECRET changed again")],
        cutoff,
    )
    .await
    .unwrap();
    assert!(!db.publish_release(&stale, &stale.values).await.unwrap());
    finish_export_jobs(&db).await;
    assert_eq!(
        protected
            .release_export_page("activities", page.sequence, cutoff, 10)
            .await
            .unwrap()
            .rows
            .as_array()
            .unwrap()
            .len(),
        1
    );
    db.configure_release(&ReleasePolicy {
        identity: "new-policy".into(),
        text: true,
        images: false,
    })
    .await
    .unwrap();
    assert_eq!(
        protected
            .release_export_page("activities", 0, cutoff, 10)
            .await
            .unwrap()
            .rows,
        serde_json::json!([])
    );
    finish_export_jobs(&db).await;
    assert_eq!(
        protected
            .release_export_page("activities", 0, cutoff, 10)
            .await
            .unwrap()
            .rows
            .as_array()
            .unwrap()
            .len(),
        1
    );
    db.stage_activity_exports(&[], cutoff).await.unwrap();
    assert_eq!(
        protected
            .release_export_page("activities", 0, cutoff, 10)
            .await
            .unwrap()
            .rows,
        serde_json::json!([])
    );
    protected.close().await;
    db.close().await;
}

#[tokio::test]
async fn derived_feedback_paginates_and_reprocesses_edits_without_rewriting_local_feedback() {
    let (_root, db) = database().await;
    let cutoff = "2026-10-16T00:00:00Z";
    for i in 0..3 {
        db.execute_raw_sql_write(&format!("INSERT INTO feedback(id,target_kind,target_id,actor_id,rating,comment,snapshot,context,created_at,updated_at) VALUES('feedback-{i}','activity','stable-activity-{i}','actor-1','up','SYNTHETIC_SECRET','{{\"nested\":[\"SYNTHETIC_SECRET\"]}}','{{\"url\":\"SYNTHETIC_SECRET\"}}','2026-10-16T10:00:00Z','2026-10-16T10:00:00Z')")).await.unwrap();
    }
    assert!(db
        .prepare_derived_exports("feedback", cutoff, 1)
        .await
        .unwrap());
    while db
        .prepare_derived_exports("feedback", cutoff, 1)
        .await
        .unwrap()
    {}
    finish_export_jobs(&db).await;
    let protected = db.protected_reads().await.unwrap();
    let page = protected
        .release_export_page("feedback", 0, cutoff, 10)
        .await
        .unwrap();
    assert_eq!(page.rows.as_array().unwrap().len(), 3);
    assert!(!page.rows.to_string().contains("SYNTHETIC_SECRET"));
    assert_eq!(page.rows[0]["actor_id"], "actor-1");
    assert!(page.rows[0]["target_id"]
        .as_str()
        .unwrap()
        .starts_with("stable-activity-"));
    let raw: String = sqlx::query_scalar("SELECT comment FROM feedback WHERE id='feedback-0'")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(raw, "SYNTHETIC_SECRET");
    let token = db.storage_export_token().await.unwrap();
    db.execute_raw_sql_write(
        "UPDATE feedback SET comment='SYNTHETIC_SECRET changed' WHERE id='feedback-0'",
    )
    .await
    .unwrap();
    assert!(token.admit(&db.pool).await.is_err());
    assert_eq!(
        protected
            .release_export_page("feedback", 0, cutoff, 10)
            .await
            .unwrap()
            .rows
            .as_array()
            .unwrap()
            .len(),
        2
    );
    db.prepare_derived_exports("feedback", cutoff, 1)
        .await
        .unwrap();
    finish_export_jobs(&db).await;
    assert_eq!(
        protected
            .release_export_page("feedback", page.sequence, cutoff, 10)
            .await
            .unwrap()
            .rows
            .as_array()
            .unwrap()
            .len(),
        1
    );
    db.execute_raw_sql_write("DELETE FROM feedback WHERE id='feedback-0'")
        .await
        .unwrap();
    db.prepare_derived_exports("feedback", cutoff, 1)
        .await
        .unwrap();
    assert_eq!(
        protected
            .release_export_page("feedback", 0, cutoff, 10)
            .await
            .unwrap()
            .rows
            .as_array()
            .unwrap()
            .len(),
        2
    );
    protected.close().await;
    db.close().await;
}

#[tokio::test]
async fn derived_parsed_snapshot_covers_actor_labels_and_invalidates_join_changes() {
    let (_root, db) = database().await;
    let cutoff = "2026-10-16T00:00:00Z";
    db.execute_raw_sql_write("INSERT INTO semantic_runs(id,input_fingerprint,parser_id,parser_version,schema_version,app_platform,input_content_hash,status,item_count) VALUES(1,zeroblob(32),'test-parser','1',1,'macos',zeroblob(8),'handled',1); INSERT INTO semantic_items(id,entity_fingerprint,version_fingerprint,kind,item_key,identity_quality,title,body,actor,metadata_json) VALUES(1,zeroblob(32),zeroblob(32),'message','SYNTHETIC_SECRET key','stable','SYNTHETIC_SECRET title','SYNTHETIC_SECRET body','SYNTHETIC_SECRET actor','{\"url\":\"SYNTHETIC_SECRET\"}'); INSERT INTO semantic_run_items(run_id,local_id,item_id,sort_order) VALUES(1,'stable-local-id',1,0); INSERT INTO semantic_actors(id,name) VALUES(1,'SYNTHETIC_SECRET resolved'); INSERT INTO semantic_item_actors(item_id,actor_id) VALUES(1,1); INSERT INTO frames(id,timestamp,app_name,window_name,full_text,semantic_run_id) VALUES(1,'2026-10-16T10:00:00Z','SYNTHETIC_SECRET app','SYNTHETIC_SECRET window','SYNTHETIC_SECRET source',1)").await.unwrap();
    db.prepare_derived_exports("parsed", cutoff, 1)
        .await
        .unwrap();
    let stale = db.release_pending("exports", 1).await.unwrap().remove(0);
    db.execute_raw_sql_write(
        "UPDATE semantic_actors SET name='SYNTHETIC_SECRET edited' WHERE id=1",
    )
    .await
    .unwrap();
    assert!(!db.publish_release(&stale, &stale.values).await.unwrap());
    // Complete source workers first; their replacements also invalidate any
    // derived copy assembled from the previous source revision.
    finish_export_jobs(&db).await;
    db.prepare_derived_exports("parsed", cutoff, 10)
        .await
        .unwrap();
    finish_export_jobs(&db).await;
    let protected = db.protected_reads().await.unwrap();
    let page = protected
        .release_export_page("parsed", 0, cutoff, 10)
        .await
        .unwrap();
    assert_eq!(page.rows.as_array().unwrap().len(), 1, "{page:?}");
    let row = &page.rows[0];
    assert_eq!(row["frame_id"], 1);
    assert_eq!(row["run_id"], 1);
    assert_eq!(row["items"][0]["local_id"], "stable-local-id");
    assert_eq!(row["actors"][0]["actor_id"], 1);
    assert_eq!(row["actors"][0]["name"], "[PRIVATE]");
    assert!(!row.to_string().contains("SYNTHETIC_SECRET"));
    let token = db.storage_export_token().await.unwrap();
    db.execute_raw_sql_write(
        "UPDATE semantic_run_items SET local_id='new-local-id' WHERE run_id=1",
    )
    .await
    .unwrap();
    assert!(token.admit(&db.pool).await.is_err());
    assert_eq!(
        protected
            .release_export_page("parsed", 0, cutoff, 10)
            .await
            .unwrap()
            .rows,
        serde_json::json!([])
    );
    db.prepare_derived_exports("parsed", cutoff, 10)
        .await
        .unwrap();
    finish_export_jobs(&db).await;
    let page = protected
        .release_export_page("parsed", page.sequence, cutoff, 10)
        .await
        .unwrap();
    assert_eq!(page.rows[0]["items"][0]["local_id"], "new-local-id");
    db.execute_raw_sql_write("DELETE FROM frames WHERE id=1")
        .await
        .unwrap();
    db.prepare_derived_exports("parsed", cutoff, 10)
        .await
        .unwrap();
    assert_eq!(
        protected
            .release_export_page("parsed", 0, cutoff, 10)
            .await
            .unwrap()
            .rows,
        serde_json::json!([])
    );
    protected.close().await;
    db.close().await;
}

#[tokio::test]
async fn derived_ack_retires_payloads_but_survives_restart_and_source_reversion() {
    let (root, db) = database().await;
    let cutoff = "2026-10-16T00:00:00Z";
    let original = exported_activity("SYNTHETIC_SECRET original");
    db.stage_activity_exports(&[original.clone()], cutoff)
        .await
        .unwrap();
    finish_export_jobs(&db).await;
    let protected = db.protected_reads().await.unwrap();
    let page = protected
        .release_export_page("activities", 0, cutoff, 10)
        .await
        .unwrap();
    db.acknowledge_derived_exports("activities", page.sequence)
        .await
        .unwrap();
    let copies: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _privacy_exports")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(copies, 0);
    protected.close().await;
    db.close().await;
    let db = Arc::new(
        DatabaseManager::new(
            root.path().join("db.sqlite").to_str().unwrap(),
            Default::default(),
        )
        .await
        .unwrap(),
    );
    db.configure_release(&ReleasePolicy {
        identity: "test:model-v1".into(),
        text: true,
        images: true,
    })
    .await
    .unwrap();
    db.stage_activity_exports(&[original.clone()], cutoff)
        .await
        .unwrap();
    assert!(db.activity_export_versions().await.unwrap().is_empty());
    db.stage_activity_exports(&[exported_activity("SYNTHETIC_SECRET changed")], cutoff)
        .await
        .unwrap();
    let stale = db.release_pending("exports", 1).await.unwrap().remove(0);
    // Reverting to the already acknowledged source must discard an intermediate
    // copy, not upload that now-obsolete edit or hold other streams forever.
    db.stage_activity_exports(&[original.clone()], cutoff)
        .await
        .unwrap();
    assert!(!db.publish_release(&stale, &stale.values).await.unwrap());
    assert!(db.activity_export_versions().await.unwrap().is_empty());
    db.configure_release(&ReleasePolicy {
        identity: "new-policy".into(),
        text: true,
        images: false,
    })
    .await
    .unwrap();
    db.stage_activity_exports(&[original.clone()], cutoff)
        .await
        .unwrap();
    finish_export_jobs(&db).await;
    let protected = db.protected_reads().await.unwrap();
    let page = protected
        .release_export_page("activities", page.sequence, cutoff, 10)
        .await
        .unwrap();
    assert_eq!(page.rows.as_array().unwrap().len(), 1);
    // A policy change between transport and cleanup must keep the copy pending
    // under the new policy, even if the old response was acknowledged.
    db.configure_release(&ReleasePolicy {
        identity: "policy-changed-before-cleanup".into(),
        text: true,
        images: false,
    })
    .await
    .unwrap();
    db.acknowledge_derived_exports("activities", page.sequence)
        .await
        .unwrap();
    assert_eq!(db.activity_export_versions().await.unwrap().len(), 1);
    finish_export_jobs(&db).await;
    let fresh = protected
        .release_export_page("activities", page.sequence, cutoff, 10)
        .await
        .unwrap();
    assert_eq!(fresh.rows.as_array().unwrap().len(), 1);
    db.acknowledge_derived_exports("activities", fresh.sequence)
        .await
        .unwrap();
    db.stage_activity_exports(&[], cutoff).await.unwrap();
    let markers: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM _privacy_export_sources WHERE stream='activities'",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(markers, 0);
    protected.close().await;
    db.close().await;
}

#[tokio::test]
async fn derived_hybrid_upload_copy_uses_the_same_worker_and_cleanup() {
    let root = tempfile::tempdir().unwrap();
    let db = Arc::new(
        DatabaseManager::new_hybrid(root.path(), Default::default(), Default::default())
            .await
            .unwrap(),
    );
    db.configure_release(&ReleasePolicy {
        identity: "hybrid".into(),
        text: true,
        images: false,
    })
    .await
    .unwrap();
    let cutoff = "2026-10-16T00:00:00Z";
    db.stage_activity_exports(&[exported_activity("SYNTHETIC_SECRET")], cutoff)
        .await
        .unwrap();
    finish_export_jobs(&db).await;
    let protected = db.protected_reads().await.unwrap();
    let page = protected
        .release_export_page("activities", 0, cutoff, 10)
        .await
        .unwrap();
    assert_eq!(page.rows[0]["title"], "[PRIVATE]");
    assert!(!page.rows.to_string().contains("SYNTHETIC_SECRET"));
    db.acknowledge_derived_exports("activities", page.sequence)
        .await
        .unwrap();
    assert!(db.activity_export_versions().await.unwrap().is_empty());
    protected.close().await;
    db.close().await;
}

#[tokio::test]
async fn derived_discovery_resumes_through_unparsed_history() {
    let (root, db) = database().await;
    let policy = ReleasePolicy {
        identity: "discovery".into(),
        text: true,
        images: false,
    };
    db.configure_release(&ReleasePolicy {
        text: false,
        ..policy.clone()
    })
    .await
    .unwrap();
    db.execute_raw_sql_write("INSERT INTO semantic_runs(id,input_fingerprint,parser_id,parser_version,schema_version,app_platform,input_content_hash,status) VALUES(1,zeroblob(32),'test','1',1,'macos',zeroblob(8),'handled'); INSERT INTO frames(id,timestamp,semantic_run_id) VALUES(1,'2026-10-16T10:00:00Z',NULL),(2,'2026-10-16T10:00:00Z',NULL),(3,'2026-10-16T10:00:00Z',NULL),(4,'2026-10-16T10:00:00Z',1)").await.unwrap();
    db.configure_release(&policy).await.unwrap();
    let cutoff = "2026-10-16T00:00:00Z";
    assert!(db
        .prepare_derived_exports("parsed", cutoff, 2)
        .await
        .unwrap());
    let position: i64 =
        sqlx::query_scalar("SELECT after_id FROM _privacy_export_scan WHERE stream='parsed'")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(
        position, 2,
        "ordinary frames consume discovery's scheduling budget"
    );
    assert!(db.release_pending("exports", 10).await.unwrap().is_empty());
    db.close().await;
    let db = Arc::new(
        DatabaseManager::new(
            root.path().join("db.sqlite").to_str().unwrap(),
            Default::default(),
        )
        .await
        .unwrap(),
    );
    db.configure_release(&policy).await.unwrap();
    assert!(db
        .prepare_derived_exports("parsed", cutoff, 2)
        .await
        .unwrap());
    assert!(!db
        .prepare_derived_exports("parsed", cutoff, 2)
        .await
        .unwrap());
    finish_export_jobs(&db).await;
    // Source processing can revoke the first prepared copy; its source journal
    // must preserve that revision for the next preparation turn.
    db.prepare_derived_exports("parsed", cutoff, 2)
        .await
        .unwrap();
    finish_export_jobs(&db).await;
    let protected = db.protected_reads().await.unwrap();
    let page = protected
        .release_export_page("parsed", 0, cutoff, 10)
        .await
        .unwrap();
    assert_eq!(page.rows.as_array().unwrap().len(), 1);
    assert_eq!(page.rows[0]["frame_id"], 4);
    protected.close().await;
    db.close().await;
}

#[tokio::test]
#[ignore = "manual paired capture-write microbenchmark; run without compiler workloads"]
async fn derived_capture_journal_benchmark() {
    // The only difference in each pair is the new source-journal triggers.
    // This measures single-frame DB writes, not detector or desktop performance.
    for (label, text, parsed) in [
        ("disabled/plain", false, false),
        ("enabled/plain", true, false),
        ("enabled/parsed", true, true),
    ] {
        for run in 0..3 {
            for journal in [run % 2 == 0, run % 2 != 0] {
                let (_root, db) = database().await;
                db.configure_release(&ReleasePolicy {
                    identity: "bench".into(),
                    text,
                    images: false,
                })
                .await
                .unwrap();
                if parsed {
                    db.execute_raw_sql_write("INSERT INTO semantic_runs(id,input_fingerprint,parser_id,parser_version,schema_version,app_platform,input_content_hash,status) VALUES(1,zeroblob(32),'bench','1',1,'macos',zeroblob(8),'handled')").await.unwrap();
                }
                if !journal {
                    let triggers:Vec<String>=sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB 'privacy_export_*'").fetch_all(&db.pool).await.unwrap();
                    for trigger in triggers {
                        db.execute_raw_sql_write(&format!("DROP TRIGGER {trigger}"))
                            .await
                            .unwrap();
                    }
                }
                let query=format!("INSERT INTO frames(timestamp,full_text,semantic_run_id) VALUES('2026-10-16T10:00:00Z','synthetic capture',{})",if parsed {"1"}else{"NULL"});
                let mut times = Vec::new();
                for _ in 0..1000 {
                    let start = std::time::Instant::now();
                    db.execute_raw_sql_write(&query).await.unwrap();
                    times.push(start.elapsed().as_secs_f64() * 1000.0);
                }
                times.sort_by(f64::total_cmp);
                println!("DERIVED_CAPTURE case={label} run={run} journal={journal} samples={} p50_ms={:.3} p95_ms={:.3} p99_ms={:.3}",times.len(),times[500],times[950],times[990]);
                db.close().await;
            }
        }
    }
}

#[tokio::test]
async fn compact_receipts_preserve_identity_timestamp_edits_and_policy_cycles() {
    let (_root, db) = database().await;
    let identity = "remote-policy".repeat(500);
    let policy = ReleasePolicy {
        identity: identity.clone(),
        text: true,
        images: false,
    };
    db.configure_release(&policy).await.unwrap();
    db.execute_raw_sql_write("INSERT INTO frames(id,timestamp,full_text,accessibility_tree_json) VALUES(1,'2026-10-14T10:00:00Z','safe','[{\"role\":\"button\",\"text\":\"safe\"}]')").await.unwrap();
    let job = db.release_pending("frames", 1).await.unwrap().remove(0);
    assert_eq!(job.policy, identity);
    assert!(db.publish_release(&job, &job.values).await.unwrap());
    let key: String =
        sqlx::query_scalar("SELECT policy FROM _privacy_release WHERE kind='frames' AND id='1'")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert!(key.parse::<i64>().is_ok());
    assert_eq!(db.release_policy().await.unwrap(), policy);
    let read = db.protected_reads().await.unwrap();
    let page = read
        .release_export_page("frames", 0, "2026-01-01T00:00:00Z", 50)
        .await
        .unwrap();
    assert_eq!(page.rows[0]["accessibility_tree"][0]["role"], "button");
    db.execute_raw_sql_write("UPDATE frames SET timestamp='2026-10-15T10:00:00Z' WHERE id=1")
        .await
        .unwrap();
    assert!(!db.release_ready("frames", "1").await.unwrap());
    let job = db.release_pending("frames", 1).await.unwrap().remove(0);
    assert!(db.publish_release(&job, &job.values).await.unwrap());
    let timestamp: String = sqlx::query_scalar("SELECT timestamp FROM frames WHERE id=1")
        .fetch_one(&read.pool)
        .await
        .unwrap();
    assert_eq!(timestamp, "2026-10-15T10:00:00Z");
    db.configure_release(&ReleasePolicy {
        identity: "another".into(),
        ..policy.clone()
    })
    .await
    .unwrap();
    db.configure_release(&policy).await.unwrap();
    assert!(
        !db.release_ready("frames", "1").await.unwrap(),
        "returning to an identity must not resurrect a prior generation"
    );
    read.close().await;
    db.close().await;
}

#[tokio::test]
async fn model_windows_yield_without_releasing_partial_text_and_restart_recovers() {
    struct Windowed;
    struct Session {
        remaining: u32,
        text: String,
    }
    #[async_trait::async_trait]
    impl screenpipe_redact::RequiredRedaction for Session {
        async fn step(
            &mut self,
        ) -> Result<Option<screenpipe_redact::RedactionOutput>, screenpipe_redact::RedactError>
        {
            self.remaining -= 1;
            Ok(
                (self.remaining == 0).then(|| screenpipe_redact::RedactionOutput {
                    evidence: None,
                    input: self.text.clone(),
                    redacted: self.text.replace("PRIVATE", "safe"),
                    spans: vec![],
                }),
            )
        }
    }
    #[async_trait::async_trait]
    impl Redactor for Windowed {
        fn name(&self) -> &str {
            "windowed"
        }
        fn version(&self) -> u32 {
            1
        }
        fn provides_model_detection(&self) -> bool {
            true
        }
        fn required_session(
            self: Arc<Self>,
            text: String,
        ) -> Box<dyn screenpipe_redact::RequiredRedaction> {
            Box::new(Session { remaining: 3, text })
        }
        async fn redact_batch(
            &self,
            _: &[String],
        ) -> Result<Vec<screenpipe_redact::RedactionOutput>, screenpipe_redact::RedactError>
        {
            panic!("worker must use resumable detector")
        }
    }
    let (root, db) = database().await;
    db.execute_raw_sql_write("INSERT INTO frames(id,timestamp,full_text) VALUES(1,'2026-10-14T10:00:00Z','PRIVATE first and PRIVATE tail')").await.unwrap();
    let make_worker = |db: Arc<DatabaseManager>| {
        screenpipe_redact::worker::Worker::new_with_writer(
            db.pool.clone(),
            db.coordinated_writer(),
            Arc::new(Pipeline::regex_then_ai(
                Arc::new(Windowed),
                Default::default(),
            )),
            screenpipe_redact::worker::WorkerConfig {
                target_batch_duration: std::time::Duration::ZERO,
                ..Default::default()
            },
        )
        .with_frame_storage(db)
    };
    let worker = make_worker(db.clone());
    assert_eq!(worker.process_release_batch(1).await.unwrap(), 0);
    assert!(!db.release_ready("frames", "1").await.unwrap());
    db.execute_raw_sql_write("INSERT INTO frames(id,timestamp,full_text) VALUES(2,'2026-10-14T10:01:00Z','PRIVATE during backlog')").await.unwrap();
    drop(worker);
    db.close().await;
    let db = Arc::new(
        DatabaseManager::new(
            root.path().join("db.sqlite").to_str().unwrap(),
            Default::default(),
        )
        .await
        .unwrap(),
    );
    db.configure_release(&ReleasePolicy {
        identity: "test:model-v1".into(),
        text: true,
        images: true,
    })
    .await
    .unwrap();
    let worker = make_worker(db.clone());
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        while !db.release_ready("frames", "1").await.unwrap()
            || !db.release_ready("frames", "2").await.unwrap()
        {
            worker.process_release_batch(1).await.unwrap();
        }
    })
    .await
    .unwrap();
    let texts: Vec<String> = sqlx::query_scalar("SELECT full_text FROM frames ORDER BY id")
        .fetch_all(&db.pool)
        .await
        .unwrap();
    assert_eq!(texts, ["safe first and safe tail", "safe during backlog"]);
    db.close().await;
}

#[tokio::test]
async fn legacy_receipt_identity_migration_preserves_current_completions() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("db.sqlite");
    let db = Arc::new(
        DatabaseManager::new(path.to_str().unwrap(), Default::default())
            .await
            .unwrap(),
    );
    // Reproduce the draft's on-disk schema, including a current and an old receipt.
    db.execute_raw_sql_write("INSERT INTO frames(id,timestamp,full_text) VALUES(1,'2026-10-16T00:00:00Z','processed'),(2,'2026-10-16T00:01:00Z','pending new policy');
CREATE TABLE _privacy_policy(id INTEGER PRIMARY KEY CHECK(id=1),identity TEXT NOT NULL,text_required INTEGER NOT NULL,image_required INTEGER NOT NULL,epoch INTEGER NOT NULL DEFAULT 0,revocation INTEGER NOT NULL DEFAULT 0);
INSERT INTO _privacy_policy VALUES(1,'current',1,0,5,3);
CREATE TABLE _privacy_release(kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,policy TEXT,attempts INTEGER NOT NULL DEFAULT 0,retry_at INTEGER,PRIMARY KEY(kind,id));
INSERT INTO _privacy_release(kind,id,revision,policy) VALUES('frames','1',4,'current'),('frames','2',2,'superseded');
CREATE TABLE _privacy_ready(sequence INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,policy TEXT NOT NULL);
INSERT INTO _privacy_ready(kind,id,revision,policy) VALUES('frames','1',4,'current'),('frames','2',2,'superseded');").await.unwrap();
    let policy = ReleasePolicy {
        identity: "current".into(),
        text: true,
        images: false,
    };
    db.configure_release(&policy).await.unwrap();
    assert!(db.release_ready("frames", "1").await.unwrap());
    assert!(!db.release_ready("frames", "2").await.unwrap());
    let changes = db.ready_changes(0, 10).await.unwrap();
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0].id, "1");
    assert_eq!(changes[0].revision, 4);
    let pending = db.release_pending("frames", 10).await.unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].id, "2");
    db.close().await;
    let db = Arc::new(
        DatabaseManager::new(path.to_str().unwrap(), Default::default())
            .await
            .unwrap(),
    );
    db.configure_release(&policy).await.unwrap();
    assert!(db.release_ready("frames", "1").await.unwrap());
    assert_eq!(
        db.ready_changes(0, 10).await.unwrap()[0].sequence,
        changes[0].sequence
    );
    db.close().await;
}

#[tokio::test]
async fn local_derived_views_preserve_sources_structure_and_recover_after_restart() {
    for hybrid in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let open = || async {
            Arc::new(if hybrid {
                DatabaseManager::new_hybrid(root.path(), Default::default(), Default::default())
                    .await
                    .unwrap()
            } else {
                DatabaseManager::new(
                    root.path().join("local.sqlite").to_str().unwrap(),
                    Default::default(),
                )
                .await
                .unwrap()
            })
        };
        let db = open().await;
        let policy = ReleasePolicy {
            identity: "local-v1".into(),
            text: true,
            images: false,
        };
        db.configure_release(&policy).await.unwrap();
        db.execute_raw_sql_write(r#"
INSERT INTO meetings(id,meeting_start,meeting_app,title,attendees,note) VALUES(1,'2020-01-01T00:00:00Z','SYNTHETIC_SECRET','SYNTHETIC_SECRET','SYNTHETIC_SECRET','SYNTHETIC_SECRET');
INSERT INTO speakers(id,name,metadata) VALUES(1,'SYNTHETIC_SECRET','{"nested":["SYNTHETIC_SECRET",7,true]}');
INSERT INTO semantic_actors(id,name) VALUES(1,'SYNTHETIC_SECRET');
INSERT INTO semantic_actor_aliases(id,actor_id,source_key,source_label,normalized_label,observed_label) VALUES(1,1,'SYNTHETIC_SECRET','SYNTHETIC_SECRET','SYNTHETIC_SECRET','SYNTHETIC_SECRET');
INSERT INTO outputs(id,source,title,original_path,output_path,preview,metadata) VALUES(1,'SYNTHETIC_SECRET','SYNTHETIC_SECRET','/SYNTHETIC_SECRET/original','/SYNTHETIC_SECRET/output','SYNTHETIC_SECRET','{"nested":["SYNTHETIC_SECRET",7,true]}');
INSERT INTO feedback(id,target_kind,target_id,actor_id,rating,comment,snapshot,context,created_at,updated_at) VALUES('one','activity','stable-id','actor-id','up','SYNTHETIC_SECRET','{"nested":["SYNTHETIC_SECRET",7,true]}','{"nested":["SYNTHETIC_SECRET",7,true]}','2020-01-01T00:00:00Z','2020-01-01T00:00:00Z');
INSERT INTO pipe_executions(id,pipe_name,stdout,stderr,error_message,session_path,trigger_event,trigger_key) VALUES(1,'SYNTHETIC_SECRET','SYNTHETIC_SECRET','SYNTHETIC_SECRET','SYNTHETIC_SECRET','/SYNTHETIC_SECRET/session','{"nested":["SYNTHETIC_SECRET",7,true]}','SYNTHETIC_SECRET');
"#).await.unwrap();
        let tables = [
            "meetings",
            "speakers",
            "semantic_actors",
            "semantic_actor_aliases",
            "outputs",
            "feedback",
            "pipe_executions",
        ];
        let protected = db.protected_reads().await.unwrap();
        for table in tables {
            let rows = sqlx::query(sqlx::AssertSqlSafe(format!("SELECT * FROM {table}")))
                .fetch_all(&protected.pool)
                .await
                .unwrap();
            assert_eq!(rows.len(), 1, "pending {table} must retain identity");
        }
        let title: Option<String> = sqlx::query_scalar("SELECT title FROM meetings WHERE id=1")
            .fetch_one(&protected.pool)
            .await
            .unwrap();
        assert_eq!(title, None);
        // Leave accepted local work pending and resume through a new worker/DB.
        db.prepare_derived_exports("local_meetings", "", 1)
            .await
            .unwrap();
        protected.close().await;
        db.close().await;
        drop(protected);
        drop(db);
        let db = Arc::new(
            DatabaseManager::new(
                root.path()
                    .join(if hybrid { "db.sqlite" } else { "local.sqlite" })
                    .to_str()
                    .unwrap(),
                Default::default(),
            )
            .await
            .unwrap(),
        );
        db.configure_release(&policy).await.unwrap();
        let worker = screenpipe_redact::worker::Worker::new_with_writer(
            db.pool.clone(),
            db.coordinated_writer(),
            Arc::new(CountingDetector {
                calls: Arc::new(Default::default()),
                fail: Arc::new(Default::default()),
                delay: Default::default(),
            }),
            Default::default(),
        )
        .with_frame_storage(db.clone());
        tokio::time::timeout(std::time::Duration::from_secs(20), async {
            loop {
                worker.process_release_batch(8).await.unwrap();
                let status = db.release_queue_status().await.unwrap();
                if status
                    .surfaces
                    .iter()
                    .filter(|s| s.kind.starts_with("local_") || s.kind == "exports")
                    .all(|s| !s.discovering && s.pending == 0)
                {
                    break;
                }
            }
        })
        .await
        .unwrap();
        let protected = db.protected_reads().await.unwrap();
        for (table, column) in [
            ("meetings", "meeting_app"),
            ("speakers", "name"),
            ("semantic_actors", "name"),
            ("semantic_actor_aliases", "source_key"),
            ("outputs", "output_path"),
            ("feedback", "comment"),
            ("pipe_executions", "stdout"),
        ] {
            let safe: String =
                sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT {column} FROM {table}")))
                    .fetch_one(&protected.pool)
                    .await
                    .unwrap();
            assert_eq!(safe, "[PRIVATE]", "{table}");
            let raw: String =
                sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT {column} FROM {table}")))
                    .fetch_one(&db.pool)
                    .await
                    .unwrap();
            assert!(raw.contains("SYNTHETIC_SECRET"), "source {table} changed");
        }
        for (table, column) in [
            ("speakers", "metadata"),
            ("outputs", "metadata"),
            ("feedback", "context"),
            ("pipe_executions", "trigger_event"),
        ] {
            let json: String =
                sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT {column} FROM {table}")))
                    .fetch_one(&protected.pool)
                    .await
                    .unwrap();
            let value: serde_json::Value = serde_json::from_str(&json).unwrap();
            assert_eq!(
                value,
                serde_json::json!({"nested":["[PRIVATE]",7,true]}),
                "{table}"
            );
        }
        db.execute_raw_sql_write("INSERT INTO meetings(meeting_start,meeting_end,meeting_app,title) VALUES('2020-01-01T12:00:00Z','2020-01-01T13:00:00Z','SYNTHETIC_SECRET','SYNTHETIC_SECRET')").await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(20), async {
            loop {
                worker.process_release_batch(8).await.unwrap();
                let title: Option<String> =
                    sqlx::query_scalar("SELECT title FROM meetings WHERE id=2")
                        .fetch_one(&protected.pool)
                        .await
                        .unwrap();
                if title.as_deref() == Some("[PRIVATE]") {
                    break;
                }
            }
        })
        .await
        .unwrap();
        let token = db.storage_export_token().await.unwrap();
        db.execute_raw_sql_write(
            "UPDATE semantic_actor_aliases SET source_key='SYNTHETIC_SECRET edited' WHERE id=1",
        )
        .await
        .unwrap();
        assert!(token.admit(&db.pool).await.is_err());
        let pending: String =
            sqlx::query_scalar("SELECT source_key FROM semantic_actor_aliases WHERE id=1")
                .fetch_one(&protected.pool)
                .await
                .unwrap();
        assert_eq!(pending, "Privacy processing");
        db.configure_release(&ReleasePolicy {
            identity: "local-v2".into(),
            ..policy
        })
        .await
        .unwrap();
        let pending: Option<String> = sqlx::query_scalar("SELECT title FROM meetings WHERE id=1")
            .fetch_one(&protected.pool)
            .await
            .unwrap();
        assert_eq!(pending, None);
        protected.close().await;
        db.close().await;
    }
}

#[tokio::test]
async fn historical_replay_restages_acknowledged_copies_and_waits_only_for_requested_range() {
    let (root, db) = database().await;
    let start = "2020-01-01T00:00:00Z";
    let end = "2020-01-02T00:00:00Z";
    let streams = vec!["frames".into(), "feedback".into()];
    db.execute_raw_sql_write("INSERT INTO frames(id,timestamp,full_text) VALUES(1,'2020-01-01T12:00:00Z','SYNTHETIC_SECRET'),(2,'2020-01-03T12:00:00Z','outside'); INSERT INTO feedback(id,target_kind,target_id,actor_id,rating,comment,created_at,updated_at) VALUES('one','activity','stable','actor','up','SYNTHETIC_SECRET','2020-01-01T12:00:00Z','2020-01-01T12:00:00Z')").await.unwrap();
    db.prepare_derived_exports("feedback", start, 10)
        .await
        .unwrap();
    // Certify the old ordinary-upload copy, then retire it as a normal ack does.
    for job in db.release_pending("exports", 10).await.unwrap() {
        db.publish_release(&job, &job.values).await.unwrap();
    }
    let protected = db.protected_reads().await.unwrap();
    let page = protected
        .release_export_page("feedback", 0, start, 10)
        .await
        .unwrap();
    db.acknowledge_derived_exports("feedback", page.sequence)
        .await
        .unwrap();
    assert!(protected
        .release_export_page("feedback", 0, start, 10)
        .await
        .unwrap()
        .rows
        .as_array()
        .unwrap()
        .is_empty());
    assert!(db
        .prepare_release_replay("request-one", &streams, start, end, 1)
        .await
        .unwrap());
    protected.close().await;
    db.close().await;
    drop(protected);
    drop(db);
    let db = Arc::new(
        DatabaseManager::new(
            root.path().join("db.sqlite").to_str().unwrap(),
            Default::default(),
        )
        .await
        .unwrap(),
    );
    assert!(db
        .prepare_release_replay("request-one", &streams, start, end, 1)
        .await
        .unwrap());
    for kind in ["frames", "exports"] {
        for job in db.release_pending(kind, 10).await.unwrap() {
            if kind == "frames" && job.id == "2" {
                continue;
            }
            let values = job
                .values
                .iter()
                .map(|(k, v)| {
                    (
                        k.clone(),
                        v.as_ref()
                            .map(|s| s.replace("SYNTHETIC_SECRET", "[PRIVATE]")),
                    )
                })
                .collect();
            db.publish_release(&job, &values).await.unwrap();
        }
    }
    assert!(!db
        .prepare_release_replay("request-one", &streams, start, end, 10)
        .await
        .unwrap());
    assert!(
        !db.release_ready("frames", "2").await.unwrap(),
        "unrelated pending work must not strand replay"
    );
    let protected = db.protected_reads().await.unwrap();
    let page = protected
        .release_export_page("feedback", 0, start, 10)
        .await
        .unwrap();
    assert_eq!(page.rows[0]["comment"], "[PRIVATE]");
    let frames = protected
        .release_export_range_page("frames", 0, start, Some(end), 10)
        .await
        .unwrap();
    assert_eq!(frames.rows.as_array().unwrap().len(), 1);
    let mut after = std::collections::BTreeMap::from([
        ("frames".to_string(), frames.sequence),
        ("feedback".to_string(), page.sequence),
    ]);
    assert!(!db
        .release_replay_pending("request-one", &streams, start, end, Some(&after))
        .await
        .unwrap());
    db.execute_raw_sql_write(
        "INSERT INTO frames(id,timestamp,full_text) VALUES(4,'2020-01-01T14:00:00Z','late source')",
    )
    .await
    .unwrap();
    let job = db
        .release_pending("frames", 10)
        .await
        .unwrap()
        .into_iter()
        .find(|j| j.id == "4")
        .unwrap();
    db.publish_release(&job, &job.values).await.unwrap();
    assert!(
        db.release_replay_pending("request-one", &streams, start, end, Some(&after))
            .await
            .unwrap(),
        "a completion after page selection must keep replay pending"
    );
    let late = protected
        .release_export_range_page("frames", frames.sequence, start, Some(end), 10)
        .await
        .unwrap();
    assert_eq!(late.rows[0]["frame_id"], 4);
    after.insert("frames".to_string(), late.sequence);
    assert!(!db
        .release_replay_pending("request-one", &streams, start, end, Some(&after))
        .await
        .unwrap());
    db.acknowledge_derived_exports("feedback", page.sequence)
        .await
        .unwrap();
    assert_eq!(
        protected
            .release_export_page("feedback", 0, start, 10)
            .await
            .unwrap()
            .rows
            .as_array()
            .unwrap()
            .len(),
        1,
        "normal sync must retain an active replay's copies"
    );
    db.finish_release_replay("request-one").await.unwrap();
    db.acknowledge_derived_exports("feedback", page.sequence)
        .await
        .unwrap();
    assert!(protected
        .release_export_page("feedback", 0, start, 10)
        .await
        .unwrap()
        .rows
        .as_array()
        .unwrap()
        .is_empty());
    protected.close().await;
    db.close().await;
}

#[tokio::test]
async fn insert_trigger_upgrade_rediscovers_generated_ids_missed_after_completed_scan() {
    let (_root, db) = database().await;
    db.prepare_derived_exports("local_meetings", "", 1)
        .await
        .unwrap();
    let sql: String = sqlx::query_scalar(
        "SELECT sql FROM sqlite_master WHERE name='privacy_local_meetings_INSERT'",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    let old = sql.replace(" AFTER INSERT ", " BEFORE INSERT ");
    assert_ne!(sql, old);
    db.execute_raw_sql_write(&format!(
        "DROP TRIGGER privacy_local_meetings_INSERT; {old}"
    ))
    .await
    .unwrap();
    db.execute_raw_sql_write("INSERT INTO meetings(meeting_start,meeting_end,meeting_app,title) VALUES('2020-01-01T12:00:00Z','2020-01-01T13:00:00Z','SYNTHETIC_SECRET','SYNTHETIC_SECRET')").await.unwrap();
    db.prepare_derived_exports("local_meetings", "", 1)
        .await
        .unwrap();
    let missed: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM _privacy_exports WHERE stream='local_meetings'")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(
        missed, 0,
        "the old trigger's generated-ID failure must be reproduced"
    );
    db.configure_release(&ReleasePolicy {
        identity: "test:model-v1".into(),
        text: true,
        images: true,
    })
    .await
    .unwrap();
    db.prepare_derived_exports("local_meetings", "", 1)
        .await
        .unwrap();
    finish_export_jobs(&db).await;
    let protected = db.protected_reads().await.unwrap();
    let title: String = sqlx::query_scalar("SELECT title FROM meetings WHERE id=1")
        .fetch_one(&protected.pool)
        .await
        .unwrap();
    assert_eq!(title, "[PRIVATE]");
    protected.close().await;
    db.close().await;
}

#[tokio::test]
async fn local_json_scalars_preserve_types_and_distinguish_sql_null() {
    let (_root, db) = database().await;
    db.execute_raw_sql_write("INSERT INTO feedback(id,target_kind,target_id,actor_id,rating,context,created_at,updated_at) VALUES('one','activity','stable','actor','up','null','2020-01-01T00:00:00Z','2020-01-01T00:00:00Z')").await.unwrap();
    let protected = db.protected_reads().await.unwrap();
    for (source, expected) in [
        ("null", "null"),
        ("7", "7"),
        ("true", "true"),
        ("\"SYNTHETIC_SECRET\"", "\"[PRIVATE]\""),
    ] {
        db.execute_raw_sql_write(&format!(
            "UPDATE feedback SET context='{source}' WHERE id='one'"
        ))
        .await
        .unwrap();
        db.prepare_derived_exports("local_feedback", "", 1)
            .await
            .unwrap();
        finish_export_jobs(&db).await;
        let (context, snapshot): (String, Option<String>) =
            sqlx::query_as("SELECT context,snapshot FROM feedback WHERE id='one'")
                .fetch_one(&protected.pool)
                .await
                .unwrap();
        assert_eq!(context, expected);
        assert_eq!(snapshot, None);
    }
    protected.close().await;
    db.close().await;
}

#[tokio::test]
async fn redaction_status_distinguishes_watermarks_from_current_receipts() {
    let (_root, db) = database().await;
    db.execute_raw_sql_write("INSERT INTO frames(id,timestamp,full_text,window_name,window_name_redacted_at) VALUES(91,'2026-10-27T10:00:00Z','test raw text','test title',123)").await.unwrap();
    let pending = db.frame_redaction_status(91).await.unwrap();
    assert_eq!(pending["fields"]["window_name"]["processed_at"], 123);
    assert!(pending["fields"]["window_name"]["method"].is_null());
    assert!(pending["fields"]["window_name"]["result"].is_null());
    assert!(pending["fields"]["full_text"]["processed"].is_null());
    assert_eq!(pending["receipts"]["frames"]["complete"], false);
    assert!(pending["receipts"]["frames"]["completed_at"].is_null());
    let job = db.release_pending("frames", 10).await.unwrap().remove(0);
    assert!(db.publish_release(&job, &job.values).await.unwrap());
    let complete = db.frame_redaction_status(91).await.unwrap();
    assert_eq!(complete["receipts"]["frames"]["complete"], true);
    assert!(
        complete["receipts"]["frames"]["completed_at"]
            .as_i64()
            .unwrap()
            > 123
    );
    assert_eq!(complete["receipts"]["image"]["complete"], false);
    db.execute_raw_sql_write("UPDATE frames SET full_text='new source' WHERE id=91")
        .await
        .unwrap();
    let stale = db.frame_redaction_status(91).await.unwrap();
    assert_eq!(stale["receipts"]["frames"]["complete"], false);
    assert!(stale["receipts"]["frames"]["completed_at"].is_null());
    assert!(!db.publish_release(&job, &job.values).await.unwrap());
    db.close().await;
}

#[tokio::test]
async fn redaction_status_before_policy_configuration_does_not_invent_history() {
    let root = tempfile::tempdir().unwrap();
    let db = DatabaseManager::new(
        root.path().join("db.sqlite").to_str().unwrap(),
        Default::default(),
    )
    .await
    .unwrap();
    db.execute_raw_sql_write("INSERT INTO frames(id,timestamp,full_text) VALUES(17,'2026-10-27T10:00:00Z','legacy content')").await.unwrap();
    let status = db.frame_redaction_status(17).await.unwrap();
    assert_eq!(status["receipts"], serde_json::json!({}));
    assert!(status["fields"]["full_text"]["processed"].is_null());
    assert!(db.frame_redaction_status(999).await.unwrap().is_null());
    db.close().await;
}
