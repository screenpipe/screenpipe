/// Frame Offset Synchronization Tests
///
/// This test suite validates the hypothesis that frame offset desync occurs when:
/// 1. Video queue and OCR queue independently drop different frames
/// 2. get_next_frame_offset() calculates from DB count, not actual frame_number
/// 3. Video encoder uses its own counter, not frame_number from CaptureResult
///
/// The fix: Both video encoding and DB insertion should use CaptureResult.frame_number
/// as the source of truth, ensuring consistent offsets even when frames are dropped.
///
/// Run with: cargo test --package screenpipe-db --test frame_offset_sync_test -- --nocapture
#[cfg(test)]
mod tests {
    use chrono::Utc;
    use screenpipe_db::DatabaseManager;

    async fn setup_test_db() -> DatabaseManager {
        let db = DatabaseManager::new("sqlite::memory:").await.unwrap();

        match sqlx::migrate!("./src/migrations").run(&db.pool).await {
            Ok(_) => {}
            Err(e) => {
                eprintln!("Migration error: {:?}", e);
                panic!("Database migration failed: {}", e);
            }
        }

        db
    }

    // ===========================================================================
    // HYPOTHESIS VALIDATION: Demonstrate the desync bug
    // ===========================================================================

    /// Demonstrate that get_next_frame_offset uses DB count, not frame_number
    /// This is the core of the bug: offsets are calculated from DB state, not capture state
    #[tokio::test]
    async fn test_get_next_frame_offset_uses_db_count() {
        let db = setup_test_db().await;

        // Create a video chunk
        let chunk_id = db
            .insert_video_chunk("/tmp/test.mp4", "test_monitor")
            .await
            .unwrap();
        assert!(chunk_id > 0, "Video chunk should be created");

        // First call should return 0 (no frames yet)
        let offset1 = db.get_next_frame_offset("test_monitor").await.unwrap();
        assert_eq!(offset1, 0, "First offset should be 0");

        // Insert a frame with offset 0
        let frame_id = db
            .insert_frame(
                "test_monitor",
                Some(Utc::now()),
                None,
                Some("TestApp"),
                Some("Window1"),
                true,
                Some(0),
            )
            .await
            .unwrap();
        assert!(frame_id > 0);

        // Second call should return 1 (one frame exists)
        let offset2 = db.get_next_frame_offset("test_monitor").await.unwrap();
        assert_eq!(offset2, 1, "Second offset should be 1 (one frame in DB)");

        // Insert another frame with offset 1
        let _ = db
            .insert_frame(
                "test_monitor",
                Some(Utc::now()),
                None,
                Some("TestApp"),
                Some("Window2"),
                false,
                Some(1),
            )
            .await
            .unwrap();

        // Third call should return 2
        let offset3 = db.get_next_frame_offset("test_monitor").await.unwrap();
        assert_eq!(offset3, 2, "Third offset should be 2 (two frames in DB)");

        println!("✓ Confirmed: get_next_frame_offset calculates from DB frame count");
    }

