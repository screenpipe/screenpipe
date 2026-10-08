// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use screenpipe_db::storage::{migrate, MigrationOptions, PrivacyPolicy, Projection, StorageMode};
use screenpipe_db::{ContentType, DatabaseManager};
use sqlx::Connection;

async fn seed(db: &DatabaseManager, id: i64, text: Option<&str>, accessibility: Option<&str>) {
    let mut tx = db.begin_immediate_with_retry().await.unwrap();
    sqlx::query("INSERT INTO frames(id,timestamp,full_text,accessibility_text,text_json,accessibility_tree_json,app_name,window_name,device_name) VALUES(?,'2026-09-11T12:00:00Z',?,?,'[{\"text\":\"hello\",\"left\":0.5}]','{\"text\":\"hello\"}','Editor','notes','display')")
        .bind(id).bind(text).bind(accessibility).execute(&mut **tx.conn()).await.unwrap();
    tx.commit().await.unwrap();
}

async fn search(db: &DatabaseManager, query: &str) -> serde_json::Value {
    let results = db
        .search(
            query,
            ContentType::OCR,
            100,
            0,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
    serde_json::to_value(results).unwrap()
}

#[tokio::test]
async fn staged_sealed_reopened_search_and_full_payloads_match() {
    let root = tempfile::tempdir().unwrap();
    let db = DatabaseManager::new_hybrid(root.path(), Default::default(), Default::default())
        .await
        .unwrap();
    seed(&db, 1, Some("hello café 東京"), Some("accessibility")).await;
    seed(&db, 2, None, Some("fallback")).await;
    seed(&db, 3, Some(""), Some("must remain empty")).await;
    let before = db
        .frame_payloads(&[1, 2, 3], Projection::All)
        .await
        .unwrap();
    let results = search(&db, "hello").await;
    assert_eq!(db.seal_frame_payloads().await.unwrap(), 3);
    assert_eq!(
        before,
        db.frame_payloads(&[1, 2, 3], Projection::All)
            .await
            .unwrap()
    );
    assert_eq!(results, search(&db, "hello").await);
    let stored:i64=sqlx::query_scalar("SELECT count(*) FROM frames WHERE full_text IS NOT NULL OR text_json IS NOT NULL OR accessibility_tree_json IS NOT NULL OR accessibility_text IS NOT NULL").fetch_one(&db.pool).await.unwrap();
    assert_eq!(stored, 0);
    let durability: i64 = sqlx::query_scalar("PRAGMA synchronous")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(durability, 2);
    db.close().await;
    let reopened = DatabaseManager::new(
        root.path().join("db.sqlite").to_str().unwrap(),
        Default::default(),
    )
    .await
    .unwrap();
    assert_eq!(reopened.storage_mode(), StorageMode::HybridParquetV1);
    assert_eq!(
        before,
        reopened
            .frame_payloads(&[1, 2, 3], Projection::All)
            .await
            .unwrap()
    );
    assert_eq!(results, search(&reopened, "hello").await);
    reopened.close().await;
    let relative = std::process::Command::new(env!("CARGO_BIN_EXE_screenpipe-storage"))
        .current_dir(root.path())
        .arg("verify")
        .arg("")
        .output()
        .unwrap();
    assert!(
        relative.status.success(),
        "{}",
        String::from_utf8_lossy(&relative.stderr)
    );
}

#[tokio::test]
async fn privacy_completion_and_reader_leases_own_original_file_removal() {
    let root = tempfile::tempdir().unwrap();
    let options = MigrationOptions {
        privacy: PrivacyPolicy {
            identity: "policy-1".into(),
            required_surfaces: 15,
        },
        ..Default::default()
    };
    let db = DatabaseManager::new_hybrid(root.path(), Default::default(), options)
        .await
        .unwrap();
    seed(&db, 1, Some("secret"), Some("secret")).await;
    seed(&db, 2, Some("keep"), Some("keep")).await;
    assert_eq!(db.seal_frame_payloads().await.unwrap(), 0);
    for p in db
        .frame_payloads(&[1, 2], Projection::All)
        .await
        .unwrap()
        .into_values()
    {
        assert!(db
            .replace_frame_payload(&p, "policy-1", 15, None, None)
            .await
            .unwrap());
    }
    assert_eq!(db.seal_frame_payloads().await.unwrap(), 2);
    let original: String =
        sqlx::query_scalar("SELECT search_path FROM payload_files WHERE state='published'")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    let token = db.storage_read_token().await.unwrap();
    let mut payload = db
        .frame_payloads(&[1], Projection::All)
        .await
        .unwrap()
        .remove(&1)
        .unwrap();
    payload.full_text = Some("[REDACTED]".into());
    payload.accessibility_text = Some("[REDACTED]".into());
    assert!(db
        .replace_frame_payload(&payload, "policy-1", 15, None, None)
        .await
        .unwrap());
    assert!(!db
        .replace_frame_payload(&payload, "policy-1", 15, None, None)
        .await
        .unwrap());
    assert!(token.admit(&db.pool).await.is_err());
    db.reclaim_frame_payloads().await.unwrap();
    assert!(root.path().join(&original).exists());
    drop(token);
    db.reclaim_frame_payloads().await.unwrap();
    assert!(!root.path().join(&original).exists());
    assert_eq!(
        db.frame_payloads(&[2], Projection::Search).await.unwrap()[&2].text(),
        "keep"
    );
    assert!(search(&db, "secret").await.as_array().unwrap().is_empty());
    db.close().await;
}

#[tokio::test]
async fn legacy_migration_preserves_original_until_explicit_deletion_on_live_generation() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("db.sqlite");
    let db = DatabaseManager::new(path.to_str().unwrap(), Default::default())
        .await
        .unwrap();
    seed(&db, 7, Some("migration café"), None).await;
    let identity = db.upload_source_id().await.unwrap().to_owned();
    db.execute_raw_sql_write("CREATE TABLE test_mutable_state(id INTEGER PRIMARY KEY,state BLOB); INSERT INTO test_mutable_state VALUES(1,x'000102ff');").await.unwrap();
    let before = db.frame_payloads(&[7], Projection::All).await.unwrap();
    let mut projected = Vec::new();
    for projection in [Projection::Search, Projection::Detail] {
        let payloads = db.frame_payloads(&[7], projection).await.unwrap();
        match projection {
            Projection::Search => assert!(payloads[&7].text_json.is_none()),
            Projection::Detail => assert!(payloads[&7].full_text.is_none()),
            Projection::All => unreachable!(),
        }
        projected.push((projection, payloads));
    }
    db.close().await;
    // Model the retained original from an already completed copy-based install.
    // New migrations themselves never create this fixture copy.
    let retained = root.path().join("legacy-original.sqlite");
    let mut source = sqlx::SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new().filename(&path),
    )
    .await
    .unwrap();
    sqlx::query("VACUUM INTO ?")
        .bind(retained.to_str().unwrap())
        .execute(&mut source)
        .await
        .unwrap();
    source.close().await.unwrap();
    let mut report = migrate(root.path(), Default::default(), Default::default())
        .await
        .unwrap();
    std::fs::rename(retained, &path).unwrap();
    let metadata = std::fs::metadata(&path).unwrap();
    #[cfg(unix)]
    let file_id = {
        use std::os::unix::fs::MetadataExt;
        Some((metadata.dev(), metadata.ino()))
    };
    #[cfg(not(unix))]
    let file_id: Option<(u64, u64)> = None;
    report.source_identity = Some(
        serde_json::from_value(serde_json::json!({
            "bytes":metadata.len(), "modified":metadata.modified().unwrap(), "file_id":file_id
        }))
        .unwrap(),
    );
    report.allocated_before_bytes = None;
    report.allocated_after_bytes = None;
    report.source_bytes = metadata.len();
    std::fs::write(
        root.path().join("storage-migration-complete.json"),
        serde_json::to_vec(&report).unwrap(),
    )
    .unwrap();
    assert_eq!(report.frames, 1);
    assert!(path.exists());
    assert!(root.path().join("storage.json").exists());
    assert!(!root.path().join("storage-migration.json").exists());
    let db = DatabaseManager::new(path.to_str().unwrap(), Default::default())
        .await
        .unwrap();
    let after = db.frame_payloads(&[7], Projection::All).await.unwrap();
    assert_eq!(before[&7].full_text, after[&7].full_text);
    assert_eq!(db.upload_source_id().await.unwrap(), identity);
    for (projection, mut expected) in projected {
        let mut actual = db.frame_payloads(&[7], projection).await.unwrap();
        for payload in expected.values_mut().chain(actual.values_mut()) {
            payload.generation = 0;
        }
        assert_eq!(expected, actual);
    }
    let blob: Vec<u8> = sqlx::query_scalar("SELECT state FROM test_mutable_state")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(blob, [0, 1, 2, 255]);
    seed(&db, 8, Some("after activation"), None).await;
    assert_eq!(
        db.frame_payloads(&[8], Projection::Search).await.unwrap()[&8].text(),
        "after activation"
    );
    assert_eq!(
        db.retained_migration_source_bytes().unwrap(),
        Some(report.source_bytes)
    );
    assert!(db
        .delete_migration_source("stale-generation")
        .await
        .is_err());
    assert!(path.exists());
    let receipt_path = root.path().join("storage-migration-complete.json");
    let receipt = std::fs::read(&receipt_path).unwrap();
    std::fs::remove_file(&receipt_path).unwrap();
    assert!(db
        .delete_migration_source(&report.generation)
        .await
        .is_err());
    assert!(path.exists());
    std::fs::write(&receipt_path, receipt).unwrap();
    let pending_path = root.path().join("storage-migration.json");
    std::fs::write(&pending_path, b"{}").unwrap();
    assert!(db
        .delete_migration_source(&report.generation)
        .await
        .is_err());
    std::fs::remove_file(pending_path).unwrap();
    let original_owner =
        screenpipe_sqlite_coordinator::acquire_sqlite_manager_lease(&path).unwrap();
    assert!(db
        .delete_migration_source(&report.generation)
        .await
        .is_err());
    assert!(path.exists());
    original_owner.release();
    // A leftover WAL index contains no database records. Completion/status must
    // tolerate it while real WAL/journal data still prevents source deletion.
    let shm_path = root.path().join("db.sqlite-shm");
    std::fs::write(&shm_path, [0u8; 32768]).unwrap();
    assert_eq!(
        db.retained_migration_source_bytes().unwrap(),
        Some(report.source_bytes)
    );
    assert!(path.exists());
    let wal_path = root.path().join("db.sqlite-wal");
    std::fs::write(&wal_path, b"unmigrated writes").unwrap();
    assert!(db
        .delete_migration_source(&report.generation)
        .await
        .is_err());
    std::fs::remove_file(wal_path).unwrap();
    let journal_path = root.path().join("db.sqlite-journal");
    std::fs::write(&journal_path, b"unmigrated writes").unwrap();
    assert!(db
        .delete_migration_source(&report.generation)
        .await
        .is_err());
    assert!(path.exists());
    std::fs::remove_file(journal_path).unwrap();
    let original_meta = std::fs::metadata(&path).unwrap();
    let original = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
    original.set_len(original_meta.len() + 1).unwrap();
    assert!(db
        .delete_migration_source(&report.generation)
        .await
        .is_err());
    assert!(path.exists());
    original.set_len(original_meta.len()).unwrap();
    original
        .set_times(std::fs::FileTimes::new().set_modified(original_meta.modified().unwrap()))
        .unwrap();
    drop(original);
    assert_eq!(
        db.delete_migration_source(&report.generation)
            .await
            .unwrap(),
        report.source_bytes
    );
    assert!(!path.exists());
    assert!(db
        .delete_migration_source(&report.generation)
        .await
        .is_err());
    assert_eq!(
        db.frame_payloads(&[8], Projection::Search).await.unwrap()[&8].text(),
        "after activation"
    );
    db.close().await;
    // Automatic hidden-UI cleanup must also survive the next app launch:
    // opening the legacy path follows the active generation even when the
    // original file is gone, preserving old history and subsequent writes.
    let reopened = DatabaseManager::new(path.to_str().unwrap(), Default::default())
        .await
        .unwrap();
    assert!(!path.exists());
    let payloads = reopened
        .frame_payloads(&[7, 8], Projection::Search)
        .await
        .unwrap();
    assert_eq!(payloads[&7].text(), "migration café");
    assert_eq!(payloads[&8].text(), "after activation");
    assert_eq!(
        search(&reopened, "migration")
            .await
            .as_array()
            .unwrap()
            .len(),
        1
    );
    seed(&reopened, 9, Some("after cleanup restart"), None).await;
    assert_eq!(
        reopened
            .frame_payloads(&[9], Projection::Search)
            .await
            .unwrap()[&9]
            .text(),
        "after cleanup restart"
    );
    assert_eq!(
        search(&reopened, "cleanup").await.as_array().unwrap().len(),
        1
    );
    reopened.close().await;
}

