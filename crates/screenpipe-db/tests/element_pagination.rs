// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use rusqlite::{params_from_iter, types::Value, Connection};
use screenpipe_db::{storage::MigrationOptions, DatabaseManager};
use std::sync::atomic::{AtomicU64, Ordering};

struct Work {
    steps: AtomicU64,
    limit: u64,
}

unsafe extern "C" fn count_steps(context: *mut std::ffi::c_void) -> i32 {
    let work = unsafe { &*(context as *const Work) };
    i32::from(work.steps.fetch_add(1000, Ordering::Relaxed) + 1000 > work.limit)
}

struct ProgressGuard<'a> {
    db: &'a Connection,
    work: Box<Work>,
}

impl Drop for ProgressGuard<'_> {
    fn drop(&mut self) {
        // Remove the callback before its context or borrowed connection dies.
        unsafe {
            libsqlite3_sys::sqlite3_progress_handler(
                self.db.handle(),
                0,
                None,
                std::ptr::null_mut(),
            );
        }
    }
}

fn ids(db: &Connection, sql: &str, args: &[Value]) -> rusqlite::Result<Vec<i64>> {
    db.prepare(sql)?
        .query_map(params_from_iter(args), |r| r.get(0))?
        .collect()
}

#[tokio::test]
async fn sparse_element_selection_has_linear_work_in_both_directions() {
    let root = tempfile::tempdir().unwrap();
    let mut options = MigrationOptions::default();
    options.privacy.identity = "pagination-regression".into();
    options.privacy.required_surfaces = 1;
    let db = DatabaseManager::new_hybrid(root.path(), Default::default(), options)
        .await
        .unwrap();
    let count = 100_000_i64;
    let mut tx = db.begin_immediate_with_retry().await.unwrap();
    // Isolate the read cursor: one eligible row in a large resident backlog.
    sqlx::query("WITH RECURSIVE n(id) AS (VALUES(1) UNION ALL SELECT id+1 FROM n WHERE id<?) INSERT INTO _bulk_element_rows(id,frame_id,source,role,text,redacted_at,_archive_generation) SELECT id,1,'accessibility','AXText','pending privacy',CASE WHEN id=? THEN 1 ELSE NULL END,1 FROM n")
        .bind(count).bind(count / 2).execute(&mut **tx.conn()).await.unwrap();
    tx.commit().await.unwrap();
    {
        let mut conn = db.pool.acquire().await.unwrap();
        let mut handle = conn.lock_handle().await.unwrap();
        // The SQLx worker is paused while this borrowed handle is used.
        let sqlite = unsafe { Connection::from_handle(handle.as_raw_handle().as_ptr()) }.unwrap();
        for direction in ["ASC", "DESC"] {
            // Count SQLite VM work, including nested virtual-table statements,
            // instead of asserting machine-dependent timing. Interrupt a
            // quadratic regression before it can hang CI on a larger fixture.
            let guard = ProgressGuard {
                db: &sqlite,
                work: Box::new(Work {
                    steps: AtomicU64::new(0),
                    limit: count as u64 * 200,
                }),
            };
            unsafe {
                libsqlite3_sys::sqlite3_progress_handler(
                    sqlite.handle(),
                    1000,
                    Some(count_steps),
                    (&*guard.work as *const Work).cast_mut().cast(),
                );
            }
            let selected = ids(&sqlite, &format!("SELECT id FROM elements WHERE id BETWEEN ? AND ? AND (redacted_at IS NOT NULL OR (SELECT required_surfaces=0 FROM storage_metadata) OR (COALESCE(text,'')='' AND properties IS NULL)) ORDER BY id {direction} LIMIT 32768"), &[1.into(), count.into()]);
            let work = guard.work.steps.load(Ordering::Relaxed);
            drop(guard);
            assert_eq!(
                selected.unwrap_or_else(|error| {
                    panic!("{direction} selection failed at {work} steps: {error}")
                }),
                vec![count / 2]
            );
        }
    }
    db.close().await;
}

