// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Sampled planner maintenance, independent of the writer's query history.
//! No capture-path hooks, connection recycling, or recording-data mutations.

use serde::{Deserialize, Serialize};
use sqlx::{SqliteConnection, SqlitePool};
use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

pub(crate) const INTERVAL: Duration = Duration::from_secs(3600);
// SQLite recommends approximate ANALYZE with 100–1000 sampled rows per index;
// 1000 also repaired the reported production plan. This bounds sampling, not
// elapsed time: counting index pages may take longer and must be allowed to finish.
const ANALYSIS_LIMIT: i64 = 1000;
const FILE: &str = "sqlite-planner-maintenance.json";

/// Allowlisted metadata only: never SQL, table contents, paths, or raw errors.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Attempt {
    pub started_at: String,
    pub status: String,
    pub duration_ms: u64,
    pub analyzed_tables: usize,
    pub stage: String,
    pub sqlite_code: Option<String>,
    pub detail: Option<String>,
}

#[derive(Clone, Default, Debug, Serialize, Deserialize)]
pub struct Report {
    pub latest: Option<Attempt>,
    pub last_success: Option<Attempt>,
    pub last_failure: Option<Attempt>,
}

/// Read durable evidence even after engine restart or rolling-log rotation.
pub fn report(root: &Path) -> Result<Report, std::io::Error> {
    let file = match std::fs::File::open(root.join(FILE)) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Report::default()),
        Err(e) => return Err(e),
    };
    serde_json::from_reader(file).map_err(std::io::Error::other)
}

pub(crate) async fn save(root: &Path, attempt: &Attempt) {
    let root = root.to_owned();
    let attempt = attempt.clone();
    let result = tokio::task::spawn_blocking(move || {
        let mut saved = report(&root).map_err(sqlx::Error::Io)?;
        if attempt.status == "complete" {
            saved.last_success = Some(attempt.clone());
        } else if attempt.status != "running" {
            saved.last_failure = Some(attempt.clone());
        }
        saved.latest = Some(attempt);
        crate::storage::durable_json(&root.join(FILE), &saved)
    })
    .await;
    if !matches!(result, Ok(Ok(()))) {
        tracing::warn!("sqlite planner maintenance: could not persist support diagnostics");
    }
}

impl Attempt {
    pub(crate) fn new() -> Self {
        Self {
            started_at: chrono::Utc::now().to_rfc3339(),
            status: "running".into(),
            duration_ms: 0,
            analyzed_tables: 0,
            stage: "selecting_tables".into(),
            sqlite_code: None,
            detail: None,
        }
    }

    fn failure(&mut self, error: &sqlx::Error) {
        self.status = "deferred".into();
        self.sqlite_code = error
            .as_database_error()
            .and_then(|e| e.code())
            .map(|s| s.into_owned());
        // sqlite3_errstr returns a static generic description, unlike errmsg,
        // which can embed SQL, captured values or filesystem paths.
        self.detail = Some(
            if let Some(code) = self
                .sqlite_code
                .as_ref()
                .and_then(|s| s.parse::<i32>().ok())
            {
                // SAFETY: SQLite owns this immutable, NUL-terminated string.
                unsafe { std::ffi::CStr::from_ptr(libsqlite3_sys::sqlite3_errstr(code)) }
                    .to_string_lossy()
                    .into_owned()
            } else {
                match error {
                    sqlx::Error::PoolClosed => "database pool closed",
                    sqlx::Error::PoolTimedOut => "database pool unavailable",
                    sqlx::Error::Io(_) => "maintenance I/O failure",
                    _ => "maintenance failed; inspect SQLite health diagnostics",
                }
                .into()
            },
        );
        if crate::sqlite_error::is_sqlite_hard_fault(error) {
            self.status = "failed".into();
        }
    }
}

/// One slice owns the existing writer lane. Do not queue ahead of capture or
/// wait for another SQLite writer. Await SQLite completion before releasing
/// the permit; a Tokio timeout alone would leave its worker running.
pub(crate) async fn slice(
    pool: &SqlitePool,
    semaphore: &Arc<Semaphore>,
    health: &crate::write_queue::WriteQueueHealth,
    shutdown: &CancellationToken,
    analyze: Option<&str>,
) -> Result<Option<Vec<String>>, sqlx::Error> {
    let Ok(permit) = Arc::clone(semaphore).try_acquire_owned() else {
        return Ok(None);
    };
    if health.is_hard_faulted() || shutdown.is_cancelled() {
        return Err(sqlx::Error::PoolClosed);
    }
    let Some(mut conn) = pool.try_acquire() else {
        return Ok(None);
    };
    let health = health.clone();
    let shutdown = shutdown.clone();
    let analyze = analyze.map(str::to_owned);
    // Own both the connection and writer permit until SQLite has stopped and
    // cleanup has finished, even if the caller drops/aborts its async future.
    tokio::spawn(async move {
        let _permit = permit;
        let result = on_connection(&mut conn, &health, &shutdown, analyze.as_deref()).await;
        if let Err(error) = &result {
            if crate::sqlite_error::is_sqlite_hard_fault(error) {
                health.latch_hard_fault(error);
            }
        }
        conn.return_to_pool().await;
        result.map(Some)
    })
    .await
    .map_err(|_| sqlx::Error::WorkerCrashed)?
}