#[tokio::test]
async fn corruption_fails_reads_without_returning_partial_payloads() {
    let root = tempfile::tempdir().unwrap();
    let db = DatabaseManager::new_hybrid(root.path(), Default::default(), Default::default())
        .await
        .unwrap();
    seed(&db, 1, Some("hello"), None).await;
    db.seal_frame_payloads().await.unwrap();
    let path: String =
        sqlx::query_scalar("SELECT detail_path FROM payload_files WHERE state='published'")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    std::fs::write(root.path().join(path), b"corrupt").unwrap();
    assert!(db
        .frame_payloads(&[1], Projection::All)
        .await
        .unwrap_err()
        .to_string()
        .contains("checksum"));
    assert_eq!(
        db.frame_payloads(&[1], Projection::Search).await.unwrap()[&1].text(),
        "hello"
    );
    db.close().await;
}

#[tokio::test]
async fn backup_restores_staging_files_and_source_identity() {
    // Unix permits URL delimiters in filenames; Windows canonicalization
    // itself supplies the verbatim prefix containing a question mark.
    let parent = tempfile::Builder::new()
        .prefix(if cfg!(unix) {
            "history?mode=ro"
        } else {
            "history"
        })
        .tempdir()
        .unwrap();
    let root = parent.path().join("source");
    let db = DatabaseManager::new_hybrid(&root, Default::default(), Default::default())
        .await
        .unwrap();
    seed(&db, 1, Some("archived"), None).await;
    db.seal_frame_payloads().await.unwrap();
    seed(&db, 2, Some("staged"), Some("other")).await;
    let identity = db.upload_source_id().await.unwrap().to_owned();
    let before = db.frame_payloads(&[1, 2], Projection::All).await.unwrap();
    let backup = parent.path().join("backup");
    db.backup_to(backup.to_str().unwrap()).await.unwrap();
    let restored = parent.path().join("restored");
    screenpipe_db::storage::restore(&backup, &restored, Default::default())
        .await
        .unwrap();
    let copy = DatabaseManager::new(
        restored.join("db.sqlite").to_str().unwrap(),
        Default::default(),
    )
    .await
    .unwrap();
    assert_eq!(
        before,
        copy.frame_payloads(&[1, 2], Projection::All).await.unwrap()
    );
    assert_eq!(identity, copy.upload_source_id().await.unwrap());
    copy.close().await;
    db.close().await;
}

