// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Offline logical receipts borrow SQLite values instead of copying every cell
//! through SQLx. The existing read connection, statement snapshot and typed
//! SHA-256 format are retained; memory does not grow with the history length.

use super::{diagnostics, lifecycle::TableParity, storage_error};
use rusqlite::types::ValueRef;
use sha2::{Digest, Sha256};
use sqlx::{sqlite::LockedSqliteHandle, SqlitePool};
use tokio_util::sync::CancellationToken;

// Bounds diagnostic overhead, not which records are verified.
const PROGRESS_ROWS: u64 = 4096;

struct ScanHandle<'a>(LockedSqliteHandle<'a>);

impl Drop for ScanHandle<'_> {
    fn drop(&mut self) {
        // Also runs on query errors and unwinding. Never return a cancelled
        // progress handler to another borrower of the pool connection.
        self.0.remove_progress_handler();
    }
}

pub(super) async fn scan(
    pool: SqlitePool,
    table: String,
    sql: String,
) -> Result<TableParity, sqlx::Error> {
    let cancelled = CancellationToken::new();
    let _cancel_on_drop = cancelled.clone().drop_guard();
    tokio::task::spawn_blocking(diagnostics::blocking_scope(move || {
        tokio::runtime::Handle::current().block_on(async move {
            let mut conn = tokio::select! {
                connection = pool.acquire() => connection?,
                _ = cancelled.cancelled() => return Err(storage_error("parity scan cancelled")),
            };
            let mut handle = ScanHandle(conn.lock_handle().await?);
            handle.0.set_progress_handler(
                crate::cancellable_query::SQLITE_PROGRESS_CHECK_OPS,
                move || !cancelled.is_cancelled(),
            );
            diagnostics::stage("scanning_parity_rows");
            // SAFETY: SQLx's handle lock excludes its worker for the entire
            // scan. from_handle borrows the database and never closes it. The
            // statement/values are dropped before the lock and pool connection.
            let database =
                unsafe { rusqlite::Connection::from_handle(handle.0.as_raw_handle().as_ptr()) }
                    .map_err(sqlite_error)?;
            let mut statement = database.prepare(&sql).map_err(sqlite_error)?;
            let columns = statement.column_count();
            let mut rows = statement.query([]).map_err(sqlite_error)?;
            let mut hash = Sha256::new();
            let mut count = 0;
            let mut last = None;
            while let Some(row) = rows.next().map_err(sqlite_error)? {
                last = Some(row.get::<_, i64>(0).map_err(sqlite_error)?);
                for column in 1..columns {
                    hash_cell(&mut hash, row.get_ref(column).map_err(sqlite_error)?);
                }
                hash.update(b"E");
                count += 1;
                if count % PROGRESS_ROWS == 0 {
                    diagnostics::batch(&table, last, None, Some(count), None);
                }
            }
            diagnostics::batch(&table, last, None, Some(count), None);
            Ok(TableParity {
                table,
                rows: count,
                sha256: format!("{:x}", hash.finalize()),
            })
        })
    }))
    .await
    .map_err(storage_error)?
}

fn sqlite_error(error: rusqlite::Error) -> sqlx::Error {
    if let rusqlite::Error::SqliteFailure(code, _) = &error {
        // Preserve extended SQLite codes for the normal hard-fault classifier.
        storage_error(format!("(code: {}) {error}", code.extended_code))
    } else {
        storage_error(error)
    }
}

/// This encoding is persisted in existing migration journals. Keep NULL,
/// storage class, byte length, floating-point bits and row order identical.
pub(super) fn hash_cell(hash: &mut Sha256, value: ValueRef<'_>) {
    match value {
        ValueRef::Null => hash.update(b"N"),
        ValueRef::Integer(value) => {
            hash.update(b"I");
            hash.update(value.to_le_bytes());
        }
        ValueRef::Real(value) => {
            hash.update(b"R");
            hash.update(value.to_bits().to_le_bytes());
        }
        ValueRef::Text(bytes) | ValueRef::Blob(bytes) => {
            hash.update(if matches!(value, ValueRef::Text(_)) {
                b"T"
            } else {
                b"B"
            });
            hash.update((bytes.len() as u64).to_le_bytes());
            hash.update(bytes);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn cancelled_scan_stops_sqlite_and_returns_a_clean_connection() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        let task = tokio::spawn(scan(pool.clone(), "cancel_probe".into(),
            "WITH RECURSIVE n(id) AS (VALUES(1) UNION ALL SELECT id+1 FROM n WHERE id<100000000) SELECT id,id FROM n ORDER BY id DESC".into()));
        tokio::time::timeout(Duration::from_secs(3), async {
            while pool.num_idle() != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        // The sort is still inside sqlite3_step before yielding its first row.
        tokio::time::sleep(Duration::from_millis(20)).await;
        task.abort();
        let _ = task.await;
        let answer: i64 = tokio::time::timeout(Duration::from_secs(3),
            sqlx::query_scalar("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10000) SELECT sum(x) FROM n").fetch_one(&pool))
            .await.unwrap().unwrap();
        assert_eq!(answer, 50_005_000);
        pool.close().await;
    }

    #[test]
    fn read_failure_keeps_its_sqlite_hard_fault_code() {
        let code = libsqlite3_sys::SQLITE_IOERR_READ;
        let error = sqlite_error(rusqlite::Error::SqliteFailure(
            libsqlite3_sys::Error::new(code),
            Some("source read failed".into()),
        ));
        assert_eq!(
            crate::sqlite_error::sqlite_hard_fault_code(&error),
            Some(code)
        );
        assert!(error.to_string().contains("source read failed"));
    }
}
