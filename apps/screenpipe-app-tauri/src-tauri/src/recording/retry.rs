// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tokio::sync::{Mutex, MutexGuard};

/// Shared admission for watchdog and webview recovery. Inspect current intent
/// only after acquiring the native lifecycle slot; never publish new intent.
pub(super) fn admit<'a>(
    lifecycle: &'a Mutex<()>,
    wants_recording: &AtomicBool,
    quit_requested: &AtomicBool,
    last_spawn: &AtomicU64,
    now: u64,
) -> Option<MutexGuard<'a, ()>> {
    let guard = lifecycle.try_lock().ok()?;
    if !wants_recording.load(Ordering::SeqCst) || quit_requested.load(Ordering::SeqCst) {
        return None;
    }
    let last = last_spawn.load(Ordering::SeqCst);
    if last > 0 && now.saturating_sub(last) < super::RESTART_COOLDOWN_SECS {
        return None;
    }
    Some(guard)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pause_after_a_webview_observed_recording_cancels_native_retry() {
        let lifecycle = Mutex::new(());
        let intent = AtomicBool::new(true);
        assert!(intent.load(Ordering::SeqCst)); // old UI snapshot
        intent.store(false, Ordering::SeqCst); // user pauses before IPC arrives
        assert!(admit(
            &lifecycle,
            &intent,
            &AtomicBool::new(false),
            &AtomicU64::new(0),
            100
        )
        .is_none());
        assert!(!intent.load(Ordering::SeqCst));
        assert!(lifecycle.try_lock().is_ok());
    }

    #[test]
    fn concurrent_windows_share_one_lifecycle_slot() {
        let lifecycle = Mutex::new(());
        let intent = AtomicBool::new(true);
        let quit = AtomicBool::new(false);
        let last = AtomicU64::new(0);
        let first = admit(&lifecycle, &intent, &quit, &last, 100).unwrap();
        assert!(admit(&lifecycle, &intent, &quit, &last, 100).is_none());
        // Successful startup sets the shared cooldown before releasing the slot.
        last.store(100, Ordering::SeqCst);
        drop(first);
        assert!(admit(&lifecycle, &intent, &quit, &last, 100).is_none());
        assert!(admit(&lifecycle, &intent, &quit, &last, 130).is_some());
    }

    #[test]
    fn busy_lifecycle_does_not_queue_a_restart_that_outlives_pause() {
        let lifecycle = Mutex::new(());
        let intent = AtomicBool::new(true);
        let guard = lifecycle.try_lock().unwrap();
        assert!(admit(
            &lifecycle,
            &intent,
            &AtomicBool::new(false),
            &AtomicU64::new(0),
            100
        )
        .is_none());
        intent.store(false, Ordering::SeqCst);
        drop(guard);
        assert!(admit(
            &lifecycle,
            &intent,
            &AtomicBool::new(false),
            &AtomicU64::new(0),
            100
        )
        .is_none());
    }

    #[test]
    fn quit_cancels_retry_and_releases_lifecycle_slot() {
        let lifecycle = Mutex::new(());
        assert!(admit(
            &lifecycle,
            &AtomicBool::new(true),
            &AtomicBool::new(true),
            &AtomicU64::new(0),
            100
        )
        .is_none());
        assert!(lifecycle.try_lock().is_ok());
    }

    #[test]
    fn cooldown_honors_boundary_and_backwards_clock() {
        let lifecycle = Mutex::new(());
        let intent = AtomicBool::new(true);
        let quit = AtomicBool::new(false);
        let last = AtomicU64::new(100);
        for now in [99, 100, 129] {
            assert!(admit(&lifecycle, &intent, &quit, &last, now).is_none());
        }
        assert!(admit(&lifecycle, &intent, &quit, &last, 130).is_some());
    }

    #[test]
    fn never_started_server_can_recover_without_modifying_capture_intent() {
        let lifecycle = Mutex::new(());
        let intent = AtomicBool::new(true);
        let guard = admit(
            &lifecycle,
            &intent,
            &AtomicBool::new(false),
            &AtomicU64::new(0),
            0,
        )
        .unwrap();
        assert!(intent.load(Ordering::SeqCst));
        drop(guard);
        assert!(lifecycle.try_lock().is_ok());
    }

    #[test]
    fn pause_during_admitted_start_remains_visible_to_capture_creation() {
        let lifecycle = Mutex::new(());
        let intent = AtomicBool::new(true);
        let _guard = admit(
            &lifecycle,
            &intent,
            &AtomicBool::new(false),
            &AtomicU64::new(0),
            100,
        )
        .unwrap();
        intent.store(false, Ordering::SeqCst);
        // Server startup uses this same last-moment check before CaptureSession.
        assert!(!super::super::capture_intended_now(&intent));
    }
}