#[tokio::test]
async fn lean_retention_replaces_archived_details_and_preserves_search() {
    let root = tempfile::tempdir().unwrap();
    let db = DatabaseManager::new_hybrid(root.path(), Default::default(), Default::default())
        .await
        .unwrap();
    seed(&db, 1, Some("retained text"), Some("retained a11y")).await;
    db.seal_frame_payloads().await.unwrap();
    db.strip_heavy_text_in_range(
        "2026-09-11T00:00:00Z".parse().unwrap(),
        "2026-09-12T00:00:00Z".parse().unwrap(),
    )
    .await
    .unwrap();
    let payload = db
        .frame_payloads(&[1], Projection::All)
        .await
        .unwrap()
        .remove(&1)
        .unwrap();
    assert_eq!(payload.text(), "retained text");
    assert!(payload.text_json.is_none());
    assert!(payload.accessibility_tree_json.is_none());
    assert!(!search(&db, "retained").await.as_array().unwrap().is_empty());
    db.close().await;
}

#[tokio::test]
async fn resident_sql_resolves_wildcards_aliases_and_views() {
    let root = tempfile::tempdir().unwrap();
    let db = DatabaseManager::new_hybrid(root.path(), Default::default(), Default::default())
        .await
        .unwrap();
    seed(&db, 1, Some("private payload"), None).await;
    db.execute_raw_sql_write("CREATE VIEW payload_view AS SELECT full_text AS words FROM frames")
        .await
        .unwrap();
    for query in [
        "SELECT f.* FROM frames f LIMIT 1",
        "SELECT words FROM payload_view LIMIT 1",
        "SELECT full_text AS t FROM frames LIMIT 1",
    ] {
        assert!(
            db.query_raw_sql(query)
                .await
                .unwrap_err()
                .to_string()
                .contains("unsupported-storage-query"),
            "{query}"
        );
    }
    assert!(db
        .query_raw_sql("SELECT 'full_text' AS label, id FROM frames LIMIT 1")
        .await
        .is_ok());
    db.seal_frame_payloads().await.unwrap();
    assert_eq!(search(&db, "private").await.as_array().unwrap().len(), 1);
    db.close().await;
}

#[tokio::test]
async fn compact_and_legacy_export_preserve_logical_records() {
    let parent = tempfile::tempdir().unwrap();
    let root = parent.path().join("source");
    let db = DatabaseManager::new_hybrid(&root, Default::default(), Default::default())
        .await
        .unwrap();
    seed(&db, 1, Some("old text"), None).await;
    db.seal_frame_payloads().await.unwrap();
    let mut payload = db
        .frame_payloads(&[1], Projection::All)
        .await
        .unwrap()
        .remove(&1)
        .unwrap();
    payload.full_text = Some("replacement café".into());
    db.replace_frame_payload(&payload, "", 0, None, None)
        .await
        .unwrap();
    db.seal_frame_payloads().await.unwrap();
    db.reclaim_frame_payloads().await.unwrap();
    let before = search(&db, "replacement").await;
    let old = screenpipe_db::storage::StorageDescriptor::read(&root)
        .unwrap()
        .unwrap();
    db.close().await;
    screenpipe_db::storage::compact(&root, Default::default())
        .await
        .unwrap();
    let new = screenpipe_db::storage::StorageDescriptor::read(&root)
        .unwrap()
        .unwrap();
    assert_ne!(old.generation, new.generation);
    assert_eq!(old.payloads, new.payloads);
    assert!(!root.join(old.index).exists());
    let export = parent.path().join("legacy.sqlite");
    screenpipe_db::storage::export_sqlite(&root, &export, Default::default())
        .await
        .unwrap();
    let db = DatabaseManager::new(export.to_str().unwrap(), Default::default())
        .await
        .unwrap();
    assert_eq!(db.storage_mode(), StorageMode::Sqlite);
    assert_eq!(before, search(&db, "replacement").await);
    assert!(search(&db, "old").await.as_array().unwrap().is_empty());
    seed(&db, 2, Some("new legacy write"), None).await;
    assert_eq!(search(&db, "legacy").await.as_array().unwrap().len(), 1);
    db.close().await;
}

