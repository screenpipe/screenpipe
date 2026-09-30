// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use screenpipe_db::{
    storage::{migrate, migration_report, Projection, StorageDescriptor},
    DatabaseManager,
};

const HISTORY: &[&str] = &[
    "SELECT id,video_chunk_id FROM frames WHERE id<3 ORDER BY id",
    "SELECT id,frame_id,parent_id,text FROM elements ORDER BY id",
    "SELECT id,audio_chunk_id,speaker_id,transcription FROM audio_transcriptions ORDER BY id",
    "SELECT vision_id,tag_id FROM vision_tags ORDER BY vision_id",
];

async fn legacy_history(root: &std::path::Path) -> Vec<serde_json::Value> {
    let path = root.join("db.sqlite");
    let db = DatabaseManager::new(path.to_str().unwrap(), Default::default())
        .await
        .unwrap();
    db.close().await;
    // Only mutate the closed, disposable fixture. Historical databases can
    // contain references left behind by older writers or retention cleanup.
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys=OFF;
             INSERT INTO frames(id,timestamp,video_chunk_id,full_text) VALUES
                 (1,'2026-09-21',NULL,'legacyneedle valid frame'),
                 (2,'2026-09-21',999,'legacyneedle missing video');
             INSERT INTO elements(id,frame_id,parent_id,source,role,text) VALUES
                 (10,1,999,'accessibility','AXText','legacyneedle missing parent'),
                 (11,999,10,'accessibility','AXText','legacyneedle missing frame');
             INSERT INTO audio_transcriptions(id,audio_chunk_id,speaker_id,offset_index,timestamp,transcription,device)
                 VALUES(10,999,999,0,'2026-09-21','legacyneedle missing audio','test');
             INSERT INTO tags(id,name) VALUES(1,'retained tag');
             INSERT INTO vision_tags(vision_id,tag_id) VALUES(999,1);",
        )
        .unwrap();
    }
    let db = DatabaseManager::new(path.to_str().unwrap(), Default::default())
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, String>("PRAGMA integrity_check")
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        "ok"
    );
    assert!(!sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(&db.pool)
        .await
        .unwrap()
        .is_empty());
    // The normal application can already read this history before migration.
    let mut history = Vec::new();
    for sql in HISTORY {
        history.push(db.query_raw_sql(sql).await.unwrap());
    }
    db.close().await;
    history
}

async fn assert_migration(root: &std::path::Path, history: &[serde_json::Value]) {
    let report = migrate(root, Default::default(), Default::default())
        .await
        .unwrap();
    assert_eq!(report.frames, 2);
    assert!(StorageDescriptor::read(root).unwrap().is_some());
    assert_eq!(
        migration_report(root).unwrap().unwrap().generation,
        report.generation
    );
    assert!(!root.join("storage-migration.json").exists());
    for reopen in 0..2 {
        let db = DatabaseManager::new(root.join("db.sqlite").to_str().unwrap(), Default::default())
            .await
            .unwrap();
        db.verify_storage().await.unwrap();
        for (sql, expected) in HISTORY.iter().zip(history) {
            assert_eq!(&db.query_raw_sql(sql).await.unwrap(), expected, "{sql}");
        }
        let payloads = db.frame_payloads(&[1, 2], Projection::All).await.unwrap();
        assert_eq!(
            payloads[&1].full_text.as_deref(),
            Some("legacyneedle valid frame")
        );
        assert_eq!(
            payloads[&2].full_text.as_deref(),
            Some("legacyneedle missing video")
        );
        for (table, rows) in [("frames", 2), ("elements", 2), ("audio_transcriptions", 1)] {
            let found: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
                "SELECT count(*) FROM {table}_fts WHERE {table}_fts MATCH 'legacyneedle'"
            )))
            .fetch_one(&db.pool)
            .await
            .unwrap();
            assert_eq!(found, rows, "{table} history must remain searchable");
        }
        // Preserving old dangling references must not disable enforcement for
        // new writes or prevent continued durable recording.
        assert_eq!(
            sqlx::query_scalar::<_, i64>("PRAGMA foreign_keys")
                .fetch_one(&db.pool)
                .await
                .unwrap(),
            1
        );
        if reopen == 0 {
            assert!(db.execute_raw_sql_write("INSERT INTO elements(id,frame_id,parent_id,source,role) VALUES(12,1,999,'accessibility','AXText')").await.is_err());
            db.execute_raw_sql_write(
                "INSERT INTO frames(id,timestamp,full_text) VALUES(3,'2026-09-21','new recording')",
            )
            .await
            .unwrap();
            assert_eq!(db.seal_frame_payloads().await.unwrap(), 1);
        } else {
            assert_eq!(
                db.frame_payloads(&[3], Projection::All).await.unwrap()[&3]
                    .full_text
                    .as_deref(),
                Some("new recording")
            );
        }
        db.close().await;
    }
}

#[tokio::test]
async fn legacy_foreign_key_violations_do_not_block_migration() {
    let root = tempfile::tempdir().unwrap();
    let history = legacy_history(root.path()).await;
    assert_migration(root.path(), &history).await;
}

#[cfg(feature = "storage-fault-injection")]
#[tokio::test]
async fn legacy_foreign_key_violations_do_not_block_migration_retry() {
    for point in [
        "migration_before_rename",
        "migration_batch_staged",
        "migration_ready",
    ] {
        let root = tempfile::tempdir().unwrap();
        let history = legacy_history(root.path()).await;
        let crashed = std::process::Command::new(env!("CARGO_BIN_EXE_screenpipe-storage"))
            .arg("migrate")
            .arg(root.path())
            .env("SCREENPIPE_STORAGE_CRASH_AT", point)
            .output()
            .unwrap();
        assert_eq!(
            crashed.status.code(),
            Some(86),
            "{point}: {}",
            String::from_utf8_lossy(&crashed.stderr)
        );
        if point == "migration_batch_staged" {
            screenpipe_db::storage::recover_interrupted_migration(root.path(), Default::default())
                .await
                .unwrap();
        }
        assert_migration(root.path(), &history).await;
    }
}
