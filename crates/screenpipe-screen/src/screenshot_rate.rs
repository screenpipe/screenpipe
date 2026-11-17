// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Acquisition preference shared by native screenshot sources. The effective
//! rate covers the configured idle screenshot cadence; HD remains independent.

use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};

struct RateControl {
    preferred: AtomicU32,
    // Zero encodes Auto; configured zero-millisecond intervals are rejected.
    idle_interval_ms: AtomicU64,
}

impl RateControl {
    const fn new(fps: u32) -> Self {
        Self {
            preferred: AtomicU32::new(fps),
            idle_interval_ms: AtomicU64::new(0),
        }
    }

    fn minimum(&self) -> u32 {
        let interval = self.idle_interval_ms.load(Ordering::Acquire);
        if interval == 0 {
            // Built-in Auto power profiles and meeting idle intervals are all
            // slower than one screenshot per second, the native setting minimum.
            1
        } else {
            1000_u64.div_ceil(interval).max(1) as u32
        }
    }

    fn current(&self) -> u32 {
        self.preferred.load(Ordering::Acquire).max(self.minimum())
    }

    fn initialize(&self, fps: u32, idle_interval_ms: Option<u64>) -> anyhow::Result<()> {
        validate_native_rate(fps)?;
        anyhow::ensure!(idle_interval_ms != Some(0),
            "idleCaptureIntervalMs 0 ms cannot be covered by a finite screenshot sampling rate; select Auto or a positive interval in milliseconds");
        // Preserve both preferences. A fast idle pin raises acquisition rather
        // than weakening its guaranteed recording cadence or changing HD.
        self.idle_interval_ms
            .store(idle_interval_ms.unwrap_or(0), Ordering::Release);
        self.preferred.store(fps, Ordering::Release);
        let effective_fps = self.current();
        if effective_fps > fps {
            tracing::warn!(
                configured_fps = fps,
                effective_fps,
                ?idle_interval_ms,
                outcome = "sampling_raised_to_cover_idle",
                "screenshot sampling raised to cover configured idle recording cadence"
            );
        }
        Ok(())
    }

    fn set(&self, fps: u32) -> anyhow::Result<()> {
        validate_native_rate(fps)?;
        let minimum_fps = self.minimum();
        anyhow::ensure!(fps >= minimum_fps,
            "screenshotFrameRate {fps} fps is below the idle recording requirement {minimum_fps} fps (idleCaptureIntervalMs {} ms); raise sampling or increase the idle interval and apply recording settings",
            self.idle_interval_ms.load(Ordering::Acquire));
        let previous = self.current();
        self.preferred.store(fps, Ordering::Release);
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
}

fn validate_native_rate(fps: u32) -> anyhow::Result<()> {
    // CMTime has a positive signed 32-bit timescale, a representation boundary.
    anyhow::ensure!(fps > 0 && fps <= screenpipe_config::MAX_SCREENSHOT_FRAME_RATE,
        "screenshot acquisition rate {fps} fps is outside the native range 1..={} fps; correct screenshotFrameRate", screenpipe_config::MAX_SCREENSHOT_FRAME_RATE);
    Ok(())
}

static FRAME_RATE: RateControl = RateControl::new(screenpipe_config::DEFAULT_SCREENSHOT_FRAME_RATE);

pub fn current() -> u32 {
    FRAME_RATE.current()
}

pub fn initialize(fps: u32, idle_interval_ms: Option<u64>) -> anyhow::Result<()> {
    FRAME_RATE.initialize(fps, idle_interval_ms)
}

pub fn set(fps: u32) -> anyhow::Result<()> {
    FRAME_RATE.set(fps)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sampling_covers_idle_rates_below_at_and_above_the_preference() {
        let rate = RateControl::new(2);
        for (interval, expected) in [
            (None, 2),
            (Some(30_000), 2),
            (Some(1_000), 2),
            (Some(501), 2),
            (Some(500), 2),
            (Some(499), 3),
            (Some(333), 4),
            (Some(250), 4),
            (Some(1), 1_000),
        ] {
            rate.initialize(2, interval).unwrap();
            assert_eq!(rate.current(), expected, "idle interval {interval:?} ms");
        }
    }

    #[test]
    fn live_changes_preserve_the_idle_guarantee_and_restart_reloads_the_preferences() {
        let rate = RateControl::new(2);
        rate.initialize(1, Some(500)).unwrap();
        assert_eq!(rate.current(), 2);
        let error = rate.set(1).unwrap_err().to_string();
        assert!(error.contains("500 ms"));
        assert!(error.contains("2 fps"));
        assert_eq!(rate.current(), 2);
        rate.set(2).unwrap();
        rate.set(4).unwrap();
        assert_eq!(rate.current(), 4);
        rate.initialize(1, None).unwrap();
        assert_eq!(rate.current(), 1);
    }

    #[test]
    fn invalid_settings_preserve_the_running_rate() {
        let rate = RateControl::new(4);
        rate.initialize(4, Some(250)).unwrap();
        assert!(rate.initialize(2, Some(0)).is_err());
        assert!(rate.initialize(0, None).is_err());
        assert!(rate
            .set(screenpipe_config::MAX_SCREENSHOT_FRAME_RATE + 1)
            .is_err());
        assert_eq!(rate.current(), 4);
    }
}
