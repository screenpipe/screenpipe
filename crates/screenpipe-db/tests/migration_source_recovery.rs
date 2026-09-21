// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

#![cfg(feature = "storage-fault-injection")]

use screenpipe_db::{
    storage::{migrate, recover_interrupted_migration, Projection},
    DatabaseManager,
};
use std::path::Path;

const RECOVERY_KEY: [u8; 32] = [7; 32];

async fn credential_source(root: &Path) {
    use screenpipe_secrets::{secrets_database_path, shared_secret_pool, SecretStore};
    // Seal the old one-time import before a legacy process recreates db.sqlite.
    let dedicated = SecretStore::open_for_data_dir(root, Some(RECOVERY_KEY))
        .await
        .unwrap();
    dedicated
        .set("dedicated-newer", b"current token")
        .await
        .unwrap();
    dedicated.set("source-newer", b"old token").await.unwrap();
    let pool = shared_secret_pool(secrets_database_path(root).to_str().unwrap())
        .await
        .unwrap();
    sqlx::query("UPDATE secrets SET updated_at=CASE key WHEN 'dedicated-newer' THEN '2026-09-21' ELSE '2026-09-19' END")
        .execute(&pool).await.unwrap();
    pool.close().await;

    let source = root.join("db.sqlite");
    let store = SecretStore::open(source.to_str().unwrap(), Some(RECOVERY_KEY))
        .await
        .unwrap();
    store
        .set("recovered-only", b"preserved token")
        .await
        .unwrap();
    store.set("dedicated-newer", b"stale token").await.unwrap();
    store.set("source-newer", b"refreshed token").await.unwrap();
    let pool = shared_secret_pool(source.to_str().unwrap()).await.unwrap();
    sqlx::query("UPDATE secrets SET created_at='2026-09-14', updated_at='2026-09-20', expires_at='2099-01-01'")
        .execute(&pool).await.unwrap();
    pool.close().await;
}

async fn verify_recovered_credentials(root: &Path) {
    use screenpipe_secrets::{secrets_database_path, shared_secret_pool, SecretStore};
    let path = secrets_database_path(root);
    shared_secret_pool(path.to_str().unwrap())
        .await
        .unwrap()
        .close()
        .await;
    let store = SecretStore::open_for_data_dir(root, Some(RECOVERY_KEY))
        .await
        .unwrap();
    for (key, expected) in [
        ("recovered-only", "preserved token"),
        ("dedicated-newer", "current token"),
        ("source-newer", "refreshed token"),
    ] {
        assert_eq!(store.get(key).await.unwrap().unwrap(), expected.as_bytes());
    }
    let pool = shared_secret_pool(path.to_str().unwrap()).await.unwrap();
    let dates: (String, String, String) = sqlx::query_as(
        "SELECT created_at,updated_at,expires_at FROM secrets WHERE key='recovered-only'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        dates,
        (
            "2026-09-14".into(),
            "2026-09-20".into(),
            "2099-01-01".into()
        )
    );
    pool.close().await;

    let descriptor = screenpipe_db::storage::StorageDescriptor::read(root)
        .unwrap()
        .unwrap();
    let retained: Vec<_> = std::fs::read_dir(root.join(descriptor.index).parent().unwrap())
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("recovered-secrets-source-")
        })
        .collect();
    assert_eq!(retained.len(), 1);
    let conn = rusqlite::Connection::open_with_flags(
        retained[0].path(),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    assert_eq!(
        conn.query_row("SELECT count(*) FROM secrets", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        3
    );
}

#[tokio::test]
async fn retry_recovers_credentials_only_source_and_preserves_newer_secrets() {
    for (active, startup_recovery) in [(false, false), (true, false), (false, true)] {
        let root = paused_before_activation().await;
        if active {
            recover_interrupted_migration(root.path(), Default::default())
                .await
                .unwrap();
        }
        credential_source(root.path()).await;
        if startup_recovery {
            recover_interrupted_migration(root.path(), Default::default())
                .await
                .unwrap();
            assert!(root.path().join("storage-migration.json").is_file());
            assert!(!root.path().join("storage-migration-complete.json").exists());
        }
        finish_and_verify(root.path()).await;
        verify_recovered_credentials(root.path()).await;
    }
}

#[tokio::test]
async fn credentials_recovery_survives_copy_and_retirement_interruptions() {
    for point in [
        "migration_source_secrets_copied",
        "migration_source_retired",
    ] {
        let root = paused_before_activation().await;
        recover_interrupted_migration(root.path(), Default::default())
            .await
            .unwrap();
        credential_source(root.path()).await;
        crash_migration(root.path(), point);
        finish_and_verify(root.path()).await;
        verify_recovered_credentials(root.path()).await;
    }
}

#[tokio::test]
async fn failed_credential_recovery_is_atomic_and_retryable() {
    use screenpipe_secrets::{secrets_database_path, shared_secret_pool};
    let root = paused_before_activation().await;
    credential_source(root.path()).await;
    let source = root.path().join("db.sqlite");
    let before = std::fs::read(&source).unwrap();
    let journal = std::fs::read(root.path().join("storage-migration.json")).unwrap();
    let pool = shared_secret_pool(secrets_database_path(root.path()).to_str().unwrap())
        .await
        .unwrap();
    sqlx::query("CREATE TRIGGER refuse_recovery BEFORE INSERT ON secrets WHEN NEW.key='source-newer' BEGIN SELECT RAISE(ABORT,'credential destination refused write'); END")
        .execute(&pool).await.unwrap();
    let error = migrate(root.path(), Default::default(), Default::default())
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("credential destination refused write"),
        "{error}"
    );
    assert_eq!(std::fs::read(&source).unwrap(), before);
    assert_eq!(
        std::fs::read(root.path().join("storage-migration.json")).unwrap(),
        journal
    );
    let partial: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM secrets WHERE key='recovered-only')")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(!partial, "failed import must roll back every credential");
    sqlx::query("DROP TRIGGER refuse_recovery")
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
    finish_and_verify(root.path()).await;
    verify_recovered_credentials(root.path()).await;
}

#[tokio::test]
async fn credentials_do_not_hide_other_source_history() {
    use screenpipe_secrets::{secrets_database_path, shared_secret_pool};
    let root = paused_before_activation().await;
    credential_source(root.path()).await;
    let source = root.path().join("db.sqlite");
    {
        let conn = rusqlite::Connection::open(&source).unwrap();
        conn.execute_batch("CREATE TABLE extension_history(text TEXT); INSERT INTO extension_history VALUES('additional history')").unwrap();
    }
    let before = std::fs::read(&source).unwrap();
    let error = migrate(root.path(), Default::default(), Default::default())
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("source contains recorded history in extension_history"),
        "{error}"
    );
    assert_eq!(std::fs::read(source).unwrap(), before);
    let pool = shared_secret_pool(secrets_database_path(root.path()).to_str().unwrap())
        .await
        .unwrap();
    let imported: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM secrets WHERE key='recovered-only')")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(
        !imported,
        "validate every source table before importing credentials"
    );
    pool.close().await;
}

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
    crash_migration(root.path(), "migration_source_retired");
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
