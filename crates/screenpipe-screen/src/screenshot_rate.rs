// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Acquisition preference shared by native screenshot sources. This does not
//! control OCR/JPEG/save admission or the independent HD video encoder.

use std::sync::atomic::{AtomicU32, Ordering};

static FRAME_RATE: AtomicU32 = AtomicU32::new(screenpipe_config::DEFAULT_SCREENSHOT_FRAME_RATE);

pub fn current() -> u32 {
    FRAME_RATE.load(Ordering::Acquire)
}

pub fn set(fps: u32) -> anyhow::Result<()> {
    // CMTime has a positive signed 32-bit timescale; reject values that cannot
    // be represented rather than silently clamping the user's preference.
    anyhow::ensure!(fps > 0 && fps <= i32::MAX as u32,
        "screenshot acquisition rate {fps} fps cannot be represented by the native positive timescale; correct screenshotFrameRate");
    let previous = FRAME_RATE.swap(fps, Ordering::AcqRel);
    if previous != fps {
        tracing::info!(
            previous_fps = previous,
            fps,
            activation = "next_screenshot",
            "screenshot acquisition frame rate changed"
        );
    }
    Ok(())
}
