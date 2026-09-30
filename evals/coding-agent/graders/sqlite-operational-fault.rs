// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use screenpipe_sqlite_coordinator::{
    latch_sqlite_error, latch_sqlite_hard_fault, persist_sqlite_quarantine,
    prepare_sqlite_quarantine_reserve, registered_sqlite_hard_fault, sqlite_file_identity,
    sqlite_hard_fault_code, sqlite_quarantine_exists, sqlite_quarantine_marker_path,
    sqlite_write_lock,
};
use sqlx::sqlite::{SqliteConnectOptions, SqliteConnection, SqliteJournalMode};
use sqlx::Connection;
use std::path::Path;
use std::sync::Arc;

async fn seed_database(path: &Path) {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Delete);
    let mut connection = SqliteConnection::connect_with(&options).await.unwrap();
    sqlx::query("CREATE TABLE samples(id INTEGER PRIMARY KEY, value TEXT NOT NULL)")
        .execute(&mut connection)
        .await
        .unwrap();
    sqlx::query("INSERT INTO samples VALUES (1, 'synthetic alpha'), (2, 'synthetic beta')")
        .execute(&mut connection)
        .await
        .unwrap();
    connection.close().await.unwrap();
}

async fn fault_without_corruption_verdict(code: i32, reserve: bool) {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("samples.sqlite");
    seed_database(&db).await;
    let bytes = std::fs::read(&db).unwrap();
    let identity = sqlite_file_identity(&db).unwrap();
    if reserve {
        prepare_sqlite_quarantine_reserve(&db).unwrap();
    }
    let old_gate = sqlite_write_lock(&db);
    assert!(!old_gate.is_closed());
    assert!(latch_sqlite_hard_fault(&db, code));
    assert!(old_gate.is_closed(), "faulted writers must remain stopped");
    assert_eq!(registered_sqlite_hard_fault(&db), Some(code));
    assert_eq!(std::fs::read(&db).unwrap(), bytes);
    assert_eq!(sqlite_file_identity(&db).unwrap(), identity);
    assert!(
        !sqlite_quarantine_exists(&db),
        "an unverified result code must not create corruption quarantine"
    );
}

#[tokio::test]
async fn generic_io_error_does_not_declare_corruption() {
    fault_without_corruption_verdict(10, false).await;
}

#[tokio::test]
async fn extended_io_error_does_not_declare_corruption() {
    fault_without_corruption_verdict(522, true).await;
}

#[tokio::test]
async fn full_disk_does_not_declare_corruption() {
    fault_without_corruption_verdict(13, true).await;
}

#[tokio::test]
async fn fault_admission_barrier_survives_process_restart() {
    const PHASE: &str = "SCREENPIPE_SYNTHETIC_FAULT_PHASE";
    const DATABASE: &str = "SCREENPIPE_SYNTHETIC_FAULT_DATABASE";
    if let Ok(phase) = std::env::var(PHASE) {
        let db = std::path::PathBuf::from(std::env::var(DATABASE).unwrap());
        if phase == "fault" {
            prepare_sqlite_quarantine_reserve(&db).unwrap();
            assert!(latch_sqlite_hard_fault(&db, 13));
        } else {
            assert_eq!(registered_sqlite_hard_fault(&db), Some(13));
            assert!(sqlite_write_lock(&db).is_closed());
        }
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("samples.sqlite");
    seed_database(&db).await;
    let bytes = std::fs::read(&db).unwrap();
    let identity = sqlite_file_identity(&db).unwrap();
    for phase in ["fault", "restart"] {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "fault_admission_barrier_survives_process_restart",
            ])
            .env(PHASE, phase)
            .env(DATABASE, &db)
            .output()
            .unwrap();
        assert!(output.status.success(), "durable fault gate phase failed");
    }
    assert_eq!(std::fs::read(&db).unwrap(), bytes);
    assert_eq!(sqlite_file_identity(&db).unwrap(), identity);
}

#[tokio::test]
async fn repeated_faults_never_reopen_old_or_recreated_gates() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("samples.sqlite");
    seed_database(&db).await;
    let gate = sqlite_write_lock(&db);
    let held = Arc::clone(&gate).acquire_owned().await.unwrap();
    assert!(latch_sqlite_hard_fault(&db, 522));
    assert!(!latch_sqlite_hard_fault(&db, 13));
    assert_eq!(registered_sqlite_hard_fault(&db), Some(522));
    drop(held);
    assert!(gate.is_closed());
    assert!(gate.try_acquire().is_err());
    drop(gate);
    assert!(sqlite_write_lock(&db).is_closed());
}

#[tokio::test]
async fn ordinary_contention_does_not_poison_writer_admission() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("samples.sqlite");
    seed_database(&db).await;
    let gate = sqlite_write_lock(&db);
    for code in [0, 5, 6, 19, 261] {
        assert!(!latch_sqlite_hard_fault(&db, code));
    }
    assert_eq!(registered_sqlite_hard_fault(&db), None);
    assert!(!gate.is_closed());
    assert!(gate.try_acquire().is_ok());
    assert!(!sqlite_quarantine_exists(&db));
}

#[tokio::test]
async fn pool_pressure_is_not_a_database_fault() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("samples.sqlite");
    seed_database(&db).await;
    for error in [sqlx::Error::PoolTimedOut, sqlx::Error::PoolClosed] {
        assert!(!latch_sqlite_error(&db, &error));
    }
    assert_eq!(registered_sqlite_hard_fault(&db), None);
    assert!(!sqlite_write_lock(&db).is_closed());
    assert_eq!(
        sqlite_hard_fault_code(&sqlx::Error::Protocol(
            "error returned from database: (code: 522) disk I/O error".into()
        )),
        Some(522)
    );
}

#[tokio::test]
async fn an_unrelated_database_keeps_its_writer_lane() {
    let dir = tempfile::tempdir().unwrap();
    let first = dir.path().join("first.sqlite");
    let second = dir.path().join("second.sqlite");
    seed_database(&first).await;
    seed_database(&second).await;
    let second_gate = sqlite_write_lock(&second);
    assert!(latch_sqlite_hard_fault(&first, 10));
    assert_eq!(registered_sqlite_hard_fault(&second), None);
    assert!(!second_gate.is_closed());
    assert!(second_gate.try_acquire().is_ok());
}

#[tokio::test]
async fn existing_quarantine_is_not_erased_or_ignored() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("samples.sqlite");
    seed_database(&db).await;
    persist_sqlite_quarantine(&db, Some(11), "synthetic existing incident").unwrap();
    let marker = sqlite_quarantine_marker_path(&db).unwrap();
    let before = std::fs::read(&marker).unwrap();
    assert_eq!(registered_sqlite_hard_fault(&db), Some(11));
    assert!(sqlite_write_lock(&db).is_closed());
    assert!(sqlite_quarantine_exists(&db));
    assert_eq!(std::fs::read(marker).unwrap(), before);
}

#[tokio::test]
async fn malformed_incident_metadata_remains_fail_closed() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("samples.sqlite");
    seed_database(&db).await;
    let marker = sqlite_quarantine_marker_path(&db).unwrap();
    std::fs::write(&marker, b"{incomplete").unwrap();
    assert_eq!(registered_sqlite_hard_fault(&db), Some(10));
    assert!(sqlite_write_lock(&db).is_closed());
    assert_eq!(std::fs::read(marker).unwrap(), b"{incomplete");
}
