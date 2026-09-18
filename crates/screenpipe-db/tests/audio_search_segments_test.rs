// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use chrono::{TimeZone, Utc};
use screenpipe_db::{AudioDevice, ContentType, DatabaseManager, DeviceType, Order, TagContentType};

#[tokio::test]
async fn search_preserves_segments_with_shared_offsets_across_pages() {
    let dir = tempfile::tempdir().unwrap();
    let db = DatabaseManager::new(
        dir.path().join("segments.sqlite").to_str().unwrap(),
        Default::default(),
    )
    .await
    .unwrap();
    let device = AudioDevice {
        name: "test microphone".into(),
        device_type: DeviceType::Input,
    };
    let timestamp = Utc.with_ymd_and_hms(2026, 1, 1, 12, 0, 0).unwrap();
    let tags = vec!["meeting".to_string(), "engineering".to_string()];
    let phrases = [
        "Review the database migration",
        "Customer feedback needs attention",
        "Release planning starts tomorrow",
        "Assign ownership for documentation",
        "Schedule another design review",
    ];
    for (chunk_index, chunk_phrases) in phrases.chunks(3).enumerate() {
        let chunk = db
            .insert_audio_chunk(&format!("chunk-{chunk_index}.wav"), Some(timestamp))
            .await
            .unwrap();
        db.add_tags(chunk, TagContentType::Audio, tags.clone())
            .await
            .unwrap();
        for (segment_index, phrase) in chunk_phrases.iter().enumerate() {
            // The live insertion path uses offset 0 for every speech segment.
            db.insert_audio_transcription(
                chunk,
                phrase,
                0,
                "test",
                &device,
                None,
                Some(segment_index as f64),
                Some(segment_index as f64 + 1.0),
                Some(timestamp),
            )
            .await
            .unwrap();
        }
    }

    for filter in [vec![], tags.clone()] {
        let total = db
            .count_search_results_with_tags(
                "",
                ContentType::Audio,
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
                &filter,
            )
            .await
            .unwrap();
        assert_eq!(total, phrases.len());
        for order in [Order::Ascending, Order::Descending] {
            let mut found = Vec::new();
            for offset in [0, 2, 4, 6] {
                let page = db
                    .search_audio_ordered(
                        "",
                        2,
                        offset,
                        None,
                        None,
                        None,
                        None,
                        None,
                        None,
                        None,
                        None,
                        &filter,
                        order.clone(),
                    )
                    .await
                    .unwrap();
                assert_eq!(page.len(), total.saturating_sub(offset as usize).min(2));
                for result in page {
                    // Tag joins must not multiply rows or mix segment contents.
                    assert_eq!(result.tags.len(), 2);
                    assert_eq!(result.offset_index, 0);
                    assert!(result.start_time.is_some());
                    found.push(result.transcription);
                }
            }
            let mut expected: Vec<String> = phrases.iter().map(|s| s.to_string()).collect();
            if matches!(order, Order::Descending) {
                expected.reverse();
            }
            assert_eq!(found, expected);
        }
    }
    db.close().await;
}