#[tokio::test]
async fn legacy_exports_can_be_migrated_again() {
    for populated in [false, true] {
        // Unix permits URL delimiters in filenames; Windows canonicalization
        // itself supplies the verbatim prefix containing a question mark.
        let parent = tempfile::Builder::new()
            .prefix(if cfg!(unix) {
                "history?mode=ro"
            } else {
                "history"
            })
            .tempdir()
            .unwrap();
        let root = parent.path().join("source");
        let db = DatabaseManager::new_hybrid(&root, Default::default(), Default::default())
            .await
            .unwrap();
        if populated {
            seed(&db, 1, Some("export café 東京"), Some("accessible text")).await;
            db.seal_frame_payloads().await.unwrap();
            seed(&db, 2, None, Some("")).await;
        }
        let expected_payloads = db.frame_payloads(&[1, 2], Projection::All).await.unwrap();
        let expected_search = search(&db, "export").await;
        db.close().await;

        let exported_root = parent.path().join("exported");
        std::fs::create_dir(&exported_root).unwrap();
        let exported_path = exported_root.join("db.sqlite");
        screenpipe_db::storage::export_sqlite(&root, &exported_path, Default::default())
            .await
            .unwrap();

        migrate(&exported_root, Default::default(), Default::default())
            .await
            .unwrap();
        assert!(!exported_path.exists());

        let remigrated = DatabaseManager::new(exported_path.to_str().unwrap(), Default::default())
            .await
            .unwrap();
        assert_eq!(remigrated.storage_mode(), StorageMode::HybridParquetV1);
        assert_eq!(
            remigrated
                .frame_payloads(&[1, 2], Projection::All)
                .await
                .unwrap(),
            expected_payloads
        );
        assert_eq!(search(&remigrated, "export").await, expected_search);
        remigrated.verify_storage().await.unwrap();
        remigrated.close().await;
    }
}

#[tokio::test]
async fn archive_record_budget_keeps_large_captures_resident_and_archives_later_work() {
    let root = tempfile::tempdir().unwrap();
    let mut options = MigrationOptions::default();
    options.budget.record_bytes = 1024;
    options.budget.staging_bytes = options.budget.record_bytes as u64;
    let limit = options.budget.record_bytes;
    let db = DatabaseManager::new_hybrid(root.path(), Default::default(), options)
        .await
        .unwrap();
    let large = "x".repeat(limit + 1);
    let mut tx = db.begin_immediate_with_retry().await.unwrap();
    sqlx::query("INSERT INTO frames(id,timestamp,full_text) VALUES(1,'2026-09-11',?)")
        .bind(&large)
        .execute(&mut **tx.conn())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM frames")
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        1
    );
    seed(&db, 2, Some("complete payload"), None).await;
    assert_eq!(db.seal_frame_payloads().await.unwrap(), 1);
    assert_eq!(
        db.frame_payloads(&[1], Projection::All).await.unwrap()[&1]
            .full_text
            .as_deref(),
        Some(large.as_str())
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT staging_bytes FROM storage_metadata")
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        0
    );
    assert!(db
        .admit_consumer_sync()
        .unwrap_err()
        .to_string()
        .contains("binding unavailable"));
    db.close().await;
}

#[cfg(feature = "storage-fault-injection")]
#[tokio::test]
async fn migration_crashes_resume_without_losing_acknowledged_records() {
    for point in [
        "migration_before_rename",
        "migration_after_rename",
        "migration_schema_step",
        "migration_batch_staged",
        "seal_reserved",
        "seal_files_synced",
        "seal_before_commit",
        "seal_committed",
        "migration_batch_sealed",
        "migration_ready",
        "migration_activated",
        "migration_completed",
    ] {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("db.sqlite");
        let db = DatabaseManager::new(path.to_str().unwrap(), Default::default())
            .await
            .unwrap();
        seed(
            &db,
            7,
            Some("survives crash café"),
            Some("distinct accessibility"),
        )
        .await;
        let identity = db.upload_source_id().await.unwrap().to_owned();
        let before = search(&db, "survives").await;
        db.close().await;
        let killed = std::process::Command::new(env!("CARGO_BIN_EXE_screenpipe-storage"))
            .arg("migrate")
            .arg(root.path())
            .env("SCREENPIPE_STORAGE_CRASH_AT", point)
            .output()
            .unwrap();
        assert_eq!(
            killed.status.code(),
            Some(86),
            "{point}: {}",
            String::from_utf8_lossy(&killed.stderr)
        );
        assert!(screenpipe_db::storage::migration_requires_resume(root.path()).unwrap());
        assert!(
            DatabaseManager::new(path.to_str().unwrap(), Default::default())
                .await
                .is_err(),
            "{point}"
        );
        migrate(root.path(), Default::default(), Default::default())
            .await
            .unwrap();
        let db = DatabaseManager::new(path.to_str().unwrap(), Default::default())
            .await
            .unwrap();
        assert!(!path.exists(), "source becomes the index after {point}");
        assert!(
            db.retained_migration_source_bytes()
                .unwrap_or_else(|error| panic!("{point}: {error}"))
                .is_none(),
            "{point}"
        );
        assert_eq!(db.upload_source_id().await.unwrap(), identity, "{point}");
        assert_eq!(before, search(&db, "survives").await, "{point}");
        db.reclaim_frame_payloads().await.unwrap();
        db.verify_storage().await.unwrap();
        db.close().await;
    }
}

#[cfg(feature = "storage-fault-injection")]
#[tokio::test]
async fn interrupted_initialization_resumes_its_recorded_generation() {
    for point in [
        "migration_schema_step",
        "initialization_ready",
        "initialization_activated",
    ] {
        let root = tempfile::tempdir().unwrap();
        let killed = std::process::Command::new(env!("CARGO_BIN_EXE_screenpipe-storage"))
            .arg("init")
            .arg(root.path())
            .env("SCREENPIPE_STORAGE_CRASH_AT", point)
            .output()
            .unwrap();
        assert_eq!(
            killed.status.code(),
            Some(86),
            "{}",
            String::from_utf8_lossy(&killed.stderr)
        );
        let expected: serde_json::Value =
            serde_json::from_slice(&std::fs::read(root.path().join("storage-init.json")).unwrap())
                .unwrap();
        let db = DatabaseManager::new_hybrid(root.path(), Default::default(), Default::default())
            .await
            .unwrap();
        let active = screenpipe_db::storage::StorageDescriptor::read(root.path())
            .unwrap()
            .unwrap();
        assert_eq!(active.generation, expected["generation"].as_str().unwrap());
        seed(&db, 1, Some("ready after interruption"), None).await;
        db.close().await;
    }
}

