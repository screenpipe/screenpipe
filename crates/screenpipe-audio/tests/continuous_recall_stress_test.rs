// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Seeded, synthetic retention evaluations against the real consumer and SQLite
//! search. No microphone, credentials or private recordings are used. Large
//! sweeps are manual so ordinary CI does not pay for thousands of inserts.
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
use std::{collections::BTreeMap, sync::Arc};

#[derive(Clone)]
struct Segment {
    text: String,
    file: String,
    device: String,
    output: bool,
    at: u64,
    start: f64,
    end: f64,
    error: Option<String>,
}

fn segment(text: &str, file: &str, at: u64, start: f64, end: f64) -> Segment {
    Segment {
        text: text.into(),
        file: file.into(),
        device: "duplex".into(),
        output: false,
        at,
        start,
        end,
        error: None,
    }
}

fn result(s: &Segment, root: &std::path::Path) -> TranscriptionResult {
    TranscriptionResult {
        path: root.join(&s.file).to_string_lossy().into_owned(),
        input: AudioInput {
            data: Arc::new(vec![]),
            sample_rate: 16000,
            channels: 1,
            device: Arc::new(AudioDevice::new(
                s.device.clone(),
                if s.output {
                    DeviceType::Output
                } else {
                    DeviceType::Input
                },
            )),
            capture_timestamp: s.at,
        },
        speaker_embedding: vec![],
        transcription: Some(s.text.clone()),
        timestamp: s.at,
        error: s.error.clone(),
        start_time: s.start,
        end_time: s.end,
        diarization_provider: None,
        diarization_segments: vec![],
    }
}

