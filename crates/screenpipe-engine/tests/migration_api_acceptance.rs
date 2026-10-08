// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Explicit, isolated production-budget acceptance run. Never opens user data.
//! cargo test -p screenpipe-engine --test migration_api_acceptance -- --ignored --nocapture

use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use screenpipe_audio::audio_manager::AudioManagerBuilder;
use screenpipe_db::{
    storage::{migrate, Projection},
    DatabaseManager,
};
use screenpipe_engine::SCServer;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{net::SocketAddr, path::Path, sync::Arc, time::Instant};
use tower::ServiceExt;

const MIB: usize = 1024 * 1024;

async fn open(root: &Path) -> Arc<DatabaseManager> {
    Arc::new(
        DatabaseManager::new(root.join("db.sqlite").to_str().unwrap(), Default::default())
            .await
            .unwrap(),
    )
}

async fn router(root: &Path, db: Arc<DatabaseManager>) -> Router {
    let audio = Arc::new(
        AudioManagerBuilder::new()
            .is_disabled(true)
            .output_path(root.join("audio"))
            .build(db.clone())
            .await
            .unwrap(),
    );
    let mut server = SCServer::new(
        db,
        SocketAddr::from(([127, 0, 0, 1], 0)),
        root.to_path_buf(),
        true,
        true,
        audio,
        false,
        "balanced".into(),
    );
    server.api_auth = true;
    server.api_auth_key = Some("isolated-migration-acceptance".into());
    server.try_create_router().await.unwrap()
}

// Check allocation, including WAL, journals, staging, and archives, rather than
// adding logical lengths of sparse SQLite files or quoting compression ratios.
#[cfg(unix)]
fn allocated(root: &Path) -> u64 {
    use std::os::unix::fs::MetadataExt;
    std::fs::read_dir(root)
        .unwrap()
        .map(|entry| {
            let entry = entry.unwrap();
            if entry.file_type().unwrap().is_dir() {
                allocated(&entry.path())
            } else {
                entry.metadata().unwrap().blocks() * 512
            }
        })
        .sum()
}

fn payload(bytes: usize) -> String {
    // Many distinct lines model captured JSON/text with repeated structure,
    // without measuring the unrealistic compression of one repeated byte.
    let block: String = (0..4096)
        .map(|n| {
            format!(
                "capture node {n:04} document invoice account {} 東京🙂\n",
                n * 7919
            )
        })
        .collect();
    block.repeat(bytes / block.len() + 1)
}

async fn fixture(db: &DatabaseManager) {
    let normal = json!({"is_enabled":true,"description":payload(128 * 1024)}).to_string();
    let large = json!({"is_enabled":true,"description":payload(40 * MIB)}).to_string();
    let tree = json!([{"role":"AXText","text":payload(40 * MIB),"depth":0,"bounds":{"left":0.1,"top":0.1,"width":0.5,"height":0.5}}]).to_string();
    for id in 1..=264_i64 {
        let mut tx = db.begin_immediate_with_retry().await.unwrap();
        sqlx::query("INSERT INTO frames(id,timestamp,device_name,app_name,window_name,full_text,accessibility_text,accessibility_tree_json,snapshot_path) VALUES(?,'2026-09-18T12:00:00Z','display','Browser','Acceptance',?,?,?,?)")
            .bind(id).bind(format!("{} migration frame {id}", if id > 256 {"oversizedneedle"} else {"ordinaryneedle"}))
            .bind(format!("{} accessibility frame {id}", if id > 256 {"oversizedneedle"} else {"ordinaryneedle"}))
            .bind(if id > 256 {tree.as_str()} else {"[]"}).bind(format!("fixture-{id}.jpg"))
            .execute(&mut **tx.conn()).await.unwrap();
        for offset in 0..4 {
            sqlx::query("INSERT INTO elements(id,frame_id,source,role,text,properties) VALUES(?,?,'accessibility','AXText',?,?)")
                .bind(id * 4 + offset).bind(id).bind(format!("{} element {id}/{offset}", if id > 256 {"oversizedneedle"} else {"ordinaryneedle"}))
                .bind(if id > 256 && offset == 0 {&large} else {&normal})
                .execute(&mut **tx.conn()).await.unwrap();
        }
        tx.commit().await.unwrap();
        if id % 32 == 0 {
            db.wal_checkpoint().await.unwrap();
        }
    }
    // Three full-text captures collectively exceed the 128 MiB response
    // budget; each is an acknowledged record the API could read in SQLite.
    let huge_text = format!(
        "gianttextneedle {}",
        "historical context ".repeat(48 * MIB / 19)
    );
    for id in 300..303_i64 {
        let mut tx = db.begin_immediate_with_retry().await.unwrap();
        sqlx::query("INSERT INTO frames(id,timestamp,app_name,full_text,accessibility_text,snapshot_path) VALUES(?,'2026-09-18T13:00:00Z','Browser',?,'gianttextneedle',?)")
            .bind(id).bind(&huge_text).bind(format!("fixture-{id}.jpg")).execute(&mut **tx.conn()).await.unwrap();
        tx.commit().await.unwrap();
        db.wal_checkpoint().await.unwrap();
    }
}

async fn request(router: &Router, path: &str) -> (StatusCode, String, usize, f64) {
    let start = Instant::now();
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .uri(path)
                .header("Authorization", "Bearer isolated-migration-acceptance")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 768 * MIB).await.unwrap();
    let elapsed = start.elapsed().as_secs_f64() * 1000.0;
    if !status.is_success() {
        eprintln!(
            "API FAILURE {path}: {status} {}",
            String::from_utf8_lossy(&bytes)
        );
    }
    (
        status,
        format!("{:x}", Sha256::digest(&bytes)),
        bytes.len(),
        elapsed,
    )
}