#[cfg(feature = "storage-fault-injection")]
#[tokio::test]
async fn interrupted_desktop_migration_restores_recording_without_conversion_retry() {
    use screenpipe_db::storage::recover_interrupted_migration;

    for point in [
        "migration_before_rename",
        "migration_after_rename",
        "migration_ready",
        "migration_activated",
    ] {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("db.sqlite");
        let db = DatabaseManager::new(path.to_str().unwrap(), Default::default())
            .await
            .unwrap();
        seed(&db, 7, Some("before restart"), None).await;
        db.close().await;
        let killed = std::process::Command::new(env!("CARGO_BIN_EXE_screenpipe-storage"))
            .arg("migrate")
            .arg(root.path())
            .env("SCREENPIPE_STORAGE_CRASH_AT", point)
            .output()
            .unwrap();
        assert_eq!(killed.status.code(), Some(86), "{point}");

        for id in 8..=9 {
            recover_interrupted_migration(root.path(), Default::default())
                .await
                .unwrap();
            let db = DatabaseManager::new(path.to_str().unwrap(), Default::default())
                .await
                .unwrap();
            assert_eq!(
                db.frame_payloads(&[7], Projection::Search).await.unwrap()[&7].text(),
                "before restart"
            );
            seed(&db, id, Some("recording with migration paused"), None).await;
            assert_eq!(
                search(&db, "recording").await.as_array().unwrap().len(),
                (id - 7) as usize
            );
            let mut last_reader = if point == "migration_before_rename" {
                let mut reader = sqlx::SqliteConnection::connect_with(
                    &sqlx::sqlite::SqliteConnectOptions::new()
                        .filename(&path)
                        .read_only(true),
                )
                .await
                .unwrap();
                sqlx::query("SELECT count(*) FROM frames")
                    .fetch_one(&mut reader)
                    .await
                    .unwrap();
                Some(reader)
            } else {
                None
            };
            db.close().await;
            if let Some(reader) = last_reader.take() {
                reader.close().await.unwrap();
                assert!(
                    root.path().join("db.sqlite-wal").exists(),
                    "read-only last closer must exercise retained WAL recovery"
                );
            }
        }
        assert!(root.path().join("storage-migration.json").exists());
        let report = migrate(root.path(), Default::default(), Default::default())
            .await
            .unwrap();
        assert_eq!(report.frames, 3);
        let db = DatabaseManager::new(path.to_str().unwrap(), Default::default())
            .await
            .unwrap();
        assert_eq!(
            db.frame_payloads(&[7], Projection::Search).await.unwrap()[&7].text(),
            "before restart"
        );
        seed(&db, 10, Some("after explicit retry"), None).await;
        assert_eq!(
            db.frame_payloads(&[8, 9, 10], Projection::Search)
                .await
                .unwrap()
                .len(),
            3
        );
        assert!(db.storage_descriptor().is_some());
        assert!(!path.is_file(), "source reused at {point}");
        db.close().await;
    }
}

#[cfg(feature = "storage-fault-injection")]
#[tokio::test]
async fn in_place_cancellation_is_rejected_without_losing_progress() {
    for point in [
        "migration_after_rename",
        "migration_ready",
        "migration_activated",
    ] {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("db.sqlite");
        let db = DatabaseManager::new(path.to_str().unwrap(), Default::default())
            .await
            .unwrap();
        seed(&db, 1, Some("survives cancellation"), None).await;
        let before = search(&db, "survives").await;
        db.close().await;
        let killed = std::process::Command::new(env!("CARGO_BIN_EXE_screenpipe-storage"))
            .arg("migrate")
            .arg(root.path())
            .env("SCREENPIPE_STORAGE_CRASH_AT", point)
            .output()
            .unwrap();
        assert_eq!(killed.status.code(), Some(86));
        let cancelled =
            screenpipe_db::storage::cancel_migration(root.path(), Default::default()).await;
        assert!(cancelled.is_err());
        assert!(root.path().join("storage-migration.json").is_file());
        migrate(root.path(), Default::default(), Default::default())
            .await
            .unwrap();
        let db = DatabaseManager::new(path.to_str().unwrap(), Default::default())
            .await
            .unwrap();
        assert_eq!(search(&db, "survives").await, before);
        db.close().await;
    }
}

#[cfg(unix)]
#[tokio::test]
async fn descriptor_and_catalog_paths_stay_inside_their_generation() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let db = DatabaseManager::new_hybrid(root.path(), Default::default(), Default::default())
        .await
        .unwrap();
    seed(&db, 1, Some("path ownership"), None).await;
    db.seal_frame_payloads().await.unwrap();
    let original: String =
        sqlx::query_scalar("SELECT search_path FROM payload_files WHERE state='published'")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    let original_path = root.path().join(&original);
    std::fs::rename(&original_path, outside.path().join("search.parquet")).unwrap();
    std::os::unix::fs::symlink(outside.path().join("search.parquet"), &original_path).unwrap();
    assert!(db.frame_payloads(&[1], Projection::Search).await.is_err());
    db.close().await;
    assert!(DatabaseManager::new(
        root.path().join("db.sqlite").to_str().unwrap(),
        Default::default()
    )
    .await
    .is_err());
    let mut descriptor = screenpipe_db::storage::StorageDescriptor::read(root.path())
        .unwrap()
        .unwrap();
    descriptor.index = "elsewhere/index.sqlite".into();
    std::fs::write(
        root.path().join("storage.json"),
        serde_json::to_vec(&descriptor).unwrap(),
    )
    .unwrap();
    assert!(DatabaseManager::new(
        root.path().join("db.sqlite").to_str().unwrap(),
        Default::default()
    )
    .await
    .is_err());
}

