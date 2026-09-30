// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tokio::sync::{Mutex, MutexGuard};

/// Keep the originating startup error in the bounded log collected by support.
/// A completed invocation only describes startup; durable capture and upload
/// remain independently observable outcomes.
pub(super) async fn run(
    data_dir: &std::path::Path,
    wants_recording: &AtomicBool,
    startup: impl std::future::Future<Output = Result<(), String>>,
) -> Result<(), String> {
    super::recovery_log::append(data_dir, "retry_started", "recording recovery admitted");
    let result = startup.await;
    let capture_intended = wants_recording.load(Ordering::SeqCst);
    match &result {
        Ok(()) => super::recovery_log::append(
            data_dir,
            "retry_completed",
            &format!("startup command completed; capture_intended={capture_intended}"),
        ),
        Err(error) => super::recovery_log::append(
            data_dir,
            "retry_failed",
            &format!("startup failed; capture_intended={capture_intended}; cause={error}"),
        ),
    }
    result
}

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

/// A pause may complete after retry admission but before a healthy server's
/// capture slot becomes available. Recheck intent while owning that slot.
pub(super) async fn lock_intended_capture<'a, T>(
    capture: &'a Mutex<Option<T>>,
    wants_recording: &AtomicBool,
) -> Option<MutexGuard<'a, Option<T>>> {
    let guard = capture.lock().await;
    wants_recording.load(Ordering::SeqCst).then_some(guard)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn retry_failure_and_paused_completion_survive_collected_redacted_support_report() {
        let dir = tempfile::tempdir().unwrap();
        let intent = AtomicBool::new(true);
        let failure = run(dir.path(), &intent, async {
            // Exercise a real startup prerequisite failure, retaining its OS
            // cause rather than replacing it with a generic retry error.
            std::fs::read(dir.path().join("missing-config"))
                .map(|_| ())
                .map_err(|error| format!("recording configuration unavailable: {error}"))
        })
        .await
        .unwrap_err();
        run(dir.path(), &intent, async {
            // Pause races an admitted recovery. Completing startup must leave
            // that newer user intent intact and describe it accurately.
            intent.store(false, Ordering::SeqCst);
            Ok(())
        })
        .await
        .unwrap();

        // Simulate application-log rotation and restart. The recovery log
        // must retain priority despite newer noisy application logs.
        for day in 1..=7 {
            std::fs::write(
                dir.path()
                    .join(format!("screenpipe-app.2026-09-{day:02}.log")),
                "app restarted; contact=private-person@example.com\n",
            )
            .unwrap();
        }
        let report =
            crate::diagnostic_logs::collect_redacted_from_dirs(&[dir.path().to_path_buf()])
                .await
                .unwrap();
        assert!(report.contains("retry_started: recording recovery admitted"));
        assert!(report.contains("retry_failed: startup failed; capture_intended=true"));
        assert!(report.contains(&failure));
        assert!(
            report.contains("retry_completed: startup command completed; capture_intended=false")
        );
        assert!(!report.contains("private-person@example.com"));
        assert!(!intent.load(Ordering::SeqCst));
    }

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

    #[tokio::test]
    async fn healthy_server_retry_honors_pause_while_waiting_for_capture_slot() {
        let capture = Mutex::new(None::<()>);
        let intent = AtomicBool::new(true);
        let pause_guard = capture.lock().await;
        let retry = lock_intended_capture(&capture, &intent);
        tokio::pin!(retry);
        assert!(futures::poll!(retry.as_mut()).is_pending());

        // The pause completes with no capture to stop before retry gets the
        // slot. A stale pre-lock intent check would create a new session here.
        intent.store(false, Ordering::SeqCst);
        drop(pause_guard);
        let mut starts = 0;
        if let Some(mut slot) = retry.await {
            starts += 1;
            *slot = Some(());
        }
        assert_eq!(starts, 0);
        assert!(capture.lock().await.is_none());
        assert!(!intent.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn intended_capture_start_keeps_slot_until_session_is_installed() {
        let capture = Mutex::new(None::<()>);
        let intent = AtomicBool::new(true);
        let mut slot = lock_intended_capture(&capture, &intent).await.unwrap();
        assert!(capture.try_lock().is_err());
        *slot = Some(());
        drop(slot);
        assert!(capture.lock().await.is_some());
        assert!(intent.load(Ordering::SeqCst));
    }
}