// SQLite's B-tree count can run inside a single VM opcode. A progress
// handler alone cannot interrupt it during shutdown. sqlite3_interrupt is thread-safe;
// this guard synchronizes its lifetime with the owned connection, including
// unwinding, so cancellation cannot interrupt a later borrower or freed handle.
struct InterruptOnShutdown {
    target: Arc<Mutex<Option<usize>>>,
    watcher: tokio::task::JoinHandle<()>,
}

impl InterruptOnShutdown {
    fn new(raw: usize, shutdown: CancellationToken) -> Self {
        let target = Arc::new(Mutex::new(Some(raw)));
        let watcher_target = Arc::clone(&target);
        let watcher = tokio::spawn(async move {
            shutdown.cancelled().await;
            let guard = watcher_target.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(raw) = *guard {
                // SAFETY: Drop clears the pointer under this same lock before
                // the owning task can return/close the connection.
                unsafe {
                    libsqlite3_sys::sqlite3_interrupt(raw as *mut libsqlite3_sys::sqlite3);
                }
            }
        });
        Self { target, watcher }
    }
}

impl Drop for InterruptOnShutdown {
    fn drop(&mut self) {
        *self.target.lock().unwrap_or_else(|e| e.into_inner()) = None;
        self.watcher.abort();
    }
}

async fn on_connection(
    conn: &mut SqliteConnection,
    health: &crate::write_queue::WriteQueueHealth,
    shutdown: &CancellationToken,
    analyze: Option<&str>,
) -> Result<Vec<String>, sqlx::Error> {
    let busy: i64 = sqlx::query_scalar("PRAGMA busy_timeout")
        .fetch_one(&mut *conn)
        .await?;
    let limit: i64 = sqlx::query_scalar("PRAGMA analysis_limit")
        .fetch_one(&mut *conn)
        .await?;
    sqlx::query("PRAGMA busy_timeout=0")
        .execute(&mut *conn)
        .await?;
    let cancel = shutdown.clone();
    let raw = {
        let mut handle = conn.lock_handle().await?;
        handle.set_progress_handler(1000, move || !cancel.is_cancelled());
        handle.as_raw_handle().as_ptr() as usize
    };
    let watcher = InterruptOnShutdown::new(raw, shutdown.clone());
    let result = work(conn, analyze).await;
    drop(watcher);
    if let Err(error) = &result {
        if crate::sqlite_error::is_sqlite_hard_fault(error) {
            health.latch_hard_fault(error);
        }
    }
    let cleanup = async {
        let in_transaction = {
            let mut handle = conn.lock_handle().await?;
            handle.remove_progress_handler();
            // SAFETY: the handle guard excludes SQLx. INTERRUPT can already have
            // rolled back the transaction; SQLx's transaction-depth counter does
            // not track that, so maintenance uses SQLite's actual transaction state.
            unsafe { libsqlite3_sys::sqlite3_get_autocommit(handle.as_raw_handle().as_ptr()) == 0 }
        };
        if in_transaction {
            sqlx::query("ROLLBACK").execute(&mut *conn).await?;
        }
        // Always restore connection-local settings before normal writes reuse it.
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "PRAGMA analysis_limit={limit}"
        )))
        .execute(&mut *conn)
        .await?;
        sqlx::query(sqlx::AssertSqlSafe(format!("PRAGMA busy_timeout={busy}")))
            .execute(&mut *conn)
            .await?;
        if result.is_err()
            && !result
                .as_ref()
                .err()
                .is_some_and(crate::sqlite_error::is_sqlite_hard_fault)
        {
            // ANALYZE may have loaded uncommitted estimates before a later error
            // rolled back the transaction. Restore this writer's in-memory view.
            sqlx::query("ANALYZE main.sqlite_schema")
                .execute(&mut *conn)
                .await?;
        }
        Ok::<_, sqlx::Error>(())
    }
    .await;
    if let Err(error) = &cleanup {
        if crate::sqlite_error::is_sqlite_hard_fault(error) {
            health.latch_hard_fault(error);
        }
    }
    // A cleanup error must not overwrite the originating SQLite failure.
    match result {
        Err(error) => Err(error),
        Ok(rows) => cleanup.map(|()| rows),
    }
}

