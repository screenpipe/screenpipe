// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use super::*;
use crate::planner_stats::{self, Attempt};
use std::time::Instant;

const LOOKUP: &str = "SELECT id FROM _bulk_element_rows WHERE id IN (SELECT value FROM json_each('[1]')) ORDER BY id";
const PLAN: &str = "EXPLAIN QUERY PLAN SELECT id FROM _bulk_element_rows WHERE id IN (SELECT value FROM json_each('[1]')) ORDER BY id";

// Delay the actual SQLite ANALYZE preparation, after maintenance owns the
// writer. This deterministically reproduces a slow operation without depending
// on host disk speed or adding a production timing knob.
struct AnalyzeHook {
    entered: tokio::sync::Notify,
    delay: Duration,
    cancel: Option<tokio_util::sync::CancellationToken>,
}

unsafe extern "C" fn analyze_hook(
    context: *mut std::ffi::c_void,
    action: std::ffi::c_int,
    table: *const std::ffi::c_char,
    _: *const std::ffi::c_char,
    _: *const std::ffi::c_char,
    _: *const std::ffi::c_char,
) -> std::ffi::c_int {
    if action == libsqlite3_sys::SQLITE_ANALYZE
        && !table.is_null()
        && unsafe { std::ffi::CStr::from_ptr(table).to_bytes() } == b"_bulk_element_rows"
    {
        // SAFETY: registration retains an Arc until the callback is removed.
        let hook = unsafe { &*context.cast::<AnalyzeHook>() };
        hook.entered.notify_one();
        if let Some(cancel) = &hook.cancel {
            cancel.cancel();
        }
        std::thread::sleep(hook.delay);
    }
    libsqlite3_sys::SQLITE_OK
}

async fn install_analyze_hook(db: &DatabaseManager, hook: &Arc<AnalyzeHook>) {
    let mut conn = db.write_pool.acquire().await.unwrap();
    {
        let mut handle = conn.lock_handle().await.unwrap();
        // SAFETY: exclusive connection; this fixture has no permanent authorizer.
        // Retain ownership even if the test panics before explicit removal.
        let result = unsafe {
            libsqlite3_sys::sqlite3_set_authorizer(
                handle.as_raw_handle().as_ptr(),
                Some(analyze_hook),
                Arc::into_raw(Arc::clone(hook)).cast_mut().cast(),
            )
        };
        assert_eq!(result, libsqlite3_sys::SQLITE_OK);
    }
    conn.return_to_pool().await;
}

async fn remove_analyze_hook(db: &DatabaseManager, hook: &Arc<AnalyzeHook>) {
    let mut conn = db.write_pool.acquire().await.unwrap();
    {
        let mut handle = conn.lock_handle().await.unwrap();
        // SAFETY: remove callback under exclusive access before releasing its Arc.
        unsafe {
            assert_eq!(
                libsqlite3_sys::sqlite3_set_authorizer(
                    handle.as_raw_handle().as_ptr(),
                    None,
                    std::ptr::null_mut()
                ),
                libsqlite3_sys::SQLITE_OK
            );
            drop(Arc::from_raw(Arc::as_ptr(hook)));
        }
    }
    conn.return_to_pool().await;
}

async fn plan(conn: &mut sqlx::SqliteConnection) -> String {
    sqlx::query(PLAN)
        .persistent(false)
        .fetch_all(conn)
        .await
        .unwrap()
        .iter()
        .map(|r| r.get::<String, _>(3))
        .collect::<Vec<_>>()
        .join("; ")
}

async fn scan_steps(conn: &mut sqlx::SqliteConnection, reset: bool) -> i32 {
    let mut handle = conn.lock_handle().await.unwrap();
    // SAFETY: exclusive handle guard; statement pointers are borrowed only
    // while the guard prevents the SQLx worker from using this connection.
    unsafe {
        let db = handle.as_raw_handle().as_ptr();
        let mut stmt = libsqlite3_sys::sqlite3_next_stmt(db, std::ptr::null_mut());
        while !stmt.is_null() {
            let sql = std::ffi::CStr::from_ptr(libsqlite3_sys::sqlite3_sql(stmt))
                .to_str()
                .unwrap();
            if sql == LOOKUP {
                return libsqlite3_sys::sqlite3_stmt_status(
                    stmt,
                    libsqlite3_sys::SQLITE_STMTSTATUS_FULLSCAN_STEP,
                    i32::from(reset),
                );
            }
            stmt = libsqlite3_sys::sqlite3_next_stmt(db, stmt);
        }
    }
    panic!("cached lookup missing");
}