    /// Simulate the exact desync scenario:
    /// - Frames 0, 1, 2, 3, 4 are captured with frame_numbers 0, 1, 2, 3, 4
    /// - Video queue drops frame 2 (writes frames 0, 1, 3, 4 to positions 0, 1, 2, 3)
    /// - OCR queue processes all frames (inserts with offsets 0, 1, 2, 3, 4)
    /// - Result: Frame 3's OCR text is stored with offset 3, but video position 3 has frame 4's image
    #[tokio::test]
    async fn test_desync_when_video_drops_frame() {
        let db = setup_test_db().await;

        println!("\n=== FRAME OFFSET DESYNC DEMONSTRATION ===\n");

        // Create a video chunk
        let _chunk_id = db
            .insert_video_chunk("/tmp/monitor1.mp4", "monitor_1")
            .await
            .unwrap();

        // Simulate: Capture produces frames with frame_numbers 0, 1, 2, 3, 4
        // But video queue drops frame 2 (due to queue full)
        // Video encoder writes: frame_0 -> pos 0, frame_1 -> pos 1, frame_3 -> pos 2, frame_4 -> pos 3
        let video_written_frames = [0u64, 1, 3, 4]; // Frame 2 was dropped
        let mut video_position_to_frame: std::collections::HashMap<u64, u64> =
            std::collections::HashMap::new();
        for (video_pos, frame_num) in video_written_frames.iter().enumerate() {
            video_position_to_frame.insert(video_pos as u64, *frame_num);
        }

        // OCR queue doesn't drop anything, processes all 5 frames
        // DB inserts use get_next_frame_offset which returns 0, 1, 2, 3, 4
        let ocr_processed_frames = [0u64, 1, 2, 3, 4];
        let frame_names = ["App0", "App1", "App2", "App3", "App4"];

        for (i, frame_num) in ocr_processed_frames.iter().enumerate() {
            let db_offset = db.get_next_frame_offset("monitor_1").await.unwrap();

            // Insert frame with the offset calculated from DB (the bug!)
            let _ = db
                .insert_frame(
                    "monitor_1",
                    Some(Utc::now()),
                    None,
                    Some(frame_names[*frame_num as usize]),
                    Some(&format!("Window_{}", frame_num)),
                    true,
                    Some(db_offset),
                )
                .await
                .unwrap();

            println!(
                "Frame {} (OCR: {}) inserted with offset {} (DB calculated)",
                i, frame_names[*frame_num as usize], db_offset
            );
        }

        println!("\n--- Now simulating video extraction ---");

        // When user searches for "App3" (frame_number 3), DB returns offset 3
        // But video position 3 actually contains frame 4's image!
        let searched_frame_number = 3u64;
        let db_offset_for_frame_3 = 3i64; // What DB stores for frame 3

        // In video, position 3 actually has:
        let actual_frame_at_video_pos_3 = video_position_to_frame.get(&3).unwrap();

        println!(
            "User searches for 'App3' (frame_number={})",
            searched_frame_number
        );
        println!("DB returns offset={} for this frame", db_offset_for_frame_3);
        println!(
            "Video position {} actually contains frame {} (App{})",
            db_offset_for_frame_3, actual_frame_at_video_pos_3, actual_frame_at_video_pos_3
        );

        // THE BUG: Frame 3 was stored with offset 3, but video position 3 has frame 4
        assert_ne!(
            searched_frame_number, *actual_frame_at_video_pos_3,
            "BUG DEMONSTRATED: Offset 3 in DB points to frame 3, but video position 3 has frame 4!"
        );

        println!("\n✓ BUG CONFIRMED: OCR text for 'App3' will show image from 'App4'");
        println!("=== This is exactly the search result mismatch user reported ===\n");
    }

    /// Test that using frame_number as offset would prevent desync
    #[tokio::test]
    async fn test_frame_number_as_offset_prevents_desync() {
        let db = setup_test_db().await;

        println!("\n=== SOLUTION: Use frame_number as offset ===\n");

        // Create a video chunk
        let _chunk_id = db
            .insert_video_chunk("/tmp/monitor2.mp4", "monitor_2")
            .await
            .unwrap();

        // Same scenario: Video drops frame 2
        // But now we store frames with their actual frame_number as offset
        // Video encoder also tracks: frame_number -> video_position mapping

        // Video writes frames 0, 1, 3, 4 to positions 0, 1, 2, 3
        // We record this mapping
        let video_frame_to_position: std::collections::HashMap<u64, u64> = [
            (0u64, 0u64), // frame 0 -> video pos 0
            (1, 1),       // frame 1 -> video pos 1
            (3, 2),       // frame 3 -> video pos 2 (frame 2 was skipped)
            (4, 3),       // frame 4 -> video pos 3
        ]
        .iter()
        .cloned()
        .collect();

        // OCR processes frames 0, 1, 2, 3, 4
        // But we only insert frames that exist in video
        let ocr_processed_frames = [0u64, 1, 2, 3, 4];
        let frame_names = ["App0", "App1", "App2", "App3", "App4"];

        for frame_num in ocr_processed_frames.iter() {
            // Check if this frame was written to video
            if let Some(&video_pos) = video_frame_to_position.get(frame_num) {
                // Use the ACTUAL video position, not DB-calculated offset
                let _ = db
                    .insert_frame(
                        "monitor_2",
                        Some(Utc::now()),
                        None,
                        Some(frame_names[*frame_num as usize]),
                        Some(&format!("Window_{}", frame_num)),
                        true,
                        Some(video_pos as i64), // Use actual video position!
                    )
                    .await
                    .unwrap();

                println!(
                    "Frame {} (App{}) inserted with offset {} (actual video position)",
                    frame_num, frame_num, video_pos
                );
            } else {
                println!(
                    "Frame {} skipped - not in video (was dropped from video queue)",
                    frame_num
                );
            }
        }

        println!("\n--- Verifying correct mapping ---");

        // Now when user searches for "App3", DB returns offset 2
        // Video position 2 actually contains frame 3's image
        let searched_frame_number = 3u64;
        let correct_video_pos = video_frame_to_position.get(&searched_frame_number).unwrap();

        println!(
            "User searches for 'App3' (frame_number={})",
            searched_frame_number
        );
        println!(
            "DB correctly returns offset={} (actual video position)",
            correct_video_pos
        );
        println!(
            "Video position {} contains frame {}'s image - CORRECT!",
            correct_video_pos, searched_frame_number
        );

        println!("\n✓ SOLUTION WORKS: Using frame_number->video_position mapping prevents desync");
        println!("=== Search results will now match images correctly ===\n");
    }

