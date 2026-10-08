// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use screenpipe_db::{
    storage::{migrate, MigrationOptions, Projection},
    DatabaseManager,
};

async fn checkpoint_fixture(db: &DatabaseManager) {
    // PASSIVE may stop at an active reader's snapshot. Fixture construction
    // must wait for that reader before using the checkpoint as a disk baseline.
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let (busy, logged, checkpointed) = db.wal_checkpoint().await.unwrap();
            if busy == 0 && logged == checkpointed {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("fixture WAL did not drain before disk measurement");
}

async fn fixture(root: &std::path::Path) {
    let db = DatabaseManager::new(root.join("db.sqlite").to_str().unwrap(), Default::default())
        .await
        .unwrap();
    let mut tx = db.begin_immediate_with_retry().await.unwrap();
    let detail = "capture detail ".repeat(32768);
    for id in 1..=48 {
        sqlx::query("INSERT INTO frames(id,timestamp,full_text,accessibility_tree_json) VALUES(?,'2026-09-11T12:00:00Z','searchable migration history',?)").bind(id).bind(&detail).execute(&mut **tx.conn()).await.unwrap();
        sqlx::query("INSERT INTO elements(id,frame_id,source,role,text,properties) VALUES(?,?,'accessibility','AXText','searchable element',?)").bind(id).bind(id).bind(&detail).execute(&mut **tx.conn()).await.unwrap();
    }
    tx.commit().await.unwrap();
    // The size baseline must include committed payloads, even when a final
    // read-only connection leaves a WAL behind while the pools close.
    checkpoint_fixture(&db).await;
    db.close().await;
}

#[tokio::test]
async fn many_archive_files_complete_verification_without_exhausting_runtime_budget() {
    const CHILD_ROOT: &str = "SCREENPIPE_MANY_ARCHIVE_FILES_CHILD";
    let Ok(root) = std::env::var(CHILD_ROOT) else {
        let root = tempfile::tempdir().unwrap();
        // The regression spins inside a synchronous SQLite callback. A child
        // process gives this test a real timeout that also stops the spinner.
        let output = tokio::time::timeout(
            std::time::Duration::from_secs(90),
            tokio::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "many_archive_files_complete_verification_without_exhausting_runtime_budget",
                    "--nocapture",
                ])
                .env(CHILD_ROOT, root.path())
                .kill_on_drop(true)
                .output(),
        )
        .await
        .expect("verification stalled across many immutable files")
        .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    };
    let root = std::path::Path::new(&root);
    let path = root.join("db.sqlite");
    let db = DatabaseManager::new(path.to_str().unwrap(), Default::default())
        .await
        .unwrap();
    let detail = "archive detail ".repeat(512);
    let mut tx = db.begin_immediate_with_retry().await.unwrap();
    for id in 1..=160 {
        sqlx::query("INSERT INTO frames(id,timestamp,full_text,accessibility_tree_json) VALUES(?,'2026-09-21','verification history',?)")
            .bind(id).bind(&detail).execute(&mut **tx.conn()).await.unwrap();
        sqlx::query("INSERT INTO elements(id,frame_id,source,role,text,properties) VALUES(?,?,'accessibility','AXText','verification element',?)")
            .bind(id).bind(id).bind(&detail).execute(&mut **tx.conn()).await.unwrap();
    }
    tx.commit().await.unwrap();
    db.close().await;
    let mut options = MigrationOptions::default();
    options.budget.file_bytes = 1024;
    options.budget.record_bytes = 2048;
    options.budget.decode_bytes = 8192;
    options.budget.response_bytes = 8192;
    let report = migrate(root, Default::default(), options).await.unwrap();
    assert!(report.all_eligible_payloads_archived);
    assert_eq!(report.frames, 160);
    assert!(
        screenpipe_db::storage::inventory(root)
            .unwrap()
            .iter()
            .filter(|path| path.extension().is_some_and(|ext| ext == "parquet"))
            .count()
            >= 160
    );
    let db = DatabaseManager::new(path.to_str().unwrap(), Default::default())
        .await
        .unwrap();
    db.verify_storage().await.unwrap();
    assert_eq!(
        db.frame_payloads(&[160], Projection::All).await.unwrap()[&160]
            .accessibility_tree_json
            .as_deref(),
        Some(detail.as_str())
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT properties FROM elements WHERE id=160")
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        detail
    );
    db.close().await;
}

#[tokio::test]
async fn oversized_legacy_bulk_records_are_archived_and_remain_readable() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("db.sqlite");
    let db = DatabaseManager::new(path.to_str().unwrap(), Default::default())
        .await
        .unwrap();
    db.execute_raw_sql_write("INSERT INTO frames(id,timestamp,full_text) VALUES(1,'2026-09-16','history'); INSERT INTO audio_chunks(id,file_path) VALUES(1,'test.wav');").await.unwrap();
    db.execute_raw_sql_write(
        "INSERT INTO meetings(id,meeting_start,meeting_app) VALUES(1,'2026-09-16','test')",
    )
    .await
    .unwrap();
    let other_payloads = [
        ("ui_events", "text_content", "INSERT INTO ui_events(id,timestamp,event_type,text_content) VALUES(?1,'2026-09-16','text',?2)"),
        ("semantic_items", "body", "INSERT INTO semantic_items(id,entity_fingerprint,version_fingerprint,kind,item_key,identity_quality,title,body,metadata_json) VALUES(?1,randomblob(32),randomblob(32),'document','doc-'||?1,'stable','title',?2,'{}')"),
        ("pipe_executions", "stdout", "INSERT INTO pipe_executions(id,pipe_name,status,finished_at,stdout) VALUES(?1,'test','completed','2026-09-16',?2)"),
        ("meeting_transcript_segments", "transcript", "INSERT INTO meeting_transcript_segments(id,meeting_id,provider,item_id,transcript,captured_at) VALUES(?1,1,'test','item-'||?1,?2,'2026-09-16')"),
        ("outputs", "preview", "INSERT INTO outputs(id,source,title,output_path,preview) VALUES(?1,'test','output','test-'||?1,?2)"),
    ];
    let large = "oversized searchable 東京 ".repeat(256);
    let mut tx = db.begin_immediate_with_retry().await.unwrap();
    for id in 1..=4 {
        let text = if id == 2 || id == 4 {
            large.as_str()
        } else {
            "ordinary searchable"
        };
        sqlx::query("INSERT INTO elements(id,frame_id,source,role,text,properties) VALUES(?,1,'accessibility','AXText',?,?)")
            .bind(id).bind(text).bind(text).execute(&mut **tx.conn()).await.unwrap();
        sqlx::query("INSERT INTO audio_transcriptions(id,audio_chunk_id,offset_index,timestamp,transcription,device) VALUES(?,1,?,'2026-09-16',?,'test')")
            .bind(id).bind(id).bind(format!("{text} {id}")).execute(&mut **tx.conn()).await.unwrap();
    }
    for (_, _, sql) in other_payloads {
        for id in 1..=4 {
            let text = if id == 2 || id == 4 {
                large.as_str()
            } else {
                "ordinary searchable"
            };
            sqlx::query(sql)
                .bind(id)
                .bind(text)
                .execute(&mut **tx.conn())
                .await
                .unwrap();
        }
    }
    for table in ["elements", "audio_transcriptions", "ui_events"] {
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "UPDATE {table} SET redacted_at=1 WHERE id<4"
        )))
        .execute(&mut **tx.conn())
        .await
        .unwrap();
    }
    tx.commit().await.unwrap();
    db.close().await;
    let mut options = MigrationOptions::default();
    options.privacy.identity = "migration-regression-policy".into();
    options.privacy.required_surfaces = 1;
    options.budget.record_bytes = 1024;
    options.budget.file_bytes = 1024;
    options.budget.decode_bytes = 2048;
    options.budget.response_bytes = 1024;
    options.budget.staging_bytes = 1024;
    migrate(root.path(), Default::default(), options)
        .await
        .unwrap();
    let db = DatabaseManager::new(path.to_str().unwrap(), Default::default())
        .await
        .unwrap();
    db.verify_storage().await.unwrap();
    for id in [2, 4] {
        let text: String = sqlx::query_scalar("SELECT text FROM elements WHERE id=?")
            .bind(id)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(text, large);
        let text: String =
            sqlx::query_scalar("SELECT transcription FROM audio_transcriptions WHERE id=?")
                .bind(id)
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert_eq!(text, format!("{large} {id}"));
    }
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM _bulk_element_rows WHERE _archive_deleted=0"
        )
        .fetch_one(&db.pool)
        .await
        .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM main.audio_transcriptions WHERE _archive_file IS NOT NULL"
        )
        .fetch_one(&db.pool)
        .await
        .unwrap(),
        3
    );
    for (table, column, _) in other_payloads {
        for id in [2, 4] {
            let actual: String = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
                "SELECT {column} FROM {table} WHERE id=?"
            )))
            .bind(id)
            .fetch_one(&db.pool)
            .await
            .unwrap();
            assert_eq!(actual, large);
        }
        assert_eq!(
            sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(format!(
                "SELECT count(*) FROM main.{table} WHERE _archive_file IS NOT NULL"
            )))
            .fetch_one(&db.pool)
            .await
            .unwrap(),
            if table == "ui_events" { 3 } else { 4 }
        );
    }
    for table in [
        "elements",
        "audio_transcriptions",
        "ui_events",
        "semantic_items",
    ] {
        assert_eq!(
            sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(format!(
                "SELECT count(*) FROM {table}_fts WHERE {table}_fts MATCH 'oversized'"
            )))
            .fetch_one(&db.pool)
            .await
            .unwrap(),
            2
        );
    }
    db.execute_raw_sql_write("INSERT INTO frames(id,timestamp,full_text) VALUES(2,'2026-09-16','new recording'); INSERT INTO elements(id,frame_id,source,role,text) VALUES(5,2,'accessibility','AXText','new recording');").await.unwrap();
    while db.seal_payloads().await.unwrap() != 0 {}
    db.close().await;
    let db = DatabaseManager::new(path.to_str().unwrap(), Default::default())
        .await
        .unwrap();
    db.verify_storage().await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT text FROM elements WHERE id=5")
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        "new recording"
    );
    db.close().await;
}

