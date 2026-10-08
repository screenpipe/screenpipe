// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use chrono::{DateTime, Duration, Utc};
use screenpipe_db::{
    storage::{migrate, MigrationOptions, Projection},
    ContentType, DatabaseManager, Order, SearchResult,
};

async fn search(db: &DatabaseManager, query: &str) -> Vec<(i64, String)> {
    db.search(
        query,
        ContentType::OCR,
        50,
        0,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap()
    .into_iter()
    .map(|result| {
        let SearchResult::OCR(row) = result else {
            panic!("expected a frame")
        };
        (row.frame_id, row.ocr_text)
    })
    .collect()
}

async fn large_search_page(db: &DatabaseManager, accessibility: bool) -> serde_json::Value {
    if accessibility {
        serde_json::to_value(
            db.search_accessibility("migrationneedle", None, None, None, None, 50, 0)
                .await
                .unwrap(),
        )
        .unwrap()
    } else {
        serde_json::to_value(
            db.search_with_text_positions(
                "migrationneedle",
                50,
                0,
                None,
                None,
                false,
                Order::Descending,
                None,
                None,
            )
            .await
            .unwrap(),
        )
        .unwrap()
    }
}

async fn assert_large_search_page_survives_migration(accessibility: bool) {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("db.sqlite");
    let db = DatabaseManager::new(path.to_str().unwrap(), Default::default())
        .await
        .unwrap();
    let text = format!("migrationneedle {}", "東京🙂".repeat(300));
    let mut tx = db.begin_immediate_with_retry().await.unwrap();
    for id in 1..=3 {
        sqlx::query("INSERT INTO frames(id,timestamp,full_text,accessibility_text,snapshot_path) VALUES(?,'2026-09-09T12:00:00Z',?,'migrationneedle',?)")
            .bind(id).bind(&text).bind(format!("frame-{id}.jpg"))
            .execute(&mut **tx.conn()).await.unwrap();
    }
    tx.commit().await.unwrap();
    let before = large_search_page(&db, accessibility).await;
    assert_eq!(before.as_array().unwrap().len(), 3);
    db.close().await;
    let mut options = MigrationOptions::default();
    options.budget.record_bytes = 4096;
    options.budget.file_bytes = 8192;
    options.budget.response_bytes = 8192;
    migrate(root.path(), Default::default(), options)
        .await
        .unwrap();
    for _ in 0..2 {
        let db = DatabaseManager::new(path.to_str().unwrap(), Default::default())
            .await
            .unwrap();
        assert!(db
            .frame_payloads(&[1, 2, 3], Projection::Search)
            .await
            .is_err());
        assert_eq!(large_search_page(&db, accessibility).await, before);
        db.close().await;
    }
}

#[tokio::test]
async fn migrated_accessibility_search_keeps_large_pages() {
    assert_large_search_page_survives_migration(true).await;
}

#[tokio::test]
async fn migrated_position_search_keeps_large_pages() {
    assert_large_search_page_survives_migration(false).await;
}

async fn timeline(db: &DatabaseManager, day: &str) -> Vec<(i64, String, String)> {
    let start: DateTime<Utc> = format!("{day}T00:00:00Z").parse().unwrap();
    db.find_video_chunks(start, start + Duration::days(1))
        .await
        .unwrap_or_else(|error| panic!("timeline for {day}: {error}"))
        .frames
        .into_iter()
        .map(|frame| {
            assert_eq!(frame.ocr_entries.len(), 1);
            let entry = frame.ocr_entries.into_iter().next().unwrap();
            (frame.frame_id, entry.text, entry.video_file_path)
        })
        .collect()
}

#[tokio::test]
async fn migrated_timeline_previews_do_not_load_a_days_full_text() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("db.sqlite");
    let db = DatabaseManager::new(path.to_str().unwrap(), Default::default())
        .await
        .unwrap();
    let text = format!("migrationneedle {}", "東京🙂".repeat(300));
    let oversized = text.repeat(8);
    let mut tx = db.begin_immediate_with_retry().await.unwrap();
    for id in 1..=12 {
        let day = match id {
            1 => "2026-09-01",
            12 => "2026-09-10",
            _ => "2026-09-09",
        };
        let (full_text, accessibility) = match id {
            1 => (Some("light day"), None),
            2 => (Some("café\0hidden after SQLite text terminator"), None),
            3..=5 => (Some(text.as_str()), None),
            6..=9 => (None, Some(text.as_str())),
            10 => (Some(""), Some(text.as_str())),
            11 => (None, None),
            _ => (Some(oversized.as_str()), None),
        };
        sqlx::query("INSERT INTO frames(id,timestamp,full_text,accessibility_text,snapshot_path,device_name) VALUES(?,?,?,?,?,'display')")
            .bind(id)
            .bind(format!("{day}T12:00:{id:02}Z"))
            .bind(full_text)
            .bind(accessibility)
            .bind(format!("frame-{id}.jpg"))
            .execute(&mut **tx.conn())
            .await
            .unwrap();
    }
    tx.commit().await.unwrap();
    let days = ["2026-09-01", "2026-09-09", "2026-09-10"];
    let mut before = Vec::new();
    for day in days {
        before.push(timeline(&db, day).await);
    }
    let browse_before = search(&db, "").await;
    let keyword_before = search(&db, "migrationneedle").await;
    assert!(!keyword_before.is_empty());
    db.close().await;

    // Scale down the production budget to reproduce the same failure cheaply:
    // ordinary rows fit individually, their full text exceeds the response cap,
    // and the timeline's 200-character previews fit comfortably.
    let mut options = MigrationOptions::default();
    options.budget.record_bytes = 4096;
    options.budget.file_bytes = 8192;
    options.budget.response_bytes = 16 * 1024;
    migrate(root.path(), Default::default(), options)
        .await
        .unwrap();

    // Reopen twice to cover the user's persistent failure after restarting.
    for reopen in 0..2 {
        let db = DatabaseManager::new(path.to_str().unwrap(), Default::default())
            .await
            .unwrap();
        db.verify_storage().await.unwrap();
        let error = db
            .frame_payloads(&(2..=11).collect::<Vec<_>>(), Projection::Search)
            .await
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("response payload budget exceeded"));
        // An indivisible migrated capture remains retrievable even when it is
        // larger than the response target. Timeline still loads previews only.
        assert_eq!(
            db.frame_payloads(&[12], Projection::Search).await.unwrap()[&12]
                .full_text
                .as_deref(),
            Some(oversized.as_str())
        );
        for (day, expected) in days.into_iter().zip(&before) {
            assert_eq!(timeline(&db, day).await, *expected, "{day}");
        }
        // API pages retain complete text, including a page whose aggregate
        // payload is over budget. Hydration splits it without truncating it.
        assert_eq!(
            search(&db, "")
                .await
                .into_iter()
                .filter(|(id, _)| *id != 13)
                .collect::<Vec<_>>(),
            browse_before
        );
        assert_eq!(search(&db, "migrationneedle").await, keyword_before);
        if reopen == 0 {
            db.execute_raw_sql_write("INSERT INTO frames(id,timestamp,full_text,snapshot_path) VALUES(13,'2026-09-17T12:00:00Z','new recording','new.jpg')")
                .await
                .unwrap();
        }
        assert_eq!(
            timeline(&db, "2026-09-17").await,
            vec![(13, "new recording".into(), "new.jpg".into())]
        );
        db.close().await;
    }
}
