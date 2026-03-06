use super::segment::get_segments;
use crate::{
    utils::audio::{
        average_noise_spectrum, filter_music_frames, normalize_v2, spectral_subtraction,
    },
    vad::VadEngine,
};
use anyhow::Result;
use std::{path::PathBuf, sync::Arc, sync::Mutex as StdMutex};
use tokio::sync::Mutex;
use tracing::{debug, error};
use vad_rs::VadStatus;

use super::{
    embedding::EmbeddingExtractor, embedding_manager::EmbeddingManager, segment::SpeechSegment,
};

pub async fn prepare_segments(
    audio_data: &[f32],
    vad_engine: Arc<Mutex<Box<dyn VadEngine + Send>>>,
    segmentation_model_path: &PathBuf,
    embedding_manager: Arc<StdMutex<EmbeddingManager>>,
    embedding_extractor: Arc<StdMutex<EmbeddingExtractor>>,
    device: &str,
    is_output_device: bool,
    filter_music: bool,
) -> Result<(tokio::sync::mpsc::Receiver<SpeechSegment>, bool, f32)> {
    let mut audio_data = normalize_v2(audio_data);

    if filter_music {
        filter_music_frames(&mut audio_data);
    }

    // Silero VAD v5 expects continuous 512-sample chunks at 16kHz (32ms).
    // On Windows, WASAPI delivers lower audio levels than CoreAudio, so we
    // must feed Silero at its native frame size to preserve its LSTM temporal
    // state — using 1600 caused 68ms gaps that broke speech detection.
    #[cfg(target_os = "windows")]
    let frame_size = 512;
    #[cfg(not(target_os = "windows"))]
    let frame_size = 1600;
    let vad_engine = vad_engine.clone();

    // Use a lower speech threshold for output/system audio devices.
    // System audio (YouTube, Zoom speaker output) often has background music
    // mixed with speech, reducing Silero's confidence below the default 0.5.
    if is_output_device {
        vad_engine
            .lock()
            .await
            .set_speech_threshold(Some(crate::vad::OUTPUT_SPEECH_THRESHOLD));
    }

    let mut noise = 0.;
    let mut audio_frames = Vec::new();
    let mut total_frames = 0;
    let mut speech_frame_count = 0;

    for chunk in audio_data.chunks(frame_size) {
        total_frames += 1;

        let mut new_chunk = chunk.to_vec();
        let status = vad_engine.lock().await.audio_type(chunk);
        match status {
            Ok(VadStatus::Speech) => {
                if let Ok(processed_audio) = spectral_subtraction(chunk, noise) {
                    new_chunk = processed_audio;
                    speech_frame_count += 1;
                }
            }
            Ok(VadStatus::Unknown) => {
                noise = average_noise_spectrum(chunk);
            }
            _ => {}
        }
        audio_frames.extend(new_chunk);
    }

    // Reset threshold to default after processing
    if is_output_device {
        vad_engine.lock().await.set_speech_threshold(None);
    }

    let speech_ratio = speech_frame_count as f32 / total_frames as f32;
    let current_min_ratio = crate::vad::min_speech_ratio();
    debug!(
        "device: {}, speech ratio: {}, min_speech_ratio: {}, audio_frames: {}, speech_frames: {}",
        device,
        speech_ratio,
        current_min_ratio,
        audio_frames.len(),
        speech_frame_count
    );

    let threshold_met = speech_ratio > current_min_ratio;

    let (tx, rx) = tokio::sync::mpsc::channel(100);
    if !audio_frames.is_empty() && threshold_met {
        let segments = get_segments(
            &audio_data,
            16000,
            segmentation_model_path,
            embedding_extractor,
            embedding_manager,
        )?;

        for segment in segments {
            match segment {
                Ok(segment) => {
                    if let Err(e) = tx.send(segment).await {
                        error!("failed to send segment: {:?}", e);
                        break;
                    }
                }
                Err(e) => {
                    error!("failed to get segment: {:?}", e);
                    return Err(e);
                }
            }
        }
    }

    Ok((rx, threshold_met, speech_ratio))
}