#[tokio::test]
async fn migration_streams_large_payloads_with_bounded_temporary_space() {
    use std::sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    };
    fn bytes(path: &std::path::Path) -> u64 {
        std::fs::read_dir(path)
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .map(|entry| {
                if entry.path().is_dir() {
                    bytes(&entry.path())
                } else {
                    entry
                        .metadata()
                        .map(|m| {
                            #[cfg(unix)]
                            {
                                use std::os::unix::fs::MetadataExt;
                                m.blocks() * 512
                            }
                            #[cfg(not(unix))]
                            {
                                m.len()
                            }
                        })
                        .unwrap_or(0)
                }
            })
            .sum()
    }
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("db.sqlite");
    let source = DatabaseManager::new(path.to_str().unwrap(), Default::default())
        .await
        .unwrap();
    let payload = format!("{{\"value\":\"{}\"}}", "x".repeat(1024 * 1024));
    let mut tx = source.begin_immediate_with_retry().await.unwrap();
    for id in 1..=64 {
        sqlx::query("INSERT INTO frames(id,timestamp,full_text,accessibility_tree_json) VALUES(?,'2026-09-11T12:00:00Z','streamed history',?)")
            .bind(id).bind(&payload).execute(&mut **tx.conn()).await.unwrap();
    }
    tx.commit().await.unwrap();
    source.execute_raw_sql_write("CREATE TABLE migration_audit(id INTEGER PRIMARY KEY,n INTEGER); INSERT INTO migration_audit VALUES(1,1); CREATE TRIGGER audit_frame AFTER INSERT ON frames BEGIN UPDATE migration_audit SET n=n+1; END;").await.unwrap();
    // Import visits the child first; its parent is in a later byte-bounded batch.
    let mut tx = source.begin_immediate_with_retry().await.unwrap();
    sqlx::query("INSERT INTO elements(id,frame_id,source,role,properties) VALUES(2,1,'accessibility','AXGroup',?)")
        .bind(&payload).execute(&mut **tx.conn()).await.unwrap();
    sqlx::query("INSERT INTO elements(id,frame_id,source,role,properties,parent_id) VALUES(1,1,'accessibility','AXText',?,2)")
        .bind(&payload).execute(&mut **tx.conn()).await.unwrap();
    tx.commit().await.unwrap();
    let (busy, logged, checkpointed) = source.wal_checkpoint().await.unwrap();
    assert_eq!((busy, logged), (0, checkpointed));
    source.close().await;
    let original = std::fs::metadata(&path).unwrap();
    let mut options = MigrationOptions::default();
    options.budget.file_bytes = 2 * 1024 * 1024;
    options.budget.record_bytes = 2 * 1024 * 1024;
    // Measure bounded extra allocation here. Actual disk exhaustion is covered
    // on marked disposable volumes, independent of other host/test writes.
    let headroom = 48 * 1024 * 1024;
    assert!(original.len() > headroom);
    let original_allocated = bytes(root.path());
    let done = Arc::new(AtomicBool::new(false));
    let peak = Arc::new(AtomicU64::new(0));
    let monitor = {
        let (done, peak, directory) = (done.clone(), peak.clone(), root.path().join("storage"));
        std::thread::spawn(move || {
            while !done.load(Ordering::Relaxed) {
                peak.fetch_max(bytes(&directory), Ordering::Relaxed);
                std::thread::sleep(std::time::Duration::from_millis(2));
            }
        })
    };
    let updates = std::sync::Mutex::new(Vec::new());
    let result = screenpipe_db::storage::migrate_with_progress(
        root.path(),
        Default::default(),
        options,
        |update| {
            updates.lock().unwrap().push(update);
        },
    )
    .await;
    done.store(true, Ordering::Relaxed);
    monitor.join().unwrap();
    let report = result.unwrap();
    let updates = updates.into_inner().unwrap();
    let counts: Vec<_> = updates
        .iter()
        .filter_map(|update| update.completed_records.zip(update.total_records))
        .collect();
    assert!(
        counts.len() > 3,
        "byte-bounded batches must report intermediate work"
    );
    assert_eq!(counts.first().unwrap().0, 0);
    assert!(
        counts.last().unwrap().1 >= 66,
        "frames and elements contribute to the total"
    );
    assert!(counts
        .windows(2)
        .all(|pair| pair[0].0 <= pair[1].0 && pair[0].1 == pair[1].1));
    let (converted, total) = *counts.last().unwrap();
    assert_eq!(converted, total);
    assert!(
        updates.last().unwrap().total_records.is_none(),
        "conversion percentage must not pretend to measure verification or activation"
    );
    let peak = peak.load(Ordering::Relaxed);
    eprintln!("streaming migration: source={} peak_candidate={} final_index={} parquet={} headroom={headroom}", original.len(), peak, report.index_bytes, report.payload_bytes);
    assert!(
        peak < original_allocated + headroom,
        "peak {peak} exceeds batch headroom {headroom}"
    );
    assert!(updates
        .iter()
        .any(|u| u.bytes_saved.unwrap_or(0) > original_allocated / 2));
    assert!(report.allocated_after_bytes.unwrap() < original.len() / 4);
    assert!(!path.exists());
    let db = DatabaseManager::new(path.to_str().unwrap(), Default::default())
        .await
        .unwrap();
    assert_eq!(
        db.frame_payloads(&[1, 64], Projection::All).await.unwrap()[&64]
            .accessibility_tree_json
            .as_deref(),
        Some(payload.as_str())
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT n FROM migration_audit")
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("PRAGMA auto_vacuum")
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        0
    );
    assert!(
        sqlx::query_scalar::<_, i64>("PRAGMA freelist_count")
            .fetch_one(&db.pool)
            .await
            .unwrap()
            > 0
    );
    seed(&db, 65, Some("after migration"), None).await;
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT n FROM migration_audit")
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        2
    );
    db.verify_storage().await.unwrap();
    db.close().await;
}

#[tokio::test]
async fn starred_upgrade_restores_older_hybrid_search_and_preserves_recordings() {
    let root = tempfile::tempdir().unwrap();
    let db = DatabaseManager::new_hybrid(root.path(), Default::default(), Default::default())
        .await
        .unwrap();
    seed(&db, 1, Some("starred upgrade history"), None).await;
    db.seal_frame_payloads().await.unwrap();
    let before = db.frame_payloads(&[1], Projection::All).await.unwrap();
    // Reproduce a generation converted before starred sessions shipped. Only
    // mutate this disposable fixture, through its existing serialized writer.
    db.execute_raw_sql_write(
        "DROP TABLE starred_sessions;
         DELETE FROM _sqlx_migrations WHERE version=20261002190000;",
    )
    .await
    .unwrap();
    db.close().await;

    let start = "2026-09-11T12:00:00.000Z";
    let end = "2026-09-11T12:15:00.000Z";
    for reopen in 0..2 {
        let db = DatabaseManager::new(
            root.path().join("db.sqlite").to_str().unwrap(),
            Default::default(),
        )
        .await
        .unwrap();
        assert_eq!(db.storage_mode(), StorageMode::HybridParquetV1);
        db.verify_storage().await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT count(*) FROM _sqlx_migrations WHERE version=20261002190000 AND success=1"
            )
            .fetch_one(&db.pool)
            .await
            .unwrap(),
            1,
        );
        assert_eq!(
            before,
            db.frame_payloads(&[1], Projection::All).await.unwrap()
        );
        assert_eq!(search(&db, "history").await.as_array().unwrap().len(), 1);
        assert_eq!(
            db.list_starred_sessions(start, end, 10, 0)
                .await
                .unwrap()
                .len(),
            reopen,
        );
        // Search response assembly calls this even without a starred filter.
        assert_eq!(
            db.starred_timestamps(&[start.into(), end.into()])
                .await
                .unwrap(),
            vec![reopen == 1, false],
        );
        assert!(db.starred_timestamps(&[]).await.unwrap().is_empty());
        if reopen == 0 {
            assert!(db
                .save_starred_session("upgrade", start, end, false, 0, start)
                .await
                .unwrap());
            seed(&db, 2, Some("continued capture"), None).await;
            db.seal_frame_payloads().await.unwrap();
        } else {
            assert_eq!(
                db.get_starred_session("upgrade")
                    .await
                    .unwrap()
                    .unwrap()
                    .revision,
                1
            );
            assert_eq!(
                db.starred_search_ranges(start, end).await.unwrap(),
                vec![(start.into(), end.into())]
            );
            assert_eq!(search(&db, "continued").await.as_array().unwrap().len(), 1);
        }
        db.close().await;
    }
}

