// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use screenpipe_db::{AudioDevice, DatabaseManager, DeviceType, Order, TagContentType};

#[tokio::test]
async fn preserves_segments_with_shared_chunk_offset_and_paginates_without_tag_duplicates() {
    let temp = tempfile::tempdir().unwrap();
    let db = DatabaseManager::new(
        temp.path().join("audio.sqlite").to_str().unwrap(),
        Default::default(),
    )
    .await
    .unwrap();
    let chunk = db
        .insert_audio_chunk("realistic-segmented-speech.mp4", None)
        .await
        .unwrap();
    let device = AudioDevice {
        name: "System Audio".into(),
        device_type: DeviceType::Output,
    };
    let captured = chrono::Utc::now();
    for (index, text) in [
        "Juniper artwork",
        "requires review",
        "before customer sharing",
    ]
    .iter()
    .enumerate()
    {
        db.insert_audio_transcription(
            chunk,
            text,
            0,
            "test",
            &device,
            None,
            Some(index as f64 * 2.0),
            Some(index as f64 * 2.0 + 2.0),
            Some(captured),
        )
        .await
        .unwrap();
    }
    db.add_tags(
        chunk,
        TagContentType::Audio,
        vec!["juniper".into(), "review".into()],
    )
    .await
    .unwrap();
    for (order, expected) in [
        (
            Order::Ascending,
            vec![
                "Juniper artwork",
                "requires review",
                "before customer sharing",
            ],
        ),
        (
            Order::Descending,
            vec![
                "before customer sharing",
                "requires review",
                "Juniper artwork",
            ],
        ),
    ] {
        let mut observed = Vec::new();
        for offset in 0..4 {
            let page = db
                .search_audio_ordered(
                    "",
                    1,
                    offset,
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    &[],
                    order,
                )
                .await
                .unwrap();
            for segment in page {
                assert_eq!(segment.tags.len(), 2);
                observed.push(segment.transcription);
            }
        }
        assert_eq!(observed, expected);
    }
}
