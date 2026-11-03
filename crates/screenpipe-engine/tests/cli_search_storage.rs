// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use screenpipe_db::DatabaseManager;
use std::path::Path;
use std::process::{Command, Output};

fn search(root: &Path, json: bool) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_screenpipe"));
    command.args(["search", "storageregression", "--data-dir"]);
    command.arg(root).args(["--content-type", "ocr"]);
    if json {
        command.arg("--json");
    }
    command.output().unwrap()
}

async fn seed(db: &DatabaseManager) -> i64 {
    db.insert_snapshot_frame(
        "test-display",
        chrono::Utc::now(),
        "/tmp/cli-search-fixture.jpg",
        Some("Editor"),
        Some("Search fixture"),
        None,
        true,
        Some("test"),
        Some("storageregression recorded text"),
        Some("accessibility"),
        None,
        None,
        None,
    )
    .await
    .unwrap()
}

fn assert_search_results(root: &Path, frame_id: i64) {
    for json in [false, true] {
        let output = search(root, json);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let stdout = String::from_utf8(output.stdout).unwrap();
        assert!(
            stdout.contains("storageregression recorded text"),
            "{stdout}"
        );
        if json {
            let rows: Vec<serde_json::Value> = stdout
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect();
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0]["content"]["frame_id"], frame_id);
        }
    }
}

#[tokio::test]
async fn searches_fresh_hybrid_history_after_payload_sealing_and_restart() {
    let root = tempfile::tempdir().unwrap();
    let db = DatabaseManager::new_hybrid(root.path(), Default::default(), Default::default())
        .await
        .unwrap();
    let frame_id = seed(&db).await;
    assert_eq!(db.seal_frame_payloads().await.unwrap(), 1);
    db.close().await;
    assert!(root.path().join("storage.json").is_file());
    assert!(!root.path().join("db.sqlite").exists());
    assert_search_results(root.path(), frame_id);
    assert!(!root.path().join("db.sqlite").exists());
}

#[tokio::test]
async fn searches_existing_legacy_history() {
    let root = tempfile::tempdir().unwrap();
    let db = DatabaseManager::new(
        root.path().join("db.sqlite").to_str().unwrap(),
        Default::default(),
    )
    .await
    .unwrap();
    let frame_id = seed(&db).await;
    db.close().await;
    assert_search_results(root.path(), frame_id);
    assert!(!root.path().join("storage.json").exists());
}

#[test]
fn missing_history_reports_recording_instruction_without_creating_database() {
    let root = tempfile::tempdir().unwrap();
    let output = search(root.path(), true);
    assert!(!output.status.success());
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("run `screenpipe record` first"), "{stderr}");
    assert!(!root.path().join("db.sqlite").exists());
}

#[test]
fn invalid_descriptor_reports_originating_error_without_creating_database() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("storage.json"), "invalid descriptor").unwrap();
    let output = search(root.path(), true);
    assert!(!output.status.success());
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(
        stderr.contains("expected value at line 1 column 1"),
        "{stderr}"
    );
    assert!(stderr.contains("failed to resolve database in"), "{stderr}");
    assert!(stderr.contains(root.path().to_str().unwrap()), "{stderr}");
    assert!(
        !stderr.contains("run `screenpipe record` first"),
        "{stderr}"
    );
    assert!(!root.path().join("db.sqlite").exists());
}