#[tokio::test]
async fn starred_upgrade_preserves_existing_sessions_and_tracks_mutations() {
    let root = tempfile::tempdir().unwrap();
    let db = DatabaseManager::new_hybrid(root.path(), Default::default(), Default::default())
        .await
        .unwrap();
    let start = "2026-09-11T12:00:00.000Z";
    let end = "2026-09-11T12:15:00.000Z";
    assert!(db
        .save_starred_session("existing", start, end, true, 0, start)
        .await
        .unwrap());
    // Already-applied SQLx migrations must preserve their data; missing
    // generic storage hooks can still be installed without replaying the DDL.
    db.execute_raw_sql_write(
        "DROP TRIGGER IF EXISTS hybrid_revision_starred_sessions_INSERT;
         DROP TRIGGER IF EXISTS hybrid_revision_starred_sessions_UPDATE;
         DROP TRIGGER IF EXISTS hybrid_revision_starred_sessions_DELETE;
         DROP TRIGGER IF EXISTS hybrid_read_revoke_delete_starred_sessions;",
    )
    .await
    .unwrap();
    db.close().await;

    for _ in 0..2 {
        let db = DatabaseManager::new(
            root.path().join("db.sqlite").to_str().unwrap(),
            Default::default(),
        )
        .await
        .unwrap();
        let session = db.get_starred_session("existing").await.unwrap().unwrap();
        assert_eq!(session.revision, 1);
        assert!(session.hd_requested);
        let before = db.storage_read_token().await.unwrap().revision;
        assert!(db
            .save_starred_session("temporary", end, "2026-09-11T12:30:00.000Z", false, 0, end)
            .await
            .unwrap());
        assert_eq!(db.storage_read_token().await.unwrap().revision, before + 1);
        assert!(db
            .save_starred_session("temporary", end, "2026-09-11T12:45:00.000Z", false, 1, end)
            .await
            .unwrap());
        assert_eq!(db.storage_read_token().await.unwrap().revision, before + 2);
        let revocation: i64 =
            sqlx::query_scalar("SELECT revision FROM _storage_revocation WHERE id=1")
                .fetch_one(&db.pool)
                .await
                .unwrap();
        db.execute_raw_sql_write("DELETE FROM starred_sessions WHERE id='temporary'")
            .await
            .unwrap();
        assert_eq!(db.storage_read_token().await.unwrap().revision, before + 3);
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT revision FROM _storage_revocation WHERE id=1")
                .fetch_one(&db.pool)
                .await
                .unwrap(),
            revocation + 1
        );
        db.close().await;
    }
}

#[tokio::test]
async fn later_resident_tables_receive_storage_and_privacy_hooks() {
    let root = tempfile::tempdir().unwrap();
    let db = DatabaseManager::new_hybrid(root.path(), Default::default(), Default::default())
        .await
        .unwrap();
    // A future resident feature needs no feature-specific Rust upgrade.
    db.execute_raw_sql_write(
        "CREATE TABLE feature_notes(id INTEGER PRIMARY KEY, text TEXT, redacted_at TEXT);",
    )
    .await
    .unwrap();
    db.close().await;
    for _ in 0..2 {
        let db = DatabaseManager::new(
            root.path().join("db.sqlite").to_str().unwrap(),
            Default::default(),
        )
        .await
        .unwrap();
        let before = db.storage_read_token().await.unwrap().revision;
        db.execute_raw_sql_write("INSERT INTO feature_notes VALUES(1,'private',NULL)")
            .await
            .unwrap();
        assert_eq!(db.storage_read_token().await.unwrap().revision, before + 1);
        let token = db.storage_read_token().await.unwrap();
        db.execute_raw_sql_write(
            "UPDATE feature_notes SET text='redacted',redacted_at='2026-10-03' WHERE id=1",
        )
        .await
        .unwrap();
        assert!(token.admit(&db.pool).await.is_err());
        drop(token);
        assert_eq!(db.storage_read_token().await.unwrap().revision, before + 2);
        let token = db.storage_read_token().await.unwrap();
        db.execute_raw_sql_write("DELETE FROM feature_notes WHERE id=1")
            .await
            .unwrap();
        assert!(token.admit(&db.pool).await.is_err());
        drop(token);
        assert_eq!(db.storage_read_token().await.unwrap().revision, before + 3);
        db.close().await;
    }
}

