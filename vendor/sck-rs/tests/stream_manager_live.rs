#![cfg(target_os = "macos")]

use sck_rs::{peek_latest_frame, start_hd_capture, stop_all_streams, Monitor};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

const MAX_CONTROL_LATENCY: Duration = Duration::from_millis(250);

/// Live ScreenCaptureKit stress test for the capture-recovery/tray-preview path.
///
/// This is ignored by default because it requires Screen Recording permission
/// and at least one real display. Run it explicitly on macOS with:
///
/// `SCK_STRESS_CYCLES=100 cargo test --test stream_manager_live -- --ignored --nocapture`
#[test]
#[ignore = "requires macOS Screen Recording permission and a real display"]
fn invalidate_and_peek_stay_responsive_under_real_sck_churn() {
    let cycles = std::env::var("SCK_STRESS_CYCLES")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(20);
    let watchdog_secs = std::env::var("SCK_STRESS_TIMEOUT_SECS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(300);

    let completed = Arc::new(AtomicBool::new(false));
    let watchdog_completed = Arc::clone(&completed);
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(watchdog_secs));
        if !watchdog_completed.load(Ordering::Acquire) {
            eprintln!(
                "live SCK stream-manager stress exceeded {watchdog_secs}s; probable teardown deadlock"
            );
            std::process::abort();
        }
    });

    let monitors = Monitor::all().expect("enumerate real macOS displays");
    assert!(!monitors.is_empty(), "at least one display is required");

    // Bootstrap every display so stop_all_streams exercises a populated map,
    // including the multi-monitor drain case when hardware is available.
    for monitor in &monitors {
        let frame = monitor
            .capture_image_scaled(640)
            .expect("bootstrap persistent SCK stream");
        assert!(frame.width() > 0 && frame.height() > 0);
    }

    let monitor_ids: Vec<u32> = monitors.iter().map(Monitor::id).collect();
    let keep_peeking = Arc::new(AtomicBool::new(true));
    let slow_peeks = Arc::new(AtomicUsize::new(0));
    let max_peek_micros = Arc::new(AtomicU64::new(0));

    let preview_running = Arc::clone(&keep_peeking);
    let preview_slow = Arc::clone(&slow_peeks);
    let preview_max = Arc::clone(&max_peek_micros);
    let preview_thread = thread::spawn(move || {
        while preview_running.load(Ordering::Acquire) {
            for monitor_id in &monitor_ids {
                let started = Instant::now();
                let _ = peek_latest_frame(*monitor_id);
                let elapsed = started.elapsed();
                preview_max.fetch_max(elapsed.as_micros() as u64, Ordering::AcqRel);
                if elapsed > MAX_CONTROL_LATENCY {
                    preview_slow.fetch_add(1, Ordering::AcqRel);
                }
            }
            thread::sleep(Duration::from_millis(2));
        }
    });

    for cycle in 0..cycles {
        let monitor = &monitors[cycle % monitors.len()];

        let invalidate_started = Instant::now();
        monitor.stop_stream();
        assert!(
            invalidate_started.elapsed() <= MAX_CONTROL_LATENCY,
            "cycle {cycle}: per-monitor invalidation blocked for {:?}",
            invalidate_started.elapsed()
        );

        // Repeated invalidation is intentionally idempotent and must remain
        // prompt when the stream is already absent.
        let repeated_started = Instant::now();
        monitor.stop_stream();
        assert!(
            repeated_started.elapsed() <= MAX_CONTROL_LATENCY,
            "cycle {cycle}: repeated invalidation blocked for {:?}",
            repeated_started.elapsed()
        );

        // Alternate native/scaled dimensions and exclusion updates to cover
        // both full stream replacement and in-place filter updates.
        let frame = if cycle % 2 == 0 {
            monitor
                .capture_image_scaled((monitor.raw_width() / 2).clamp(1, 1280))
                .expect("recreate scaled stream after invalidation")
        } else {
            monitor
                .capture_image_excluding(&[u32::MAX])
                .expect("recreate stream and update exclusion state")
        };
        assert!(frame.width() > 0 && frame.height() > 0);

        // HdCaptureStream owns a MonitorStream outside the global persistent
        // stream map. Exercise that destructor too so the asynchronous stop
        // path is covered for both capture modes used by screenpipe.
        if cycle % 10 == 0 {
            let (hd_stream, _hd_frames) = start_hd_capture(
                monitor.id(),
                (monitor.raw_width() / 4).clamp(160, 640),
                (monitor.raw_height() / 4).clamp(90, 360),
                5,
                &[],
            )
            .expect("start dedicated HD stream");
            let hd_drop_started = Instant::now();
            drop(hd_stream);
            assert!(
                hd_drop_started.elapsed() <= MAX_CONTROL_LATENCY,
                "cycle {cycle}: HD stream teardown blocked for {:?}",
                hd_drop_started.elapsed()
            );
        }

        if cycle % 5 == 4 {
            let stop_all_started = Instant::now();
            stop_all_streams();
            assert!(
                stop_all_started.elapsed() <= MAX_CONTROL_LATENCY,
                "cycle {cycle}: stop_all_streams blocked for {:?}",
                stop_all_started.elapsed()
            );
        }
    }

    keep_peeking.store(false, Ordering::Release);
    preview_thread.join().expect("preview stress thread");

    let final_stop_started = Instant::now();
    stop_all_streams();
    assert!(
        final_stop_started.elapsed() <= MAX_CONTROL_LATENCY,
        "final stop_all_streams blocked for {:?}",
        final_stop_started.elapsed()
    );

    completed.store(true, Ordering::Release);
    assert_eq!(
        slow_peeks.load(Ordering::Acquire),
        0,
        "preview reads exceeded {:?}; max observed {}us",
        MAX_CONTROL_LATENCY,
        max_peek_micros.load(Ordering::Acquire)
    );
    eprintln!(
        "completed {cycles} live teardown/recreate cycles across {} monitor(s); max preview latency={}us",
        monitors.len(),
        max_peek_micros.load(Ordering::Acquire)
    );
}
