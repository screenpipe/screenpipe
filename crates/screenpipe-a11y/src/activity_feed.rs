//! Lightweight activity feed for adaptive FPS consumers
//!
//! This provides input activity information WITHOUT event content.
//! Safe to use even when full UI event capture is disabled.
//! Used by screenpipe-vision for adaptive capture rate.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// Activity event kind (no content, just type)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActivityKind {
    KeyPress,
    KeyRelease,
    MouseClick,
    MouseMove,
    Scroll,
}

/// Shared activity state that can be cloned to consumers
#[derive(Clone)]
pub struct ActivityFeed {
    last_activity_ms: Arc<AtomicU64>,
    last_keyboard_ms: Arc<AtomicU64>,
    keyboard_count: Arc<AtomicU64>,
    last_count_reset_ms: Arc<AtomicU64>,
}

impl ActivityFeed {
    /// Create a new activity feed
    pub fn new() -> Self {
        let now = current_time_ms();
        Self {
            last_activity_ms: Arc::new(AtomicU64::new(now)),
            last_keyboard_ms: Arc::new(AtomicU64::new(0)),
            keyboard_count: Arc::new(AtomicU64::new(0)),
            last_count_reset_ms: Arc::new(AtomicU64::new(now)),
        }
    }

    /// Record an activity event (called by platform code)
    pub fn record(&self, kind: ActivityKind) {
        let now = current_time_ms();
        self.last_activity_ms.store(now, Ordering::Relaxed);

        // Reset keyboard count if more than 500ms since last reset
        let last_reset = self.last_count_reset_ms.load(Ordering::Relaxed);
        if now.saturating_sub(last_reset) > 500 {
            self.keyboard_count.store(0, Ordering::Relaxed);
            self.last_count_reset_ms.store(now, Ordering::Relaxed);
        }

        if matches!(kind, ActivityKind::KeyPress) {
            self.last_keyboard_ms.store(now, Ordering::Relaxed);
            self.keyboard_count.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// Milliseconds since last activity
    pub fn idle_ms(&self) -> u64 {
        let now = current_time_ms();
        let last = self.last_activity_ms.load(Ordering::Relaxed);
        now.saturating_sub(last)
    }

    /// Milliseconds since last keyboard activity
    pub fn keyboard_idle_ms(&self) -> u64 {
        let last = self.last_keyboard_ms.load(Ordering::Relaxed);
        if last == 0 {
            return u64::MAX; // No keyboard activity yet
        }
        let now = current_time_ms();
        now.saturating_sub(last)
    }

    /// True if actively typing (keyboard activity in last 300ms)
    pub fn is_typing(&self) -> bool {
        self.keyboard_idle_ms() < 300
    }

    /// True if in keyboard burst (frequent typing - 3+ keys in 500ms window)
    pub fn is_keyboard_burst(&self) -> bool {
        self.keyboard_idle_ms() < 500 && self.keyboard_count.load(Ordering::Relaxed) >= 3
    }

    /// True if any activity in last N milliseconds
    pub fn is_active(&self, threshold_ms: u64) -> bool {
        self.idle_ms() < threshold_ms
    }

    /// Get recommended capture parameters based on current activity
    pub fn get_capture_params(&self) -> CaptureParams {
        let idle = self.idle_ms();
        let kb_idle = self.keyboard_idle_ms();

        if self.is_keyboard_burst() {
            // Keyboard burst: high capture rate for typing (reduced from 10 FPS to cut CPU)
            CaptureParams {
                interval: Duration::from_millis(200), // 5 FPS
                skip_threshold: 0.02,                 // 2%
            }
        } else if kb_idle < 300 {
            // Active typing
            CaptureParams {
                interval: Duration::from_millis(150), // ~7 FPS
                skip_threshold: 0.01,                 // 1%
            }
        } else if idle < 500 {
            // General activity (mouse, etc.)
            CaptureParams {
                interval: Duration::from_millis(200), // 5 FPS
                skip_threshold: 0.02,                 // 2%
            }
        } else if idle < 2000 {
            // Cooling down
            CaptureParams {
                interval: Duration::from_millis(500), // 2 FPS
                skip_threshold: 0.02,
            }
        } else if idle < 5000 {
            // Idle
            CaptureParams {
                interval: Duration::from_millis(1000), // 1 FPS
                skip_threshold: 0.02,
            }
        } else {
            // Deep idle
            CaptureParams {
                interval: Duration::from_millis(2000), // 0.5 FPS
                skip_threshold: 0.02,
            }
        }
    }
}

impl Default for ActivityFeed {
    fn default() -> Self {
        Self::new()
    }
}

/// Recommended capture parameters based on activity level
#[derive(Debug, Clone, Copy)]
pub struct CaptureParams {
    /// Recommended interval between captures
    pub interval: Duration,
    /// Recommended frame skip threshold (0.0 - 1.0)
    pub skip_threshold: f64,
}

impl Default for CaptureParams {
    fn default() -> Self {
        Self {
            interval: Duration::from_millis(1000),
            skip_threshold: 0.02,
        }
    }
}

/// Get current time in milliseconds since UNIX epoch
fn current_time_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread::sleep;

    #[test]
    fn test_activity_feed_new() {
        let feed = ActivityFeed::new();
        assert!(feed.idle_ms() < 100); // Should be very recent
    }

    #[test]
    fn test_record_activity() {
        let feed = ActivityFeed::new();
        sleep(Duration::from_millis(50));

        let idle_before = feed.idle_ms();
        feed.record(ActivityKind::MouseClick);
        let idle_after = feed.idle_ms();

        assert!(idle_after < idle_before);
    }

    #[test]
    fn test_keyboard_tracking() {
        let feed = ActivityFeed::new();

        assert!(!feed.is_typing());
        assert_eq!(feed.keyboard_idle_ms(), u64::MAX);

        feed.record(ActivityKind::KeyPress);
        assert!(feed.is_typing());
        assert!(feed.keyboard_idle_ms() < 100);
    }

    #[test]
    fn test_keyboard_burst() {
        let feed = ActivityFeed::new();

        assert!(!feed.is_keyboard_burst());

        // Simulate burst typing
        feed.record(ActivityKind::KeyPress);
        feed.record(ActivityKind::KeyPress);
        feed.record(ActivityKind::KeyPress);

        assert!(feed.is_keyboard_burst());
    }

    #[test]
    fn test_capture_params_typing() {
        let feed = ActivityFeed::new();

        // Simulate typing burst
        for _ in 0..5 {
            feed.record(ActivityKind::KeyPress);
        }

        let params = feed.get_capture_params();
        assert_eq!(params.interval, Duration::from_millis(200)); // 5 FPS during burst
        assert_eq!(params.skip_threshold, 0.02);
    }

    #[test]
    fn test_capture_params_idle() {
        let feed = ActivityFeed::new();
        // Don't record any activity, let it be "idle"
        // Note: Since we just created it, it won't be truly idle
        // This test just verifies the method works
        let params = feed.get_capture_params();
        assert!(params.interval.as_millis() >= 100);
    }

    #[test]
    fn test_default_capture_params() {
        let params = CaptureParams::default();
        assert_eq!(params.interval, Duration::from_millis(1000));
        assert_eq!(params.skip_threshold, 0.02);
    }
}