#[tokio::test]
async fn completed_migration_requires_explicit_one_time_compaction() {
    use screenpipe_db::storage::{
        compact_migrated_storage_with_progress, inventory, migration_report, StorageDescriptor,
    };
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("db.sqlite");
    let db = DatabaseManager::new(path.to_str().unwrap(), Default::default())
        .await
        .unwrap();
    db.execute_raw_sql_write(
        "INSERT INTO frames(id,timestamp,full_text) VALUES(1,'2026-09-19','archived history')",
    )
    .await
    .unwrap();
    db.close().await;
    let mut options = MigrationOptions::default();
    options.budget.record_bytes = 1024;
    options.budget.file_bytes = 1024;
    options.budget.decode_bytes = 2048;
    options.budget.response_bytes = 1024;
    migrate(root.path(), Default::default(), options)
        .await
        .unwrap();
    let descriptor = StorageDescriptor::read(root.path()).unwrap().unwrap();
    let published: Vec<_> = inventory(root.path())
        .unwrap()
        .into_iter()
        .filter(|p| p.extension().is_some_and(|ext| ext == "parquet"))
        .map(|p| {
            let bytes = std::fs::read(&p).unwrap();
            (p, bytes)
        })
        .collect();
    let large = "uncompressed history 東京\0tail ".repeat(4096);
    let db = DatabaseManager::new(path.to_str().unwrap(), Default::default())
        .await
        .unwrap();
    let mut tx = db.begin_immediate_with_retry().await.unwrap();
    sqlx::query("INSERT INTO frames(id,timestamp,full_text,accessibility_tree_json) VALUES(2,'2026-09-19','remaining history',?)")
        .bind(&large).execute(&mut **tx.conn()).await.unwrap();
    sqlx::query("INSERT INTO elements(id,frame_id,source,role,text,properties) VALUES(1,2,'accessibility','AXText','remaining element',?)")
        .bind(&large).execute(&mut **tx.conn()).await.unwrap();
    sqlx::query("INSERT INTO outputs(id,source,title,output_path,preview) VALUES(1,'test','remaining output','test',?)")
        .bind(&large).execute(&mut **tx.conn()).await.unwrap();
    tx.commit().await.unwrap();
    // Model the old completion marker with oversized resident records.
    db.execute_raw_sql_write(
        "DELETE FROM _storage_conversion_steps WHERE step='conversion-all-records'",
    )
    .await
    .unwrap();
    db.close().await;
    let receipt = root.path().join("storage-migration-complete.json");
    let mut old: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&receipt).unwrap()).unwrap();
    old.as_object_mut()
        .unwrap()
        .remove("all_eligible_payloads_archived");
    std::fs::write(&receipt, serde_json::to_vec(&old).unwrap()).unwrap();
    let original_receipt = std::fs::read(&receipt).unwrap();
    // Upgrading or invoking the ordinary migration does not revisit a completed
    // database, even though its old receipt predates full payload archival.
    let report = migrate(root.path(), Default::default(), Default::default())
        .await
        .unwrap();
    assert!(!report.all_eligible_payloads_archived);
    assert_eq!(std::fs::read(&receipt).unwrap(), original_receipt);
    assert!(!root.path().join("storage-migration.json").exists());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let destination = published[0].0.parent().unwrap().parent().unwrap();
        let permissions = std::fs::metadata(destination).unwrap().permissions();
        std::fs::set_permissions(destination, std::fs::Permissions::from_mode(0o500)).unwrap();
        let failed = compact_migrated_storage_with_progress(
            root.path(),
            Default::default(),
            Default::default(),
            |_| {},
        )
        .await;
        // Recording recovery must work even while the archive remains unwritable.
        screenpipe_db::storage::recover_interrupted_migration(root.path(), Default::default())
            .await
            .unwrap();
        std::fs::set_permissions(destination, permissions).unwrap();
        assert!(failed.is_err());
        assert_eq!(std::fs::read(&receipt).unwrap(), original_receipt);
        let journal = root.path().join("storage-migration.json");
        let paused = std::fs::read(&journal).unwrap();
        assert!(screenpipe_db::storage::compaction_requires_resume(root.path()).unwrap());
        assert!(migrate(root.path(), Default::default(), Default::default())
            .await
            .unwrap_err()
            .to_string()
            .contains("explicitly"));
        assert_eq!(std::fs::read(&journal).unwrap(), paused);
        let db = DatabaseManager::new(path.to_str().unwrap(), Default::default())
            .await
            .unwrap();
        assert_eq!(
            db.frame_payloads(&[2], Projection::All).await.unwrap()[&2]
                .accessibility_tree_json
                .as_deref(),
            Some(large.as_str())
        );
        db.execute_raw_sql_write("INSERT INTO ui_events(id,timestamp,event_type,text_content) VALUES(99,'2026-09-19','text','recorded during paused compaction')").await.unwrap();
        db.close().await;
    }
    let report = compact_migrated_storage_with_progress(
        root.path(),
        Default::default(),
        Default::default(),
        |_| {},
    )
    .await
    .unwrap();
    assert_eq!(report.generation, descriptor.generation);
    assert_eq!(report.frames, 2);
    assert!(report.all_eligible_payloads_archived);
    assert!(!root.path().join("storage-migration.json").exists());
    for (path, bytes) in published {
        assert_eq!(std::fs::read(path).unwrap(), bytes);
    }
    let db = DatabaseManager::new(path.to_str().unwrap(), Default::default())
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM frame_payloads WHERE state='staged'")
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM _bulk_element_rows")
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM main.outputs WHERE _archive_mask!=0")
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        db.frame_payloads(&[2], Projection::All).await.unwrap()[&2]
            .accessibility_tree_json
            .as_deref(),
        Some(large.as_str())
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT properties FROM elements WHERE id=1")
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        large
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT preview FROM outputs WHERE id=1")
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        large
    );
    db.verify_storage().await.unwrap();
    db.execute_raw_sql_write("INSERT INTO frames(id,timestamp,full_text) VALUES(3,'2026-09-19','new recording after repair')").await.unwrap();
    db.close().await;
    let completed_receipt = std::fs::read(&receipt).unwrap();
    let report = compact_migrated_storage_with_progress(
        root.path(),
        Default::default(),
        Default::default(),
        |_| {},
    )
    .await
    .unwrap();
    assert_eq!(
        report.frames, 2,
        "a second request must not compact new recordings"
    );
    assert_eq!(std::fs::read(&receipt).unwrap(), completed_receipt);
    // A crash after the durable receipt, followed by recording recovery, may
    // leave a paused journal. Retrying only retires it, without a second pass.
    let journal = root.path().join("storage-migration.json");
    std::fs::write(
        &journal,
        serde_json::to_vec(&serde_json::json!({
            "format": 2, "compaction": true, "phase": "paused", "descriptor": descriptor,
            "source": report.tables, "report": report, "snapshot": null
        }))
        .unwrap(),
    )
    .unwrap();
    compact_migrated_storage_with_progress(
        root.path(),
        Default::default(),
        Default::default(),
        |_| {},
    )
    .await
    .unwrap();
    assert!(!journal.exists());
    assert_eq!(std::fs::read(&receipt).unwrap(), completed_receipt);
    assert!(
        migration_report(root.path())
            .unwrap()
            .unwrap()
            .all_eligible_payloads_archived
    );
}

