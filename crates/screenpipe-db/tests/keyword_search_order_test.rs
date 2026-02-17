#[cfg(test)]
mod tests {
    use chrono::{Duration, Utc};
    use screenpipe_db::{DatabaseManager, OcrEngine, Order};
    use screenpipe_db::fts_indexer::index_all_tables;
    use std::sync::Arc;

    async fn setup_test_db() -> DatabaseManager {
        let db = DatabaseManager::new("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./src/migrations")
            .run(&db.pool)
            .await
            .unwrap();
        db
    }

    /// Insert a frame with OCR text and return the frame_id.
    /// The ocr_text MUST contain the search keyword for FTS to find it.
    async fn insert_frame_with_ocr(
        db: &DatabaseManager,
        app_name: &str,
        window_name: &str,
        ocr_text: &str,
        minutes_ago: i64,
    ) -> i64 {
        let _ = db
            .insert_video_chunk("test_video.mp4", "test_device")
            .await
            .unwrap();

        let frame_id = db
            .insert_frame(
                "test_device",
                None,
                None,
                Some(app_name),
                Some(window_name),
                false,
                None,
            )
            .await
            .unwrap();

        // Manually set the timestamp to the desired time
        let ts = Utc::now() - Duration::minutes(minutes_ago);
        sqlx::query("UPDATE frames SET timestamp = ? WHERE id = ?")
            .bind(ts)
            .bind(frame_id)
            .execute(&db.pool)
            .await
            .unwrap();

        db.insert_ocr_text(frame_id, ocr_text, "[]", Arc::new(OcrEngine::AppleNative))
            .await
            .unwrap();

        frame_id
    }

    #[tokio::test]
    async fn test_keyword_search_sorted_by_timestamp_descending() {
        let db = setup_test_db().await;

        // All frames have "hello" in OCR text so FTS finds them.
        // They differ in timestamp — we verify results come back newest-first.
        // Frame A: 60 min ago, "hello" also in window_name (high relevance)
        let _frame_a =
            insert_frame_with_ocr(&db, "Arc", "hello world page", "hello from the browser", 60)
                .await;

        // Frame B: 10 min ago, "hello" only in OCR (low relevance)
        let _frame_b = insert_frame_with_ocr(&db, "WezTerm", "terminal", "echo hello", 10).await;

        // Frame C: 30 min ago
        let _frame_c = insert_frame_with_ocr(&db, "Cursor", "editor", "println hello", 30).await;

        // Index FTS tables before searching
        index_all_tables(&db).await;

        let results = db
            .search_with_text_positions(
                "hello",
                10,
                0,
                None,
                None,
                true,
                Order::Descending,
                None,
                None,
            )
            .await
            .unwrap();

        assert!(
            results.len() >= 3,
            "Expected at least 3 results, got {}",
            results.len()
        );

        // Results must be sorted by timestamp DESCENDING (most recent first)
        // Frame B (10 min ago) → Frame C (30 min ago) → Frame A (60 min ago)
        for i in 0..results.len() - 1 {
            assert!(
                results[i].timestamp >= results[i + 1].timestamp,
                "Results not sorted by timestamp descending: [{}] {} should be >= [{}] {}",
                i,
                results[i].timestamp,
                i + 1,
                results[i + 1].timestamp,
            );
        }

        // The most recent result (Frame B, 10 min ago) should be first
        // even though Frame A has higher relevance (keyword in window_name)
        assert_eq!(
            results[0].app_name, "WezTerm",
            "Most recent frame should be first regardless of relevance. Got: {} at {}",
            results[0].app_name, results[0].timestamp
        );
    }

    #[tokio::test]
    async fn test_keyword_search_sorted_by_timestamp_ascending() {
        let db = setup_test_db().await;

        let _frame_old =
            insert_frame_with_ocr(&db, "Arc", "browser", "old content with hello", 120).await;

        let _frame_new =
            insert_frame_with_ocr(&db, "WezTerm", "terminal", "new content hello world", 5).await;

        // Index FTS tables before searching
        index_all_tables(&db).await;

        let results = db
            .search_with_text_positions(
                "hello",
                10,
                0,
                None,
                None,
                true,
                Order::Ascending,
                None,
                None,
            )
            .await
            .unwrap();

        assert!(
            results.len() >= 2,
            "Expected at least 2 results, got {}",
            results.len()
        );

        // Ascending: oldest first
        for i in 0..results.len() - 1 {
            assert!(
                results[i].timestamp <= results[i + 1].timestamp,
                "Results not sorted by timestamp ascending: [{}] {} should be <= [{}] {}",
                i,
                results[i].timestamp,
                i + 1,
                results[i + 1].timestamp,
            );
        }
    }

    #[tokio::test]
    async fn test_keyword_search_same_timestamp_uses_relevance_tiebreak() {
        let db = setup_test_db().await;

        // Two frames at the same time, different relevance.
        // Both have "hello" in OCR text so FTS finds both.
        // Frame 1: "hello" only in OCR (relevance 1)
        let _frame_low =
            insert_frame_with_ocr(&db, "Terminal", "bash", "hello world from terminal", 10).await;

        // Frame 2: "hello" in window_name too (relevance 3)
        let _frame_high = insert_frame_with_ocr(
            &db,
            "Arc",
            "hello dashboard",
            "hello content here",
            10, // same time
        )
        .await;

        // Index FTS tables before searching
        index_all_tables(&db).await;

        let results = db
            .search_with_text_positions(
                "hello",
                10,
                0,
                None,
                None,
                true,
                Order::Descending,
                None,
                None,
            )
            .await
            .unwrap();

        assert!(
            results.len() >= 2,
            "Expected at least 2 results, got {}",
            results.len()
        );

        // Both have ~same timestamp, so within the same second,
        // the one with "hello" in window_name (higher relevance) should come first
        let first_has_hello_in_window = results[0].window_name.to_lowercase().contains("hello");
        assert!(
            first_has_hello_in_window,
            "Within same timestamp, higher relevance result should come first. Got: {} - {}",
            results[0].app_name, results[0].window_name
        );
    }
}
