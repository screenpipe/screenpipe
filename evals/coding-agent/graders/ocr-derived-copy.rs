// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use std::{sync::Arc, time::Duration};
use screenpipe_redact::{
    adapters::regex::RegexRedactor, pipeline::Pipeline,
    worker::{RedactColumns, TargetTable, Worker, WorkerConfig}, Redactor,
};
use serde_json::{json, Value};
use sqlx::{sqlite::{SqliteConnectOptions, SqlitePoolOptions}, Row};

const SECRET: &str = "sk-proj-AbCdEf123456GhIjKlMnOp";

async fn database() -> (sqlx::SqlitePool, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let options = SqliteConnectOptions::new()
        .filename(dir.path().join("synthetic.sqlite")).create_if_missing(true);
    let pool = SqlitePoolOptions::new().max_connections(2).connect_with(options).await.unwrap();
    sqlx::query("CREATE TABLE frames (
        id INTEGER PRIMARY KEY, full_text TEXT, full_text_redacted_at INTEGER,
        accessibility_text TEXT, accessibility_redacted_at INTEGER,
        accessibility_tree_json TEXT, accessibility_tree_redacted_at INTEGER,
        window_name TEXT, window_name_redacted_at INTEGER,
        browser_url TEXT, browser_url_redacted_at INTEGER,
        text_json TEXT, text_json_redacted_at INTEGER)")
        .execute(&pool).await.unwrap();
    (pool, dir)
}

fn words(text: &str) -> Value {
    json!([
        {"text": text, "left":"10", "top":"40", "width":"120", "height":"22",
         "conf":"95", "block_num":"1", "page_num":"1", "par_num":"1",
         "line_num":"1", "word_num":"1", "level":"5"},
        {"text":"Inbox", "left":"140", "top":"40", "width":"80", "height":"22"}
    ])
}

async fn seed(pool: &sqlx::SqlitePool, text: &str) {
    sqlx::query("INSERT INTO frames (id,full_text,text_json,window_name,browser_url,accessibility_tree_json)
        VALUES (1,?,?,?,?,?)")
        .bind(format!("mail {text}"))
        .bind(words(text).to_string())
        .bind(format!("Window {text}"))
        .bind(format!("https://example.invalid/{text}"))
        .bind(json!([{"text":text,"role":"AXStaticText"}]).to_string())
        .execute(pool).await.unwrap();
}

fn config() -> WorkerConfig {
    WorkerConfig {
        tables: vec![TargetTable::FullText],
        columns: RedactColumns::from_keys::<&str>(&[]),
        batch_size: 4,
        idle_between_batches: Duration::from_millis(1),
        poll_interval: Duration::from_millis(10),
        ..Default::default()
    }
}

async fn completed(pool: &sqlx::SqlitePool) -> bool {
    sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM frames WHERE id=1 AND full_text_redacted_at IS NOT NULL")
        .fetch_one(pool).await.unwrap() == 1
}

async fn wait<F, Fut>(label: &str, mut condition: F)
where F: FnMut() -> Fut, Fut: std::future::Future<Output=bool> {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !condition().await { tokio::time::sleep(Duration::from_millis(10)).await; }
    }).await.unwrap_or_else(|_| panic!("worker did not reach observable state: {label}"));
}

async fn assert_scrubbed(pool: &sqlx::SqlitePool, original: &str) {
    let row=sqlx::query("SELECT full_text,text_json FROM frames WHERE id=1")
        .fetch_one(pool).await.unwrap();
    assert!(!row.get::<String,_>(0).contains(original), "full text still contains sensitive text");
    assert!(row.get::<String,_>(0).starts_with("mail "), "non-sensitive full-text prefix changed");
    let actual:Value=serde_json::from_str(&row.get::<String,_>(1)).unwrap();
    assert!(actual[0]["text"].as_str().is_some_and(|v| !v.contains(original) && !v.is_empty()),
        "persisted OCR word still contains sensitive text or was discarded");
    let mut expected=words(original);
    expected[0]["text"]=actual[0]["text"].clone();
    assert_eq!(actual,expected,"OCR geometry, metadata, block order or clean words changed");
}