#[tokio::test]
async fn completion_receipt_requires_all_eligible_payloads_to_leave_sqlite() {
    use screenpipe_db::storage::{diagnostics, StorageDescriptor};
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("db.sqlite");
    let db = DatabaseManager::new(path.to_str().unwrap(), Default::default())
        .await
        .unwrap();
    db.execute_raw_sql_write(
        "INSERT INTO frames(id,timestamp,full_text) VALUES(1,'2026-09-19','private history')",
    )
    .await
    .unwrap();
    db.close().await;
    let report = migrate(root.path(), Default::default(), Default::default())
        .await
        .unwrap();
    let descriptor = StorageDescriptor::read(root.path()).unwrap().unwrap();
    let db = DatabaseManager::new(path.to_str().unwrap(), Default::default())
        .await
        .unwrap();
    db.execute_raw_sql_write("INSERT INTO frames(id,timestamp,full_text) VALUES(2,'2026-09-19','private history left resident')").await.unwrap();
    db.close().await;
    let receipt = root.path().join("storage-migration-complete.json");
    std::fs::remove_file(&receipt).unwrap();
    // A prematurely committed conversion marker is insufficient evidence.
    std::fs::write(
        root.path().join("storage-migration.json"),
        serde_json::to_vec(&serde_json::json!({
            "format": 2, "phase": "building", "descriptor": descriptor,
            "source": report.tables, "snapshot": null, "report": null
        }))
        .unwrap(),
    )
    .unwrap();
    let error = migrate(root.path(), Default::default(), Default::default())
        .await
        .unwrap_err();
    assert!(error
        .to_string()
        .contains("migration incomplete: 1 eligible frames records (29 bytes) remain in SQLite"));
    assert!(!receipt.exists());
    assert!(root.path().join("storage-migration.json").exists());
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            if diagnostics::recent(root.path()).unwrap().iter().any(|s| {
                s.status == "failed"
                    && s.failure_stage.as_deref() == Some("verifying_no_eligible_resident_payloads")
                    && s.table.as_deref() == Some("frames")
                    && s.batch_bytes == Some(29)
                    && s.error.as_deref().is_some_and(|e| {
                        e.contains("remain in SQLite") && !e.contains("private history")
                    })
            }) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn older_verified_attempt_finishes_large_rows_against_its_original_receipts() {
    use screenpipe_db::storage::StorageDescriptor;
    for tampered in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("db.sqlite");
        let db = DatabaseManager::new(path.to_str().unwrap(), Default::default())
            .await
            .unwrap();
        db.execute_raw_sql_write("INSERT INTO frames(id,timestamp,full_text,accessibility_tree_json) VALUES(1,'2026-09-19','original history',printf('%.*c',65536,'x'))").await.unwrap();
        db.close().await;
        let mut options = MigrationOptions::default();
        options.budget.record_bytes = 1024;
        options.budget.file_bytes = 4096;
        options.budget.decode_bytes = 8192;
        options.budget.response_bytes = 1024;
        let report = migrate(root.path(), Default::default(), options)
            .await
            .unwrap();
        let descriptor = StorageDescriptor::read(root.path()).unwrap().unwrap();
        let db = DatabaseManager::new(path.to_str().unwrap(), Default::default())
            .await
            .unwrap();
        let mut payload = db
            .frame_payloads(&[1], Projection::All)
            .await
            .unwrap()
            .remove(&1)
            .unwrap();
        if tampered {
            payload.full_text = Some("changed after verification".into());
        }
        // Restore the original logical row to SQLite without changing its
        // privacy columns, as the older size-limited converter left it.
        assert!(db
            .replace_frame_payload(&payload, "", 0, None, None)
            .await
            .unwrap());
        db.execute_raw_sql_write(
            "DELETE FROM _storage_conversion_steps WHERE step='conversion-all-records'",
        )
        .await
        .unwrap();
        db.close().await;
        std::fs::remove_file(root.path().join("storage-migration-complete.json")).unwrap();
        std::fs::write(
            root.path().join("storage-migration.json"),
            serde_json::to_vec(&serde_json::json!({
                "format": 2, "phase": "ready", "descriptor": descriptor,
                "source": report.tables, "snapshot": null, "report": null
            }))
            .unwrap(),
        )
        .unwrap();
        let result = migrate(root.path(), Default::default(), Default::default()).await;
        if tampered {
            assert!(result
                .unwrap_err()
                .to_string()
                .contains("migration logical data differs"));
            assert!(!root.path().join("storage-migration-complete.json").exists());
        } else {
            assert!(result.unwrap().all_eligible_payloads_archived);
            let db = DatabaseManager::new(path.to_str().unwrap(), Default::default())
                .await
                .unwrap();
            assert_eq!(
                sqlx::query_scalar::<_, i64>(
                    "SELECT count(*) FROM frame_payloads WHERE state='staged'"
                )
                .fetch_one(&db.pool)
                .await
                .unwrap(),
                0
            );
            assert_eq!(
                db.frame_payloads(&[1], Projection::All).await.unwrap()[&1].accessibility_tree_json,
                payload.accessibility_tree_json
            );
            db.close().await;
        }
    }
}

#[tokio::test]
async fn migration_diagnostics_preserve_table_totals_and_verified_completion() {
    use screenpipe_db::storage::diagnostics;
    use std::time::Duration;
    let root = tempfile::tempdir().unwrap();
    fixture(root.path()).await;
    let report = migrate(root.path(), Default::default(), Default::default())
        .await
        .unwrap();
    let snapshot = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if let Some(snapshot) = diagnostics::recent(root.path())
                .unwrap()
                .into_iter()
                .find(|s| s.status == "completed")
            {
                break snapshot;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(snapshot.kind, "conversion");
    assert_eq!(snapshot.stage, "saving_completion_receipt");
    assert_eq!(snapshot.table_records["frames"], report.frames);
    assert_eq!(snapshot.table_records["elements"], 48);
    assert_eq!(snapshot.completed_records, Some(96));
    assert_eq!(snapshot.total_records, Some(96));
    assert!(snapshot.error.is_none());
    assert!(root
        .path()
        .join("storage-migration-complete.json")
        .is_file());
    assert!(!root.path().join("storage-migration.json").exists());
    let json = serde_json::to_string(&snapshot).unwrap();
    assert!(!json.contains("searchable element"));
    assert!(!json.contains("capture detail"));
}

#[tokio::test]
async fn migration_search_probes_handle_controls_symbols_and_unicode() {
    for texts in [
        ["\0\0├───┼───── foo", "┃"],
        ["\0שלום עולם", "café\0東京"],
        ["\0\0├───┼─────", "┃"],
    ] {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("db.sqlite");
        let db = DatabaseManager::new(path.to_str().unwrap(), Default::default())
            .await
            .unwrap();
        let mut tx = db.begin_immediate_with_retry().await.unwrap();
        for (index, text) in texts.iter().enumerate() {
            sqlx::query(
                "INSERT INTO frames(id,timestamp,full_text) VALUES(?,'2026-09-28T12:00:00Z',?)",
            )
            .bind(index as i64 + 1)
            .bind(text)
            .execute(&mut **tx.conn())
            .await
            .unwrap();
        }
        tx.commit().await.unwrap();
        let before = db.frame_payloads(&[1, 2], Projection::All).await.unwrap();
        let mut searches = Vec::new();
        for term in ["foo", "שלום", "café", "東京"] {
            let ids: Vec<i64> = sqlx::query_scalar(
                "SELECT rowid FROM frames_fts WHERE frames_fts MATCH ? ORDER BY rowid",
            )
            .bind(term)
            .fetch_all(&db.pool)
            .await
            .unwrap();
            searches.push((term, ids));
        }
        db.close().await;

        let report = migrate(root.path(), Default::default(), Default::default())
            .await
            .unwrap();
        assert_eq!(report.frames, 2);
        assert!(root
            .path()
            .join("storage-migration-complete.json")
            .is_file());
        assert!(!root.path().join("storage-migration.json").exists());
        let reopened = DatabaseManager::new(path.to_str().unwrap(), Default::default())
            .await
            .unwrap();
        assert_eq!(
            reopened.storage_mode(),
            screenpipe_db::storage::StorageMode::HybridParquetV1
        );
        let after = reopened
            .frame_payloads(&[1, 2], Projection::All)
            .await
            .unwrap();
        for id in [1, 2] {
            assert_eq!(after[&id].full_text, before[&id].full_text);
        }
        for (term, expected) in searches {
            let actual: Vec<i64> = sqlx::query_scalar(
                "SELECT rowid FROM frames_fts WHERE frames_fts MATCH ? ORDER BY rowid",
            )
            .bind(term)
            .fetch_all(&reopened.pool)
            .await
            .unwrap();
            assert_eq!(actual, expected, "search changed for {term}");
        }
        reopened.verify_storage().await.unwrap();
        reopened.close().await;
    }
}

#[tokio::test]
async fn migration_preserves_search_when_frames_and_bulk_history_are_both_present() {
    assert_migration_search(false).await;
}

#[tokio::test]
#[cfg(feature = "storage-fault-injection")]
async fn retry_repairs_search_for_already_archived_bulk_history() {
    assert_migration_search(true).await;
}

async fn assert_migration_search(resume: bool) {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("db.sqlite");
    let db = DatabaseManager::new(path.to_str().unwrap(), Default::default())
        .await
        .unwrap();
    db.execute_raw_sql_write("INSERT INTO frames(id,timestamp,full_text) VALUES(1,'2026-09-19','frame history'),(2,'2026-09-19','other frame'); INSERT INTO audio_chunks(id,file_path) VALUES(1,'test.wav'); INSERT INTO audio_transcriptions(id,audio_chunk_id,offset_index,timestamp,transcription,device) VALUES(1,1,0,'2026-09-19','migrationneedle spoken history','test'); INSERT INTO ui_events(id,timestamp,event_type,text_content) VALUES(1,'2026-09-19','text','migrationneedle typed history'); INSERT INTO semantic_items(id,entity_fingerprint,version_fingerprint,kind,item_key,identity_quality,title,body,metadata_json) VALUES(1,randomblob(32),randomblob(32),'document','migration','stable','title','migrationneedle document','{}');").await.unwrap();
    db.close().await;
    if resume {
        let crashed = std::process::Command::new(env!("CARGO_BIN_EXE_screenpipe-storage"))
            .arg("migrate")
            .arg(root.path())
            .env("SCREENPIPE_STORAGE_CRASH_AT", "bulk_committed")
            .output()
            .unwrap();
        assert_eq!(crashed.status.code(), Some(86));
        screenpipe_db::storage::recover_interrupted_migration(root.path(), Default::default())
            .await
            .unwrap();
        let db = DatabaseManager::new(path.to_str().unwrap(), Default::default())
            .await
            .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT count(*) FROM main.audio_transcriptions WHERE _archive_file IS NOT NULL"
            )
            .fetch_one(&db.pool)
            .await
            .unwrap(),
            1
        );
        // Older attempts could publish this archive before populating FTS.
        db.execute_raw_sql_write("DELETE FROM audio_transcriptions_fts; DELETE FROM _storage_conversion_steps WHERE step LIKE '%-all-fts-%'")
            .await.unwrap();
        db.close().await;
    }
    let report = migrate(root.path(), Default::default(), Default::default())
        .await
        .unwrap();
    assert_eq!(report.frames, 2);
    let db = DatabaseManager::new(path.to_str().unwrap(), Default::default())
        .await
        .unwrap();
    for table in ["audio_transcriptions", "ui_events", "semantic_items"] {
        let found: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            "SELECT count(*) FROM {table}_fts WHERE {table}_fts MATCH 'migrationneedle'"
        )))
        .fetch_one(&db.pool)
        .await
        .unwrap();
        assert_eq!(found, 1, "migrated {table} must remain searchable");
    }
    db.verify_storage().await.unwrap();
    db.close().await;
}