async fn replay(segments: &[Segment], engine: AudioTranscriptionEngine) -> Vec<String> {
    let dir = tempfile::tempdir().unwrap();
    let db = Arc::new(
        DatabaseManager::new(
            dir.path().join("eval.sqlite").to_str().unwrap(),
            Default::default(),
        )
        .await
        .unwrap(),
    );
    // Captured chunks already exist independently of recognition success.
    for s in segments {
        db.get_or_insert_audio_chunk(
            &dir.path().join(&s.file).to_string_lossy(),
            chrono::DateTime::from_timestamp(s.at as i64, 0),
        )
        .await
        .unwrap();
    }
    let (tx, rx) = flume::unbounded();
    for s in segments {
        tx.send(result(s, dir.path())).unwrap();
    }
    drop(tx);
    handle_new_transcript(
        db.clone(),
        Arc::new(rx),
        Arc::new(engine),
        "batch",
        false,
        Arc::new(AudioPipelineMetrics::new()),
        None,
        dir.path().into(),
    )
    .await;
    let mut text = vec![];
    let mut offset = 0;
    loop {
        let rows = db
            .search_audio_ordered(
                "",
                100,
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
            .unwrap();
        let count = rows.len();
        text.extend(rows.into_iter().map(|r| r.transcription));
        offset += count as u32;
        if count < 100 {
            break;
        }
    }
    text
}

fn counts(texts: &[String]) -> BTreeMap<String, usize> {
    let mut counts = BTreeMap::new();
    for text in texts {
        *counts.entry(text.trim().to_owned()).or_default() += 1;
    }
    counts
}

#[tokio::test]
async fn separate_cross_device_utterances_with_matching_words_survive() {
    let text = "Please send the complete proposal tomorrow.";
    let first = segment(text, "first.wav", 1_700_000_000, 0.0, 5.0);
    let mut second = segment(text, "second.wav", 1_700_000_000, 15.0, 20.0);
    second.output = true;
    assert_eq!(
        replay(
            &[first, second],
            AudioTranscriptionEngine::WhisperLargeV3TurboQuantized
        )
        .await,
        [text, text],
        "different speech intervals are not an echo even when chunk timestamps match"
    );
}

// Each category has independently specified expected transcript rows, rather
// than reimplementing the dedup algorithm as its own oracle.
fn corpus(repetitions: usize) -> (Vec<Segment>, Vec<String>) {
    let mut inputs = vec![];
    let mut expected = vec![];
    let mut seed = 0x5eed_u64;
    for i in 0..repetitions * 12 {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
        let at = 1_700_000_000 + i as u64 * 120;
        let value = 100 + seed % 900;
        let prior = format!("For case{i} please order {value} chairs tomorrow.");
        let changed = format!("For case{i} please order {} desks tomorrow.", value + 1);
        let tail = format!("Include appendix case{i}.");
        let prefix = format!("{value} chairs tomorrow.");
        let mut a = segment(&prior, &format!("{i}-a.wav"), at, 0.0, 10.0);
        let mut b = segment(&changed, &format!("{i}-b.wav"), at + 30, 0.0, 10.0);
        match i % 12 {
            0 => {
                expected.extend([prior, changed]);
            }
            1 => {
                b.at = at + 5;
                expected.extend([prior, changed]);
            }
            2 => {
                b.at = at + 5;
                b.text = format!("{prefix} {tail}");
                expected.extend([prior, tail]);
            }
            3 => {
                b.at = at + 10;
                b.text = format!("{prefix} {tail}");
                expected.extend([prior, b.text.clone()]);
            }
            4 => {
                b.output = true;
                b.at = at;
                b.text = prior.clone();
                expected.push(prior);
            }
            5 => {
                b.output = true;
                b.at = at;
                b.start = 15.0;
                b.end = 20.0;
                b.text = prior.clone();
                expected.extend([prior.clone(), prior]);
            }
            6 => {
                b.file = a.file.clone();
                b.at = at;
                b.start = 10.0;
                b.end = 20.0;
                expected.extend([prior, changed]);
            }
            7 => {
                b.text = prior.clone();
                expected.extend([prior.clone(), prior]);
            }
            8 => {
                b.at = at - 30;
                expected.extend([prior, changed]);
            }
            9 => {
                a.error = Some("injected recognition failure".into());
                b.at = at + 5;
                b.text = format!("{prefix} {tail}");
                expected.push(b.text.clone());
            }
            10 => {
                a.text = " ".into();
                expected.push(changed);
            }
            11 => {
                b.device = "second microphone".into();
                b.at = at + 5;
                expected.extend([prior, changed]);
            }
            _ => unreachable!(),
        }
        inputs.extend([a, b]);
    }
    (inputs, expected)
}

#[tokio::test]
#[ignore = "manual multi-day replay, thousands of actual SQLite writes"]
async fn seeded_multi_day_retention_eval() {
    let repetitions = std::env::var("SCREENPIPE_RECALL_REPETITIONS")
        .ok()
        .map(|v| v.parse().unwrap())
        .unwrap_or(128);
    let (inputs, expected) = corpus(repetitions);
    let wanted = counts(&expected);
    let mut reports = vec![];
    for engine in [
        AudioTranscriptionEngine::WhisperLargeV3TurboQuantized,
        AudioTranscriptionEngine::Parakeet,
    ] {
        let start = std::time::Instant::now();
        let actual = counts(&replay(&inputs, engine.clone()).await);
        let missing: usize = wanted
            .iter()
            .map(|(text, count)| count.saturating_sub(*actual.get(text).unwrap_or(&0)))
            .sum();
        let unexpected: usize = actual
            .iter()
            .map(|(text, count)| count.saturating_sub(*wanted.get(text).unwrap_or(&0)))
            .sum();
        reports.push(serde_json::json!({"engine_label":engine.to_string(), "seed":"0x5eed", "cases":repetitions*12, "submitted_segments":inputs.len(), "expected_rows":expected.len(), "missing_occurrences":missing, "unexpected_rows":unexpected, "elapsed_ms":start.elapsed().as_millis()}));
    }
    eprintln!("LARGE_RECALL_EVAL {}", serde_json::json!(reports));
    if let Ok(path) = std::env::var("SCREENPIPE_RECALL_STRESS_RECEIPT") {
        std::fs::write(path, serde_json::to_vec_pretty(&reports).unwrap()).unwrap();
    }
    assert!(
        reports
            .iter()
            .all(|r| r["missing_occurrences"] == 0 && r["unexpected_rows"] == 0),
        "large replay lost speech or retained an unexpected echo: {reports:?}"
    );
}

#[test]
fn seeded_boundary_cleanup_properties() {
    let root = std::path::Path::new("/synthetic");
    for i in 0..10_000 {
        let suffix = format!("confirm order {i} tomorrow");
        let prior = format!("Please {suffix}");
        let novel = format!("Keep detail {}.", i + 1);
        let mut current = result(
            &segment(&format!("{suffix} {novel}"), "test", 0, 0.0, 10.0),
            root,
        );
        assert_eq!(
            current.cleanup_overlap(prior.clone()),
            Some((prior.clone(), novel))
        );
        current.transcription = Some(format!("Do not confirm order {i} tomorrow"));
        assert!(
            current.cleanup_overlap(prior).is_none(),
            "a negation must survive"
        );
    }
    eprintln!("PROPERTY_RECALL_EVAL {{\"seed\":\"enumerated\",\"cases\":20000,\"passed\":20000}}");
}

#[tokio::test]
#[ignore = "manual cached Silero/Whisper acoustic eval; requires two synthetic WAVs"]
async fn acoustic_vad_and_whisper_retention_eval() {
    use screenpipe_audio::{
        speaker::{embedding_manager::EmbeddingManager, prepare_segments},
        transcription::whisper::{
            batch::process_with_whisper,
            model::{create_whisper_context_parameters_with_gpu, get_cached_whisper_model_path},
        },
        vad::{silero::SileroVad, VadEngine},
    };
    use std::sync::Mutex as StdMutex;
    use tokio::sync::Mutex;
    fn read_wav(variable: &str) -> Vec<f32> {
        let mut wav = hound::WavReader::open(std::env::var(variable).unwrap()).unwrap();
        assert_eq!((wav.spec().sample_rate, wav.spec().channels), (16000, 1));
        wav.samples::<i16>()
            .map(|x| x.unwrap() as f32 / 32768.0)
            .collect()
    }
    let sentence = read_wav("SCREENPIPE_RECALL_SENTENCE_WAV");
    let short = read_wav("SCREENPIPE_RECALL_SHORT_WAV");
    let vad_cache = dirs::cache_dir()
        .unwrap()
        .join("screenpipe/vad/silero_vad_v5.onnx");
    assert!(
        vad_cache.exists(),
        "cached Silero required; do not download"
    );
    let engine = Arc::new(AudioTranscriptionEngine::WhisperLargeV3TurboQuantized);
    let model =
        get_cached_whisper_model_path(&engine).expect("cached Whisper required; do not download");
    let context = whisper_rs::WhisperContext::new_with_params(
        &model,
        create_whisper_context_parameters_with_gpu(engine, false).unwrap(),
    )
    .unwrap();
    let mut state = context.create_state().unwrap();
    let mut reports = Vec::new();
    for (source_name, source) in [
        ("sentence", &sentence),
        ("single_word", &short),
        ("silence", &Vec::new()),
    ] {
        for position in [0, 12, 24] {
            for gain in [1.0_f32, 0.05] {
                for noise in [0.0_f32, 0.01, 0.05] {
                    for output in [false, true] {
                        let mut pcm = vec![0.0_f32; 30 * 16000];
                        let mut seed = 0x5eed_u64;
                        for sample in &mut pcm {
                            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
                            *sample = ((seed >> 32) as f32 / u32::MAX as f32 * 2.0 - 1.0) * noise;
                        }
                        for (i, sample) in source.iter().enumerate() {
                            if let Some(dest) = pcm.get_mut(position * 16000 + i) {
                                *dest = (*dest + sample * gain).clamp(-1.0, 1.0);
                            }
                        }
                        let vad: Arc<Mutex<Box<dyn VadEngine + Send>>> =
                            Arc::new(Mutex::new(Box::new(SileroVad::new().await.unwrap())));
                        let (mut segments, admitted, ratio) = prepare_segments(
                            &pcm,
                            vad,
                            None,
                            Arc::new(StdMutex::new(EmbeddingManager::new(1))),
                            None,
                            "synthetic",
                            output,
                            false,
                        )
                        .await
                        .unwrap();
                        // Acoustic recognition is deliberately limited to six
                        // sentence conditions; the full 108-case grid scores VAD.
                        let run_stt =
                            source_name == "sentence" && gain == 1.0 && !output && noise != 0.01;
                        let mut recognized = Vec::new();
                        if run_stt {
                            while let Some(s) = segments.recv().await {
                                recognized.push(
                                    process_with_whisper(
                                        &s.samples,
                                        vec![screenpipe_core::Language::English],
                                        &mut state,
                                        &[],
                                    )
                                    .await
                                    .unwrap(),
                                );
                            }
                        }
                        let mut stored = Vec::new();
                        if !recognized.is_empty() {
                            let items: Vec<_> = recognized
                                .iter()
                                .enumerate()
                                .map(|(i, t)| {
                                    segment(
                                        t,
                                        &format!("acoustic-{i}.wav"),
                                        1_700_000_000 + i as u64 * 30,
                                        0.0,
                                        30.0,
                                    )
                                })
                                .collect();
                            stored = replay(
                                &items,
                                AudioTranscriptionEngine::WhisperLargeV3TurboQuantized,
                            )
                            .await;
                            assert_eq!(
                                counts(&recognized),
                                counts(&stored),
                                "recognized acoustic content must survive storage"
                            );
                        }
                        let report = serde_json::json!({"source":source_name,"position_seconds":position,"gain":gain,"noise_peak":noise,"output_device":output,"vad_admitted":admitted,"speech_ratio":ratio,"stt_ran":run_stt && admitted,"recognized":recognized,"stored":stored});
                        eprintln!("ACOUSTIC_RECALL_EVAL {report}");
                        reports.push(report);
                    }
                }
            }
        }
    }
    if let Ok(path) = std::env::var("SCREENPIPE_RECALL_ACOUSTIC_RECEIPT") {
        std::fs::write(path, serde_json::to_vec_pretty(&reports).unwrap()).unwrap();
    }
    assert!(
        reports
            .iter()
            .filter(|r| r["source"] == "sentence" && r["noise_peak"] == 0.0)
            .all(|r| r["vad_admitted"] == true),
        "clean full sentences must reach recognition"
    );
    assert!(
        reports
            .iter()
            .filter(|r| r["source"] == "silence" && r["noise_peak"] == 0.0)
            .all(|r| r["vad_admitted"] == false),
        "true silence must not be recognized as speech"
    );
}

#[tokio::test]
#[ignore = "manual short-speech diagnosis with cached Silero and Whisper"]
async fn short_speech_padding_diagnosis() {
    use screenpipe_audio::{
        speaker::{embedding_manager::EmbeddingManager, prepare_segments},
        transcription::whisper::{
            batch::process_with_whisper,
            model::{create_whisper_context_parameters_with_gpu, get_cached_whisper_model_path},
        },
        vad::{silero::SileroVad, VadEngine},
    };
    use std::sync::Mutex as StdMutex;
    use tokio::sync::Mutex;
    let mut wav =
        hound::WavReader::open(std::env::var("SCREENPIPE_RECALL_SHORT_WAV").unwrap()).unwrap();
    assert_eq!((wav.spec().sample_rate, wav.spec().channels), (16000, 1));
    let samples: Vec<f32> = wav
        .samples::<i16>()
        .map(|s| s.unwrap() as f32 / 32768.0)
        .collect();
    assert!(dirs::cache_dir()
        .unwrap()
        .join("screenpipe/vad/silero_vad_v5.onnx")
        .exists());
    let engine = Arc::new(AudioTranscriptionEngine::WhisperLargeV3TurboQuantized);
    let model = get_cached_whisper_model_path(&engine).expect("cached model required");
    let context = whisper_rs::WhisperContext::new_with_params(
        &model,
        create_whisper_context_parameters_with_gpu(engine, false).unwrap(),
    )
    .unwrap();
    let mut state = context.create_state().unwrap();
    let mut report = vec![];
    for seconds in [5, 10, 15, 30, 60] {
        let mut pcm = vec![0.0; seconds * 16000];
        pcm[..samples.len()].copy_from_slice(&samples);
        let vad: Arc<Mutex<Box<dyn VadEngine + Send>>> =
            Arc::new(Mutex::new(Box::new(SileroVad::new().await.unwrap())));
        let (_, admitted, ratio) = prepare_segments(
            &pcm,
            vad,
            None,
            Arc::new(StdMutex::new(EmbeddingManager::new(1))),
            None,
            "synthetic",
            false,
            false,
        )
        .await
        .unwrap();
        // Bypass the VAD gate in two explicit controls to separate an admission
        // miss from the recognition model being unable to recognize the word.
        let recognized = if seconds == 5 || seconds == 30 {
            Some(
                process_with_whisper(
                    &pcm,
                    vec![screenpipe_core::Language::English],
                    &mut state,
                    &[],
                )
                .await
                .unwrap(),
            )
        } else {
            None
        };
        report.push(serde_json::json!({"chunk_seconds":seconds,"speech_seconds":samples.len()as f64/16000.0,"speech_ratio":ratio,"vad_admitted":admitted,"whisper_bypassing_vad":recognized}));
    }
    eprintln!("SHORT_SPEECH_DIAGNOSIS {}", serde_json::json!(report));
    std::fs::write(
        std::env::var("SCREENPIPE_RECALL_PADDING_RECEIPT").unwrap(),
        serde_json::to_vec_pretty(&report).unwrap(),
    )
    .unwrap();
    // This is a diagnostic receipt, not a test claiming all short speech is
    // captured. Preserve the unresolved false negatives in the report.
}
