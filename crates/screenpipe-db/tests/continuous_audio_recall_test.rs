// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use chrono::Utc;
use screenpipe_db::{AudioDevice, DatabaseManager, DeviceType, Order};

// Perfect STT inputs isolate storage/retrieval from recognition and summarization.
// No meeting, live stream, second device, or model is involved.
#[tokio::test]
async fn spoken_checklist_preserves_distinct_details_from_one_microphone() {
    let db = DatabaseManager::new("sqlite::memory:", Default::default())
        .await
        .unwrap();
    let mic = AudioDevice {
        name: "Synthetic microphone".into(),
        device_type: DeviceType::Input,
    };
    let captured = Utc::now();
    let mut expected = Vec::new();
    for (group, template) in [
        "For the launch checklist please remember to send a separate invitation to",
        "For the office order please remember to include a separate box of",
        "For the travel schedule please remember to book a separate visit to",
        "For the review meeting please remember to request a separate update from",
        "For the website release please remember to check the complete page for",
    ]
    .iter()
    .enumerate()
    {
        for (item, detail) in ["amber", "birch", "cedar", "dahlia", "elm"]
            .iter()
            .enumerate()
        {
            let text = format!("{template} {detail}.");
            let idx = group * 5 + item;
            db.insert_audio_chunk_and_transcription(
                &format!("synthetic-checklist-{group}.mp4"),
                &text,
                0,
                "perfect-stt-fixture",
                &mic,
                None,
                Some(item as f64 * 5.0),
                Some((item + 1) as f64 * 5.0),
                Some(captured),
            )
            .await
            .unwrap();
            expected.push(text);
            eprintln!("submitted fact {}", idx + 1);
        }
    }
    let stored: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM audio_transcriptions")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    eprintln!("stored transcript rows: {stored}");
    let mut actual = Vec::new();
    for offset in [0, 20, 40] {
        actual.extend(
            db.search_audio_ordered(
                "",
                20,
                offset,
                None,
                None,
                None,
                None,
                None,
                None,
                Some("Synthetic microphone"),
                None,
                &[],
                Order::Ascending,
            )
            .await
            .unwrap(),
        );
    }
    let found = expected
        .iter()
        .filter(|text| actual.iter().any(|r| &r.transcription == *text))
        .count();
    eprintln!(
        "perfect input facts: {}; searchable facts: {}",
        expected.len(),
        found
    );
    assert_eq!(
        found, 25,
        "distinct checklist details must survive continuous audio persistence and paginated search"
    );
}

#[tokio::test]
async fn two_distinct_numbers_from_same_mic_survive() {
    let db = DatabaseManager::new("sqlite::memory:", Default::default())
        .await
        .unwrap();
    let mic = AudioDevice {
        name: "Synthetic microphone".into(),
        device_type: DeviceType::Input,
    };
    let captured = Utc::now();
    for (i, text) in [
        "Please remember that the number of chairs we need to order is 12.",
        "Please remember that the number of chairs we need to order is 20.",
    ]
    .iter()
    .enumerate()
    {
        db.insert_audio_chunk_and_transcription(
            "synthetic-correction.mp4",
            text,
            0,
            "perfect-stt-fixture",
            &mic,
            None,
            Some(i as f64 * 5.0),
            Some(i as f64 * 5.0 + 5.0),
            Some(captured),
        )
        .await
        .unwrap();
    }
    let stored: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM audio_transcriptions")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(
        stored, 2,
        "a changed number is new information, not a duplicate"
    );
}

#[tokio::test]
async fn all_segments_in_five_recorded_chunks_are_searchable() {
    let db = DatabaseManager::new("sqlite::memory:", Default::default())
        .await
        .unwrap();
    let mic = AudioDevice {
        name: "Synthetic microphone".into(),
        device_type: DeviceType::Input,
    };
    let base = Utc::now() - chrono::Duration::hours(1);
    for chunk in 0..5 {
        for segment in 0..5 {
            let text = format!("Checklist fact {}", chunk * 5 + segment + 1);
            db.insert_audio_chunk_and_transcription(
                &format!("recorded-{chunk}.mp4"),
                &text,
                0,
                "perfect-stt-fixture",
                &mic,
                None,
                Some(segment as f64 * 5.0),
                Some(segment as f64 * 5.0 + 5.0),
                Some(base + chrono::Duration::seconds(chunk * 30)),
            )
            .await
            .unwrap();
        }
    }
    let stored: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM audio_transcriptions")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(stored, 25, "setup must preserve all facts before search");
    let mut found = Vec::new();
    for offset in [0, 20, 40] {
        found.extend(
            db.search_audio_ordered(
                "",
                20,
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
                Order::Ascending,
            )
            .await
            .unwrap(),
        );
    }
    eprintln!("stored facts: {stored}; searchable facts: {}", found.len());
    assert_eq!(
        found.len(),
        25,
        "segments sharing a chunk and offset are distinct speech"
    );
}

