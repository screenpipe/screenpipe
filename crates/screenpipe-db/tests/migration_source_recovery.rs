// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

#![cfg(feature = "storage-fault-injection")]

use screenpipe_db::{
    storage::{migrate, recover_interrupted_migration, Projection},
    DatabaseManager,
};
use std::path::Path;

async fn seed(path: &Path, text: Option<&str>) {
    let db = DatabaseManager::new(path.to_str().unwrap(), Default::default())
        .await
        .unwrap();
    if let Some(text) = text {
        db.execute_raw_sql_write(&format!(
            "INSERT INTO frames(id,timestamp,full_text) VALUES(1,'2026-09-18','{text}')"
        ))
        .await
        .unwrap();
    }
    db.close().await;
}

fn crash_migration(root: &Path, point: &str) {
    let result = std::process::Command::new(env!("CARGO_BIN_EXE_screenpipe-storage"))
        .arg("migrate")
        .arg(root)
        .env("SCREENPIPE_STORAGE_CRASH_AT", point)
        .output()
        .unwrap();
    assert_eq!(
        result.status.code(),
        Some(86),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}

#[tokio::test]
async fn recovery_child() {
    if let Ok(root) = std::env::var("SCREENPIPE_TEST_SOURCE_RECOVERY_ROOT") {
        recover_interrupted_migration(Path::new(&root), Default::default())
            .await
            .unwrap();
    }
}

async fn paused_before_activation() -> tempfile::TempDir {
    let root = tempfile::tempdir().unwrap();
    seed(&root.path().join("db.sqlite"), Some("original history")).await;
    crash_migration(root.path(), "migration_after_rename");
    let result = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "recovery_child", "--nocapture"])
        .env("SCREENPIPE_TEST_SOURCE_RECOVERY_ROOT", root.path())
        .env("SCREENPIPE_STORAGE_CRASH_AT", "migration_recovery_ready")
        .output()
        .unwrap();
    assert_eq!(
        result.status.code(),
        Some(86),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(!root.path().join("storage.json").exists());
    assert!(!root.path().join("db.sqlite").exists());
    root
}

async fn finish_and_verify(root: &Path) {
    let report = migrate(root, Default::default(), Default::default())
        .await
        .unwrap();
    assert_eq!(report.frames, 1);
    assert!(root.join("storage-migration-complete.json").is_file());
    assert!(!root.join("storage-migration.json").exists());
    assert!(!root.join("db.sqlite").exists());
    for pass in 0..2 {
        let db = DatabaseManager::new(root.join("db.sqlite").to_str().unwrap(), Default::default())
            .await
            .unwrap();
        assert_eq!(
            db.frame_payloads(&[1], Projection::Search).await.unwrap()[&1].text(),
            "original history"
        );
        if pass == 0 {
            db.execute_raw_sql_write(
                "INSERT INTO frames(id,timestamp,full_text) VALUES(2,'2026-09-18','new recording')",
            )
            .await
            .unwrap();
        }
        assert_eq!(
            db.frame_payloads(&[2], Projection::Search).await.unwrap()[&2].text(),
            "new recording"
        );
        db.verify_storage().await.unwrap();
        db.close().await;
    }
}

#[tokio::test]
async fn explicit_retry_after_interrupted_recovery_uses_the_existing_index() {
    let root = paused_before_activation().await;
    finish_and_verify(root.path()).await;
}

async fn recreate_old_retry(root: &Path) {
    // The old retry opened the missing legacy path with create-if-missing.
    let empty = root.join("recreated.sqlite");
    seed(&empty, None).await;
    std::fs::rename(empty, root.join("db.sqlite")).unwrap();
    // The old retry then saved receipts from the empty DB and changed paused
    // back to building before hitting the conflicting-files guard.
    let journal_path = root.join("storage-migration.json");
    let mut journal: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&journal_path).unwrap()).unwrap();
    journal["phase"] = "building".into();
    for table in journal["source"].as_array_mut().unwrap() {
        if table["table"] == "frames" {
            table["rows"] = 0.into();
            table["sha256"] = "old-empty-source-receipt".into();
        }
    }
    std::fs::write(&journal_path, serde_json::to_vec(&journal).unwrap()).unwrap();
}

