use super::detect_language;
use anyhow::Result;
use screenpipe_core::Language;
use whisper_rs::{FullParams, SamplingStrategy, WhisperState};
/// Processes audio data using the Whisper model to generate transcriptions.
///
/// # Returns
/// A string containing the processed transcript
pub async fn process_with_whisper(
    audio: &[f32],
    languages: Vec<Language>,
    whisper_state: &mut WhisperState,
) -> Result<String> {

    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 0 });

    let mut audio = audio.to_vec();

    if audio.len() < 16000 {
        audio.resize(16000, 0.0);
    }

    // Edit params as needed.
    // Set the number of threads to use to 2.
    params.set_n_threads(2);
    // Disable anything that prints to stdout.
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    // Disable token-level timestamps since DTW is disabled for stability.
    params.set_token_timestamps(false);
    whisper_state.pcm_to_mel(&audio, 2)?;
    let (_, lang_tokens) = whisper_state.lang_detect(0, 2)?;
    let lang = detect_language(lang_tokens, languages);
    params.set_language(lang);
    params.set_debug_mode(false);
    params.set_logprob_thold(-2.0);
    params.set_translate(false);

    whisper_state
        .full(params, &audio)
        .map_err(|e| anyhow::anyhow!("failed to run whisper model: {}", e))?;

    let num_segments = whisper_state.full_n_segments();

    let mut transcript = String::new();

    for i in 0..num_segments {
        // Get the transcribed text and timestamps for the current segment.
        if let Some(segment) = whisper_state.get_segment(i) {
            if let Ok(text) = segment.to_str() {
                transcript.push_str(text);
            }
        }
    }

    Ok(transcript)
}