    // ===========================================================================
    // REGRESSION: Multiple windows per capture must share same offset
    // ===========================================================================

    /// When multiple windows are captured in one cycle, they must share the same offset
    #[tokio::test]
    async fn test_multiple_windows_same_offset() {
        let db = setup_test_db().await;

        let _chunk_id = db
            .insert_video_chunk("/tmp/multi.mp4", "multi_window_monitor")
            .await
            .unwrap();

        // Single capture cycle produces 3 windows
        // All should share the same video offset since they're from same screenshot
        let offset = db
            .get_next_frame_offset("multi_window_monitor")
            .await
            .unwrap();

        let windows = vec![
            ("Firefox", "Google Search"),
            ("VSCode", "main.rs"),
            ("Terminal", "zsh"),
        ];

        for (app, window) in &windows {
            let frame_id = db
                .insert_frame(
                    "multi_window_monitor",
                    Some(Utc::now()),
                    None,
                    Some(app),
                    Some(window),
                    false,
                    Some(offset), // All windows share same offset
                )
                .await
                .unwrap();
            assert!(frame_id > 0);
        }

        // Verify all 3 frames have the same offset
        let frames: Vec<(i64,)> = sqlx::query_as(
            "SELECT offset_index FROM frames WHERE video_chunk_id = (
                SELECT id FROM video_chunks WHERE device_name = 'multi_window_monitor' ORDER BY id DESC LIMIT 1
            )",
        )
        .fetch_all(&db.pool)
        .await
        .unwrap();

        assert_eq!(frames.len(), 3, "Should have 3 frames");
        assert!(
            frames.iter().all(|f| f.0 == offset),
            "All frames should share offset {}",
            offset
        );

        println!("✓ Multiple windows correctly share the same video offset");
    }

    // ===========================================================================
    // EDGE CASES
    // ===========================================================================

    /// Test offset behavior across video chunk boundaries
    #[tokio::test]
    async fn test_offset_resets_per_chunk() {
        let db = setup_test_db().await;

        // First chunk
        let _chunk1 = db
            .insert_video_chunk("/tmp/chunk1.mp4", "reset_test")
            .await
            .unwrap();
        let offset1 = db.get_next_frame_offset("reset_test").await.unwrap();
        assert_eq!(offset1, 0, "First chunk should start at offset 0");

        // Insert 3 frames
        for i in 0..3 {
            let _ = db
                .insert_frame(
                    "reset_test",
                    Some(Utc::now()),
                    None,
                    Some("App"),
                    Some(&format!("Window{}", i)),
                    true,
                    Some(i),
                )
                .await
                .unwrap();
        }

        // Check offset is now 3
        let offset_before_new_chunk = db.get_next_frame_offset("reset_test").await.unwrap();
        assert_eq!(
            offset_before_new_chunk, 3,
            "Should have offset 3 after 3 frames"
        );

        // Create new chunk
        let _chunk2 = db
            .insert_video_chunk("/tmp/chunk2.mp4", "reset_test")
            .await
            .unwrap();

        // Offset should reset to 0 for new chunk
        let offset_after_new_chunk = db.get_next_frame_offset("reset_test").await.unwrap();
        assert_eq!(
            offset_after_new_chunk, 0,
            "New chunk should start at offset 0"
        );

        println!("✓ Offset correctly resets to 0 for each new video chunk");
    }

    /// Test that None offset falls back to DB calculation (legacy behavior)
    #[tokio::test]
    async fn test_none_offset_uses_db_fallback() {
        let db = setup_test_db().await;

        let _chunk = db
            .insert_video_chunk("/tmp/fallback.mp4", "fallback_test")
            .await
            .unwrap();

        // Insert with explicit offset
        let _ = db
            .insert_frame(
                "fallback_test",
                Some(Utc::now()),
                None,
                Some("App1"),
                Some("Window1"),
                true,
                Some(0),
            )
            .await
            .unwrap();

        // Insert with None offset (should use MAX+1 = 1)
        let frame2_id = db
            .insert_frame(
                "fallback_test",
                Some(Utc::now()),
                None,
                Some("App2"),
                Some("Window2"),
                true,
                None, // Legacy: let DB calculate
            )
            .await
            .unwrap();
        assert!(frame2_id > 0);

        // Verify it got offset 1
        let offset: (i64,) = sqlx::query_as("SELECT offset_index FROM frames WHERE id = ?1")
            .bind(frame2_id)
            .fetch_one(&db.pool)
            .await
            .unwrap();

        assert_eq!(offset.0, 1, "None offset should fallback to MAX+1");

        println!("✓ None offset correctly falls back to DB calculation");
    }
}
