// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Attribution evals at the production DB boundary. Fixtures are synthetic:
//! no private recordings, customer identities, or provider credentials.
//! Run with --nocapture for per-case outcomes and a machine-readable summary.
use chrono::{DateTime, Duration, Utc};
use screenpipe_db::DatabaseManager;
use serde_json::json;

async fn db() -> DatabaseManager {
    DatabaseManager::new("sqlite::memory:", Default::default())
        .await
        .unwrap()
}

async fn audio(
    db: &DatabaseManager,
    speaker: i64,
    at: DateTime<Utc>,
    text: &str,
    device: &str,
    input: bool,
    engine: &str,
    chunk: Option<i64>,
    duration: f64,
) -> i64 {
    let chunk = match chunk {
        Some(id) => id,
        None => db
            .insert_audio_chunk(&format!("{device}_{}.mp4", at.timestamp_micros()), Some(at))
            .await
            .unwrap(),
    };
    sqlx::query("INSERT INTO audio_transcriptions (audio_chunk_id, offset_index, timestamp, transcription, device, is_input_device, speaker_id, transcription_engine, start_time, end_time) VALUES (?1, 0, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8)")
        .bind(chunk).bind(at).bind(text).bind(device).bind(input).bind(speaker).bind(engine).bind(duration)
        .execute(&db.pool).await.unwrap();
    chunk
}

#[tokio::test]
async fn speaker_identity_backfill_eval() {
    let cases = [
        ("exact_mirror", true),
        ("microsecond_mirror", true),
        ("ambiguous_stream_mirror", false),
        ("adjacent_other_turn", false),
        ("other_output_device", false),
        ("other_direction", false),
        ("same_text_after_reconnect", false),
        ("conflicting_exact_mirrors", false),
        ("agreeing_exact_mirrors", true),
        ("background_text_is_not_live_provenance", false),
        ("empty_transcript", false),
        ("human_assignment_survives", true),
    ];
    let mut failures = Vec::new();
    let mut false_assignments = 0;
    let mut missed_assignments = 0;
    for (case, should_assign) in cases {
        let db = db().await;
        // Stable millisecond timestamp exercises UTC storage and exact matching.
        let base: DateTime<Utc> = if case == "microsecond_mirror" {
            "2026-08-01T12:00:00.123789Z"
        } else {
            "2026-08-01T12:00:00.123Z"
        }
        .parse()
        .unwrap();
        let correct = db.create_speaker_with_name("Guest").await.unwrap().id;
        let wrong = db.create_speaker_with_name("Local user").await.unwrap().id;
        let meeting = db.insert_meeting("Meet", "test", None, None).await.unwrap();
        let text = if case == "empty_transcript" {
            ""
        } else {
            "A distinct guest turn."
        };
        db.insert_meeting_transcript_segment_with_identity(
            meeting,
            "test",
            None,
            "turn",
            "Meeting Tap",
            "output",
            "stream-new",
            Some("stream-new:1"),
            Some("speaker 1"),
            "A distinct guest turn.",
            base,
        )
        .await
        .unwrap();
        if case == "ambiguous_stream_mirror" {
            db.insert_meeting_transcript_segment_with_identity(
                meeting,
                "test",
                None,
                "other-turn",
                "Meeting Tap",
                "output",
                "other-stream",
                Some("other-stream:1"),
                Some("speaker 1"),
                text,
                base,
            )
            .await
            .unwrap();
        }
        if case == "empty_transcript" {
            sqlx::query(
                "UPDATE meeting_transcript_segments SET transcript = '' WHERE meeting_id = ?1",
            )
            .bind(meeting)
            .execute(&db.pool)
            .await
            .unwrap();
        }
        let time = if case == "same_text_after_reconnect" {
            base - Duration::seconds(5)
        } else {
            base
        };
        let candidate_text = if case == "adjacent_other_turn" {
            "A different person's preceding turn."
        } else {
            text
        };
        let device = if case == "other_output_device" {
            "Media player"
        } else {
            "Meeting Tap"
        };
        let input = case == "other_direction";
        let engine = if case == "background_text_is_not_live_provenance" {
            "Parakeet"
        } else {
            "live"
        };
        audio(
            &db,
            correct,
            time,
            candidate_text,
            device,
            input,
            engine,
            None,
            3.0,
        )
        .await;
        if matches!(case, "conflicting_exact_mirrors" | "agreeing_exact_mirrors") {
            let other = if case == "conflicting_exact_mirrors" {
                wrong
            } else {
                correct
            };
            audio(
                &db,
                other,
                base,
                text,
                "Meeting Tap",
                false,
                "live",
                None,
                3.0,
            )
            .await;
        }
        if case == "human_assignment_survives" {
            sqlx::query(
                "UPDATE meeting_transcript_segments SET speaker_id = ?1 WHERE meeting_id = ?2",
            )
            .bind(wrong)
            .bind(meeting)
            .execute(&db.pool)
            .await
            .unwrap();
        }
        let updated = db
            .backfill_meeting_segment_speakers(base - Duration::hours(1), 15.0)
            .await
            .unwrap();
        let actual: Option<i64> = sqlx::query_scalar("SELECT speaker_id FROM meeting_transcript_segments WHERE meeting_id = ?1 AND item_id = 'turn'")
            .bind(meeting).fetch_one(&db.pool).await.unwrap();
        let expected = should_assign.then_some(if case == "human_assignment_survives" {
            wrong
        } else {
            correct
        });
        let passed = actual == expected;
        if !passed {
            failures.push(case);
        }
        if actual.is_some() && actual != expected {
            false_assignments += 1;
        }
        if expected.is_some() && actual.is_none() {
            missed_assignments += 1;
        }
        let again = db
            .backfill_meeting_segment_speakers(base - Duration::hours(1), 15.0)
            .await
            .unwrap();
        assert_eq!(again, 0, "{case}: backfill must be idempotent");
        assert_eq!(
            db.count_meeting_transcript_segments(meeting).await.unwrap(),
            if case == "ambiguous_stream_mirror" {
                2
            } else {
                1
            },
            "{case}: preserve captured evidence"
        );
        println!(
            "{}",
            json!({"eval":"speaker_backfill","case":case,"passed":passed,"updated":updated,"expected":expected,"actual":actual})
        );
    }
    println!(
        "{}",
        json!({"eval":"speaker_backfill_summary","cases":cases.len(),"passed":cases.len()-failures.len(),"false_assignments":false_assignments,"missed_assignments":missed_assignments})
    );
    assert!(
        failures.is_empty(),
        "speaker backfill failures: {failures:?}"
    );
}