#[tokio::test]
#[ignore = "migration throughput benchmark; generates an isolated recording history"]
async fn migration_throughput() {
    use std::{sync::Mutex, time::Instant};
    let _ = tracing_subscriber::fmt()
        .with_env_filter("screenpipe_db::storage=info")
        .with_writer(std::io::stderr)
        .try_init();
    let root = tempfile::tempdir().unwrap();
    let db = DatabaseManager::new(
        root.path().join("db.sqlite").to_str().unwrap(),
        Default::default(),
    )
    .await
    .unwrap();
    let frames = 4096_i64;
    let elements = 262144_i64;
    let detail = "capture detail ".repeat(4096);
    let properties = "element properties ".repeat(32);
    let mut tx = db.begin_immediate_with_retry().await.unwrap();
    for id in 1..=frames {
        sqlx::query("INSERT INTO frames(id,timestamp,full_text,accessibility_tree_json) VALUES(?,'2026-09-15T12:00:00Z','searchable migration history',?)")
            .bind(id).bind(&detail).execute(&mut **tx.conn()).await.unwrap();
    }
    sqlx::query("WITH RECURSIVE n(id) AS (VALUES(1) UNION ALL SELECT id+1 FROM n WHERE id<?) INSERT INTO elements(id,frame_id,source,role,text,properties) SELECT id,1+(id-1)/?,'accessibility','AXText','searchable element',? FROM n")
        .bind(elements).bind(elements / frames).bind(&properties).execute(&mut **tx.conn()).await.unwrap();
    tx.commit().await.unwrap();
    db.wal_checkpoint().await.unwrap();
    db.close().await;
    let started = Instant::now();
    let previous = Mutex::new(("", started, 0_u64));
    let report = screenpipe_db::storage::migrate_with_progress(
        root.path(),
        Default::default(),
        Default::default(),
        |p| {
            let mut previous = previous.lock().unwrap();
            let completed = p.completed_records.unwrap_or(previous.2);
            if p.message != previous.0 || completed >= previous.2 + 32768 {
                eprintln!(
                    "migration benchmark: elapsed={:.3}s phase={} records={} interval={:.3}s",
                    started.elapsed().as_secs_f64(),
                    p.message,
                    completed,
                    previous.1.elapsed().as_secs_f64()
                );
                *previous = (p.message, Instant::now(), completed);
            }
        },
    )
    .await
    .unwrap();
    eprintln!("migration benchmark: total={:.3}s frames={frames} elements={elements} source={} payloads={}",
        started.elapsed().as_secs_f64(), report.source_bytes, report.payload_bytes);
    assert_eq!(report.frames, frames as u64);
    assert_eq!(
        report
            .tables
            .iter()
            .find(|t| t.table == "elements")
            .unwrap()
            .rows,
        elements as u64
    );
}

#[tokio::test]
#[ignore = "requires a marked disposable volume; optional production-default run uses up to 8 GiB"]
async fn migration_completes_with_less_free_space_than_its_final_payloads() {
    use std::io::Write;
    let volume = std::path::PathBuf::from(std::env::var("SCREENPIPE_CONSTRAINED_VOLUME").unwrap());
    assert!(volume.join(".screenpipe-disposable-volume").is_file());
    let production = std::env::var_os("SCREENPIPE_TEST_MIGRATION_DEFAULTS").is_some();
    let count: i64 = if production { 4096 } else { 96 };
    let payload_bytes = if production { 512 * 1024 } else { 256 * 1024 };
    let mut options = MigrationOptions::default();
    let (capacity_limit, free_target) = if production {
        (
            8_u64 * 1024 * 1024 * 1024,
            options.budget.disk_reserve_bytes + 128 * 1024 * 1024,
        )
    } else {
        options.budget.file_bytes = 512 * 1024;
        options.budget.record_bytes = 1024 * 1024;
        options.budget.disk_reserve_bytes = 0;
        (512 * 1024 * 1024, 13 * 1024 * 1024)
    };
    assert!(fs2::total_space(&volume).unwrap() <= capacity_limit);
    let root = tempfile::tempdir_in(&volume).unwrap();
    let db = DatabaseManager::new(
        root.path().join("db.sqlite").to_str().unwrap(),
        Default::default(),
    )
    .await
    .unwrap();
    let mut state = 0x852df832c973ba01_u64;
    let alphabet = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/";
    for id in 1..=count {
        let detail: String = (0..payload_bytes)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                alphabet[(state & 63) as usize] as char
            })
            .collect();
        let mut tx = db.begin_immediate_with_retry().await.unwrap();
        sqlx::query("INSERT INTO frames(id,timestamp,full_text,accessibility_tree_json) VALUES(?,'2026-09-14','constrained disk history',?)").bind(id).bind(&detail).execute(&mut **tx.conn()).await.unwrap();
        sqlx::query("INSERT INTO elements(id,frame_id,source,role,properties) VALUES(?,?,'accessibility','AXText',?)").bind(id).bind(id).bind(&detail).execute(&mut **tx.conn()).await.unwrap();
        tx.commit().await.unwrap();
        // Keep fixture generation from accumulating a second multi-GiB WAL
        // before the constrained migration itself has even started.
        if id % 128 == 0 || id == count {
            checkpoint_fixture(&db).await;
        }
    }
    db.close().await;
    let mut filler = std::fs::File::create(root.path().join("unrelated-data")).unwrap();
    let block = vec![0xa5; 1024 * 1024];
    while fs2::available_space(&volume).unwrap() > free_target {
        filler.write_all(&block).unwrap();
        filler.sync_all().unwrap();
    }
    drop(filler);
    let initial_free = fs2::available_space(&volume).unwrap();
    let updates = std::sync::Mutex::new(Vec::new());
    let result = screenpipe_db::storage::migrate_with_progress(
        root.path(),
        Default::default(),
        options,
        |p| {
            eprintln!(
                "phase={} completed={:?} saved={:?} available={:?}",
                p.message, p.completed_records, p.bytes_saved, p.available_bytes
            );
            updates.lock().unwrap().push(p);
        },
    )
    .await;
    let report = match result {
        Ok(report) => report,
        Err(error) => {
            let kept = root.keep();
            panic!(
                "{error}; retained fixture={} free={}",
                kept.display(),
                fs2::available_space(&volume).unwrap()
            );
        }
    };
    assert!(
        report.payload_bytes > initial_free,
        "fixture must require progressive reclamation"
    );
    assert!(updates
        .lock()
        .unwrap()
        .iter()
        .any(|u| u.completed_records.unwrap_or(0) < 2 * count as u64
            && u.bytes_saved.unwrap_or(0) > 1024 * 1024));
    eprintln!("constrained migration: initial_free={initial_free}, final_payloads={}, allocated_before={}, allocated_after={}, remaining_free={}", report.payload_bytes,report.allocated_before_bytes.unwrap(),report.allocated_after_bytes.unwrap(),fs2::available_space(&volume).unwrap());
    let db = DatabaseManager::new(
        root.path().join("db.sqlite").to_str().unwrap(),
        Default::default(),
    )
    .await
    .unwrap();
    db.verify_storage().await.unwrap();
    assert_eq!(
        db.frame_payloads(&[1, count], Projection::All)
            .await
            .unwrap()
            .len(),
        2
    );
    db.close().await;
}

#[tokio::test]
async fn external_reader_prevents_conversion_before_rename() {
    use sqlx::Connection;
    let root = tempfile::tempdir().unwrap();
    fixture(root.path()).await;
    let source = root.path().join("db.sqlite");
    let mut reader = sqlx::SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new()
            .filename(&source)
            .read_only(true),
    )
    .await
    .unwrap();
    let mut tx = reader.begin().await.unwrap();
    sqlx::query("SELECT count(*) FROM frames")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert!(migrate(root.path(), Default::default(), Default::default())
        .await
        .is_err());
    assert!(source.is_file());
    assert!(!root.path().join("storage-migration.json").exists());
    tx.rollback().await.unwrap();
    reader.close().await.unwrap();
    migrate(root.path(), Default::default(), Default::default())
        .await
        .unwrap();
}

#[tokio::test]
async fn insufficient_headroom_keeps_the_complete_source() {
    let root = tempfile::tempdir().unwrap();
    fixture(root.path()).await;
    let mut options = MigrationOptions::default();
    options.budget.disk_reserve_bytes = fs2::available_space(root.path()).unwrap();
    assert!(migrate(root.path(), Default::default(), options)
        .await
        .is_err());
    assert!(root.path().join("db.sqlite").is_file());
    assert!(!root.path().join("storage-migration.json").exists());
}

#[cfg(feature = "storage-fault-injection")]
#[tokio::test]
async fn legacy_candidate_is_retired_only_with_a_verified_source() {
    let root = tempfile::tempdir().unwrap();
    fixture(root.path()).await;
    let crashed = std::process::Command::new(env!("CARGO_BIN_EXE_screenpipe-storage"))
        .arg("migrate")
        .arg(root.path())
        .env("SCREENPIPE_STORAGE_CRASH_AT", "migration_before_rename")
        .output()
        .unwrap();
    assert_eq!(crashed.status.code(), Some(86));
    let journal_path = root.path().join("storage-migration.json");
    let mut legacy: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&journal_path).unwrap()).unwrap();
    legacy["format"] = 1.into();
    let mut unknown = legacy.clone();
    unknown["source"] = serde_json::json!([]);
    unknown["snapshot"] = serde_json::Value::Null;
    std::fs::write(&journal_path, serde_json::to_vec(&unknown).unwrap()).unwrap();
    assert!(migrate(root.path(), Default::default(), Default::default())
        .await
        .is_err());
    assert!(root.path().join("db.sqlite").is_file());
    assert!(journal_path.is_file());

    std::fs::write(&journal_path, serde_json::to_vec(&legacy).unwrap()).unwrap();
    let report = migrate(root.path(), Default::default(), Default::default())
        .await
        .unwrap();
    assert_eq!(report.frames, 48);
    assert!(report.allocated_before_bytes.is_some());
    assert!(!root.path().join("db.sqlite").exists());
    assert!(!journal_path.exists());
}

