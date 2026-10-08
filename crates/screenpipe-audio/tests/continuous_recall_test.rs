// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use screenpipe_audio::{
    core::{
        device::{AudioDevice, DeviceType},
        engine::AudioTranscriptionEngine,
    },
    metrics::AudioPipelineMetrics,
    transcription::handle_new_transcript,
    AudioInput, TranscriptionResult,
};
use screenpipe_db::{DatabaseManager, Order};
use std::sync::Arc;

async fn replay(texts: &[&str]) -> Vec<String> {
    let windows: Vec<_> = (0..texts.len())
        .map(|i| (i as u64 * 30, 0.0, 30.0))
        .collect();
    replay_windows(texts, &windows).await
}

async fn replay_windows(texts: &[&str], windows: &[(u64, f64, f64)]) -> Vec<String> {
    let dir = tempfile::tempdir().unwrap();
    let db = Arc::new(
        DatabaseManager::new(
            dir.path().join("recall.sqlite").to_str().unwrap(),
            Default::default(),
        )
        .await
        .unwrap(),
    );
    let (tx, rx) = flume::unbounded();
    // Old capture timestamps deliberately remove the recent-DB-dedup variable.
    let base = chrono::Utc::now().timestamp() as u64 - 3600;
    for (i, text) in texts.iter().enumerate() {
        let path = dir
            .path()
            .join(format!("chunk-{}.mp4", windows[i].0))
            .to_string_lossy()
            .into_owned();
        let timestamp = base + windows[i].0;
        tx.send(TranscriptionResult {
            path,
            input: AudioInput {
                data: Arc::new(vec![]),
                sample_rate: 16000,
                channels: 1,
                device: Arc::new(AudioDevice::new("Synthetic mic".into(), DeviceType::Input)),
                capture_timestamp: timestamp,
            },
            speaker_embedding: vec![],
            transcription: Some(text.to_string()),
            timestamp,
            error: None,
            start_time: windows[i].1,
            end_time: windows[i].2,
            diarization_provider: None,
            diarization_segments: vec![],
        })
        .unwrap();
    }
    drop(tx);
    handle_new_transcript(
        db.clone(),
        Arc::new(rx),
        Arc::new(AudioTranscriptionEngine::WhisperLargeV3TurboQuantized),
        "batch",
        false,
        Arc::new(AudioPipelineMetrics::new()),
        None,
        dir.path().to_path_buf(),
    )
    .await;
    let mut rows = Vec::new();
    for offset in [0, 20, 40] {
        rows.extend(
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
    rows.into_iter().map(|r| r.transcription).collect()
}

#[tokio::test]
async fn different_non_overlapping_sentences_survive_real_transcript_handler() {
    let original = [
        "Order twelve chairs for the workshop.",
        "Order twenty desks for the office.",
    ];
    let actual = replay(&original).await;
    eprintln!("original={original:?}; stored={actual:?}");
    assert_eq!(
        actual, original,
        "sharing an ordinary word is not overlapping audio"
    );
}

#[tokio::test]
async fn twenty_five_facts_survive_real_transcript_handler() {
    let original: Vec<&str> = include_str!("fixtures/continuous-recall-checklist.txt")
        .lines()
        .collect();
    let actual = replay(&original).await;
    let preserved = original
        .iter()
        .filter(|s| actual.iter().any(|a| a == **s))
        .count();
    eprintln!("intact facts: {preserved}/25; output={actual:?}");
    assert_eq!(
        preserved, 25,
        "all original facts should survive independent non-overlapping speech chunks"
    );
}

#[tokio::test]
#[ignore = "manual local Whisper check; requires cached model and synthetic WAV"]
async fn synthetic_audio_through_whisper_and_transcript_handler() {
    use screenpipe_audio::transcription::whisper::{
        batch::process_with_whisper,
        model::{create_whisper_context_parameters_with_gpu, get_cached_whisper_model_path},
    };
    let wav_path = std::env::var("SCREENPIPE_RECALL_WAV").unwrap();
    let receipt_path = std::env::var("SCREENPIPE_RECALL_RECEIPT").unwrap();
    let engine = Arc::new(AudioTranscriptionEngine::WhisperLargeV3TurboQuantized);
    let model = get_cached_whisper_model_path(&engine).expect("cached model required; no download");
    let context = whisper_rs::WhisperContext::new_with_params(
        &model,
        create_whisper_context_parameters_with_gpu(engine, false).unwrap(),
    )
    .unwrap();
    let mut state = context.create_state().unwrap();
    let mut wav = hound::WavReader::open(wav_path).unwrap();
    assert_eq!(wav.spec().sample_rate, 16000);
    assert_eq!(wav.spec().channels, 1);
    let pcm: Vec<f32> = wav
        .samples::<i16>()
        .map(|x| x.unwrap() as f32 / 32768.0)
        .collect();
    let mut transcripts = Vec::new();
    for part in pcm.chunks(30 * 16000) {
        transcripts.push(
            process_with_whisper(
                part,
                vec![screenpipe_core::Language::English],
                &mut state,
                &[],
            )
            .await
            .unwrap(),
        );
    }
    let refs: Vec<&str> = transcripts.iter().map(String::as_str).collect();
    let stored = replay(&refs).await;
    std::fs::write(receipt_path,serde_json::to_vec_pretty(&serde_json::json!({"engine":"whisper-large-v3-turbo-quantized","backend":"CPU","chunk_seconds":30,"audio_seconds":pcm.len() as f64/16000.0,"recognized_chunks":transcripts,"stored_chunks":stored})).unwrap()).unwrap();
    assert!(!transcripts.is_empty());
    assert_eq!(
        stored.iter().map(|s| s.trim()).collect::<Vec<_>>(),
        transcripts.iter().map(|s| s.trim()).collect::<Vec<_>>(),
        "non-overlapping recognized chunks must retain their text"
    );
}

#[tokio::test]
async fn verified_boundary_overlap_keeps_one_complete_copy() {
    let original = [
        "We need twelve chairs for the workshop.",
        "chairs for the workshop. Invite Rowan tomorrow.",
    ];
    let actual = replay_windows(&original, &[(0, 0.0, 20.0), (15, 0.0, 20.0)]).await;
    assert_eq!(actual, [original[0], "Invite Rowan tomorrow."]);
}

#[tokio::test]
async fn shared_middle_words_in_overlapping_audio_do_not_delete_a_sentence() {
    let original = [
        "Order twelve chairs for the workshop.",
        "Order twenty desks for the office.",
    ];
    let actual = replay_windows(&original, &[(0, 0.0, 20.0), (15, 0.0, 20.0)]).await;
    assert_eq!(actual, original);
}

#[tokio::test]
async fn repeated_sentence_outside_overlap_is_preserved() {
    let original = [
        "Please send the complete proposal tomorrow.",
        "Please send the complete proposal tomorrow.",
    ];
    assert_eq!(replay(&original).await, original);
}

#[tokio::test]
async fn complete_duplicate_inside_overlap_is_suppressed() {
    let original = [
        "Please send the complete proposal tomorrow.",
        "Please send the complete proposal tomorrow.",
    ];
    assert_eq!(
        replay_windows(&original, &[(0, 0.0, 20.0), (0, 0.0, 20.0)]).await,
        [original[0]]
    );
}

#[tokio::test]
async fn later_segments_of_one_chunk_do_not_overlap_earlier_segments() {
    let original = [
        "Order twelve chairs for the workshop.",
        "Order twenty desks for the office.",
    ];
    assert_eq!(
        replay_windows(&original, &[(0, 0.0, 5.0), (0, 5.0, 10.0)]).await,
        original
    );
}

// A labeled evaluation against the production handler and paginated DB search.
// Both retain and suppress controls are needed: keeping everything would pass
// retention-only tests but regress genuine overlap removal.
#[tokio::test]
async fn boundary_retention_and_echo_eval_matrix() {
    let prior = "Send the complete proposal tomorrow.";
    let next = "the complete proposal tomorrow. Include the appendix.";
    let novel = "Include the appendix.";
    let cases = [
        ("true_overlap", (0, 0.0, 20.0), (15, 0.0, 20.0), novel),
        ("adjacent_chunks", (0, 0.0, 20.0), (20, 0.0, 20.0), next),
        ("separated_chunks", (0, 0.0, 20.0), (60, 0.0, 20.0), next),
        ("out_of_order", (30, 0.0, 20.0), (0, 0.0, 20.0), next),
        ("same_file_overlap", (0, 0.0, 20.0), (0, 15.0, 30.0), novel),
        ("same_file_adjacent", (0, 0.0, 15.0), (0, 15.0, 30.0), next),
        ("same_file_gap", (0, 0.0, 10.0), (0, 15.0, 30.0), next),
        ("unknown_current_end", (0, 0.0, 20.0), (15, 0.0, 0.0), next),
        ("reversed_current", (0, 0.0, 20.0), (15, 5.0, 1.0), next),
        (
            "nonfinite_current",
            (0, 0.0, 20.0),
            (15, 0.0, f64::INFINITY),
            next,
        ),
        (
            "nonfinite_previous",
            (0, 0.0, f64::INFINITY),
            (60, 0.0, 20.0),
            next,
        ),
        (
            "negative_infinite_previous_start",
            (0, f64::NEG_INFINITY, 20.0),
            (15, 0.0, 20.0),
            next,
        ),
    ];
    let mut failures = Vec::new();
    for (name, first_window, second_window, expected_second) in cases {
        let actual = replay_windows(&[prior, next], &[first_window, second_window]).await;
        let mut expected = vec![prior, expected_second];
        if first_window.0 > second_window.0 {
            expected.reverse();
        }
        let passed = actual == expected;
        eprintln!(
            "RECALL_EVAL {}",
            serde_json::json!({
                "case": name, "passed": passed, "expected": expected, "actual": actual
            })
        );
        if !passed {
            failures.push(name);
        }
    }
    assert!(failures.is_empty(), "boundary eval failures: {failures:?}");
}

#[tokio::test]
async fn vocabulary_retention_and_echo_eval_matrix() {
    let cases: &[(&str, &str, &str, &str)] = &[
        (
            "one_common_word",
            "Order chairs tomorrow.",
            "tomorrow. Buy desks.",
            "tomorrow. Buy desks.",
        ),
        (
            "two_common_words",
            "Please order chairs tomorrow.",
            "chairs tomorrow. Buy desks.",
            "chairs tomorrow. Buy desks.",
        ),
        (
            "three_boundary_words",
            "Please order chairs tomorrow.",
            "order chairs tomorrow. Buy desks.",
            "Buy desks.",
        ),
        (
            "case_only_echo",
            "Please order chairs tomorrow.",
            "ORDER CHAIRS TOMORROW. Buy desks.",
            "Buy desks.",
        ),
        (
            "changed_number",
            "Order exactly twelve chairs tomorrow.",
            "Order exactly twenty chairs tomorrow.",
            "Order exactly twenty chairs tomorrow.",
        ),
        (
            "negation",
            "Please approve the payment.",
            "Please do not approve the payment.",
            "Please do not approve the payment.",
        ),
        (
            "word_order",
            "Please ship from London to Paris.",
            "Please ship from Paris to London.",
            "Please ship from Paris to London.",
        ),
        (
            "interior_phrase",
            "We need twelve chairs for the workshop.",
            "We need twenty desks for the office.",
            "We need twenty desks for the office.",
        ),
        (
            "punctuation_mismatch_kept",
            "Please order chairs tomorrow.",
            "order chairs tomorrow! Buy desks.",
            "order chairs tomorrow! Buy desks.",
        ),
        (
            "non_latin_exact_echo",
            "明日 会議 の 準備 を お願いします。",
            "準備 を お願いします。 資料 も 必要です。",
            "資料 も 必要です。",
        ),
    ];
    let mut failures = Vec::new();
    for &(name, prior, next, expected_second) in cases {
        let actual = replay_windows(&[prior, next], &[(0, 0.0, 20.0), (15, 0.0, 20.0)]).await;
        let passed = actual == [prior, expected_second];
        eprintln!(
            "RECALL_EVAL {}",
            serde_json::json!({
                "case": name, "passed": passed, "expected": [prior, expected_second], "actual": actual
            })
        );
        if !passed {
            failures.push(name);
        }
    }
    assert!(
        failures.is_empty(),
        "vocabulary eval failures: {failures:?}"
    );
}