async fn fixture() -> (tempfile::TempDir, DatabaseManager) {
    let root = tempfile::tempdir().unwrap();
    let config = DbConfig {
        read_pool_max: 4,
        read_pool_min: 1,
        write_pool_max: 1,
        ..Default::default()
    };
    let initial = DatabaseManager::new_hybrid(root.path(), config.clone(), Default::default())
        .await
        .unwrap();
    let storage = initial.storage.clone();
    let path = initial
        .write_pool
        .connect_options()
        .get_filename()
        .to_owned();
    initial.close().await;
    let db =
        DatabaseManager::new_with_storage(path.to_str().unwrap(), config, storage, false, false)
            .await
            .unwrap();
    db.execute_raw_sql_write("INSERT INTO frames(id,timestamp,full_text) VALUES(1,'2026-10-08','private history');
        WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<30)
        INSERT INTO _bulk_element_rows(id,frame_id,text,_archive_generation) SELECT x,1,'private history',1 FROM n;
        ANALYZE _bulk_element_rows;
        CREATE TABLE planner_other(id INTEGER PRIMARY KEY, group_id INTEGER);
        CREATE INDEX planner_other_group ON planner_other(group_id);
        INSERT INTO planner_other SELECT id,1 FROM _bulk_element_rows;
        ANALYZE planner_other;
        INSERT INTO upload_bindings(destination,checkpoint) VALUES('test','{\"last_id\":42}');")
        .await.unwrap();
    let storage = db.storage.clone();
    let config = DbConfig {
        read_pool_max: 4,
        read_pool_min: 1,
        write_pool_max: 1,
        ..Default::default()
    };
    db.close().await;
    let db =
        DatabaseManager::new_with_storage(path.to_str().unwrap(), config, storage, false, false)
            .await
            .unwrap();
    (root, db)
}