async fn scrub(redactor:Arc<dyn Redactor>, text:&str) {
    let (pool,_dir)=database().await;
    seed(&pool,text).await;
    let worker=Worker::new(pool.clone(),redactor,config());
    let handle=worker.spawn();
    wait("full-text completion",||completed(&pool)).await;
    handle.abort(); let _=handle.await;
    assert_scrubbed(&pool,text).await;
    // Optional columns stay opted out even though OCR is coupled to full_text.
    let row=sqlx::query("SELECT window_name,browser_url FROM frames WHERE id=1").fetch_one(&pool).await.unwrap();
    assert_eq!(row.get::<String,_>(0),format!("Window {text}"));
    assert_eq!(row.get::<String,_>(1),format!("https://example.invalid/{text}"));
}

#[tokio::test]
async fn map_scrubs_ocr_and_preserves_geometry_and_optouts() {
    scrub(Arc::new(Pipeline::regex_only()),SECRET).await;
}

#[tokio::test]
async fn spanless_scrubs_ocr_and_preserves_geometry_and_optouts() {
    scrub(Arc::new(RegexRedactor::new()),"carol@example.com").await;
}

#[tokio::test]
async fn clean_words_and_geometry_are_preserved() {
    let (pool,_dir)=database().await;
    seed(&pool,"ordinary").await;
    let handle=Worker::new(pool.clone(),Arc::new(Pipeline::regex_only()),config()).spawn();
    wait("clean frame completion",||completed(&pool)).await;
    handle.abort(); let _=handle.await;
    let row=sqlx::query("SELECT full_text,text_json FROM frames WHERE id=1").fetch_one(&pool).await.unwrap();
    assert_eq!(row.get::<String,_>(0),"mail ordinary");
    assert_eq!(serde_json::from_str::<Value>(&row.get::<String,_>(1)).unwrap(),words("ordinary"));
}

async fn retry_after_failed_write(redactor:Arc<dyn Redactor>, text:&str) {
    let (pool,_dir)=database().await;
    seed(&pool,text).await;
    sqlx::query("CREATE TRIGGER fail_ocr BEFORE UPDATE OF text_json ON frames
        BEGIN SELECT RAISE(ABORT,'synthetic OCR write failure'); END")
        .execute(&pool).await.unwrap();
    let worker=Worker::new(pool.clone(),redactor.clone(),config());
    let handle=worker.clone().spawn();
    wait("write failure or completion",||async {
        worker.status().await.last_error.is_some() || completed(&pool).await
    }).await;
    handle.abort(); let _=handle.await;
    let row=sqlx::query("SELECT full_text,full_text_redacted_at,text_json FROM frames WHERE id=1")
        .fetch_one(&pool).await.unwrap();
    assert!(row.get::<Option<i64>,_>(1).is_none(),"failed OCR write was marked complete, preventing retry");
    assert!(row.get::<String,_>(0).contains(text),"retry source was destroyed after failed OCR write");
    assert_eq!(serde_json::from_str::<Value>(&row.get::<String,_>(2)).unwrap(),words(text));
    sqlx::query("DROP TRIGGER fail_ocr").execute(&pool).await.unwrap();
    let resumed=Worker::new(pool.clone(),redactor,config()).spawn();
    wait("retry completion after restarting worker",||completed(&pool)).await;
    resumed.abort(); let _=resumed.await;
    assert_scrubbed(&pool,text).await;
}

#[tokio::test]
async fn map_failed_ocr_write_remains_retryable() {
    retry_after_failed_write(Arc::new(Pipeline::regex_only()),SECRET).await;
}

#[tokio::test]
async fn spanless_failed_ocr_write_remains_retryable() {
    retry_after_failed_write(Arc::new(RegexRedactor::new()),"carol@example.com").await;
}