#[cfg(feature = "storage-fault-injection")]
#[tokio::test]
async fn schema_staging_and_reclamation_interruptions_retain_completed_files() {
    for (point, hit) in [
        ("migration_schema_step", 2),
        ("migration_schema_step", 8),
        ("migration_schema_step", 16),
        ("migration_schema_step", 32),
        ("migration_batch_staged", 2),
        ("seal_committed", 2),
        ("bulk_committed", 2),
        ("migration_blocks_reclaimed", 2),
    ] {
        let root = tempfile::tempdir().unwrap();
        fixture(root.path()).await;
        let crashed = std::process::Command::new(env!("CARGO_BIN_EXE_screenpipe-storage"))
            .arg("migrate")
            .arg(root.path())
            .env("SCREENPIPE_STORAGE_CRASH_AT", point)
            .env("SCREENPIPE_STORAGE_CRASH_HIT", hit.to_string())
            .output()
            .unwrap();
        assert_eq!(
            crashed.status.code(),
            Some(86),
            "{point}/{hit}: {}",
            String::from_utf8_lossy(&crashed.stderr)
        );
        let before: Vec<_> = screenpipe_db::storage::inventory(root.path())
            .unwrap()
            .into_iter()
            .filter(|p| p.extension().is_some_and(|s| s == "parquet"))
            .map(|p| {
                let bytes = std::fs::read(&p).unwrap();
                (p, bytes)
            })
            .collect();
        assert!(screenpipe_db::storage::migration_requires_resume(root.path()).unwrap());
        let report = migrate(root.path(), Default::default(), Default::default())
            .await
            .unwrap();
        assert_eq!(report.frames, 48);
        for (path, bytes) in before {
            assert_eq!(
                std::fs::read(path).unwrap(),
                bytes,
                "completed Parquet must not be rebuilt at {point}/{hit}"
            );
        }
        let db = DatabaseManager::new(
            root.path().join("db.sqlite").to_str().unwrap(),
            Default::default(),
        )
        .await
        .unwrap();
        db.verify_storage().await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM elements")
                .fetch_one(&db.pool)
                .await
                .unwrap(),
            48
        );
        db.close().await;
    }
}

#[tokio::test]
async fn privacy_pending_payloads_remain_resident_and_searchable() {
    let root = tempfile::tempdir().unwrap();
    fixture(root.path()).await;
    let source = DatabaseManager::new(
        root.path().join("db.sqlite").to_str().unwrap(),
        Default::default(),
    )
    .await
    .unwrap();
    source.execute_raw_sql_write("INSERT INTO audio_chunks(id,file_path) VALUES(1,'audio.wav'); INSERT INTO audio_transcriptions(id,audio_chunk_id,offset_index,timestamp,transcription,device) VALUES(1,1,0,'2026-09-14','private spoken history','microphone'); INSERT INTO ui_events(id,timestamp,event_type,text_content) VALUES(1,'2026-09-14','text','private typed history'); INSERT INTO pipe_executions(id,pipe_name,status,stdout) VALUES(1,'running-task','running','mutable progress');").await.unwrap();
    source.close().await;
    let options = MigrationOptions {
        privacy: screenpipe_db::storage::PrivacyPolicy {
            identity: "required-redaction".into(),
            required_surfaces: 15,
        },
        ..Default::default()
    };
    migrate(root.path(), Default::default(), options)
        .await
        .unwrap();
    let db = DatabaseManager::new(
        root.path().join("db.sqlite").to_str().unwrap(),
        Default::default(),
    )
    .await
    .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM frame_payloads WHERE state='staged'")
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        48
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM _bulk_element_rows")
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        48
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM elements_fts WHERE elements_fts MATCH 'searchable'"
        )
        .fetch_one(&db.pool)
        .await
        .unwrap(),
        48
    );
    assert_eq!(db.seal_frame_payloads().await.unwrap(), 0);
    for table in ["audio_transcriptions", "ui_events"] {
        assert_eq!(
            sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(format!(
                "SELECT count(*) FROM {table}_fts WHERE {table}_fts MATCH 'private'"
            )))
            .fetch_one(&db.pool)
            .await
            .unwrap(),
            1
        );
    }
    db.execute_raw_sql_write("UPDATE pipe_executions SET stdout='still running' WHERE id=1")
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT stdout FROM pipe_executions WHERE id=1")
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        "still running"
    );
    db.verify_storage().await.unwrap();
    db.close().await;
}

#[tokio::test]
async fn sparse_privacy_backlog_completes_migration_and_preserves_recording() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("db.sqlite");
    let db = DatabaseManager::new(path.to_str().unwrap(), Default::default())
        .await
        .unwrap();
    let count = 100_000_i64;
    db.execute_raw_sql_write("INSERT INTO frames(id,timestamp,full_text) VALUES(1,'2026-09-18T12:00:00Z','pending frame privacy')").await.unwrap();
    let mut tx = db.begin_immediate_with_retry().await.unwrap();
    sqlx::query("WITH RECURSIVE n(id) AS (VALUES(1) UNION ALL SELECT id+1 FROM n WHERE id<?) INSERT INTO elements(id,frame_id,source,role,text,redacted_at) SELECT id,1,'accessibility','AXText','pending element history '||id,CASE WHEN id=? THEN 1 ELSE NULL END FROM n")
        .bind(count).bind(count / 2).execute(&mut **tx.conn()).await.unwrap();
    tx.commit().await.unwrap();
    db.close().await;
    let mut options = MigrationOptions::default();
    options.privacy.identity = "sparse-privacy-migration".into();
    options.privacy.required_surfaces = 1;
    let report = migrate(root.path(), Default::default(), options)
        .await
        .unwrap();
    assert_eq!(
        report
            .tables
            .iter()
            .find(|t| t.table == "elements")
            .unwrap()
            .rows,
        count as u64
    );
    assert!(root
        .path()
        .join("storage-migration-complete.json")
        .is_file());
    assert!(!root.path().join("storage-migration.json").exists());

    let db = DatabaseManager::new(path.to_str().unwrap(), Default::default())
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM _bulk_element_rows")
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        count - 1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT sum(rows) FROM _bulk_files WHERE table_name='elements' AND state='published'"
        )
        .fetch_one(&db.pool)
        .await
        .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM elements_fts WHERE elements_fts MATCH 'history'"
        )
        .fetch_one(&db.pool)
        .await
        .unwrap(),
        count
    );
    db.verify_storage().await.unwrap();
    db.execute_raw_sql_write("INSERT INTO frames(id,timestamp,full_text) VALUES(2,'2026-09-18T13:00:00Z','new durable capture'); INSERT INTO elements(id,frame_id,source,role,text) VALUES(100001,2,'accessibility','AXText','new capture element')").await.unwrap();
    db.close().await;
    let reopened = DatabaseManager::new(path.to_str().unwrap(), Default::default())
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM elements")
            .fetch_one(&reopened.pool)
            .await
            .unwrap(),
        count + 1
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT text FROM elements WHERE id=100001")
            .fetch_one(&reopened.pool)
            .await
            .unwrap(),
        "new capture element"
    );
    reopened.close().await;
}

#[tokio::test]
#[ignore = "requires a marked disposable volume; network mounts also exercise rollback journal recovery"]
#[cfg(target_os = "macos")]
async fn retained_wal_verification_and_reopen_preserve_committed_rows() {
    use sqlx::Connection;
    const CHILD: &str = "SCREENPIPE_NAS_WAL_CHILD";
    if let Ok(path) = std::env::var(CHILD) {
        // Reproduce an old owner that exited with committed WAL on the share.
        let mut conn = sqlx::SqliteConnection::connect_with(
            &sqlx::sqlite::SqliteConnectOptions::new()
                .filename(path)
                .create_if_missing(false)
                .pragma("locking_mode", "EXCLUSIVE")
                .pragma("journal_mode", "WAL")
                .pragma("synchronous", "FULL")
                .pragma("wal_autocheckpoint", "0"),
        )
        .await
        .unwrap();
        sqlx::raw_sql("CREATE TABLE nas_wal(value TEXT); INSERT INTO nas_wal VALUES('acknowledged before crash')")
            .execute(&mut conn).await.unwrap();
        std::process::exit(86);
    }
    let volume = std::path::PathBuf::from(std::env::var("SCREENPIPE_UNSUPPORTED_VOLUME").unwrap());
    assert!(volume.join(".screenpipe-disposable-volume").is_file());
    // Unsupported hole punching does not make a local HFS+ volume a network
    // filesystem. Only actual network mounts use rollback journaling.
    let expected_journal = if screenpipe_fs::is_network_volume(&volume).unwrap() {
        "delete"
    } else {
        "wal"
    };
    let root = tempfile::tempdir_in(volume).unwrap();
    let path = root.path().join("db.sqlite");
    let db = DatabaseManager::new(path.to_str().unwrap(), Default::default())
        .await
        .unwrap();
    db.close().await;
    let crashed = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--ignored",
            "--exact",
            "retained_wal_verification_and_reopen_preserve_committed_rows",
        ])
        .env(CHILD, &path)
        .output()
        .unwrap();
    assert_eq!(
        crashed.status.code(),
        Some(86),
        "{}",
        String::from_utf8_lossy(&crashed.stderr)
    );
    let wal = root.path().join("db.sqlite-wal");
    let before = std::fs::read(&path).unwrap();
    let before_wal = std::fs::read(&wal).unwrap();
    assert!(!before_wal.is_empty());
    screenpipe_sqlite_coordinator::inspect_database_health(&path)
        .await
        .unwrap();
    assert_eq!(
        std::fs::read(&path).unwrap(),
        before,
        "verification must not rewrite the source"
    );
    assert_eq!(
        std::fs::read(&wal).unwrap(),
        before_wal,
        "verification must not checkpoint or remove WAL"
    );
    screenpipe_sqlite_coordinator::persist_sqlite_verification_pending(
        &path,
        Some(3850),
        "previous NAS locking failure",
    )
    .unwrap();
    let db = DatabaseManager::new(path.to_str().unwrap(), Default::default())
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT value FROM nas_wal")
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        "acknowledged before crash"
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>("PRAGMA journal_mode")
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        expected_journal
    );
    assert!(!screenpipe_sqlite_coordinator::sqlite_verification_pending_exists(&path));
    db.execute_raw_sql_write("INSERT INTO nas_wal VALUES('recorded after recovery')")
        .await
        .unwrap();
    db.close().await;
    let db = DatabaseManager::new(path.to_str().unwrap(), Default::default())
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM nas_wal")
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        2
    );
    db.close().await;
    println!("retained WAL: verification preserved database and committed WAL bytes; pending incident recovered; acknowledged and new rows survive restart in {expected_journal} mode");
}