async fn grow(db: &DatabaseManager, end: i64) {
    db.execute_raw_sql_write(&format!("WITH RECURSIVE n(x) AS (VALUES(31) UNION ALL SELECT x+1 FROM n WHERE x<{end})
        INSERT INTO _bulk_element_rows(id,frame_id,text,_archive_generation) SELECT x,1,'private history',1 FROM n;
        INSERT INTO planner_other SELECT id,1 FROM _bulk_element_rows WHERE id>30;"))
        .await.unwrap();
}

async fn maintain(db: &DatabaseManager) -> Attempt {
    planner_stats::run(
        &db.write_pool,
        &db.write_semaphore,
        &db.write_queue_health,
        &db.close_token,
        Attempt::new(),
    )
    .await
}

async fn finish(db: &DatabaseManager) -> usize {
    let mut analyzed = 0;
    for _ in 0..100 {
        let attempt = maintain(db).await;
        println!("maintenance: {attempt:?}");
        analyzed += attempt.analyzed_tables;
        if attempt.status == "complete" {
            return analyzed;
        }
        assert_eq!(attempt.status, "deferred");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("maintenance failed to complete");
}

#[tokio::test]
async fn stale_statistics_repair_replans_existing_pools_and_preserves_storage() {
    let (_root, db) = fixture().await;
    // Keep two application readers alive, including their cached statements.
    let mut a = db.pool.acquire().await.unwrap();
    let mut b = db.pool.acquire().await.unwrap();
    let before = plan(&mut a).await;
    assert!(before.contains("SCAN _bulk_element_rows"), "{before}");
    assert!(plan(&mut b).await.contains("SCAN _bulk_element_rows"));
    grow(&db, 300_000).await;
    let stats: String =
        sqlx::query_scalar("SELECT stat FROM sqlite_stat1 WHERE idx='_bulk_element_staged_frame'")
            .fetch_one(&mut *a)
            .await
            .unwrap();
    assert_eq!(stats, "30 30");
    // The old maintenance path runs on the writer, whose SELECT history does
    // not contain these reader lookups. It leaves the 30-row estimate stale.
    {
        let permit = db.coordinated_writer().lock().await.unwrap();
        sqlx::query("PRAGMA optimize")
            .execute(permit.pool())
            .await
            .unwrap();
    }
    let stats: String =
        sqlx::query_scalar("SELECT stat FROM sqlite_stat1 WHERE idx='_bulk_element_staged_frame'")
            .fetch_one(&mut *a)
            .await
            .unwrap();
    assert_eq!(stats, "30 30");
    let rows_before: (i64, i64, i64) =
        sqlx::query_as("SELECT count(*),sum(id),sum(length(text)) FROM _bulk_element_rows")
            .fetch_one(&mut *a)
            .await
            .unwrap();
    let revisions: (i64, i64) = sqlx::query_as(
        "SELECT revision,(SELECT revision FROM _storage_revocation) FROM storage_metadata",
    )
    .fetch_one(&mut *a)
    .await
    .unwrap();
    let schema: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_stat%' ORDER BY name",
    )
    .fetch_all(&mut *a)
    .await
    .unwrap();
    let start = Instant::now();
    let ids: Vec<i64> = sqlx::query_scalar(LOOKUP).fetch_all(&mut *a).await.unwrap();
    let slow = start.elapsed();
    assert_eq!(ids, vec![1]);
    assert!(scan_steps(&mut a, true).await > 200_000);
    sqlx::query_scalar::<_, i64>(LOOKUP)
        .fetch_all(&mut *b)
        .await
        .unwrap();
    assert!(scan_steps(&mut b, true).await > 200_000);
    assert!(finish(&db).await >= 2);
    for conn in [&mut *a, &mut *b] {
        // EXPLAIN does not step the program's schema-cookie check. Execute
        // the cached application query first, as real callers do.
        assert_eq!(
            sqlx::query_scalar::<_, i64>(LOOKUP)
                .fetch_all(&mut *conn)
                .await
                .unwrap(),
            vec![1]
        );
        assert_eq!(
            scan_steps(conn, false).await,
            0,
            "cached lookup must not scan"
        );
        let after = plan(conn).await;
        println!("before={before}; after={after}; scan_duration={slow:?}");
        assert!(
            after.contains("SEARCH _bulk_element_rows USING INTEGER PRIMARY KEY"),
            "{after}"
        );
        let start = Instant::now();
        assert_eq!(
            sqlx::query_scalar::<_, i64>(LOOKUP)
                .fetch_all(&mut *conn)
                .await
                .unwrap(),
            vec![1]
        );
        println!("pk_duration={:?}", start.elapsed());
        let other: Vec<(i64,i64,i64,String)> = sqlx::query_as("EXPLAIN QUERY PLAN SELECT id FROM planner_other WHERE id IN (SELECT value FROM json_each('[1]')) ORDER BY id").fetch_all(&mut *conn).await.unwrap();
        assert!(
            other
                .iter()
                .any(|r| r.3.contains("USING INTEGER PRIMARY KEY")),
            "{other:?}"
        );
    }
    assert_eq!(
        sqlx::query_as::<_, (i64, i64, i64)>(
            "SELECT count(*),sum(id),sum(length(text)) FROM _bulk_element_rows"
        )
        .fetch_one(&mut *a)
        .await
        .unwrap(),
        rows_before
    );
    assert_eq!(
        sqlx::query_as::<_, (i64, i64)>(
            "SELECT revision,(SELECT revision FROM _storage_revocation) FROM storage_metadata"
        )
        .fetch_one(&mut *a)
        .await
        .unwrap(),
        revisions
    );
    assert_eq!(
        sqlx::query_as::<_, (String, Option<String>)>(
            "SELECT name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_stat%' ORDER BY name"
        )
        .fetch_all(&mut *a)
        .await
        .unwrap(),
        schema
    );
    let selected = sqlx::query_scalar::<_, String>("PRAGMA main.optimize=0x10003")
        .fetch_all(&db.write_pool)
        .await
        .unwrap();
    assert!(
        !selected
            .iter()
            .any(|s| s.contains("_bulk_element_rows") || s.contains("planner_other")),
        "unchanged large tables need no reanalysis: {selected:?}"
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT checkpoint FROM upload_bindings WHERE destination='test'"
        )
        .fetch_one(&mut *a)
        .await
        .unwrap(),
        r#"{"last_id":42}"#
    );
    drop(a);
    drop(b);
    db.close().await;
}

#[tokio::test]
async fn maintenance_defers_to_writer_and_recording_remains_durable() {
    let (root, db) = fixture().await;
    grow(&db, 100_000).await;
    let tx = db.begin_immediate_with_retry().await.unwrap();
    let start = Instant::now();
    let deferred = maintain(&db).await;
    assert_eq!(deferred.status, "deferred");
    assert!(start.elapsed() < Duration::from_millis(100));
    planner_stats::save(root.path(), &deferred).await;
    tx.commit().await.unwrap();
    let writes = async {
        let mut max_latency = Duration::ZERO;
        for id in 2..52 {
            let start = Instant::now();
            let _ = id;
            db.insert_snapshot_frame(
                "test",
                chrono::Utc::now(),
                "",
                None,
                None,
                None,
                true,
                Some("test"),
                Some("private history"),
                Some("accessibility"),
                None,
                None,
                None,
            )
            .await
            .unwrap();
            max_latency = max_latency.max(start.elapsed());
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        println!("maximum capture writer latency={max_latency:?}");
        assert!(max_latency < Duration::from_secs(1));
    };
    let (_, _) = tokio::join!(writes, finish(&db));
    let complete = maintain(&db).await;
    planner_stats::save(root.path(), &complete).await;
    let path = db.write_pool.connect_options().get_filename().to_owned();
    let config = DbConfig::default();
    db.close().await;
    let reopened = DatabaseManager::new_with_storage(
        path.to_str().unwrap(),
        config,
        crate::storage::HybridStorage::for_index(&path).unwrap(),
        false,
        false,
    )
    .await
    .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM frames")
            .fetch_one(&reopened.pool)
            .await
            .unwrap(),
        51
    );
    let report = planner_stats::report(root.path()).unwrap();
    assert_eq!(
        report.last_failure.unwrap().detail.unwrap(),
        "writer busy; retry on next maintenance tick"
    );
    assert_eq!(report.last_success.unwrap().status, "complete");
    reopened.close().await;
}

#[tokio::test]
async fn interrupted_analysis_rolls_back_and_returns_a_usable_writer() {
    let (_root, db) = fixture().await;
    grow(&db, 100_000).await;
    let original: String =
        sqlx::query_scalar("SELECT stat FROM sqlite_stat1 WHERE idx='_bulk_element_staged_frame'")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    let mut conn = db.write_pool.acquire().await.unwrap();
    let busy: i64 = sqlx::query_scalar("PRAGMA busy_timeout")
        .fetch_one(&mut *conn)
        .await
        .unwrap();
    let limit: i64 = sqlx::query_scalar("PRAGMA analysis_limit")
        .fetch_one(&mut *conn)
        .await
        .unwrap();
    conn.return_to_pool().await;
    let cancel = tokio_util::sync::CancellationToken::new();
    let hook = Arc::new(AnalyzeHook {
        entered: tokio::sync::Notify::new(),
        delay: Duration::from_millis(10),
        cancel: Some(cancel.clone()),
    });
    install_analyze_hook(&db, &hook).await;
    let error = planner_stats::slice(
        &db.write_pool,
        &db.write_semaphore,
        &db.write_queue_health,
        &cancel,
        Some("ANALYZE main._bulk_element_rows"),
    )
    .await
    .unwrap_err();
    remove_analyze_hook(&db, &hook).await;
    assert!(crate::is_sqlite_interrupt(&error), "{error}");
    let mut conn = db.write_pool.acquire().await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("PRAGMA busy_timeout")
            .fetch_one(&mut *conn)
            .await
            .unwrap(),
        busy
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("PRAGMA analysis_limit")
            .fetch_one(&mut *conn)
            .await
            .unwrap(),
        limit
    );
    conn.return_to_pool().await;
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT stat FROM sqlite_stat1 WHERE idx='_bulk_element_staged_frame'"
        )
        .fetch_one(&db.pool)
        .await
        .unwrap(),
        original
    );
    db.insert_snapshot_frame(
        "test",
        chrono::Utc::now(),
        "",
        None,
        None,
        None,
        true,
        Some("test"),
        Some("private history"),
        Some("accessibility"),
        None,
        None,
        None,
    )
    .await
    .unwrap();
    assert!(!db.write_queue_health.is_hard_faulted());
    finish(&db).await;
    db.close().await;
}