// Built by the unmodified 2.7.84 database implementation, not by removing
// migrations from a database created with today's schema. See fixtures/README.md.
#[tokio::test]
#[ignore = "requires a synthetic fixture built with historical 2.7.84 code"]
async fn historical_2_7_84_compressed_upgrade_preserves_data_and_restarts() {
    use sha2::{Digest, Sha256};
    use std::{collections::BTreeMap, path::Path};

    fn copy_tree(source: &Path, destination: &Path) {
        std::fs::create_dir_all(destination).unwrap();
        for entry in std::fs::read_dir(source).unwrap() {
            let entry = entry.unwrap();
            let kind = entry.file_type().unwrap();
            assert!(!kind.is_symlink(), "fixture must not contain symlinks");
            let target = destination.join(entry.file_name());
            if kind.is_dir() {
                copy_tree(&entry.path(), &target);
            } else {
                assert!(kind.is_file());
                std::fs::copy(entry.path(), target).unwrap();
            }
        }
    }

    fn hashes(root: &Path, parquet_only: bool) -> BTreeMap<std::path::PathBuf, Vec<u8>> {
        fn visit(
            root: &Path,
            dir: &Path,
            parquet_only: bool,
            result: &mut BTreeMap<std::path::PathBuf, Vec<u8>>,
        ) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let entry = entry.unwrap();
                let kind = entry.file_type().unwrap();
                assert!(!kind.is_symlink());
                if kind.is_dir() {
                    visit(root, &entry.path(), parquet_only, result);
                } else if !parquet_only
                    || entry.path().extension().is_some_and(|ext| ext == "parquet")
                {
                    result.insert(
                        entry.path().strip_prefix(root).unwrap().to_path_buf(),
                        Sha256::digest(std::fs::read(entry.path()).unwrap()).to_vec(),
                    );
                }
            }
        }
        let mut result = BTreeMap::new();
        visit(root, root, parquet_only, &mut result);
        result
    }

    let source = std::path::PathBuf::from(
        std::env::var("SCREENPIPE_UPGRADE_FIXTURE_ROOT")
            .expect("set the historical synthetic fixture directory"),
    );
    assert_eq!(
        std::fs::read_to_string(source.join(".synthetic-upgrade-fixture")).unwrap(),
        "screenpipe-2.7.84\n"
    );
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(source.join("fixture-manifest.json")).unwrap())
            .unwrap();
    assert_eq!(
        manifest["source_commit"],
        "8325934d5571b3d7d87ac068177d63c6dc5c9ce6"
    );
    assert_eq!(manifest["synthetic"], true);
    assert_eq!(manifest["sealed_frames"], 128);
    assert_eq!(manifest["starred_table_present"], false);
    let source_hashes = hashes(&source, false);
    let root = tempfile::tempdir().unwrap();
    copy_tree(&source, root.path());
    let compressed_hashes = hashes(root.path(), true);
    assert!(!compressed_hashes.is_empty());
    let ids: Vec<i64> = (1..=128).collect();
    let start = "2026-09-11T12:00:00.000Z";
    let end = "2026-09-11T12:15:00.000Z";

    for reopen in 0..3 {
        let began = std::time::Instant::now();
        // Spawning startup also guards the Send contract used by engine restart.
        let path = root.path().join("db.sqlite");
        let db = tokio::spawn(async move {
            DatabaseManager::new(path.to_str().unwrap(), Default::default()).await
        })
        .await
        .unwrap()
        .unwrap();
        println!("historical upgrade/open {reopen}: {:?}", began.elapsed());
        assert_eq!(db.storage_mode(), StorageMode::HybridParquetV1);
        db.verify_storage().await.unwrap();
        for snapshot in manifest["snapshots"].as_array().unwrap() {
            let rows = db
                .query_raw_sql(snapshot["query"].as_str().unwrap())
                .await
                .unwrap();
            let actual = rows.as_array().unwrap();
            let expected = snapshot["rows"].as_array().unwrap();
            // New migration and capture rows append; every historical row stays exact.
            assert!(actual.len() >= expected.len());
            assert_eq!(&actual[..expected.len()], expected, "{}", snapshot["query"]);
        }
        assert_eq!(
            serde_json::to_value(db.frame_payloads(&ids, Projection::All).await.unwrap()).unwrap(),
            manifest["payloads"]
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT count(*) FROM _sqlx_migrations WHERE version=20261002190000 AND success=1"
            )
            .fetch_one(&db.pool)
            .await
            .unwrap(),
            1
        );
        assert_eq!(
            search(&db, "historicalneedle")
                .await
                .as_array()
                .unwrap()
                .len(),
            100
        );
        let audio = db
            .search(
                "historicalneedle",
                ContentType::Audio,
                100,
                0,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
            )
            .await
            .unwrap();
        // Audio search includes the eight live meeting transcript segments.
        assert_eq!(audio.len(), 16);
        assert_eq!(
            db.starred_timestamps(&[start.into(), end.into()])
                .await
                .unwrap(),
            vec![reopen > 0, false]
        );
        assert_eq!(
            db.list_starred_sessions(start, end, 10, 0)
                .await
                .unwrap()
                .len(),
            usize::from(reopen > 0)
        );
        // Startup must not rewrite or delete any historical compressed payload.
        let now = hashes(root.path(), true);
        for (path, digest) in &compressed_hashes {
            assert_eq!(now.get(path), Some(digest), "{}", path.display());
        }
        if reopen == 0 {
            assert_eq!(now, compressed_hashes);
            db.save_starred_session("historical-upgrade", start, end, false, 0, start)
                .await
                .unwrap();
            seed(&db, 129, Some("postupgradeneedle capture"), None).await;
            db.execute_raw_sql_write("INSERT INTO audio_chunks(id,file_path,timestamp) VALUES(2,'post-upgrade.wav','2026-09-11T12:01:00Z'); INSERT INTO audio_transcriptions(id,audio_chunk_id,offset_index,timestamp,transcription,device) VALUES(9,2,9,'2026-09-11T12:01:00Z','postupgradeneedle speech','fixture-mic')").await.unwrap();
            while db.seal_payloads().await.unwrap() != 0 {}
        } else {
            assert_eq!(
                db.get_starred_session("historical-upgrade")
                    .await
                    .unwrap()
                    .unwrap()
                    .revision,
                1
            );
            assert_eq!(
                search(&db, "postupgradeneedle")
                    .await
                    .as_array()
                    .unwrap()
                    .len(),
                1
            );
            assert_eq!(
                db.frame_payloads(&[129], Projection::All)
                    .await
                    .unwrap()
                    .len(),
                1
            );
            assert_eq!(
                db.search(
                    "postupgradeneedle",
                    ContentType::Audio,
                    100,
                    0,
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    None
                )
                .await
                .unwrap()
                .len(),
                1
            );
        }
        db.close().await;
    }
    assert_eq!(
        hashes(&source, false),
        source_hashes,
        "original fixture remains untouched"
    );
}

#[tokio::test]
async fn pending_sqlx_migration_rolls_back_and_retries_on_compressed_storage() {
    use screenpipe_db::storage::StorageDescriptor;
    let root = tempfile::tempdir().unwrap();
    let db = DatabaseManager::new_hybrid(root.path(), Default::default(), Default::default())
        .await
        .unwrap();
    seed(&db, 1, Some("migration retry history"), None).await;
    db.seal_frame_payloads().await.unwrap();
    let before = db.frame_payloads(&[1], Projection::All).await.unwrap();
    // Fail the second statement of the pending migration, after CREATE TABLE.
    db.execute_raw_sql_write(
        "DROP TABLE starred_sessions;
         DELETE FROM _sqlx_migrations WHERE version=20261002190000;
         CREATE INDEX idx_starred_sessions_start_end ON tags(name);",
    )
    .await
    .unwrap();
    db.close().await;
    let path = root.path().join("db.sqlite");
    let error = match DatabaseManager::new(path.to_str().unwrap(), Default::default()).await {
        Ok(db) => {
            db.close().await;
            panic!("conflicting index must fail startup");
        }
        Err(error) => error.to_string(),
    };
    assert!(error.contains("idx_starred_sessions_start_end"), "{error}");
    // Inspect only this closed, disposable index. SQLx must roll back both DDL
    // and its completion record before a corrected retry can proceed.
    let descriptor = StorageDescriptor::read(root.path()).unwrap().unwrap();
    let mut conn = sqlx::SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new().filename(root.path().join(descriptor.index)),
    )
    .await
    .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM sqlite_master WHERE name='starred_sessions'"
        )
        .fetch_one(&mut conn)
        .await
        .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM _sqlx_migrations WHERE version=20261002190000"
        )
        .fetch_one(&mut conn)
        .await
        .unwrap(),
        0
    );
    sqlx::query("DROP INDEX idx_starred_sessions_start_end")
        .execute(&mut conn)
        .await
        .unwrap();
    conn.close().await.unwrap();
    let db = DatabaseManager::new(path.to_str().unwrap(), Default::default())
        .await
        .unwrap();
    db.verify_storage().await.unwrap();
    assert_eq!(
        before,
        db.frame_payloads(&[1], Projection::All).await.unwrap()
    );
    assert_eq!(search(&db, "history").await.as_array().unwrap().len(), 1);
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM _sqlx_migrations WHERE version=20261002190000 AND success=1"
        )
        .fetch_one(&db.pool)
        .await
        .unwrap(),
        1
    );
    db.close().await;
}