#[tokio::test]
#[ignore = "requires a marked disposable filesystem without hole punching"]
async fn non_sparse_volume_migrates_and_keeps_recording_after_restart() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter("screenpipe_db::storage=info")
        .with_ansi(false)
        .try_init();
    let volume = std::path::PathBuf::from(std::env::var("SCREENPIPE_UNSUPPORTED_VOLUME").unwrap());
    assert!(volume.join(".screenpipe-disposable-volume").is_file());
    assert!(fs2::total_space(&volume).unwrap() <= 512 * 1024 * 1024);
    let root = tempfile::tempdir_in(volume).unwrap();
    fixture(root.path()).await;
    let path = root.path().join("db.sqlite");
    let mut options = MigrationOptions::default();
    options.budget.disk_reserve_bytes = 0;
    options.budget.file_bytes = 1024 * 1024;
    options.budget.record_bytes = 1024 * 1024;
    let report = migrate(root.path(), Default::default(), options)
        .await
        .unwrap();
    assert_eq!(report.frames, 48);
    assert!(root
        .path()
        .join("storage-migration-complete.json")
        .is_file());
    assert!(!root.path().join("storage-migration.json").exists());
    let db = DatabaseManager::new(path.to_str().unwrap(), Default::default())
        .await
        .unwrap();
    db.verify_storage().await.unwrap();
    db.execute_raw_sql_write("INSERT INTO frames(id,timestamp,full_text,accessibility_tree_json) VALUES(49,'2026-09-18T12:00:00Z','nasafter recording','new detail'); INSERT INTO elements(id,frame_id,source,role,text) VALUES(49,49,'accessibility','AXText','nasafter element'); INSERT INTO audio_chunks(id,file_path) VALUES(1,'nas-audio.mp4'); INSERT INTO audio_transcriptions(id,audio_chunk_id,offset_index,timestamp,transcription,device) VALUES(1,1,0,'2026-09-18T12:00:00Z','nasafter transcript','test');").await.unwrap();
    while db.seal_payloads().await.unwrap() != 0 {}
    db.close().await;
    let db = DatabaseManager::new(path.to_str().unwrap(), Default::default())
        .await
        .unwrap();
    db.verify_storage().await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM frames")
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        49
    );
    let payloads = db
        .frame_payloads(&[1, 48, 49], Projection::All)
        .await
        .unwrap();
    for id in [1, 48] {
        assert_eq!(
            payloads[&id].accessibility_tree_json.as_deref(),
            Some("capture detail ".repeat(32768).as_str())
        );
    }
    assert_eq!(
        payloads[&49].full_text.as_deref(),
        Some("nasafter recording")
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT text FROM elements WHERE id=49")
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        "nasafter element"
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT transcription FROM audio_transcriptions WHERE id=1"
        )
        .fetch_one(&db.pool)
        .await
        .unwrap(),
        "nasafter transcript"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM frames_fts WHERE frames_fts MATCH 'nasafter'"
        )
        .fetch_one(&db.pool)
        .await
        .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>("PRAGMA integrity_check")
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        "ok"
    );
    println!("non-sparse migration: {} historical frames verified; receipt present; journal removed; new frame, element and transcript sealed, searchable and intact after restart; source_bytes={} index_bytes={} parquet_bytes={}", report.frames, report.source_bytes, report.index_bytes, report.payload_bytes);
    db.close().await;
}

#[cfg(unix)]
#[tokio::test]
async fn failed_payload_write_resumes_without_discarding_published_files() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    fixture(root.path()).await;
    let changed = std::sync::Mutex::new(Vec::new());
    let result = screenpipe_db::storage::migrate_with_progress(
        root.path(),
        Default::default(),
        Default::default(),
        |p| {
            let mut changed = changed.lock().unwrap();
            if p.completed_records.unwrap_or(0) == 0 || !changed.is_empty() {
                return;
            }
            let journal: serde_json::Value = serde_json::from_slice(
                &std::fs::read(root.path().join("storage-migration.json")).unwrap(),
            )
            .unwrap();
            let directory = root
                .path()
                .join(journal["descriptor"]["payloads"].as_str().unwrap());
            let permissions = std::fs::metadata(&directory).unwrap().permissions();
            std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o500)).unwrap();
            changed.push((directory, permissions));
        },
    )
    .await;
    assert!(result.is_err());
    // Recover while the fault is still present. Recovery must not need another
    // write to the failed archive destination before recording can resume.
    screenpipe_db::storage::recover_interrupted_migration(root.path(), Default::default())
        .await
        .unwrap();
    let db = DatabaseManager::new(
        root.path().join("db.sqlite").to_str().unwrap(),
        Default::default(),
    )
    .await
    .unwrap();
    db.execute_raw_sql_write("INSERT INTO frames(id,timestamp,full_text) VALUES(49,'2026-09-14T12:00:00Z','recording while archive writes fail')").await.unwrap();
    db.close().await;
    for (path, permissions) in changed.into_inner().unwrap() {
        std::fs::set_permissions(path, permissions).unwrap();
    }
    assert!(screenpipe_db::storage::migration_requires_resume(root.path()).unwrap());
    let files: Vec<_> = screenpipe_db::storage::inventory(root.path())
        .unwrap()
        .into_iter()
        .filter(|p| p.extension().is_some_and(|e| e == "parquet"))
        .map(|p| {
            let data = std::fs::read(&p).unwrap();
            (p, data)
        })
        .collect();
    assert!(!files.is_empty());
    migrate(root.path(), Default::default(), Default::default())
        .await
        .unwrap();
    for (p, data) in files {
        assert_eq!(std::fs::read(p).unwrap(), data);
    }
}

#[tokio::test]
#[ignore = "fills a marked disposable non-sparse volume to exercise saved disk-full progress"]
async fn exhausted_volume_resumes_after_space_is_restored() {
    use std::io::Write;
    let volume = std::path::PathBuf::from(std::env::var("SCREENPIPE_CONSTRAINED_VOLUME").unwrap());
    assert!(volume.join(".screenpipe-disposable-volume").is_file());
    assert!(fs2::total_space(&volume).unwrap() <= 512 * 1024 * 1024);
    let root = tempfile::tempdir_in(&volume).unwrap();
    fixture(root.path()).await;
    // Sparse filesystems can reclaim SQLite blocks after the injected ENOSPC
    // and finish successfully. Use a non-sparse volume to require a retry.
    let filler = root.path().join("unrelated-data");
    let filled = std::sync::atomic::AtomicBool::new(false);
    let mut options = MigrationOptions::default();
    options.budget.file_bytes = 1024 * 1024;
    options.budget.record_bytes = 1024 * 1024;
    options.budget.disk_reserve_bytes = 0;
    let result = screenpipe_db::storage::migrate_with_progress(
        root.path(),
        Default::default(),
        options,
        |p| {
            if p.completed_records.unwrap_or(0) == 0
                || filled.swap(true, std::sync::atomic::Ordering::SeqCst)
            {
                return;
            }
            let mut file = std::fs::File::create(&filler).unwrap();
            // Two MiB of headroom can still finish this highly compressible
            // fixture. Exercise an actual full filesystem, not a guessed
            // reserve threshold that can silently stop injecting a failure.
            let block = vec![0x5a; 64 * 1024];
            loop {
                if let Err(error) = file.write_all(&block).and_then(|_| file.sync_all()) {
                    assert_eq!(error.kind(), std::io::ErrorKind::StorageFull);
                    eprintln!("injected actual disk exhaustion: {error}");
                    break;
                }
            }
        },
    )
    .await;
    assert!(filled.load(std::sync::atomic::Ordering::SeqCst));
    assert!(result.is_err());
    assert!(screenpipe_db::storage::migration_requires_resume(root.path()).unwrap());
    assert!(DatabaseManager::new(
        root.path().join("db.sqlite").to_str().unwrap(),
        Default::default()
    )
    .await
    .is_err());
    let files: Vec<_> = screenpipe_db::storage::inventory(root.path())
        .unwrap()
        .into_iter()
        .filter(|p| p.extension().is_some_and(|e| e == "parquet"))
        .map(|p| {
            let data = std::fs::read(&p).unwrap();
            (p, data)
        })
        .collect();
    assert!(!files.is_empty());
    // Release the allocation explicitly: Windows can defer freeing a deleted
    // file while another handle (for example a scanner) still observes it.
    std::fs::File::create(&filler).unwrap().sync_all().unwrap();
    std::fs::remove_file(filler).unwrap();
    migrate(root.path(), Default::default(), Default::default())
        .await
        .unwrap();
    for (p, data) in files {
        assert_eq!(std::fs::read(p).unwrap(), data);
    }
}

