// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
use screenpipe_db::{storage::{migrate, MigrationOptions, Projection, StorageMode}, DatabaseManager};

async fn seed(root: &std::path::Path, texts: [&str; 2]) -> DatabaseManager {
    let db = DatabaseManager::new(root.join("db.sqlite").to_str().unwrap(), Default::default()).await.unwrap();
    let mut tx = db.begin_immediate_with_retry().await.unwrap();
    for (index, text) in texts.iter().enumerate() {
        sqlx::query("INSERT INTO frames(id,timestamp,full_text) VALUES(?,'2026-01-01T12:00:00Z',?)")
            .bind(index as i64 + 1).bind(text).execute(&mut **tx.conn()).await.unwrap();
    }
    tx.commit().await.unwrap();
    db
}

async fn converted(texts: [&str; 2]) {
    let root = tempfile::tempdir().unwrap();
    let db = seed(root.path(), texts).await;
    let before = db.frame_payloads(&[1, 2], Projection::All).await.unwrap();
    let mut searches = Vec::new();
    for term in ["foo", "שלום", "café", "東京", "ordinary", "absent"] {
        let ids: Vec<i64> = sqlx::query_scalar("SELECT rowid FROM frames_fts WHERE frames_fts MATCH ? ORDER BY rowid")
            .bind(term).fetch_all(&db.pool).await.unwrap();
        searches.push((term, ids));
    }
    db.close().await;
    let result = migrate(root.path(), Default::default(), Default::default()).await;
    assert!(result.is_ok(), "eligible synthetic history must convert: {result:?}");
    assert_eq!(result.unwrap().frames, 2, "conversion must retain both frames");
    assert!(root.path().join("storage-migration-complete.json").is_file());
    assert!(!root.path().join("storage-migration.json").exists());
    let db = DatabaseManager::new(root.path().join("db.sqlite").to_str().unwrap(), Default::default()).await.unwrap();
    assert_eq!(db.storage_mode(), StorageMode::HybridParquetV1, "success must perform conversion");
    let after = db.frame_payloads(&[1, 2], Projection::All).await.unwrap();
    for id in [1, 2] { assert_eq!(after[&id].full_text, before[&id].full_text, "payload changed for {id}"); }
    for (term, ids) in searches {
        let actual: Vec<i64> = sqlx::query_scalar("SELECT rowid FROM frames_fts WHERE frames_fts MATCH ? ORDER BY rowid")
            .bind(term).fetch_all(&db.pool).await.unwrap();
        assert_eq!(actual, ids, "search changed for {term}");
    }
    db.verify_storage().await.unwrap();
    db.close().await;
}

#[tokio::test]
async fn controls_and_diagrams_preserve_payload_and_search() { converted(["\0\0├───┼───── foo", "┃"]).await; }
#[tokio::test]
async fn unicode_history_preserves_payload_and_search() { converted(["\0שלום עולם", "café\0東京"]).await; }
#[tokio::test]
async fn symbol_only_history_still_converts() { converted(["\0\0├───┼─────", "┃"]).await; }
#[tokio::test]
async fn ordinary_history_still_converts() { converted(["ordinary foo", "café 東京 שלום"]).await; }

fn retained(root: &std::path::Path) {
    assert!(root.join("db.sqlite").is_file(), "refusal must retain original source");
    assert!(!root.join("storage-migration.json").exists());
    assert!(!root.join("storage-migration-complete.json").exists());
    let conn = rusqlite::Connection::open_with_flags(root.join("db.sqlite"), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let rows: Vec<String> = conn.prepare("SELECT full_text FROM frames ORDER BY id").unwrap()
        .query_map([], |row| row.get(0)).unwrap().map(Result::unwrap).collect();
    assert_eq!(rows, vec!["ordinary original", "retained original"]);
}
#[tokio::test]
async fn genuine_missing_index_is_refused_without_discarding_history() {
    let root = tempfile::tempdir().unwrap();
    let db = seed(root.path(), ["ordinary original", "retained original"]).await;
    db.execute_raw_sql_write("DROP TABLE frames_fts").await.unwrap();
    db.close().await;
    assert!(migrate(root.path(), Default::default(), Default::default()).await.is_err(), "missing source search index must not be silently accepted");
    retained(root.path());
}
#[tokio::test]
async fn insufficient_headroom_retains_original_history() {
    let root = tempfile::tempdir().unwrap();
    let db = seed(root.path(), ["ordinary original", "retained original"]).await;
    db.close().await;
    let mut options = MigrationOptions::default();
    options.budget.disk_reserve_bytes = fs2::available_space(root.path()).unwrap();
    assert!(migrate(root.path(), Default::default(), options).await.is_err());
    retained(root.path());
}
#[tokio::test]
async fn external_reader_refusal_preserves_history_and_later_retry() {
    use sqlx::Connection;
    let root = tempfile::tempdir().unwrap();
    let db = seed(root.path(), ["ordinary original", "retained original"]).await;
    db.close().await;
    let mut reader = sqlx::SqliteConnection::connect_with(&sqlx::sqlite::SqliteConnectOptions::new().filename(root.path().join("db.sqlite")).read_only(true)).await.unwrap();
    let mut tx = reader.begin().await.unwrap();
    sqlx::query("SELECT count(*) FROM frames").fetch_one(&mut *tx).await.unwrap();
    assert!(migrate(root.path(), Default::default(), Default::default()).await.is_err());
    tx.rollback().await.unwrap();
    reader.close().await.unwrap();
    retained(root.path());
    assert_eq!(migrate(root.path(), Default::default(), Default::default()).await.unwrap().frames, 2);
    let db = DatabaseManager::new(root.path().join("db.sqlite").to_str().unwrap(), Default::default()).await.unwrap();
    let rows = db.frame_payloads(&[1, 2], Projection::All).await.unwrap();
    assert_eq!(rows[&1].full_text.as_deref(), Some("ordinary original"));
    assert_eq!(rows[&2].full_text.as_deref(), Some("retained original"));
    db.verify_storage().await.unwrap();
    db.close().await;
}
