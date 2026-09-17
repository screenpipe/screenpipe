// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use screenpipe_db::storage::{MigrationOptions, PrivacyPolicy, Projection};
use screenpipe_db::DatabaseManager;

async fn number(db: &DatabaseManager, sql: &str) -> i64 {
    sqlx::query_scalar(sqlx::AssertSqlSafe(sql.to_owned()))
        .fetch_one(&db.pool)
        .await
        .unwrap()
}

fn private_options() -> MigrationOptions {
    let mut options = MigrationOptions::default();
    options.budget.record_bytes = 1024;
    options.budget.staging_bytes = 1024;
    options.privacy = PrivacyPolicy {
        identity: "private".into(),
        required_surfaces: 1,
    };
    options
}

async fn record(db: &DatabaseManager, text: &str) -> i64 {
    // Exercise the same queue/commit acknowledgement used by paired_capture.
    db.insert_snapshot_frame(
        "display",
        chrono::Utc::now(),
        "",
        Some("Editor"),
        None,
        None,
        true,
        Some("test"),
        Some(text),
        Some("accessibility"),
        None,
        None,
        None,
    )
    .await
    .unwrap()
}

async fn reopen(root: &std::path::Path) -> DatabaseManager {
    DatabaseManager::new(root.join("db.sqlite").to_str().unwrap(), Default::default())
        .await
        .unwrap()
}

#[tokio::test]
async fn blocked_old_element_range_does_not_starve_later_private_work() {
    let root = tempfile::tempdir().unwrap();
    let options = MigrationOptions {
        privacy: PrivacyPolicy {
            identity: "private".into(),
            required_surfaces: 1,
        },
        ..Default::default()
    };
    let db = DatabaseManager::new_hybrid(root.path(), Default::default(), options)
        .await
        .unwrap();
    db.execute_raw_sql_write("INSERT INTO frames(id,timestamp,full_text) VALUES(1,'2026-09-17','private'); INSERT INTO elements(id,frame_id,source,role,text,redacted_at) VALUES(1,1,'accessibility','AXText','first',1),(2,1,'accessibility','AXText','second',1);").await.unwrap();
    assert_eq!(db.seal_payloads().await.unwrap(), 2);
    db.execute_raw_sql_write("UPDATE elements SET text='private again',redacted_at=NULL WHERE id=2; UPDATE elements SET text='safe' WHERE id=1; INSERT INTO elements(id,frame_id,source,role,text,redacted_at) VALUES(3,1,'accessibility','AXText','later safe',1);").await.unwrap();
    assert_eq!(db.seal_payloads().await.unwrap(), 1);
    assert_eq!(
        number(
            &db,
            "SELECT count(*) FROM _bulk_element_rows WHERE id IN (1,2)"
        )
        .await,
        2
    );
    assert_eq!(
        number(&db, "SELECT count(*) FROM _bulk_element_rows WHERE id=3").await,
        0
    );
    assert_eq!(db.seal_payloads().await.unwrap(), 0);
    // The blocked range becomes eligible normally after redaction, without
    // losing either the edits or the independently archived newer record.
    db.execute_raw_sql_write("UPDATE elements SET text='now safe',redacted_at=1 WHERE id=2;")
        .await
        .unwrap();
    assert_eq!(db.seal_payloads().await.unwrap(), 2);
    assert_eq!(number(&db, "SELECT count(*) FROM elements").await, 3);
    assert_eq!(
        number(
            &db,
            "SELECT count(*) FROM elements WHERE text IN ('safe','now safe','later safe')"
        )
        .await,
        3
    );
    assert_eq!(
        number(
            &db,
            "SELECT completed_surfaces FROM frame_payloads WHERE frame_id=1"
        )
        .await
            & 1,
        0
    );
    db.verify_storage().await.unwrap();
    db.close().await;
}

