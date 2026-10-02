// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use screenpipe_audio::speaker::{embedding_manager::EmbeddingManager, prepare_segments};
use screenpipe_audio::vad::{webrtc::WebRtcVad, VadEngine};
use std::sync::{Arc, Mutex};
use vad_rs::VadStatus;

// Model the native Silero window: samples beyond its first 512 never reach
// inference. Put a short cue in the portion the old macOS frame loop skipped.
struct WindowVad {
    seen: Arc<Mutex<Vec<Vec<f32>>>>,
}
impl VadEngine for WindowVad {
    fn is_voice_segment(&mut self, audio: &[f32]) -> anyhow::Result<bool> {
        Ok(matches!(self.audio_type(audio)?, VadStatus::Speech))
    }
    fn audio_type(&mut self, audio: &[f32]) -> anyhow::Result<VadStatus> {
        self.seen.lock().unwrap().push(audio.to_vec());
        Ok(if audio.iter().take(512).any(|x| x.abs() > 0.1) {
            VadStatus::Speech
        } else {
            VadStatus::Silence
        })
    }
    fn set_speech_threshold(&mut self, _: Option<f32>) {}
}

#[tokio::test]
async fn short_cue_between_native_windows_reaches_transcription() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let vad: Arc<tokio::sync::Mutex<Box<dyn VadEngine + Send>>> =
        Arc::new(tokio::sync::Mutex::new(Box::new(WindowVad {
            seen: seen.clone(),
        })));
    let mut audio = vec![0.0; 1601];
    for (i, sample) in audio[600..1000].iter_mut().enumerate() {
        *sample = if i % 2 == 0 { 0.5 } else { -0.5 };
    }
    let (mut segments, accepted, _) = prepare_segments(
        &audio,
        vad,
        None,
        Arc::new(Mutex::new(EmbeddingManager::new(4))),
        None,
        "synthetic microphone",
        false,
        false,
    )
    .await
    .unwrap();
    assert!(
        accepted,
        "a cue outside the first 512 samples must not be skipped"
    );
    let segment = segments
        .recv()
        .await
        .expect("retain the full audio for transcription");
    assert_eq!(segment.samples.len(), audio.len());
    assert!(segments.recv().await.is_none());
    let calls = seen.lock().unwrap();
    assert_eq!(calls.len(), 4);
    assert!(calls.iter().all(|call| call.len() == 512));
}

#[test]
fn webrtc_accepts_30ms_of_16khz_audio() {
    let mut vad = WebRtcVad::new();
    assert!(
        vad.audio_type(&[0.0; 480]).is_ok(),
        "fallback must use the pipeline's 16 kHz sample rate"
    );
}

struct CheckedWebRtc {
    inner: WebRtcVad,
    calls: Arc<Mutex<usize>>,
}
impl VadEngine for CheckedWebRtc {
    fn frame_size(&self) -> usize {
        self.inner.frame_size()
    }
    fn is_voice_segment(&mut self, audio: &[f32]) -> anyhow::Result<bool> {
        self.inner.is_voice_segment(audio)
    }
    fn audio_type(&mut self, audio: &[f32]) -> anyhow::Result<VadStatus> {
        assert_eq!(audio.len(), 480);
        let result = self.inner.audio_type(audio);
        assert!(
            result.is_ok(),
            "fallback must receive a supported frame, including the tail"
        );
        *self.calls.lock().unwrap() += 1;
        result
    }
    fn set_speech_threshold(&mut self, value: Option<f32>) {
        self.inner.set_speech_threshold(value)
    }
}

#[tokio::test]
async fn fallback_processes_a_partial_final_frame_without_invalid_length_errors() {
    let calls = Arc::new(Mutex::new(0));
    let vad: Arc<tokio::sync::Mutex<Box<dyn VadEngine + Send>>> =
        Arc::new(tokio::sync::Mutex::new(Box::new(CheckedWebRtc {
            inner: WebRtcVad::default(),
            calls: calls.clone(),
        })));
    let (mut segments, accepted, ratio) = prepare_segments(
        &[0.0; 1601],
        vad,
        None,
        Arc::new(Mutex::new(EmbeddingManager::new(4))),
        None,
        "synthetic microphone",
        false,
        false,
    )
    .await
    .unwrap();
    assert!(!accepted);
    assert_eq!(ratio, 0.0);
    assert!(segments.recv().await.is_none());
    assert_eq!(*calls.lock().unwrap(), 4);
}

/// Bounded native-model measurement on a public repository speech fixture.
/// Set VAD_SPEECH_FIXTURE to the Git LFS contents of test_data/accuracy1.wav.
/// Reports timing without a machine-dependent latency assertion.
#[tokio::test]
#[ignore = "requires the Silero model and a decoded Git LFS speech fixture"]
async fn native_silero_speech_continuity_cost() {
    use screenpipe_audio::vad::silero::SileroVad;
    use std::time::Instant;
    let path = std::env::var("VAD_SPEECH_FIXTURE").expect("set VAD_SPEECH_FIXTURE");
    let (audio, rate) = screenpipe_audio::pcm_decode(std::path::Path::new(&path)).unwrap();
    let mut audio = screenpipe_audio::resample(&audio, rate, 16000).unwrap();
    audio.truncate(30 * 16000);
    assert!(
        audio.len() >= 16000,
        "need at least one second of real audio"
    );
    let audio = screenpipe_audio::utils::audio::normalize_v2(&audio);
    SileroVad::ensure_model_available().await.unwrap();
    for frame_size in [1600, 512] {
        let mut vad = SileroVad::new().await.unwrap();
        let start = Instant::now();
        let mut speech = 0;
        for chunk in audio.chunks(frame_size) {
            speech += usize::from(matches!(vad.audio_type(chunk).unwrap(), VadStatus::Speech));
        }
        println!(
            "frame_size={frame_size} frames={} speech={speech} elapsed_ms={:.3}",
            audio.chunks(frame_size).len(),
            start.elapsed().as_secs_f64() * 1000.0
        );
        if frame_size == 512 {
            assert!(speech > 0, "native detector must recognize fixture speech");
        }
    }
    let vad: Arc<tokio::sync::Mutex<Box<dyn VadEngine + Send>>> = Arc::new(
        tokio::sync::Mutex::new(Box::new(SileroVad::new().await.unwrap())),
    );
    let start = Instant::now();
    let (mut segments, accepted, ratio) = prepare_segments(
        &audio,
        vad,
        None,
        Arc::new(Mutex::new(EmbeddingManager::new(4))),
        None,
        "public speech fixture",
        false,
        false,
    )
    .await
    .unwrap();
    println!(
        "prepare_segments audio_seconds={:.3} elapsed_ms={:.3} speech_ratio={ratio}",
        audio.len() as f64 / 16000.0,
        start.elapsed().as_secs_f64() * 1000.0
    );
    assert!(accepted);
    let segment = segments.recv().await.unwrap();
    assert_eq!(segment.samples.len(), audio.len());
}