#[tokio::test]
async fn recovery_and_retry_preserve_history_when_old_retry_recreated_an_empty_source() {
    let root = paused_before_activation().await;
    recreate_old_retry(root.path()).await;
    recover_interrupted_migration(root.path(), Default::default())
        .await
        .unwrap();
    // Recovery must keep conversion paused and permit durable recording.
    assert!(root.path().join("storage-migration.json").is_file());
    assert!(!root.path().join("storage-migration-complete.json").exists());
    let descriptor = screenpipe_db::storage::StorageDescriptor::read(root.path())
        .unwrap()
        .unwrap();
    let retained: Vec<_> = std::fs::read_dir(root.path().join(descriptor.index).parent().unwrap())
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("recovered-empty-source-")
        })
        .collect();
    assert_eq!(retained.len(), 1);
    recover_interrupted_migration(root.path(), Default::default())
        .await
        .unwrap();
    finish_and_verify(root.path()).await;
}

#[tokio::test]
async fn conflicting_nonempty_source_is_preserved_and_diagnosed() {
    let root = paused_before_activation().await;
    let extra = root.path().join("recreated.sqlite");
    seed(&extra, Some("additional history")).await;
    let source = root.path().join("db.sqlite");
    std::fs::rename(extra, &source).unwrap();
    let before = std::fs::read(&source).unwrap();
    let journal = std::fs::read(root.path().join("storage-migration.json")).unwrap();
    let error = migrate(root.path(), Default::default(), Default::default())
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("source contains recorded history"),
        "{error}"
    );
    assert_eq!(std::fs::read(&source).unwrap(), before);
    assert_eq!(
        std::fs::read(root.path().join("storage-migration.json")).unwrap(),
        journal
    );
    let snapshots = tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            let snapshots =
                screenpipe_db::storage::diagnostics::recent(root.path()).unwrap_or_default();
            if snapshots.iter().any(|s| s.status == "failed") {
                break snapshots;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let failed = snapshots.iter().find(|s| s.status == "failed").unwrap();
    assert_eq!(
        failed.failure_stage.as_deref(),
        Some("validating_migration_source")
    );
    let state = failed.source_state.as_ref().unwrap();
    assert!(state.source_exists && state.index_exists);
    assert!(!state.active_descriptor_present);
    assert_eq!(state.journal_phase, "paused");
}

#[tokio::test]
async fn retry_resumes_if_interrupted_after_retaining_the_empty_source() {
    let root = paused_before_activation().await;
    recreate_old_retry(root.path()).await;
    crash_migration(root.path(), "migration_empty_source_retired");
    assert!(!root.path().join("db.sqlite").exists());
    // An explicit retry must also work without another startup recovery first.
    finish_and_verify(root.path()).await;
}

#[tokio::test]
async fn explicit_retry_refreshes_a_source_checkpoint_before_it_was_renamed() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("db.sqlite");
    seed(&path, Some("original history")).await;
    crash_migration(root.path(), "migration_before_rename");
    std::fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1))
        .unwrap();
    finish_and_verify(root.path()).await;
}

#[tokio::test]
async fn changed_source_contents_before_rename_are_preserved() {
    use sqlx::Connection;
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("db.sqlite");
    seed(&path, Some("original history")).await;
    crash_migration(root.path(), "migration_before_rename");
    let journal = std::fs::read(root.path().join("storage-migration.json")).unwrap();
    let mut conn = sqlx::SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new().filename(&path),
    )
    .await
    .unwrap();
    sqlx::query("UPDATE frames SET full_text='changed history' WHERE id=1")
        .execute(&mut conn)
        .await
        .unwrap();
    conn.close().await.unwrap();
    let error = migrate(root.path(), Default::default(), Default::default())
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("source content changed before rename"),
        "{error}"
    );
    assert!(path.is_file());
    assert!(!root.path().join("storage.json").exists());
    assert_eq!(
        std::fs::read(root.path().join("storage-migration.json")).unwrap(),
        journal
    );
    let mut conn = sqlx::SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new()
            .filename(&path)
            .read_only(true),
    )
    .await
    .unwrap();
    let text: String = sqlx::query_scalar("SELECT full_text FROM frames WHERE id=1")
        .fetch_one(&mut conn)
        .await
        .unwrap();
    assert_eq!(text, "changed history");
    conn.close().await.unwrap();
}
