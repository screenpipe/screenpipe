// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Isolated probe for migration selection over privacy-pending element history.
use screenpipe_db::{storage::MigrationOptions, DatabaseManager};
use std::{
    sync::atomic::{AtomicU64, Ordering},
    time::Instant,
};

unsafe extern "C" fn progress(context: *mut std::ffi::c_void) -> i32 {
    let steps = unsafe { &*(context as *const AtomicU64) };
    steps.fetch_add(1000, Ordering::Relaxed);
    0
}

async fn measure(db: &DatabaseManager, label: &str, sql: &str, first: i64) -> anyhow::Result<()> {
    let steps = Box::new(AtomicU64::new(0));
    let mut conn = db.pool.acquire().await?;
    {
        let mut handle = conn.lock_handle().await?;
        unsafe {
            libsqlite3_sys::sqlite3_progress_handler(
                handle.as_raw_handle().as_ptr(),
                1000,
                Some(progress),
                (&*steps as *const AtomicU64).cast_mut().cast(),
            );
        }
    }
    let started = Instant::now();
    let result = sqlx::query_as::<_, (i64, i64)>(sqlx::AssertSqlSafe(sql.to_owned()))
        .bind(first)
        .bind(i64::MAX)
        .fetch_all(&mut *conn)
        .await;
    let elapsed = started.elapsed();
    {
        let mut handle = conn.lock_handle().await?;
        unsafe {
            libsqlite3_sys::sqlite3_progress_handler(
                handle.as_raw_handle().as_ptr(),
                0,
                None,
                std::ptr::null_mut(),
            );
        }
    }
    let rows = result?;
    assert_eq!(rows.len(), 1);
    println!(
        "{label}: rows={} first={} elapsed_ms={} sqlite_steps={}",
        rows.len(),
        rows[0].0,
        elapsed.as_millis(),
        steps.load(Ordering::Relaxed)
    );
    Ok(())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let count: i64 = std::env::args().nth(1).unwrap_or("100000".into()).parse()?;
    let root = tempfile::tempdir()?;
    let mut options = MigrationOptions::default();
    options.privacy.identity = "sparse-redaction-probe".into();
    options.privacy.required_surfaces = 1;
    let db = DatabaseManager::new_hybrid(root.path(), Default::default(), options).await?;
    let ready = count / 2;
    // Seed only the resident row source needed by the read-only selection. This
    // does not exercise ingestion, publication, or migration completion.
    let mut tx = db.begin_immediate_with_retry().await?;
    sqlx::query("WITH RECURSIVE n(id) AS (VALUES(1) UNION ALL SELECT id+1 FROM n WHERE id<?) INSERT INTO _bulk_element_rows(id,frame_id,source,role,text,properties,redacted_at,_archive_generation) SELECT id,1,'accessibility','AXText','pending privacy',?,CASE WHEN id=? THEN 1 ELSE NULL END,1 FROM n")
        .bind(count).bind("properties ".repeat(32)).bind(ready).execute(&mut **tx.conn()).await?;
    tx.commit().await?;
    let text = ["source", "role", "text", "properties"];
    let numeric = [
        "frame_id",
        "parent_id",
        "depth",
        "left_bound",
        "top_bound",
        "width_bound",
        "height_bound",
        "confidence",
        "sort_order",
        "on_screen",
        "redacted_at",
    ];
    let size = text
        .iter()
        .map(|c| format!("COALESCE(length(CAST({c} AS BLOB)),0)"))
        .chain(
            numeric
                .iter()
                .map(|c| format!("CASE WHEN {c} IS NULL THEN 0 ELSE 8 END")),
        )
        .collect::<Vec<_>>()
        .join("+");
    let eligible = "redacted_at IS NOT NULL OR (SELECT required_surfaces=0 FROM storage_metadata) OR (COALESCE(text,'')='' AND properties IS NULL)";
    println!(
        "probe: elements={count} eligible=1 required_surfaces=1 sqlite={}",
        sqlx::query_scalar::<_, String>("SELECT sqlite_version()")
            .fetch_one(&db.pool)
            .await?
    );
    for (label, source, extra) in [
        ("virtual_table", "elements", "1"),
        ("resident_table", "_bulk_element_rows", "_archive_deleted=0"),
    ] {
        let sql = format!("SELECT id,{size} FROM {source} WHERE id BETWEEN ? AND ? AND {extra} AND ({eligible}) ORDER BY id LIMIT 32768");
        measure(&db, label, &sql, ready).await?;
    }
    db.close().await;
    Ok(())
}