async fn assert_bounds(db: &DatabaseManager, reference: &Connection) {
    let mut conn = db.pool.acquire().await.unwrap();
    let mut handle = conn.lock_handle().await.unwrap();
    let sqlite = unsafe { Connection::from_handle(handle.as_raw_handle().as_ptr()) }.unwrap();
    let cases: Vec<(&str, Vec<Value>)> = vec![
        ("1", vec![]),
        ("id>=? AND id<=?", vec![(-250).into(), 350.into()]),
        (
            "id>=? AND id>? AND id<=? AND id<?",
            vec![(-500).into(), (-250).into(), 400.into(), 350.into()],
        ),
        (
            "id>=? AND id<=?",
            vec![Value::Text("-250".into()), Value::Text("350".into())],
        ),
        (
            "id>? AND id<?",
            vec![Value::Real(-250.5), Value::Real(350.5)],
        ),
        ("id<?", vec![Value::Text("not a number".into())]),
        ("id>?", vec![Value::Text("not a number".into())]),
        ("id>=?", vec![Value::Null]),
        ("id=?", vec![Value::Text("7".into())]),
        ("id>?", vec![i64::MAX.into()]),
        ("id<?", vec![i64::MIN.into()]),
        (
            "id>=? AND id<=? AND frame_id=?",
            vec![(-400).into(), 400.into(), 1.into()],
        ),
    ];
    for (condition, args) in cases {
        for direction in ["ASC", "DESC"] {
            let sql = format!("SELECT id FROM elements WHERE {condition} ORDER BY id {direction}");
            assert_eq!(
                ids(&sqlite, &sql, &args).unwrap(),
                ids(reference, &sql, &args).unwrap(),
                "{sql}, {args:?}"
            );
        }
    }
}

#[tokio::test]
async fn advancing_pages_preserve_bounds_affinity_and_mixed_archives() {
    let root = tempfile::tempdir().unwrap();
    let db = DatabaseManager::new_hybrid(root.path(), Default::default(), Default::default())
        .await
        .unwrap();
    db.execute_raw_sql_write(
        "INSERT INTO frames(id,timestamp) VALUES(1,'2026-09-18'),(2,'2026-09-18')",
    )
    .await
    .unwrap();
    let reference = Connection::open_in_memory().unwrap();
    reference.execute_batch("CREATE TABLE elements(id INTEGER PRIMARY KEY,frame_id INTEGER,source TEXT,role TEXT,text TEXT)").unwrap();
    let seed = "WITH RECURSIVE n(id) AS (VALUES(-512) UNION ALL SELECT id+1 FROM n WHERE id<512) INSERT INTO elements(id,frame_id,source,role,text) SELECT id,1+abs(id%2),'accessibility','AXText','page test' FROM n; INSERT INTO elements(id,frame_id,source,role,text) VALUES(-9223372036854775808,1,'accessibility','AXText','minimum'),(9223372036854775807,1,'accessibility','AXText','maximum');";
    db.execute_raw_sql_write(seed).await.unwrap();
    reference.execute_batch(seed).unwrap();
    assert_bounds(&db, &reference).await;
    while db.seal_payloads().await.unwrap() != 0 {}
    let changes = "UPDATE elements SET text='edited' WHERE id%3=0; DELETE FROM elements WHERE id%7=0; INSERT INTO elements(id,frame_id,source,role,text) VALUES(777,2,'accessibility','AXText','new capture');";
    db.execute_raw_sql_write(changes).await.unwrap();
    reference.execute_batch(changes).unwrap();
    assert_bounds(&db, &reference).await;
    db.verify_storage().await.unwrap();
    db.close().await;
    let reopened = DatabaseManager::new(
        root.path().join("db.sqlite").to_str().unwrap(),
        Default::default(),
    )
    .await
    .unwrap();
    assert_bounds(&reopened, &reference).await;
    reopened.close().await;
}