#[tokio::test]
async fn recording_and_growing_redaction_survive_a_full_backlog_and_reopen() {
    let root = tempfile::tempdir().unwrap();
    let db = DatabaseManager::new_hybrid(root.path(), Default::default(), private_options())
        .await
        .unwrap();
    let mut ids = Vec::new();
    for i in 0..32 {
        ids.push(record(&db, &format!("capture {i} {}", "x".repeat(128))).await);
    }
    assert!(
        number(
            &db,
            "SELECT staging_bytes>staging_limit FROM storage_metadata"
        )
        .await
            != 0
    );
    // Privacy is deliberately pending: no archiver can drain these records.
    assert_eq!(db.seal_payloads().await.unwrap(), 0);
    db.execute_raw_sql_write("INSERT INTO ui_events(id,timestamp,event_type,text_content) VALUES(1,'2026-09-17','text','pending'); INSERT INTO pipe_executions(id,pipe_name,status,stdout) VALUES(1,'test','running','output'); INSERT INTO pipe_executions(id,pipe_name,status) VALUES(2,'test','running');").await.unwrap();
    let mut payload = db
        .frame_payloads(&[ids[0]], Projection::All)
        .await
        .unwrap()
        .remove(&ids[0])
        .unwrap();
    // Replacement tokens can be longer than the original PII. They must save.
    payload.full_text = Some("redacted ".repeat(60));
    assert!(db
        .replace_frame_payload(&payload, "private", 1, None, None)
        .await
        .unwrap());
    // Stale replacements must still fail the generation check.
    assert!(!db
        .replace_frame_payload(&payload, "private", 1, None, None)
        .await
        .unwrap());
    db.execute_raw_sql_write("UPDATE ui_events SET text_content='a longer redacted replacement',redacted_at=1 WHERE id=1; UPDATE pipe_executions SET stdout='longer completed output',status='completed',finished_at='2026-09-17' WHERE id=1;").await.unwrap();
    let before = db.frame_payloads(&ids, Projection::All).await.unwrap();
    let bytes = number(&db, "SELECT staging_bytes FROM storage_metadata").await;
    db.close().await;

    let db = reopen(root.path()).await;
    assert_eq!(
        db.frame_payloads(&ids, Projection::All).await.unwrap(),
        before
    );
    assert_eq!(
        number(&db, "SELECT staging_bytes FROM storage_metadata").await,
        bytes
    );
    assert_eq!(
        number(
            &db,
            "SELECT count(*) FROM frames_fts WHERE frames_fts MATCH 'capture'"
        )
        .await,
        31
    );
    record(&db, "recording after restart").await;
    while db.seal_payloads().await.unwrap() != 0 {}
    // Redaction eligibility is preserved; the remaining captures stay resident.
    assert_eq!(
        number(
            &db,
            "SELECT count(*) FROM frame_payloads WHERE state='sealed'"
        )
        .await,
        1
    );
    // Editing an archived field restages bytes and must work above the old cap.
    db.execute_raw_sql_write(
        "UPDATE ui_events SET text_content='updated archived content' WHERE id=1",
    )
    .await
    .unwrap();
    let archived = db
        .frame_payloads(&[ids[0]], Projection::All)
        .await
        .unwrap()
        .remove(&ids[0])
        .unwrap();
    assert!(db
        .replace_frame_payload(&archived, "private", 1, None, None)
        .await
        .unwrap());
    db.set_frame_privacy_policy(&PrivacyPolicy::default())
        .await
        .unwrap();
    while db.seal_payloads().await.unwrap() != 0 {}
    assert_eq!(
        number(&db, "SELECT staging_bytes FROM storage_metadata").await,
        0
    );
    assert_eq!(number(&db, "SELECT count(*) FROM frames").await, 33);
    assert_eq!(
        number(&db, "SELECT staging_limit FROM storage_metadata").await,
        1024
    );
    db.verify_storage().await.unwrap();
    db.close().await;
}

#[tokio::test]
async fn oversized_capture_and_bulk_payloads_remain_durable_and_searchable() {
    let root = tempfile::tempdir().unwrap();
    let db = DatabaseManager::new_hybrid(root.path(), Default::default(), private_options())
        .await
        .unwrap();
    let oversized = "oversized 東京 ".repeat(200);
    let frame = record(&db, &oversized).await;
    let audio = db.insert_audio_chunk("test.wav", None).await.unwrap();
    let mut tx = db.begin_immediate_with_retry().await.unwrap();
    sqlx::query("INSERT INTO audio_transcriptions(audio_chunk_id,transcription,offset_index,timestamp,device,is_input_device) VALUES(?,?,0,'2026-09-17','mic',1)")
        .bind(audio).bind(&oversized).execute(&mut **tx.conn()).await.unwrap();
    sqlx::query(
        "INSERT INTO elements(id,frame_id,source,role,text) VALUES(1,?,'accessibility','AXText',?)",
    )
    .bind(frame)
    .bind(&oversized)
    .execute(&mut **tx.conn())
    .await
    .unwrap();
    for query in [
        "INSERT INTO ui_events(id,timestamp,event_type,text_content) VALUES(1,'2026-09-17','text',?)",
        "INSERT INTO pipe_executions(id,pipe_name,status,stdout) VALUES(1,'test','running',?)",
    ] {
        sqlx::query(sqlx::AssertSqlSafe(query)).bind(&oversized).execute(&mut **tx.conn()).await.unwrap();
    }
    tx.commit().await.unwrap();
    let mut payload = db
        .frame_payloads(&[frame], Projection::All)
        .await
        .unwrap()
        .remove(&frame)
        .unwrap();
    payload.full_text = Some(format!("{} extra", oversized));
    assert!(db
        .replace_frame_payload(&payload, "private", 1, None, None)
        .await
        .unwrap());
    db.execute_raw_sql_write("UPDATE elements SET text=text||' extra' WHERE id=1; UPDATE ui_events SET text_content=text_content||' extra' WHERE id=1;").await.unwrap();
    db.set_frame_privacy_policy(&PrivacyPolicy::default())
        .await
        .unwrap();
    let later = record(&db, "later eligible capture").await;
    while db.seal_payloads().await.unwrap() != 0 {}
    assert_eq!(
        number(
            &db,
            "SELECT count(*) FROM frame_payloads WHERE state='sealed'"
        )
        .await,
        1
    );
    assert_eq!(
        number(&db, "SELECT count(*) FROM _bulk_element_rows WHERE id=1").await,
        1
    );
    let queries = [
        "SELECT transcription FROM audio_transcriptions",
        "SELECT text FROM elements",
        "SELECT text_content FROM ui_events",
        "SELECT stdout FROM pipe_executions",
    ];
    let mut expected = Vec::new();
    for query in queries {
        expected.push(db.query_raw_sql(query).await.unwrap());
    }
    let bytes = number(&db, "SELECT staging_bytes FROM storage_metadata").await;
    db.close().await;
    let db = reopen(root.path()).await;
    assert_eq!(
        number(&db, "SELECT staging_bytes FROM storage_metadata").await,
        bytes
    );
    for (query, expected) in queries.into_iter().zip(expected) {
        assert_eq!(db.query_raw_sql(query).await.unwrap(), expected);
    }
    let saved = db
        .frame_payloads(&[frame, later], Projection::All)
        .await
        .unwrap();
    assert_eq!(saved[&frame].full_text, payload.full_text);
    assert_eq!(
        saved[&later].full_text.as_deref(),
        Some("later eligible capture")
    );
    for fts in [
        "frames_fts",
        "elements_fts",
        "ui_events_fts",
        "audio_transcriptions_fts",
    ] {
        assert_eq!(
            number(
                &db,
                &format!("SELECT count(*) FROM {fts} WHERE {fts} MATCH 'oversized'")
            )
            .await,
            1
        );
    }
    record(&db, "new recording beside oversized history").await;
    db.verify_storage().await.unwrap();
    db.close().await;
}