async fn work(
    conn: &mut SqliteConnection,
    analyze: Option<&str>,
) -> Result<Vec<String>, sqlx::Error> {
    if let Some(statement) = analyze {
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "PRAGMA analysis_limit={ANALYSIS_LIMIT}"
        )))
        .execute(&mut *conn)
        .await?;
        sqlx::query("BEGIN IMMEDIATE").execute(&mut *conn).await?;
        // The statement comes exclusively from SQLite's optimize dry run.
        sqlx::query(sqlx::AssertSqlSafe(statement))
            .execute(&mut *conn)
            .await?;
        // ANALYZE reloads only this connection's in-memory statistics. A real,
        // transactional schema change makes ALL existing connections reload
        // their schema/statistics and reprepare cached statements at their next
        // snapshot, without closing pools or writing schema_version by hand.
        // No persistent object or storage revision is changed.
        sqlx::raw_sql("CREATE TABLE main._screenpipe_planner_refresh(dummy); DROP TABLE main._screenpipe_planner_refresh;")
            .execute(&mut *conn).await?;
        sqlx::query("COMMIT").execute(conn).await?;
        Ok(Vec::new())
    } else {
        // Bundled SQLite >=3.51.3: debug + ANALYZE + all-table growth checks.
        // Selection uses b-tree estimates, not COUNT(*) scans. Analyze only
        // missing stats or ~10x growth/shrinkage, including reader-only tables.
        let candidates: Vec<String> = sqlx::query_scalar("PRAGMA main.optimize=0x10003")
            .fetch_all(&mut *conn)
            .await?;
        let mut needed = Vec::new();
        for statement in candidates {
            // Empty indexless tables have no stat1 row even after ANALYZE,
            // so SQLite can nominate them on every pass. Skip them in O(1)
            // rather than repeatedly taking writer slices ahead of real work.
            let quoted_table = statement
                .strip_prefix("ANALYZE ")
                .ok_or_else(|| sqlx::Error::Protocol("unexpected optimize operation".into()))?;
            let populated: bool = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
                "SELECT EXISTS(SELECT 1 FROM {quoted_table} LIMIT 1)"
            )))
            .fetch_one(&mut *conn)
            .await?;
            if populated {
                needed.push(statement);
            }
        }
        Ok(needed)
    }
}

pub(crate) async fn run_and_report(
    pool: &SqlitePool,
    semaphore: &Arc<Semaphore>,
    health: &crate::write_queue::WriteQueueHealth,
    shutdown: &CancellationToken,
    root: Option<&Path>,
) -> Attempt {
    let attempt = Attempt::new();
    if let Some(root) = root {
        save(root, &attempt).await;
    }
    let attempt = run(pool, semaphore, health, shutdown, attempt).await;
    tracing::info!(diagnostic = %serde_json::to_string(&attempt).unwrap_or_default(), "sqlite planner maintenance");
    if let Some(root) = root {
        save(root, &attempt).await;
    }
    attempt
}

pub(crate) async fn run(
    pool: &SqlitePool,
    semaphore: &Arc<Semaphore>,
    health: &crate::write_queue::WriteQueueHealth,
    shutdown: &CancellationToken,
    mut attempt: Attempt,
) -> Attempt {
    let started = Instant::now();
    let result = async {
        let Some(statements) = slice(pool, semaphore, health, shutdown, None).await? else {
            return Ok(false);
        };
        let mut first_error = None;
        for statement in statements {
            attempt.stage = "analyzing_table".into();
            // Each table commits independently so a deferred table cannot
            // discard completed work. Let queued captures take the writer.
            tokio::task::yield_now().await;
            match slice(pool, semaphore, health, shutdown, Some(&statement)).await {
                Ok(Some(_)) => attempt.analyzed_tables += 1,
                Ok(None) => return first_error.map_or(Ok(false), Err),
                Err(error) => {
                    if health.is_hard_faulted() || shutdown.is_cancelled() {
                        return Err(error);
                    }
                    // A failed table must not prevent repair of other tables.
                    // Keep the first originating failure for support and retry
                    // unfinished work on the next tick.
                    if first_error.is_none() {
                        first_error = Some(error);
                    }
                }
            }
        }
        first_error.map_or(Ok(true), Err)
    }
    .await;
    match result {
        Ok(true) => {
            attempt.status = "complete".into();
            attempt.stage = "complete".into();
        }
        Ok(false) => {
            attempt.status = "deferred".into();
            attempt.detail = Some("writer busy; retry on next maintenance tick".into());
        }
        Err(error) => {
            if crate::sqlite_error::is_sqlite_hard_fault(&error) {
                health.latch_hard_fault(&error);
            }
            attempt.failure(&error);
            if crate::is_sqlite_interrupt(&error) {
                attempt.detail = Some(
                    if shutdown.is_cancelled() {
                        "shutdown interrupted maintenance; retry after restart"
                    } else {
                        "SQLite interrupted maintenance; retry on next maintenance tick"
                    }
                    .into(),
                );
            }
        }
    }
    attempt.duration_ms = started.elapsed().as_millis() as u64;
    attempt
}