#[tokio::test]
async fn reuses_index_and_preserves_history_and_compact_backup() {
    let root = tempfile::tempdir().unwrap();
    fixture(root.path()).await;
    let source = std::fs::metadata(root.path().join("db.sqlite")).unwrap();
    let mut options = MigrationOptions::default();
    options.budget.file_bytes = 1024 * 1024;
    let report = migrate(root.path(), Default::default(), options)
        .await
        .unwrap();
    assert!(!root.path().join("db.sqlite").exists());
    let descriptor = screenpipe_db::storage::StorageDescriptor::read(root.path())
        .unwrap()
        .unwrap();
    let index = std::fs::metadata(root.path().join(descriptor.index)).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        assert_eq!(
            source.ino(),
            index.ino(),
            "migration must reuse the physical index"
        );
        assert!(index.blocks() < source.blocks());
    }
    assert!(report.allocated_after_bytes.unwrap() < report.allocated_before_bytes.unwrap());
    let db = DatabaseManager::new(
        root.path().join("db.sqlite").to_str().unwrap(),
        Default::default(),
    )
    .await
    .unwrap();
    assert_eq!(
        db.frame_payloads(&[1, 48], Projection::All)
            .await
            .unwrap()
            .len(),
        2
    );
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM elements WHERE text='searchable element'")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(count, 48);
    let original_schema: String = sqlx::query_scalar(
        "SELECT sql FROM _storage_conversion_schema WHERE type='table' AND name='frames'",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert!(original_schema.contains("accessibility_tree_json"));
    assert!(!original_schema.contains("payload_detail_present"));
    let backup_root = tempfile::tempdir().unwrap();
    let backup = backup_root.path().join("backup");
    db.backup_to(backup.to_str().unwrap()).await.unwrap();
    let backup_descriptor = screenpipe_db::storage::StorageDescriptor::read(&backup)
        .unwrap()
        .unwrap();
    assert!(
        std::fs::metadata(backup.join(backup_descriptor.index))
            .unwrap()
            .len()
            < source.len() / 2
    );
    db.close().await;
    let exported = tempfile::tempdir().unwrap();
    screenpipe_db::storage::export_sqlite(
        root.path(),
        &exported.path().join("db.sqlite"),
        Default::default(),
    )
    .await
    .unwrap();
    let imported = migrate(exported.path(), Default::default(), Default::default())
        .await
        .unwrap();
    assert_eq!(imported.frames, 48);
}

#[tokio::test]
#[cfg(feature = "storage-fault-injection")]
async fn recording_recovery_keeps_committed_payloads_and_survives_restarts() {
    use screenpipe_db::storage::{
        inventory, recover_interrupted_migration_with_progress, PrivacyPolicy,
    };
    for (point, hit) in [
        ("migration_schema_step", 2),
        ("migration_schema_step", 8),
        ("migration_batch_staged", 2),
        ("seal_files_synced", 1),
        ("seal_committed", 1),
        ("bulk_committed", 1),
        ("migration_blocks_reclaimed", 2),
    ] {
        let root = tempfile::tempdir().unwrap();
        fixture(root.path()).await;
        let crashed = std::process::Command::new(env!("CARGO_BIN_EXE_screenpipe-storage"))
            .arg("migrate")
            .arg(root.path())
            .env("SCREENPIPE_STORAGE_CRASH_AT", point)
            .env("SCREENPIPE_STORAGE_CRASH_HIT", hit.to_string())
            .output()
            .unwrap();
        assert_eq!(
            crashed.status.code(),
            Some(86),
            "{point}: {}",
            String::from_utf8_lossy(&crashed.stderr)
        );
        let payloads = || {
            inventory(root.path())
                .unwrap()
                .into_iter()
                .filter(|p| p.extension().is_some_and(|e| e == "parquet"))
                .map(|p| {
                    let data = std::fs::read(&p).unwrap();
                    (p, data)
                })
                .collect::<std::collections::BTreeMap<_, _>>()
        };
        let before = payloads();
        for id in 49..=50 {
            let started = std::time::Instant::now();
            let phases = std::sync::Mutex::new(Vec::new());
            recover_interrupted_migration_with_progress(
                root.path(),
                Default::default(),
                |progress| {
                    // Recovery describes work without pretending it is another
                    // conversion or inventing a percentage of the whole archive.
                    assert!(progress.total_records.is_none());
                    phases.lock().unwrap().push(progress.message);
                },
            )
            .await
            .unwrap_or_else(|e| panic!("{point}/{hit}: {e}"));
            let phases = phases.into_inner().unwrap();
            if id == 49 {
                assert_eq!(phases.first(), Some(&"checking interrupted storage"));
                assert_eq!(phases.last(), Some(&"opening recovered history"));
                assert!(phases.contains(&"restoring history search indexes"));
            } else {
                assert!(phases.is_empty(), "ready storage must not recover again");
            }
            eprintln!(
                "recording recovery {point}/{hit} launch {id}: {:?}",
                started.elapsed()
            );
            let db = DatabaseManager::new(
                root.path().join("db.sqlite").to_str().unwrap(),
                Default::default(),
            )
            .await
            .unwrap();
            db.verify_storage().await.unwrap();
            assert_eq!(
                db.frame_payloads(&[1, 48], Projection::All).await.unwrap()[&48].text(),
                "searchable migration history"
            );
            assert_eq!(
                sqlx::query_scalar::<_, i64>(
                    "SELECT count(*) FROM frames_fts WHERE frames_fts MATCH 'searchable'"
                )
                .fetch_one(&db.pool)
                .await
                .unwrap(),
                48
            );
            assert_eq!(
                sqlx::query_scalar::<_, i64>(
                    "SELECT count(*) FROM elements_fts WHERE elements_fts MATCH 'searchable'"
                )
                .fetch_one(&db.pool)
                .await
                .unwrap(),
                48
            );
            db.execute_raw_sql_write(&format!("INSERT INTO frames(id,timestamp,full_text) VALUES({id},'2026-09-14T12:00:00Z','recovered recording'); INSERT INTO elements(id,frame_id,source,role,text) VALUES({id},{id},'accessibility','AXText','recovered element')")).await.unwrap();
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT count(*) FROM elements")
                    .fetch_one(&db.pool)
                    .await
                    .unwrap(),
                id
            );
            db.set_frame_privacy_policy(&PrivacyPolicy::default())
                .await
                .unwrap();
            if point == "seal_committed" && id == 49 {
                // Wait beyond the normal maintenance interval: reopening must
                // not quietly continue conversion through the background sealer.
                tokio::time::sleep(std::time::Duration::from_millis(5200)).await;
            }
            db.close().await;
            assert_eq!(
                payloads(),
                before,
                "recovery changed Parquet at {point}/{hit}"
            );
        }
        let report = migrate(root.path(), Default::default(), Default::default())
            .await
            .unwrap_or_else(|e| panic!("explicit retry {point}: {e}"));
        assert_eq!(report.frames, 50);
        let db = DatabaseManager::new(
            root.path().join("db.sqlite").to_str().unwrap(),
            Default::default(),
        )
        .await
        .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM _bulk_element_rows")
                .fetch_one(&db.pool).await.unwrap(),
            0,
            "explicit retry must archive restored elements even after recovery removed the source table"
        );
        assert_eq!(
            db.frame_payloads(&[49, 50], Projection::Search)
                .await
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT count(*) FROM elements_fts WHERE elements_fts MATCH 'recovered'"
            )
            .fetch_one(&db.pool)
            .await
            .unwrap(),
            2
        );
        db.verify_storage().await.unwrap();
        db.close().await;
    }
}

#[tokio::test]
#[cfg(feature = "storage-fault-injection")]
async fn recording_recovery_child() {
    let Ok(root) = std::env::var("SCREENPIPE_TEST_RECOVERY_ROOT") else {
        return;
    };
    screenpipe_db::storage::recover_interrupted_migration(
        std::path::Path::new(&root),
        Default::default(),
    )
    .await
    .unwrap();
}

#[tokio::test]
#[cfg(feature = "storage-fault-injection")]
async fn recording_recovery_is_durable_when_interrupted_before_or_after_activation() {
    for point in ["migration_recovery_ready", "migration_recovery_activated"] {
        let root = tempfile::tempdir().unwrap();
        fixture(root.path()).await;
        let stopped = std::process::Command::new(env!("CARGO_BIN_EXE_screenpipe-storage"))
            .arg("migrate")
            .arg(root.path())
            .env("SCREENPIPE_STORAGE_CRASH_AT", "seal_committed")
            .output()
            .unwrap();
        assert_eq!(stopped.status.code(), Some(86));
        let stopped = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "recording_recovery_child", "--nocapture"])
            .env("SCREENPIPE_TEST_RECOVERY_ROOT", root.path())
            .env("SCREENPIPE_STORAGE_CRASH_AT", point)
            .output()
            .unwrap();
        assert_eq!(
            stopped.status.code(),
            Some(86),
            "{point}: {}",
            String::from_utf8_lossy(&stopped.stderr)
        );
        screenpipe_db::storage::recover_interrupted_migration(root.path(), Default::default())
            .await
            .unwrap();
        let db = DatabaseManager::new(
            root.path().join("db.sqlite").to_str().unwrap(),
            Default::default(),
        )
        .await
        .unwrap();
        db.verify_storage().await.unwrap();
        db.execute_raw_sql_write("INSERT INTO frames(id,timestamp,full_text) VALUES(49,'2026-09-14T12:00:00Z','recording after interrupted recovery')").await.unwrap();
        db.close().await;
    }
}