#[tokio::test]
async fn failed_archive_write_does_not_block_recording_or_recovery() {
    let root = tempfile::tempdir().unwrap();
    let mut options = private_options();
    options.privacy = PrivacyPolicy::default();
    let db = DatabaseManager::new_hybrid(root.path(), Default::default(), options)
        .await
        .unwrap();
    // A file where the archive directory belongs causes a real filesystem
    // failure, confined to this disposable test's payload storage.
    let payloads = root.path().join(&db.storage_descriptor().unwrap().payloads);
    if payloads.exists() {
        std::fs::remove_dir(&payloads).unwrap();
    }
    std::fs::write(&payloads, b"blocked archive path").unwrap();
    let mut ids = Vec::new();
    for i in 0..12 {
        ids.push(record(&db, &format!("durable capture {i} {}", "x".repeat(128))).await);
        assert!(db.seal_payloads().await.is_err());
    }
    let expected = db.frame_payloads(&ids, Projection::All).await.unwrap();
    db.close().await;
    let db = reopen(root.path()).await;
    assert_eq!(
        db.frame_payloads(&ids, Projection::All).await.unwrap(),
        expected
    );
    record(&db, "recording while archive is still broken").await;
    std::fs::remove_file(&payloads).unwrap();
    std::fs::create_dir_all(&payloads).unwrap();
    db.reclaim_frame_payloads().await.unwrap();
    while db.seal_payloads().await.unwrap() != 0 {}
    assert_eq!(number(&db, "SELECT count(*) FROM frames").await, 13);
    assert_eq!(
        number(&db, "SELECT staging_bytes FROM storage_metadata").await,
        0
    );
    assert_eq!(
        db.frame_payloads(&ids, Projection::All).await.unwrap(),
        expected
    );
    db.verify_storage().await.unwrap();
    db.close().await;
}

#[tokio::test]
async fn acknowledged_backlog_survives_process_exit() {
    const CHILD_ROOT: &str = "SCREENPIPE_RECORDING_DURABILITY_TEST_ROOT";
    if let Some(root) = std::env::var_os(CHILD_ROOT) {
        let db = DatabaseManager::new_hybrid(
            std::path::Path::new(&root),
            Default::default(),
            private_options(),
        )
        .await
        .unwrap();
        for i in 0..16 {
            assert_eq!(
                record(&db, &format!("capture {i} {}", "x".repeat(128))).await,
                i + 1
            );
        }
        // No graceful queue drain, pool close, checkpoint, or destructor.
        std::process::exit(86);
    }
    let root = tempfile::tempdir().unwrap();
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "acknowledged_backlog_survives_process_exit",
            "--nocapture",
        ])
        .env(CHILD_ROOT, root.path())
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(86));
    let db = reopen(root.path()).await;
    let rows: Vec<(i64, String)> = sqlx::query_as("SELECT id,full_text FROM frames ORDER BY id")
        .fetch_all(&db.pool)
        .await
        .unwrap();
    let expected: Vec<_> = (0..16)
        .map(|i| (i + 1, format!("capture {i} {}", "x".repeat(128))))
        .collect();
    assert_eq!(rows, expected);
    assert_eq!(record(&db, "recording after process recovery").await, 17);
    db.verify_storage().await.unwrap();
    db.close().await;
}