#[tokio::test]
async fn speaker_identity_autoname_eval() {
    let cases = [
        ("single_clean_input", true),
        ("live_input_only", false),
        ("remote_voice_on_microphone", false),
        ("two_input_people", false),
        ("already_named_owner_and_new_voice", false),
        ("old_input_only", false),
        ("meeting_input_only", false),
        ("many_rows_one_chunk", false),
        ("short_backchannels_only", false),
    ];
    let mut failures = Vec::new();
    let mut false_assignments = 0;
    let mut missed_assignments = 0;
    for (case, should_assign) in cases {
        let db = db().await;
        let base = if case == "old_input_only" {
            Utc::now() - Duration::days(10)
        } else {
            Utc::now() - Duration::minutes(5)
        };
        let candidate = db.insert_speaker(&[1.0f32; 512]).await.unwrap().id;
        let mut shared_chunk = None;
        for i in 0..10 {
            let chunk = audio(
                &db,
                candidate,
                base + Duration::seconds(i * 10),
                &format!("Clean phrase {i}"),
                "Microphone",
                true,
                if case == "live_input_only" {
                    "live"
                } else {
                    "Parakeet"
                },
                shared_chunk,
                if case == "short_backchannels_only" {
                    0.2
                } else {
                    3.0
                },
            )
            .await;
            if case == "many_rows_one_chunk" {
                shared_chunk = Some(chunk);
            }
        }
        if case == "remote_voice_on_microphone" {
            audio(
                &db,
                candidate,
                base,
                "Remote voice",
                "System Audio",
                false,
                "Parakeet",
                None,
                3.0,
            )
            .await;
        }
        if matches!(
            case,
            "two_input_people" | "already_named_owner_and_new_voice"
        ) {
            let other = db.insert_speaker(&[0.5f32; 512]).await.unwrap().id;
            if case == "already_named_owner_and_new_voice" {
                db.update_speaker_name(other, "Local user").await.unwrap();
            }
            audio(
                &db,
                other,
                base,
                "Another person",
                "Microphone",
                true,
                "Parakeet",
                None,
                3.0,
            )
            .await;
        }
        if case == "meeting_input_only" {
            let mid = db.insert_meeting("Zoom", "test", None, None).await.unwrap();
            sqlx::query("UPDATE meetings SET meeting_start = ?1, meeting_end = ?2 WHERE id = ?3")
                .bind(base - Duration::seconds(1))
                .bind(base + Duration::minutes(5))
                .bind(mid)
                .execute(&db.pool)
                .await
                .unwrap();
        }
        let actual = db.get_dominant_unnamed_input_speaker(10).await.unwrap();
        let expected = should_assign.then_some(candidate);
        let passed = actual == expected;
        if !passed {
            failures.push(case);
        }
        if actual.is_some() && actual != expected {
            false_assignments += 1;
        }
        if expected.is_some() && actual.is_none() {
            missed_assignments += 1;
        }
        println!(
            "{}",
            json!({"eval":"speaker_autoname","case":case,"passed":passed,"expected":expected,"actual":actual})
        );
    }
    println!(
        "{}",
        json!({"eval":"speaker_autoname_summary","cases":cases.len(),"passed":cases.len()-failures.len(),"false_assignments":false_assignments,"missed_assignments":missed_assignments})
    );
    assert!(
        failures.is_empty(),
        "speaker autoname failures: {failures:?}"
    );
}

