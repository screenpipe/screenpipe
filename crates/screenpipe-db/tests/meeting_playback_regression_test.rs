// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
use chrono::{Duration, Utc};
use screenpipe_db::DatabaseManager;

#[tokio::test]
async fn late_live_turn_links_to_containing_chunk_and_seeks_within_it() {
    let db = DatabaseManager::new("sqlite::memory:", Default::default())
        .await
        .unwrap();
    let id = db
        .insert_meeting("Zoom", "manual", None, None)
        .await
        .unwrap();
    let base = Utc::now();
    db.end_meeting(id, &(base + Duration::minutes(2)).to_rfc3339(), None)
        .await
        .unwrap();
    let first = db
        .insert_audio_chunk("Meeting Tap (output)_first.mp4", Some(base))
        .await
        .unwrap();
    db.insert_audio_chunk(
        "Meeting Tap (output)_next.mp4",
        Some(base + Duration::seconds(30)),
    )
    .await
    .unwrap();
    db.insert_meeting_transcript_segment(
        id,
        "deepgram",
        None,
        "turn",
        "Meeting Tap",
        "output",
        Some("speaker 1"),
        "We agreed to review the draft next Tuesday.",
        base + Duration::seconds(24),
    )
    .await
    .unwrap();
    db.mirror_live_meeting_to_audio_transcriptions(id, 30.0)
        .await
        .unwrap();
    let rows = db.list_meeting_transcript_segments(id).await.unwrap();
    let row = rows.iter().find(|r| r.source == "live").unwrap();
    assert_eq!(
        row.audio_chunk_id,
        Some(first),
        "nearest chunk is in the future and contains the wrong speech"
    );
    let json = serde_json::to_value(row).unwrap();
    assert_eq!(json["audioStartTimeSecs"], 24.0);
}

#[tokio::test]
async fn saved_transcript_preserves_repetition_and_contradictions_across_devices() {
    let db = DatabaseManager::new("sqlite::memory:", Default::default())
        .await
        .unwrap();
    let id = db
        .insert_meeting("Zoom", "manual", None, None)
        .await
        .unwrap();
    let base = Utc::now();
    db.end_meeting(id, &(base + Duration::minutes(2)).to_rfc3339(), None)
        .await
        .unwrap();
    for (key, device, direction, text, seconds) in [
        (
            "a",
            "Meeting Tap",
            "output",
            "Do not send the revised proposal on Tuesday.",
            0,
        ),
        (
            "b",
            "Microphone",
            "input",
            "Send the revised proposal on Tuesday.",
            2,
        ),
        (
            "c",
            "Microphone",
            "input",
            "Do not send the revised proposal on Tuesday.",
            3,
        ),
        ("d", "Microphone", "input", "Yes", 4),
        (
            "e",
            "Microphone",
            "input",
            "We should send the revised proposal on Tuesday.",
            20,
        ),
    ] {
        db.insert_meeting_transcript_segment(
            id,
            "deepgram",
            None,
            key,
            device,
            direction,
            Some("speaker 1"),
            text,
            base + Duration::seconds(seconds),
        )
        .await
        .unwrap();
    }
    let rows = db.list_meeting_transcript_segments(id).await.unwrap();
    assert_eq!(
        rows.len(),
        5,
        "text alone cannot distinguish echo from disagreement or deliberate read-back"
    );
    assert!(rows
        .iter()
        .any(|r| r.transcript == "Send the revised proposal on Tuesday."));
    assert_eq!(
        db.count_meeting_transcript_segments(id).await.unwrap(),
        5,
        "original evidence must remain stored"
    );
}