#[tokio::test]
async fn migration_verification_does_not_use_the_response_payload_budget() {
    for include_oversized in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("db.sqlite");
        let db = DatabaseManager::new(path.to_str().unwrap(), Default::default())
            .await
            .unwrap();
        let ordinary = "detail 東京\0".repeat(40);
        let oversized = ordinary.repeat(4);
        let mut tx = db.begin_immediate_with_retry().await.unwrap();
        for id in 1..=132 {
            let detail = if include_oversized && id == 1 {
                &oversized
            } else {
                &ordinary
            };
            sqlx::query("INSERT INTO frames(id,timestamp,full_text,accessibility_tree_json) VALUES(?,'2026-09-16T12:00:00Z','history',?)")
                .bind(id).bind(detail).execute(&mut **tx.conn()).await.unwrap();
        }
        tx.commit().await.unwrap();
        db.close().await;
        let mut options = MigrationOptions::default();
        options.budget.row_group_rows = 1;
        options.budget.file_rows = 1;
        options.budget.file_bytes = 1024;
        options.budget.record_bytes = 1024;
        options.budget.response_bytes = 1024;
        assert!(ordinary.len() < options.budget.record_bytes);
        assert!(oversized.len() > options.budget.response_bytes);
        let report = migrate(root.path(), Default::default(), options)
            .await
            .unwrap();
        assert_eq!(report.frames, 132);
        let db = DatabaseManager::new(path.to_str().unwrap(), Default::default())
            .await
            .unwrap();
        db.verify_storage().await.unwrap();
        assert!(db
            .frame_payloads(&[2, 3], Projection::All)
            .await
            .unwrap_err()
            .to_string()
            .contains("response payload budget exceeded"));
        if include_oversized {
            let (state, detail): (String, Option<String>) = sqlx::query_as("SELECT p.state,f.accessibility_tree_json FROM frames f JOIN frame_payloads p ON p.frame_id=f.id WHERE f.id=1")
                .fetch_one(&db.pool).await.unwrap();
            assert_eq!(state, "sealed");
            assert!(detail.is_none());
            assert_eq!(
                db.frame_payloads(&[1], Projection::All).await.unwrap()[&1]
                    .accessibility_tree_json
                    .as_deref(),
                Some(oversized.as_str())
            );
        }
        assert_eq!(
            db.frame_payloads(&[132], Projection::All).await.unwrap()[&132]
                .accessibility_tree_json
                .as_deref(),
            Some(ordinary.as_str())
        );
        db.execute_raw_sql_write("INSERT INTO frames(id,timestamp,full_text) VALUES(133,'2026-09-16T12:01:00Z','recording after verification')").await.unwrap();
        db.close().await;
    }
}

#[tokio::test]
async fn oversized_legacy_frames_are_archived_without_blocking_capture() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("db.sqlite");
    let db = DatabaseManager::new(path.to_str().unwrap(), Default::default())
        .await
        .unwrap();
    let detail = "legacy detail 東京 ".repeat(160_000);
    let mut tx = db.begin_immediate_with_retry().await.unwrap();
    for id in [1, 2] {
        sqlx::query("INSERT INTO frames(id,timestamp,full_text,accessibility_tree_json) VALUES(?,'2026-09-14T12:00:00Z','oversized history',?)")
            .bind(id).bind(&detail).execute(&mut **tx.conn()).await.unwrap();
    }
    tx.commit().await.unwrap();
    db.execute_raw_sql_write("INSERT INTO frames(id,timestamp,full_text) VALUES(3,'2026-09-14T12:00:00Z','ordinary history')").await.unwrap();
    db.close().await;
    let mut options = MigrationOptions::default();
    options.budget.row_group_rows = 1;
    options.budget.file_rows = 1;
    options.budget.file_bytes = 64 * 1024;
    options.budget.record_bytes = 1024 * 1024;
    options.budget.decode_bytes = 2 * 1024 * 1024;
    options.budget.staging_bytes = 1024 * 1024;
    // Each old record exceeds both decode and staging budgets. The one-time
    // migration must archive it in its own file and release its SQLite pages.
    assert!(detail.len() > options.budget.decode_bytes);
    let report = migrate(root.path(), Default::default(), options)
        .await
        .unwrap();
    assert_eq!(report.frames, 3);
    eprintln!(
        "oversized migration disk allocation: before={} after={} parquet={}",
        report.allocated_before_bytes.unwrap(),
        report.allocated_after_bytes.unwrap(),
        report.payload_bytes
    );
    let db = DatabaseManager::new(path.to_str().unwrap(), Default::default())
        .await
        .unwrap();
    db.verify_storage().await.unwrap();
    let mut payloads = db
        .frame_payloads(&[1, 2, 3], Projection::All)
        .await
        .unwrap();
    for id in [1, 2] {
        assert_eq!(
            payloads[&id].accessibility_tree_json.as_deref(),
            Some(detail.as_str())
        );
        assert_eq!(
            payloads[&id].full_text.as_deref(),
            Some("oversized history")
        );
    }
    assert_eq!(payloads[&3].full_text.as_deref(), Some("ordinary history"));
    assert_eq!(
        sqlx::query_as::<_, (i64, i64)>("SELECT staging_bytes,(SELECT count(*) FROM frame_payloads WHERE state='sealed') FROM storage_metadata")
            .fetch_one(&db.pool).await.unwrap(),
        (0, 3)
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM main.frames WHERE accessibility_tree_json IS NOT NULL"
        )
        .fetch_one(&db.pool)
        .await
        .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM frames_fts WHERE frames_fts MATCH 'oversized'"
        )
        .fetch_one(&db.pool)
        .await
        .unwrap(),
        2
    );
    assert_eq!(db.seal_frame_payloads().await.unwrap(), 0);

    // Archived records still support coordinated metadata/privacy updates.
    assert!(db
        .replace_frame_payload(&payloads[&2], "", 15, Some("renamed window"), None)
        .await
        .unwrap());
    let mut payload = payloads.remove(&1).unwrap();
    payload.accessibility_tree_json = Some("x".repeat(2 * 1024 * 1024));
    assert!(db
        .replace_frame_payload(&payload, "", 15, None, None)
        .await
        .unwrap());
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT staging_bytes FROM storage_metadata")
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        0
    );
    let mut payload = db
        .frame_payloads(&[1], Projection::All)
        .await
        .unwrap()
        .remove(&1)
        .unwrap();
    payload.accessibility_tree_json = Some("redacted detail".into());
    assert!(db
        .replace_frame_payload(&payload, "", 15, None, None)
        .await
        .unwrap());
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT staging_bytes FROM storage_metadata")
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        payload.bytes() as i64
    );
    assert_eq!(db.seal_frame_payloads().await.unwrap(), 1);
    db.execute_raw_sql_write("DELETE FROM frames WHERE id=2; INSERT INTO frames(id,timestamp,full_text) VALUES(4,'2026-09-14T12:01:00Z','new recording')").await.unwrap();
    assert_eq!(db.seal_frame_payloads().await.unwrap(), 1);
    db.close().await;

    let db = DatabaseManager::new(path.to_str().unwrap(), Default::default())
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT staging_bytes FROM storage_metadata")
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        db.frame_payloads(&[4], Projection::Search).await.unwrap()[&4]
            .full_text
            .as_deref(),
        Some("new recording")
    );
    db.verify_storage().await.unwrap();
    db.close().await;
}

#[cfg(feature = "storage-fault-injection")]
#[tokio::test]
async fn oversized_legacy_frame_resumes_after_staging_without_rebuilding_sealed_files() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("db.sqlite");
    let db = DatabaseManager::new(path.to_str().unwrap(), Default::default())
        .await
        .unwrap();
    db.execute_raw_sql_write("INSERT INTO frames(id,timestamp,full_text,accessibility_tree_json) VALUES(1,'2026-09-14T12:00:00Z','first history',NULL),(2,'2026-09-14T12:00:01Z','large history',printf('%.*c',41943040,'x')),(3,'2026-09-14T12:00:02Z','later history',NULL)").await.unwrap();
    db.close().await;
    let stopped = std::process::Command::new(env!("CARGO_BIN_EXE_screenpipe-storage"))
        .arg("migrate")
        .arg(root.path())
        .env("SCREENPIPE_STORAGE_CRASH_AT", "migration_batch_staged")
        .env("SCREENPIPE_STORAGE_CRASH_HIT", "2")
        .output()
        .unwrap();
    assert_eq!(
        stopped.status.code(),
        Some(86),
        "{}",
        String::from_utf8_lossy(&stopped.stderr)
    );
    let published: Vec<_> = screenpipe_db::storage::inventory(root.path())
        .unwrap()
        .into_iter()
        .filter(|p| p.extension().is_some_and(|ext| ext == "parquet"))
        .map(|p| {
            let bytes = std::fs::read(&p).unwrap();
            (p, bytes)
        })
        .collect();
    assert!(!published.is_empty());
    migrate(root.path(), Default::default(), Default::default())
        .await
        .unwrap();
    for (path, bytes) in published {
        assert_eq!(std::fs::read(path).unwrap(), bytes);
    }
    let db = DatabaseManager::new(path.to_str().unwrap(), Default::default())
        .await
        .unwrap();
    assert_eq!(
        db.frame_payloads(&[2], Projection::All).await.unwrap()[&2]
            .accessibility_tree_json
            .as_deref(),
        Some("x".repeat(41943040).as_str())
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM frame_payloads WHERE state='sealed'")
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        3
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT staging_bytes FROM storage_metadata")
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        0
    );
    db.verify_storage().await.unwrap();
    db.close().await;
}