#[tokio::test]
async fn background_tick_repairs_reopened_history_without_capture_trigger() {
    let (root, db) = fixture().await;
    grow(&db, 100_000).await;
    db.start_wal_maintenance();
    tokio::time::timeout(Duration::from_secs(70), async {
        loop {
            if planner_stats::report(root.path())
                .unwrap()
                .last_success
                .is_some()
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .unwrap();
    let mut reader = db.pool.acquire().await.unwrap();
    sqlx::query_scalar::<_, i64>(LOOKUP)
        .fetch_all(&mut *reader)
        .await
        .unwrap();
    assert!(plan(&mut reader)
        .await
        .contains("USING INTEGER PRIMARY KEY"));
    drop(reader);
    db.close().await;
}

#[tokio::test]
async fn dropped_maintenance_keeps_writer_until_sqlite_cleanup_finishes() {
    let (_root, db) = fixture().await;
    let db = Arc::new(db);
    // Startup returns pooled connections asynchronously; make this writer
    // available before testing cancellation rather than incidental deferral.
    let mut ready = db.write_pool.acquire().await.unwrap();
    ready.return_to_pool().await;
    let copy = Arc::clone(&db);
    let cancel = tokio_util::sync::CancellationToken::new();
    let shutdown = cancel.clone();
    // Deliberately expensive SQL at the same shutdown cancellation boundary.
    // Aborting the caller must not abandon its active worker/transaction.
    let task = tokio::spawn(async move {
        planner_stats::slice(&copy.write_pool, &copy.write_semaphore, &copy.write_queue_health,
            &shutdown, Some("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100000000) SELECT sum(x) FROM n")).await
    });
    tokio::time::timeout(Duration::from_secs(1), async {
        while db.write_semaphore.available_permits() != 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    task.abort();
    let _ = task.await;
    cancel.cancel();
    tokio::time::timeout(
        Duration::from_secs(1),
        db.insert_snapshot_frame(
            "test",
            chrono::Utc::now(),
            "",
            None,
            None,
            None,
            true,
            Some("test"),
            Some("private history"),
            Some("accessibility"),
            None,
            None,
            None,
        ),
    )
    .await
    .unwrap()
    .unwrap();
    // The shutdown watcher must not interrupt the next borrower.
    finish(&db).await;
    db.close().await;
}

#[tokio::test]
async fn slow_analysis_finishes_and_waiting_recording_is_preserved() {
    let (root, db) = fixture().await;
    grow(&db, 300_000).await;
    let mut reader = db.pool.acquire().await.unwrap();
    assert!(plan(&mut reader).await.contains("SCAN _bulk_element_rows"));
    sqlx::query_scalar::<_, i64>(LOOKUP)
        .fetch_all(&mut *reader)
        .await
        .unwrap();
    assert!(scan_steps(&mut reader, true).await > 200_000);
    let hook = Arc::new(AnalyzeHook {
        entered: tokio::sync::Notify::new(),
        delay: Duration::from_millis(250),
        cancel: None,
    });
    install_analyze_hook(&db, &hook).await;
    let record = async {
        hook.entered.notified().await;
        let start = Instant::now();
        db.insert_snapshot_frame(
            "test",
            chrono::Utc::now(),
            "",
            None,
            None,
            None,
            true,
            Some("test"),
            Some("recorded while analysis was running"),
            Some("accessibility"),
            None,
            None,
            None,
        )
        .await
        .unwrap();
        start.elapsed()
    };
    let (attempt, recording_wait) = tokio::time::timeout(Duration::from_secs(10), async {
        tokio::join!(db.maintain_planner_statistics(), record)
    })
    .await
    .unwrap();
    remove_analyze_hook(&db, &hook).await;
    println!("slow analysis attempt={attempt:?}; recording wait={recording_wait:?}");
    assert!(attempt.analyzed_tables >= 1, "{attempt:?}");
    assert!(attempt.duration_ms >= 250, "{attempt:?}");
    assert_eq!(
        attempt.sqlite_code, None,
        "slow analysis must not be interrupted"
    );
    // The slow table must be repaired in this attempt, even when maintenance
    // defers other tables to let the waiting recording take the writer.
    assert_eq!(
        sqlx::query_scalar::<_, i64>(LOOKUP)
            .fetch_all(&mut *reader)
            .await
            .unwrap(),
        vec![1]
    );
    assert_eq!(scan_steps(&mut reader, false).await, 0);
    assert!(plan(&mut reader)
        .await
        .contains("USING INTEGER PRIMARY KEY"));
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM _bulk_element_rows")
            .fetch_one(&mut *reader)
            .await
            .unwrap(),
        300_000
    );
    drop(reader);
    let path = db.write_pool.connect_options().get_filename().to_owned();
    db.close().await;
    let reopened = DatabaseManager::new_with_storage(
        path.to_str().unwrap(),
        DbConfig::default(),
        crate::storage::HybridStorage::for_index(&path).unwrap(),
        false,
        false,
    )
    .await
    .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM frames")
            .fetch_one(&reopened.pool)
            .await
            .unwrap(),
        2
    );
    assert!(
        planner_stats::report(root.path())
            .unwrap()
            .latest
            .unwrap()
            .duration_ms
            >= 250
    );
    reopened.close().await;
}
