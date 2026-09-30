// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use screenpipe_db::{
    storage::{migrate, resolve_database_path},
    DatabaseManager,
};
use screenpipe_sqlite_coordinator as coordinator;
use std::{path::Path, process::Command};

const CHILD_ROOT: &str = "SCREENPIPE_HYBRID_RECOVERY_ROOT";
const CHILD_PHASE: &str = "SCREENPIPE_HYBRID_RECOVERY_PHASE";

async fn open(root: &Path) -> DatabaseManager {
    DatabaseManager::new(
        root.join("db.sqlite").to_str().unwrap(),
        screenpipe_config::DbConfig::for_tier(screenpipe_config::DeviceTier::Low),
    )
    .await
    .expect("healthy hybrid storage must reopen after a transient fault")
}

async fn insert_transcript(db: &DatabaseManager, id: i64, text: &str) {
    let mut tx = db.begin_immediate_with_retry().await.unwrap();
    sqlx::query("INSERT INTO audio_transcriptions(id,audio_chunk_id,offset_index,timestamp,transcription,device) VALUES(?,1,?,'2026-09-21T12:00:00Z',?,'test')")
        .bind(id).bind(id).bind(text).execute(&mut **tx.conn()).await.unwrap();
    tx.commit().await.unwrap();
}

#[tokio::test]
async fn pending_hybrid_fault_recovers_across_process_restarts() {
    if let Ok(root) = std::env::var(CHILD_ROOT) {
        let root = Path::new(&root);
        match std::env::var(CHILD_PHASE).unwrap().as_str() {
            "seed" => {
                let db = open(root).await;
                db.execute_raw_sql_write(
                    "INSERT INTO audio_chunks(id,file_path) VALUES(1,'test.wav')",
                )
                .await
                .unwrap();
                insert_transcript(&db, 1, "archived transcript").await;
                db.close().await;
                migrate(root, Default::default(), Default::default())
                    .await
                    .unwrap();
                let db = open(root).await;
                let archived: i64 = sqlx::query_scalar("SELECT count(*) FROM main.audio_transcriptions WHERE _archive_file IS NOT NULL")
                    .fetch_one(&db.pool).await.unwrap();
                assert_eq!(archived, 1);
                insert_transcript(&db, 2, "resident transcript 東京").await;
                db.close().await;
                let index = resolve_database_path(&root.join("db.sqlite")).unwrap();
                coordinator::latch_sqlite_hard_fault(&index, libsqlite3_sys::SQLITE_CORRUPT);
                assert!(coordinator::sqlite_verification_pending_exists(&index));
                assert!(!coordinator::sqlite_confirmed_corruption_exists(&index));
            }
            "probe" => {
                let index = resolve_database_path(&root.join("db.sqlite")).unwrap();
                let bytes = std::fs::read(&index).unwrap();
                let identity = coordinator::sqlite_file_identity(&index).unwrap();
                let probe = screenpipe_db::probe_quarantined_generation_health(&index)
                    .await
                    .expect("standalone probe must register schema functions on a cold start");
                assert_eq!(probe.file_identity, identity);
                assert_eq!(std::fs::read(&index).unwrap(), bytes);
                assert!(coordinator::sqlite_verification_pending_exists(&index));
            }
            phase @ ("resume" | "verify") => {
                let index = resolve_database_path(&root.join("db.sqlite")).unwrap();
                if phase == "resume" {
                    assert!(coordinator::sqlite_verification_pending_exists(&index));
                }
                // This is the first database open in this process. No earlier
                // storage pool may accidentally register the missing function.
                let db = open(root).await;
                assert!(!coordinator::sqlite_verification_pending_exists(&index));
                assert!(!coordinator::sqlite_quarantine_exists(&index));
                let transcripts: Vec<String> = sqlx::query_scalar(
                    "SELECT transcription FROM audio_transcriptions ORDER BY id",
                )
                .fetch_all(&db.pool)
                .await
                .unwrap();
                let mut expected = vec!["archived transcript", "resident transcript 東京"];
                if phase == "verify" {
                    expected.push("recorded after recovery");
                }
                assert_eq!(transcripts, expected);
                if phase == "resume" {
                    insert_transcript(&db, 3, "recorded after recovery").await;
                    // The expression index must still enforce payload identity.
                    let duplicate = db.execute_raw_sql_write("INSERT INTO audio_transcriptions(audio_chunk_id,offset_index,timestamp,transcription,device) VALUES(1,4,'2026-09-21T12:00:00Z','recorded after recovery','test')").await.unwrap_err();
                    assert!(
                        duplicate.to_string().contains("UNIQUE constraint failed"),
                        "{duplicate}"
                    );
                }
                db.verify_storage().await.unwrap();
                db.close().await;
            }
            phase => panic!("unknown child phase: {phase}"),
        }
        return;
    }

    let root = tempfile::tempdir().unwrap();
    let run = |phase: &str| {
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "pending_hybrid_fault_recovers_across_process_restarts",
                "--nocapture",
            ])
            .env(CHILD_ROOT, root.path())
            .env(CHILD_PHASE, phase)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{phase} failed:\n{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    };
    run("seed");
    let index = resolve_database_path(&root.path().join("db.sqlite")).unwrap();
    let identity = coordinator::sqlite_file_identity(&index).unwrap();
    run("probe");
    run("resume");
    run("verify");
    assert_eq!(coordinator::sqlite_file_identity(&index).unwrap(), identity);
}