async fn measure(router: &Router, phase: &str, paths: &[&str]) -> Vec<Value> {
    let mut results = Vec::new();
    for path in paths {
        let first = request(router, path).await;
        let mut times = Vec::new();
        let repeats = if first.2 > MIB { 3 } else { 15 };
        for sample in 0..repeats {
            // Change a real query-key field without changing the fixture's
            // result set, so search's HTTP response cache cannot mask I/O.
            let uncached = if path.starts_with("/search?") {
                format!("{path}&end_time=2026-09-20T00:00:{sample:02}Z")
            } else {
                path.to_string()
            };
            let next = request(router, &uncached).await;
            assert_eq!(
                (next.0, &next.1, next.2),
                (first.0, &first.1, first.2),
                "unstable response: {phase} {path}"
            );
            times.push(next.3);
        }
        times.sort_by(f64::total_cmp);
        let result = json!({"phase":phase,"path":path,"status":first.0.as_u16(),"sha256":first.1,"bytes":first.2,"first_ms":first.3,"p50_ms":times[times.len()/2],"p95_ms":times[(times.len()*95/100).min(times.len()-1)],"samples":repeats});
        eprintln!("API_ACCEPTANCE {result}");
        results.push(result);
    }
    results
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "generates approximately 1 GiB of isolated history; API parity and latency acceptance"]
async fn production_size_migration_preserves_api_and_saves_allocated_space() {
    let root = tempfile::tempdir().unwrap();
    eprintln!("API_ACCEPTANCE fixture={}", root.path().display());
    let db = open(root.path()).await;
    fixture(&db).await;
    db.wal_checkpoint().await.unwrap();
    let paths = [
        "/search?q=ordinaryneedle&content_type=ocr&limit=20",
        "/search?q=oversizedneedle&content_type=ocr&limit=20",
        "/search?q=ordinaryneedle&content_type=accessibility&limit=20",
        "/elements?q=ordinaryneedle&limit=20",
        "/elements?q=oversizedneedle&limit=5",
        "/frames/257/text",
        "/frames/257/metadata",
        "/frames/257/elements",
        "/frames/257/context",
        "/search?q=gianttextneedle&content_type=ocr&limit=3",
        "/search?q=gianttextneedle&content_type=accessibility&limit=3",
    ];
    let api = router(root.path(), db.clone()).await;
    let baseline = measure(&api, "sqlite", &paths).await;
    assert!(baseline.iter().all(|row| row["status"] == 200));
    assert!(baseline
        .iter()
        .filter(|row| {
            row["path"].as_str().unwrap().contains("gianttextneedle")
                || row["path"] == "/frames/257/context"
        })
        .all(|row| row["bytes"].as_u64().unwrap() > MIB as u64));
    drop(api);
    db.wal_checkpoint().await.unwrap();
    db.close().await;
    drop(db);
    let before_bytes = allocated(root.path());
    let start = Instant::now();
    let report = migrate(root.path(), Default::default(), Default::default())
        .await
        .unwrap();
    let seconds = start.elapsed().as_secs_f64();
    assert!(report.all_eligible_payloads_archived);
    let after_bytes = allocated(root.path());
    eprintln!(
        "DISK_ACCEPTANCE {}",
        json!({"allocated_before":before_bytes,"allocated_after":after_bytes,"saved_fraction":1.0-after_bytes as f64/before_bytes as f64,"migration_seconds":seconds,"report":report})
    );
    assert!(
        after_bytes < before_bytes / 2,
        "must reclaim physical disk allocation"
    );
    let mut failures = Vec::new();
    for reopen in 0..2 {
        let db = open(root.path()).await;
        db.verify_storage().await.unwrap();
        let resident: i64 = sqlx::query_scalar("SELECT count(*) FROM frames WHERE full_text IS NOT NULL OR accessibility_tree_json IS NOT NULL").fetch_one(&db.pool).await.unwrap();
        assert_eq!(
            resident,
            i64::from(reopen > 0),
            "eligible historical frame payloads remain in SQLite"
        );
        let api = router(root.path(), db.clone()).await;
        let actual = measure(&api, &format!("parquet-reopen-{reopen}"), &paths).await;
        for (before, after) in baseline.iter().zip(&actual) {
            if before["status"] != after["status"]
                || before["sha256"] != after["sha256"]
                || before["bytes"] != after["bytes"]
            {
                failures.push(format!(
                    "reopen {reopen} parity: {} before={} after={}",
                    before["path"], before, after
                ));
            }
        }
        // A heavy archival read must not prevent the existing writer from
        // durably acknowledging the next capture, including after restart.
        let read = request(&api, "/frames/257/text");
        let write = async {
            let start = Instant::now();
            db.execute_raw_sql_write("INSERT OR IGNORE INTO frames(id,timestamp,full_text,snapshot_path) VALUES(999,'2026-09-19T00:00:00Z','capture after migration','new.jpg')").await.unwrap();
            eprintln!(
                "CAPTURE_ACCEPTANCE reopen={reopen} write_ms={}",
                start.elapsed().as_secs_f64() * 1000.0
            );
        };
        let (read_result, ()) = tokio::join!(read, write);
        assert_eq!(read_result.0, StatusCode::OK);
        assert!(
            read_result.2 > MIB,
            "concurrent read must hydrate real history"
        );
        assert_eq!(
            db.frame_payloads(&[999], Projection::Search).await.unwrap()[&999]
                .full_text
                .as_deref(),
            Some("capture after migration")
        );
        drop(api);
        db.close().await;
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
