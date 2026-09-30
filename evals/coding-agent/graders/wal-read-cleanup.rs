// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use screenpipe_db::{is_sqlite_interrupt, CancellableReadConnection, DatabaseManager};
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

async fn database() -> (tempfile::TempDir, DatabaseManager) {
    let dir = tempfile::tempdir().unwrap();
    let mut config = screenpipe_config::DbConfig::default();
    config.read_pool_max = 1;
    config.read_pool_min = 1;
    let db = DatabaseManager::new(dir.path().join("samples.sqlite").to_str().unwrap(), config)
        .await
        .unwrap();
    db.execute_raw_sql_write("CREATE TABLE samples(id INTEGER PRIMARY KEY, value TEXT)")
        .await
        .unwrap();
    db.wal_checkpoint().await.unwrap();
    (dir, db)
}

async fn reader(db: &DatabaseManager) -> CancellableReadConnection {
    CancellableReadConnection::acquire(
        &db.pool,
        Instant::now() + Duration::from_secs(5),
        CancellationToken::new(),
    )
    .await
    .unwrap()
}

async fn snapshot(db: &DatabaseManager) -> CancellableReadConnection {
    let mut connection = reader(db).await;
    sqlx::query("BEGIN")
        .execute(&mut *connection)
        .await
        .unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM samples")
        .fetch_one(&mut *connection)
        .await
        .unwrap();
    assert_eq!(count, 0);
    connection
}

async fn abandoned(mode: &str) {
    let (dir, db) = database().await;
    let connection = snapshot(&db).await;
    db.execute_raw_sql_write("INSERT INTO samples(value) VALUES ('while reading')")
        .await
        .unwrap();
    let (_, pages, checkpointed) = db.wal_checkpoint().await.unwrap();
    assert!(
        pages > checkpointed,
        "control: an active snapshot must pin real WAL frames"
    );
    match mode {
        "drop" => drop(connection),
        "release" => connection.release().await.unwrap(),
        "abort" => {
            let (ready, began) = tokio::sync::oneshot::channel();
            let task = tokio::spawn(async move {
                let _connection = connection;
                ready.send(()).unwrap();
                std::future::pending::<()>().await;
            });
            began.await.unwrap();
            task.abort();
            assert!(task.await.unwrap_err().is_cancelled());
        }
        _ => unreachable!(),
    }
    // The single pool slot cannot be borrowed until guard cleanup finishes.
    let idle = tokio::time::timeout(Duration::from_secs(3), db.pool.acquire())
        .await
        .expect("cleanup must return pool capacity")
        .unwrap();
    db.execute_raw_sql_write("INSERT INTO samples(value) VALUES ('after cleanup')")
        .await
        .unwrap();
    let (busy, pages, checkpointed) = db.wal_checkpoint().await.unwrap();
    assert_eq!(busy, 0);
    assert_eq!(
        pages, checkpointed,
        "abandoned reader must release its WAL snapshot"
    );
    drop(idle);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM samples")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(count, 2, "writes must remain visible after cleanup");
    db.close().await;
    let reopened = DatabaseManager::new(
        dir.path().join("samples.sqlite").to_str().unwrap(),
        Default::default(),
    )
    .await
    .unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM samples")
        .fetch_one(&reopened.pool)
        .await
        .unwrap();
    assert_eq!(count, 2, "writes must survive database reopen");
    let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_one(&reopened.pool)
        .await
        .unwrap();
    assert_eq!(integrity, "ok");
    reopened.close().await;
}

#[tokio::test]
async fn dropped_raw_transaction_releases_snapshot() {
    abandoned("drop").await;
}
#[tokio::test]
async fn explicit_release_releases_snapshot() {
    abandoned("release").await;
}
#[tokio::test]
async fn aborted_request_releases_snapshot() {
    abandoned("abort").await;
}

#[tokio::test]
async fn active_reader_retains_snapshot_while_writes_continue() {
    let (_dir, db) = database().await;
    let mut connection = snapshot(&db).await;
    db.execute_raw_sql_write("INSERT INTO samples(value) VALUES ('new capture')")
        .await
        .unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM samples")
        .fetch_one(&mut *connection)
        .await
        .unwrap();
    assert_eq!(count, 0, "active reader must retain its original snapshot");
    let (_, pages, checkpointed) = db.wal_checkpoint().await.unwrap();
    assert!(pages > checkpointed);
    sqlx::query("ROLLBACK")
        .execute(&mut *connection)
        .await
        .unwrap();
    connection.release().await.unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM samples")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
    db.close().await;
}

#[tokio::test]
async fn ordinary_release_keeps_pool_usable() {
    let (_dir, db) = database().await;
    reader(&db).await.release().await.unwrap();
    let sum: i64 = sqlx::query_scalar("WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<10000) SELECT sum(x) FROM n")
        .fetch_one(&db.pool).await.unwrap();
    assert_eq!(sum, 50_005_000);
    db.close().await;
}

#[tokio::test]
async fn deadline_interrupts_work_without_poisoning_next_reader() {
    let (_dir, db) = database().await;
    let mut connection = CancellableReadConnection::acquire(
        &db.pool,
        Instant::now() + Duration::from_millis(20),
        CancellationToken::new(),
    )
    .await
    .unwrap();
    let error = tokio::time::timeout(Duration::from_secs(3), sqlx::query_scalar::<_, i64>("WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<100000000) SELECT sum(x) FROM n").fetch_one(&mut *connection))
        .await.expect("SQLite execution must be interruptible").unwrap_err();
    assert!(is_sqlite_interrupt(&error));
    connection.release().await.unwrap();
    let sum: i64 = sqlx::query_scalar("WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<10000) SELECT sum(x) FROM n").fetch_one(&db.pool).await.unwrap();
    assert_eq!(sum, 50_005_000);
    db.close().await;
}