#[tokio::test]
async fn other_devices_cannot_erase_numbers_negations_or_extra_details() {
    for (first, second) in [
        (
            "Please order exactly 12 chairs for our workshop.",
            "Please order exactly 20 chairs for our workshop.",
        ),
        (
            "Approve the payment for the order.",
            "Do not approve the payment for the order.",
        ),
        (
            "Send the proposal tomorrow.",
            "Send the proposal tomorrow. Include the security appendix.",
        ),
        (
            "The adjustment is -12.5 dollars.",
            "The adjustment is 125 dollars.",
        ),
        (
            "Please ship from London to Paris.",
            "Please ship from Paris to London.",
        ),
    ] {
        let db = DatabaseManager::new("sqlite::memory:", Default::default())
            .await
            .unwrap();
        for (i, text) in [first, second].iter().enumerate() {
            let device = AudioDevice {
                name: format!("device-{i}"),
                device_type: if i == 0 {
                    DeviceType::Output
                } else {
                    DeviceType::Input
                },
            };
            let chunk = db
                .insert_audio_chunk(&format!("file-{i}.mp4"), None)
                .await
                .unwrap();
            assert!(
                db.insert_audio_transcription(
                    chunk,
                    text,
                    0,
                    "perfect-stt-fixture",
                    &device,
                    None,
                    None,
                    None,
                    None
                )
                .await
                .unwrap()
                    > 0
            );
        }
    }
}

#[tokio::test]
async fn delayed_recording_is_not_compared_with_unrelated_live_speech() {
    let db = DatabaseManager::new("sqlite::memory:", Default::default())
        .await
        .unwrap();
    let text = "Please send the complete proposal tomorrow.";
    let now = Utc::now();
    for (i, captured) in [now, now - chrono::Duration::hours(1)].iter().enumerate() {
        let device = AudioDevice {
            name: format!("device-{i}"),
            device_type: if i == 0 {
                DeviceType::Output
            } else {
                DeviceType::Input
            },
        };
        assert!(
            db.insert_audio_chunk_and_transcription(
                &format!("file-{i}.mp4"),
                text,
                0,
                "perfect-stt-fixture",
                &device,
                None,
                None,
                None,
                Some(*captured)
            )
            .await
            .unwrap()
                > 0
        );
    }
}

#[tokio::test]
async fn delayed_cross_device_echo_still_deduplicates_at_capture_time() {
    let db = DatabaseManager::new("sqlite::memory:", Default::default())
        .await
        .unwrap();
    let captured = Utc::now() - chrono::Duration::hours(1);
    let mut ids = Vec::new();
    for i in 0..2 {
        let device = AudioDevice {
            name: format!("device-{i}"),
            device_type: if i == 0 {
                DeviceType::Output
            } else {
                DeviceType::Input
            },
        };
        let chunk = db
            .insert_audio_chunk(&format!("file-{i}.mp4"), Some(captured))
            .await
            .unwrap();
        ids.push(
            db.insert_audio_transcription(
                chunk,
                "Please send the complete proposal tomorrow.",
                0,
                "perfect-stt-fixture",
                &device,
                None,
                None,
                None,
                Some(captured),
            )
            .await
            .unwrap(),
        );
    }
    assert!(ids[0] > 0);
    assert_eq!(ids[1], 0);
}

#[tokio::test]
#[ignore = "manual persistence latency probe; not a CI performance threshold"]
async fn measure_continuous_transcript_insert_latency() {
    let dir = tempfile::tempdir().unwrap();
    let db = DatabaseManager::new(
        dir.path().join("latency.sqlite").to_str().unwrap(),
        Default::default(),
    )
    .await
    .unwrap();
    let captured = Utc::now();
    let output = AudioDevice {
        name: "Synthetic output".into(),
        device_type: DeviceType::Output,
    };
    let mic = AudioDevice {
        name: "Synthetic microphone".into(),
        device_type: DeviceType::Input,
    };
    for i in 0..50 {
        db.insert_audio_chunk_and_transcription(
            &format!("output-{i}.mp4"),
            &format!("Independent system output statement number {i}."),
            0,
            "fixture",
            &output,
            None,
            None,
            None,
            Some(captured),
        )
        .await
        .unwrap();
    }
    let mut micros = Vec::new();
    let began = std::time::Instant::now();
    for i in 0..1000 {
        let start = std::time::Instant::now();
        db.insert_audio_chunk_and_transcription(
            &format!("mic-{i}.mp4"),
            &format!("Remember this distinct microphone fact number {i}."),
            0,
            "fixture",
            &mic,
            None,
            None,
            None,
            Some(captured),
        )
        .await
        .unwrap();
        micros.push(start.elapsed().as_micros());
    }
    let elapsed = began.elapsed();
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM audio_transcriptions")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(count, 1050);
    micros.sort_unstable();
    eprintln!(
        "1000 persisted microphone facts; wall_ms={}; p50_us={}; p95_us={}; p99_us={}",
        elapsed.as_millis(),
        micros[500],
        micros[950],
        micros[990]
    );
}