#[tokio::test]
async fn speaker_identity_chunk_backfill_eval() {
    let cases = [
        "single_unassigned",
        "existing_assignment",
        "mixed_live_speakers",
        "single_live_speaker",
        "reconnected_streams",
        "unmirrored_live",
        "unknown_live_label",
        "confirmed_meeting_identity",
        "partly_confirmed_same_identity",
        "overlapping_diarization",
        "conflicting_diarization",
        "multiple_provider_labels",
        "agreeing_diarization",
    ];
    let mut failures = Vec::new();
    for case in cases {
        let db = db().await;
        let base = Utc::now();
        let inferred = db.create_speaker_with_name("Inferred").await.unwrap().id;
        let confirmed = db.create_speaker_with_name("Confirmed").await.unwrap().id;
        let chunk = audio(
            &db,
            confirmed,
            base,
            "First turn",
            "Meeting Tap",
            false,
            "live",
            None,
            3.0,
        )
        .await;
        if case != "existing_assignment" {
            sqlx::query(
                "UPDATE audio_transcriptions SET speaker_id = NULL WHERE audio_chunk_id = ?1",
            )
            .bind(chunk)
            .execute(&db.pool)
            .await
            .unwrap();
        }
        if case == "single_unassigned" {
            sqlx::query("UPDATE audio_transcriptions SET transcription_engine = 'Parakeet' WHERE audio_chunk_id = ?1")
                .bind(chunk).execute(&db.pool).await.unwrap();
        } else {
            let meeting = db.insert_meeting("Meet", "test", None, None).await.unwrap();
            for i in 0..2 {
                let text = if i == 0 { "First turn" } else { "Second turn" };
                let t = base + Duration::seconds(i * 5);
                if i == 1 {
                    audio(
                        &db,
                        confirmed,
                        t,
                        text,
                        "Meeting Tap",
                        false,
                        "live",
                        Some(chunk),
                        3.0,
                    )
                    .await;
                    sqlx::query("UPDATE audio_transcriptions SET speaker_id = NULL WHERE audio_chunk_id = ?1 AND transcription = 'Second turn'")
                        .bind(chunk).execute(&db.pool).await.unwrap();
                }
                let different = i == 1 && case == "mixed_live_speakers";
                let stream = if i == 1 && case == "reconnected_streams" {
                    "new-stream"
                } else {
                    "first-stream"
                };
                let identity = if different { "speaker-b" } else { "speaker-a" };
                db.insert_meeting_transcript_segment_with_identity(
                    meeting,
                    "test",
                    None,
                    &format!("turn-{i}"),
                    "Meeting Tap",
                    "output",
                    stream,
                    Some(identity),
                    Some(identity),
                    text,
                    t,
                )
                .await
                .unwrap();
            }
        }
        if case == "unmirrored_live" {
            sqlx::query("DELETE FROM meeting_transcript_segments")
                .execute(&db.pool)
                .await
                .unwrap();
        }
        if case == "partly_confirmed_same_identity" {
            sqlx::query(
                "UPDATE meeting_transcript_segments SET speaker_id = ?1 WHERE item_id = 'turn-0'",
            )
            .bind(inferred)
            .execute(&db.pool)
            .await
            .unwrap();
        }
        if case == "confirmed_meeting_identity" {
            sqlx::query("UPDATE meeting_transcript_segments SET speaker_id = ?1")
                .bind(confirmed)
                .execute(&db.pool)
                .await
                .unwrap();
        }
        if case == "unknown_live_label" {
            sqlx::query("UPDATE meeting_transcript_segments SET session_speaker_id = NULL, speaker_name = NULL").execute(&db.pool).await.unwrap();
        }
        if matches!(
            case,
            "overlapping_diarization"
                | "conflicting_diarization"
                | "multiple_provider_labels"
                | "agreeing_diarization"
        ) {
            let run = sqlx::query("INSERT INTO diarization_runs(audio_chunk_id, mode, provider) VALUES (?1, 'background', 'eval')")
                .bind(chunk).execute(&db.pool).await.unwrap().last_insert_rowid();
            for i in 0..2 {
                sqlx::query("INSERT INTO diarization_segments(diarization_run_id, audio_chunk_id, provider_speaker_label, speaker_id, start_time, end_time, overlap) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
                    .bind(run).bind(chunk)
                    .bind(if case == "multiple_provider_labels" && i == 1 { "b" } else { "a" })
                    .bind(if case == "conflicting_diarization" { confirmed } else { inferred })
                    .bind(i as f64 * 5.0).bind(i as f64 * 5.0 + 3.0)
                    .bind(case == "overlapping_diarization").execute(&db.pool).await.unwrap();
            }
        }
        db.update_transcriptions_speaker(chunk, inferred)
            .await
            .unwrap();
        let actual: Vec<Option<i64>> = sqlx::query_scalar(
            "SELECT speaker_id FROM audio_transcriptions WHERE audio_chunk_id = ?1 ORDER BY id",
        )
        .bind(chunk)
        .fetch_all(&db.pool)
        .await
        .unwrap();
        let expected = match case {
            "single_unassigned" => vec![Some(inferred)],
            "single_live_speaker" | "agreeing_diarization" | "partly_confirmed_same_identity" => {
                vec![Some(inferred), Some(inferred)]
            }
            "existing_assignment" => vec![Some(confirmed), None],
            _ => vec![None, None],
        };
        let passed = actual == expected;
        if !passed {
            failures.push(case);
        }
        println!(
            "{}",
            json!({"eval":"speaker_chunk_backfill","case":case,"passed":passed,"expected":expected,"actual":actual})
        );
    }
    println!(
        "{}",
        json!({"eval":"speaker_chunk_backfill_summary","cases":cases.len(),"passed":cases.len()-failures.len()})
    );
    assert!(
        failures.is_empty(),
        "speaker chunk backfill failures: {failures:?}"
    );
}

/// Unknown recent turns must not permanently hide older, resolvable turns.
/// Exercise a backlog and a concurrent capture write at the production boundary.
#[tokio::test]
async fn speaker_identity_backfill_progress_eval() {
    let db = db().await;
    let base = Utc::now() - Duration::days(1);
    let speaker = db.create_speaker_with_name("Known voice").await.unwrap().id;
    let meeting = db.insert_meeting("Meet", "test", None, None).await.unwrap();
    let chunk = db
        .insert_audio_chunk("Meeting Tap (output)_backlog.mp4", Some(base))
        .await
        .unwrap();
    sqlx::query(
        "WITH RECURSIVE seq(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM seq WHERE x < 20600)
         INSERT INTO meeting_transcript_segments
             (meeting_id, provider, item_id, device_name, device_type, transcript, captured_at, speaker_name)
         SELECT ?1, 'test', printf('backlog-%d', x), 'Meeting Tap', 'output', printf('turn %d', x),
                strftime('%Y-%m-%dT%H:%M:%f+00:00', ?2, printf('+%d seconds', x)), 'speaker 1'
         FROM seq",
    ).bind(meeting).bind(base).execute(&db.pool).await.unwrap();
    sqlx::query(
        "INSERT INTO audio_transcriptions
             (audio_chunk_id, offset_index, timestamp, transcription, device, is_input_device, speaker_id, transcription_engine)
         SELECT ?1, id, captured_at, transcript, device_name, 0, ?2, 'live'
         FROM meeting_transcript_segments WHERE meeting_id = ?3 ORDER BY captured_at LIMIT 600",
    ).bind(chunk).bind(speaker).bind(meeting).execute(&db.pool).await.unwrap();

    let started = std::time::Instant::now();
    let (mapped, captured) = tokio::time::timeout(std::time::Duration::from_secs(3), async {
        tokio::join!(
            db.backfill_meeting_segment_speakers(base, 15.0),
            db.insert_audio_chunk("continued_capture.mp4", Some(Utc::now())),
        )
    })
    .await
    .expect("identity backlog must not stall capture writes for seconds");
    let mapped = mapped.unwrap();
    let captured = captured.unwrap();
    println!(
        "{}",
        json!({"eval":"speaker_backfill_progress","first_pass":mapped,"expected":500,"seconds":started.elapsed().as_secs_f64()})
    );
    assert_eq!(
        mapped, 500,
        "skip unresolved recent turns and fill eligible older turns"
    );
    assert_eq!(
        db.backfill_meeting_segment_speakers(base, 15.0)
            .await
            .unwrap(),
        100
    );
    assert_eq!(
        db.backfill_meeting_segment_speakers(base, 15.0)
            .await
            .unwrap(),
        0
    );
    let unknown: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM meeting_transcript_segments WHERE meeting_id = ?1 AND speaker_id IS NULL")
        .bind(meeting).fetch_one(&db.pool).await.unwrap();
    assert_eq!(
        unknown, 20000,
        "preserve uncertainty and captured transcripts"
    );
    let durable: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audio_chunks WHERE id = ?1 AND file_path = 'continued_capture.mp4'",
    )
    .bind(captured)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(durable, 1);
}
