use crate::core::engine::AudioTranscriptionEngine;
use anyhow::Result;
use hf_hub::{api::sync::Api, Cache, Repo, RepoType};
use std::{path::PathBuf, sync::Arc};
use tracing::info;
use whisper_rs::WhisperContextParameters;

pub fn download_whisper_model(engine: Arc<AudioTranscriptionEngine>) -> Result<PathBuf> {
    let model_name = match *engine {
        AudioTranscriptionEngine::WhisperLargeV3Turbo => "ggml-large-v3-turbo.bin",
        AudioTranscriptionEngine::WhisperTiny => "ggml-tiny.bin",
        AudioTranscriptionEngine::WhisperTinyQuantized => "ggml-tiny-q8_0.bin",
        AudioTranscriptionEngine::WhisperLargeV3 => "ggml-large-v3.bin",
        AudioTranscriptionEngine::WhisperLargeV3Quantized => "ggml-large-v3-q5_0.bin",
        // Disabled still needs a model loaded to satisfy WhisperState type requirement.
        // Use the smallest model (tiny quantized, ~40MB) — it's never used for inference.
        AudioTranscriptionEngine::Disabled => "ggml-tiny-q8_0.bin",
        _ => "ggml-large-v3-turbo-q8_0.bin",
    };

    let api = Api::new()?;
    let repo = Repo::with_revision(
        "ggerganov/whisper.cpp".to_string(),
        RepoType::Model,
        "main".to_string(),
    );

    let cache = Cache::default();
    let cache_repo = cache.repo(repo.clone());

    if let Some(model_path) = cache_repo.get(model_name) {
        info!("model found at {:?}", model_path);
        return Ok(model_path);
    }

    let api_repo = api.repo(repo);

    info!("downloading model {:?}", model_name);
    let model = api_repo.get(model_name)?;

    info!("model downloaded {}", model_name);

    Ok(model)
}

pub fn create_whisper_context_parameters<'a>(
    _engine: Arc<AudioTranscriptionEngine>,
) -> Result<WhisperContextParameters<'a>> {
    let mut context_param = WhisperContextParameters::default();

    // Explicitly enable GPU acceleration (Vulkan on Windows, Metal on macOS).
    // The whisper-rs default only enables GPU when built with the `_gpu` feature,
    // but we always want to try GPU if the runtime supports it.
    context_param.use_gpu(true);
    info!("whisper context: gpu acceleration enabled (Metal on macOS, Vulkan on Windows)");

    // NOTE: keep DTW disabled to avoid whisper.cpp median_filter asserts on short inputs
    // (WHISPER_ASSERT filter_width < a->ne[2]). Token-level timestamps are optional for us
    // and DTW can be re-enabled after the upstream issue is addressed.
    context_param.dtw_parameters.mode = whisper_rs::DtwMode::None;

    Ok(context_param)
}