#[tokio::test]
async fn cross_device_retention_and_echo_eval_matrix() {
    // Both public insertion routes must make the same retention decision.
    let cases = [
        (
            "exact_echo",
            "Send the complete proposal tomorrow.",
            "Send the complete proposal tomorrow.",
            true,
            0,
            1,
        ),
        (
            "case_punctuation_echo",
            "Send the complete proposal tomorrow.",
            "SEND THE COMPLETE PROPOSAL TOMORROW!",
            true,
            0,
            1,
        ),
        (
            "whitespace_echo",
            "Send the complete proposal tomorrow.",
            "Send  the complete proposal tomorrow.",
            true,
            0,
            1,
        ),
        (
            "same_device_repetition",
            "Send the complete proposal tomorrow.",
            "Send the complete proposal tomorrow.",
            false,
            0,
            2,
        ),
        (
            "old_unrelated_speech",
            "Send the complete proposal tomorrow.",
            "Send the complete proposal tomorrow.",
            true,
            -3600,
            2,
        ),
        (
            "future_unrelated_speech",
            "Send the complete proposal tomorrow.",
            "Send the complete proposal tomorrow.",
            true,
            3600,
            2,
        ),
        (
            "changed_number",
            "Order exactly 12 chairs tomorrow.",
            "Order exactly 20 chairs tomorrow.",
            true,
            0,
            2,
        ),
        (
            "changed_decimal",
            "The adjustment is -12.5 dollars.",
            "The adjustment is -125 dollars.",
            true,
            0,
            2,
        ),
        (
            "changed_sign",
            "The adjustment is -12.5 dollars.",
            "The adjustment is +12.5 dollars.",
            true,
            0,
            2,
        ),
        (
            "added_negation",
            "Please approve the payment.",
            "Please do not approve the payment.",
            true,
            0,
            2,
        ),
        (
            "extra_detail",
            "Send the proposal tomorrow.",
            "Send the proposal tomorrow. Include the appendix.",
            true,
            0,
            2,
        ),
        (
            "word_order",
            "Please ship from London to Paris.",
            "Please ship from Paris to London.",
            true,
            0,
            2,
        ),
    ];
    let mut failures = Vec::new();
    for combined in [false, true] {
        for (name, first, second, other_direction, delay, expected) in cases {
            let dir = tempfile::tempdir().unwrap();
            let db = DatabaseManager::new(
                dir.path().join("eval.sqlite").to_str().unwrap(),
                Default::default(),
            )
            .await
            .unwrap();
            let base = Utc::now() - chrono::Duration::hours(2);
            for (i, text) in [first, second].iter().enumerate() {
                // Same hardware name can expose both input and output streams.
                let device = AudioDevice {
                    name: "Synthetic duplex device".into(),
                    device_type: if i == 1 && other_direction {
                        DeviceType::Output
                    } else {
                        DeviceType::Input
                    },
                };
                let at = base + chrono::Duration::seconds(if i == 0 { 0 } else { delay });
                let file = format!("chunk-{i}.mp4");
                if combined {
                    db.insert_audio_chunk_and_transcription(
                        &file,
                        text,
                        0,
                        "fixture",
                        &device,
                        None,
                        Some(0.0),
                        Some(5.0),
                        Some(at),
                    )
                    .await
                    .unwrap();
                } else {
                    let chunk = db.insert_audio_chunk(&file, Some(at)).await.unwrap();
                    db.insert_audio_transcription(
                        chunk,
                        text,
                        0,
                        "fixture",
                        &device,
                        None,
                        Some(0.0),
                        Some(5.0),
                        Some(at),
                    )
                    .await
                    .unwrap();
                }
            }
            let actual: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM audio_transcriptions")
                .fetch_one(&db.pool)
                .await
                .unwrap();
            let passed = actual == expected;
            eprintln!("DB_RECALL_EVAL {{\"case\":\"{name}\",\"combined\":{combined},\"passed\":{passed},\"expected_rows\":{expected},\"actual_rows\":{actual}}}");
            if !passed {
                failures.push(format!("{name}/combined={combined}"));
            }
        }
    }
    assert!(
        failures.is_empty(),
        "cross-device eval failures: {failures:?}"
    );
}
