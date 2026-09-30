// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

// Exercise the combined app link: a standalone Whisper test can miss a second
// dependency's incompatible GGML symbols being selected by the native linker.
#[test]
#[ignore = "uses a real Whisper model and Vulkan device"]
fn real_whisper_vulkan_state_and_inference() {
    use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

    let model = std::env::var_os("SCREENPIPE_WHISPER_TEST_MODEL")
        .map(std::path::PathBuf::from)
        .expect("SCREENPIPE_WHISPER_TEST_MODEL must name a real ggml model");
    let mut context_params = WhisperContextParameters::default();
    context_params.use_gpu(true);
    eprintln!("whisper Vulkan acceptance: loading {}", model.display());
    let context = WhisperContext::new_with_params(&model, context_params)
        .expect("real Whisper Vulkan context creation must succeed");
    eprintln!("whisper Vulkan acceptance: context loaded; creating state");
    let mut state = context
        .create_state()
        .expect("real Whisper Vulkan state creation must succeed");
    eprintln!("whisper Vulkan acceptance: state created; running inference");
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some("en"));
    state
        .full(params, &[0.0_f32; 16_000])
        .expect("real Whisper Vulkan inference must succeed");
    eprintln!("whisper Vulkan acceptance: inference completed");
}
