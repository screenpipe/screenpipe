// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Regression: a memory whose content starts empty (or is emptied once) must
//! still become searchable after it is filled in.

use screenpipe_db::DatabaseManager;

const FIX_MIGRATION: i64 = 20261022000000;

/// The triggers shipped by 20260310000000_create_memories.sql.
const LEGACY_TRIGGERS: &str = "
DROP TRIGGER memories_ai;
DROP TRIGGER memories_ad;
DROP TRIGGER memories_au;
CREATE TRIGGER memories_ai AFTER INSERT ON memories
WHEN NEW.content IS NOT NULL AND NEW.content != ''
BEGIN
    INSERT INTO memories_fts(rowid, content, tags)
    VALUES (NEW.id, NEW.content, COALESCE(NEW.tags, ''));
END;
CREATE TRIGGER memories_ad AFTER DELETE ON memories
WHEN OLD.content IS NOT NULL AND OLD.content != ''
BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, tags)
    VALUES ('delete', OLD.id, OLD.content, COALESCE(OLD.tags, ''));
END;
CREATE TRIGGER memories_au AFTER UPDATE ON memories
WHEN OLD.content IS NOT NULL AND OLD.content != ''
BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, tags)
    VALUES ('delete', OLD.id, OLD.content, COALESCE(OLD.tags, ''));
    INSERT INTO memories_fts(rowid, content, tags)
    VALUES (NEW.id, COALESCE(NEW.content, ''), COALESCE(NEW.tags, ''));
END;
";

async fn open(path: &std::path::Path) -> DatabaseManager {
    DatabaseManager::new(path.to_str().unwrap(), Default::default())
        .await
        .unwrap()
}

async fn search(db: &DatabaseManager, query: &str) -> Vec<i64> {
    db.list_memories(
        Some(query),
        None,
        None,
        None,
        None,
        None,
        50,
        0,
        None,
        None,
        &[],
    )
    .await
    .unwrap()
    .into_iter()
    .map(|m| m.id)
    .collect()
}

async fn assert_index_matches_content(db: &DatabaseManager) {
    // rank=1 compares the index against the external content table.
    db.execute_raw_sql_write(
        "INSERT INTO memories_fts(memories_fts, rank) VALUES ('integrity-check', 1)",
    )
    .await
    .expect("memories_fts must match the memories table");
}

#[tokio::test]
async fn memory_filled_after_empty_creation_is_searchable() {
    let root = tempfile::tempdir().unwrap();
    let db = open(&root.path().join("db.sqlite")).await;

    let created_empty = db
        .insert_memory("", "user", None, None, 0.5, None)
        .await
        .unwrap();
    db.update_memory(created_empty, Some("filledlater fact"), None, None, None)
        .await
        .unwrap();
    assert_eq!(search(&db, "filledlater").await, vec![created_empty]);

    let emptied = db
        .insert_memory("firstversion fact", "user", None, None, 0.5, None)
        .await
        .unwrap();
    db.update_memory(emptied, Some(""), None, None, None)
        .await
        .unwrap();
    assert!(search(&db, "firstversion").await.is_empty());
    db.update_memory(emptied, Some("secondversion fact"), None, None, None)
        .await
        .unwrap();
    assert_eq!(search(&db, "secondversion").await, vec![emptied]);
    assert!(search(&db, "firstversion").await.is_empty());

    db.delete_memory(emptied).await.unwrap();
    assert!(search(&db, "secondversion").await.is_empty());
    assert_index_matches_content(&db).await;
    db.close().await;
}

#[tokio::test]
async fn upgrade_reindexes_memories_lost_by_legacy_trigger() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("db.sqlite");
    let db = open(&path).await;
    db.close().await;

    // Rewind this disposable fixture to the legacy triggers and reproduce the
    // two ways a memory used to fall out of the index.
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(LEGACY_TRIGGERS).unwrap();
        conn.execute(
            "DELETE FROM _sqlx_migrations WHERE version = ?1",
            [FIX_MIGRATION],
        )
        .unwrap();
        conn.execute_batch(
            "INSERT INTO memories(id, content) VALUES (1, '');
             UPDATE memories SET content = 'lostneedle created empty' WHERE id = 1;
             INSERT INTO memories(id, content) VALUES (2, 'oldneedle');
             UPDATE memories SET content = '' WHERE id = 2;
             UPDATE memories SET content = 'lostneedle emptied once' WHERE id = 2;
             INSERT INTO memories(id, content) VALUES (3, 'keptneedle');",
        )
        .unwrap();
        let indexed: i64 = conn
            .query_row(
                "SELECT count(*) FROM memories_fts WHERE memories_fts MATCH 'lostneedle'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(indexed, 0, "fixture must reproduce the legacy bug");
    }

    let db = open(&path).await;
    let applied: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM _sqlx_migrations WHERE version = ?1 AND success = 1",
    )
    .bind(FIX_MIGRATION)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(applied, 1);

    let mut found = search(&db, "lostneedle").await;
    found.sort();
    assert_eq!(found, vec![1, 2]);
    assert!(search(&db, "oldneedle").await.is_empty());
    assert_eq!(search(&db, "keptneedle").await, vec![3]);
    assert_index_matches_content(&db).await;
    db.close().await;
}
