// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn main() -> anyhow::Result<()> {
    let mut args = std::env::args_os().skip(1);
    let out = args.next().ok_or_else(|| {
        anyhow::anyhow!("usage: gpu_screenshot_benchmark OUTPUT_DIR [SAMPLES_PER_CASE]")
    })?;
    let samples = args
        .next()
        .map(|s| s.to_string_lossy().parse())
        .transpose()?
        .unwrap_or(200);
    screenpipe_screen::screenshot_privacy::benchmark_gpu_screenshots(
        std::path::Path::new(&out),
        samples,
    )
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn main() -> anyhow::Result<()> {
    anyhow::bail!("requires Metal or D3D11")
}
