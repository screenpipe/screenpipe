// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
use screenpipe_redact::{
    adapters::regex::RegexRedactor,
    worker::{TargetTable, Worker, WorkerConfig},
    Redactor,
};
use sqlx::{
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    Row,
};
use std::{sync::Arc, time::Duration};
use tempfile::TempDir;
use tokio::sync::Notify;

async fn db(elements: &'static str) -> (sqlx::SqlitePool, TempDir) {
    let temp = tempfile::tempdir().unwrap();
    let pool = SqlitePoolOptions::new()
        .max_connections(2)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(temp.path().join("synthetic.sqlite"))
                .create_if_missing(true),
        )
        .await
        .unwrap();
    sqlx::query("CREATE TABLE frames(id INTEGER PRIMARY KEY, full_text TEXT, full_text_redacted_at INTEGER, accessibility_text TEXT, accessibility_redacted_at INTEGER, accessibility_tree_json TEXT, accessibility_tree_redacted_at INTEGER, window_name TEXT, window_name_redacted_at INTEGER, browser_url TEXT, browser_url_redacted_at INTEGER, text_json TEXT, text_json_redacted_at INTEGER); CREATE TABLE audio_transcriptions(id INTEGER PRIMARY KEY, transcription TEXT, redacted_at INTEGER);").execute(&pool).await.unwrap();
    if !elements.is_empty() {
        sqlx::query(elements).execute(&pool).await.unwrap();
    }
    sqlx::query("INSERT INTO frames(id,full_text) VALUES(1,'contact synthetic@example.com today'),(2,'ordinary clean words'); INSERT INTO audio_transcriptions VALUES(1,'audio synthetic@example.com',NULL);").execute(&pool).await.unwrap();
    (pool, temp)
}
fn worker(pool: &sqlx::SqlitePool, tables: Vec<TargetTable>) -> Worker {
    Worker::new(
        pool.clone(),
        Arc::new(RegexRedactor::new()) as Arc<dyn Redactor>,
        WorkerConfig {
            tables,
            batch_size: 16,
            idle_between_batches: Duration::from_millis(1),
            poll_interval: Duration::from_millis(20),
            ..Default::default()
        },
    )
}
async fn frame(pool: &sqlx::SqlitePool, id: i64) -> (String, Option<i64>) {
    let r = sqlx::query("SELECT full_text,full_text_redacted_at FROM frames WHERE id=?")
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap();
    (r.get(0), r.get(1))
}
async fn stop(n: Arc<Notify>, h: tokio::task::JoinHandle<()>) {
    n.notify_waiters();
    tokio::time::timeout(Duration::from_secs(1), h)
        .await
        .expect("shutdown must finish")
        .unwrap();
}
async fn assert_missing(elements: &'static str) {
    let (pool, _temp) = db(elements).await;
    let w = worker(&pool, vec![TargetTable::Elements, TargetTable::FullText]);
    let n = Arc::new(Notify::new());
    let h = w.spawn_with_shutdown(n.clone());
    tokio::time::sleep(Duration::from_millis(700)).await;
    let first = frame(&pool, 1).await;
    let clean = frame(&pool, 2).await;
    sqlx::query("INSERT INTO frames(id,full_text) VALUES(3,'later synthetic@example.com')")
        .execute(&pool)
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(700)).await;
    let later = frame(&pool, 3).await;
    stop(n, h).await;
    assert!(
        !first.0.contains("synthetic@example.com")
            && first.0.contains("contact")
            && first.1.is_some(),
        "missing target delayed initial redaction: {first:?}"
    );
    assert_eq!(clean.0, "ordinary clean words");
    assert!(clean.1.is_some());
    assert!(
        !later.0.contains("synthetic@example.com") && later.1.is_some(),
        "later sweep lost progress: {later:?}"
    );
}
#[tokio::test]
async fn missing_table_preserves_progress() {
    assert_missing("").await;
}
#[tokio::test]
async fn missing_column_preserves_progress() {
    assert_missing("CREATE TABLE elements(id INTEGER PRIMARY KEY, text TEXT, properties TEXT);")
        .await;
}
#[tokio::test]
async fn ordinary_redaction_and_clean_words() {
    let (pool, _temp) = db("").await;
    let w = worker(&pool, vec![TargetTable::FullText]);
    let n = Arc::new(Notify::new());
    let h = w.spawn_with_shutdown(n.clone());
    tokio::time::sleep(Duration::from_millis(700)).await;
    let a = frame(&pool, 1).await;
    let b = frame(&pool, 2).await;
    stop(n, h).await;
    assert!(!a.0.contains("synthetic@example.com") && a.1.is_some());
    assert_eq!(b.0, "ordinary clean words");
    assert!(b.1.is_some());
}
#[tokio::test]
async fn pause_resume_preserved() {
    let (pool, _temp) = db("").await;
    let w = worker(&pool, vec![TargetTable::FullText]);
    w.pause();
    let n = Arc::new(Notify::new());
    let h = w.clone().spawn_with_shutdown(n.clone());
    tokio::time::sleep(Duration::from_millis(150)).await;
    let paused = frame(&pool, 1).await;
    w.resume();
    tokio::time::sleep(Duration::from_millis(700)).await;
    let resumed = frame(&pool, 1).await;
    stop(n, h).await;
    assert!(paused.0.contains("synthetic@example.com") && paused.1.is_none());
    assert!(!resumed.0.contains("synthetic@example.com") && resumed.1.is_some());
}
#[tokio::test]
async fn transient_write_error_retries() {
    let (pool, _temp) = db("").await;
    sqlx::query("CREATE TRIGGER fail_write BEFORE UPDATE ON frames BEGIN SELECT RAISE(ABORT,'synthetic transient write refusal'); END;").execute(&pool).await.unwrap();
    let w = worker(&pool, vec![TargetTable::FullText]);
    let n = Arc::new(Notify::new());
    let h = w.spawn_with_shutdown(n.clone());
    tokio::time::sleep(Duration::from_millis(250)).await;
    let refused = frame(&pool, 1).await;
    sqlx::query("DROP TRIGGER fail_write")
        .execute(&pool)
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(2400)).await;
    let retry = frame(&pool, 1).await;
    stop(n, h).await;
    assert!(refused.0.contains("synthetic@example.com") && refused.1.is_none());
    assert!(
        !retry.0.contains("synthetic@example.com") && retry.1.is_some(),
        "transient target lost retry: {retry:?}"
    );
}
#[tokio::test]
async fn hard_fault_preserves_backoff_and_shutdown() {
    let (pool, _temp) = db("").await;
    sqlx::query("CREATE TRIGGER fail_write BEFORE UPDATE ON frames BEGIN SELECT RAISE(ABORT,'database disk image is malformed'); END;").execute(&pool).await.unwrap();
    let w = worker(
        &pool,
        vec![TargetTable::FullText, TargetTable::AudioTranscription],
    );
    let n = Arc::new(Notify::new());
    let h = w.spawn_with_shutdown(n.clone());
    tokio::time::sleep(Duration::from_millis(700)).await;
    let audio: Option<i64> =
        sqlx::query_scalar("SELECT redacted_at FROM audio_transcriptions WHERE id=1")
            .fetch_one(&pool)
            .await
            .unwrap();
    stop(n, h).await;
    assert!(
        audio.is_none(),
        "hard fault must not silently continue to the next target"
    );
}
