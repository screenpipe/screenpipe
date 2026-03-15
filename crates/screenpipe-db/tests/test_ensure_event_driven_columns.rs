use screenpipe_db::DatabaseManager;
use sqlx::{SqlitePool, Row};

#[tokio::test]
async fn test_ensure_event_driven_columns_adds_missing_columns() {
    let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
    
    // Create a barebones frames table without the new columns
    sqlx::query(
        "CREATE TABLE frames (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            video_chunk_id INTEGER DEFAULT NULL,
            offset_index INTEGER NOT NULL DEFAULT 0,
            timestamp TIMESTAMP NOT NULL,
            name TEXT,
            app_name TEXT DEFAULT NULL,
            window_name TEXT DEFAULT NULL,
            focused BOOLEAN DEFAULT NULL,
            browser_url TEXT DEFAULT NULL,
            device_name TEXT NOT NULL DEFAULT '',
            sync_id TEXT,
            machine_id TEXT,
            synced_at DATETIME
        )"
    )
    .execute(&pool)
    .await
    .unwrap();
    
    // Call the fix function
    DatabaseManager::ensure_event_driven_columns(&pool).await.unwrap();
    
    // Verify the columns were added
    let rows = sqlx::query("PRAGMA table_info('frames')")
        .fetch_all(&pool)
        .await
        .unwrap();
        
    let mut columns = vec![];
    for row in rows {
        let name: String = row.get("name");
        columns.push(name);
    }
    
    assert!(columns.contains(&"snapshot_path".to_string()), "snapshot_path should be added");
    assert!(columns.contains(&"accessibility_text".to_string()), "accessibility_text should be added");
    assert!(columns.contains(&"accessibility_tree_json".to_string()), "accessibility_tree_json should be added");
    assert!(columns.contains(&"content_hash".to_string()), "content_hash should be added");
    assert!(columns.contains(&"simhash".to_string()), "simhash should be added");
    assert!(columns.contains(&"capture_trigger".to_string()), "capture_trigger should be added");
    assert!(columns.contains(&"text_source".to_string()), "text_source should be added");
}
