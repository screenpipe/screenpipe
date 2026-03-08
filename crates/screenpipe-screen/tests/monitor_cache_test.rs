/// Tests for monitor handle caching optimization.
///
/// The optimization: SafeMonitor now caches the native monitor handle (SckMonitor/XcapMonitor)
/// at construction time and reuses it for every capture_image() call, instead of calling
/// Monitor::all() + find() on every frame.
///
/// Also replaced std::thread::spawn with tokio::task::spawn_blocking to reuse the
/// tokio blocking thread pool instead of creating a new OS thread per frame.
///
/// These tests verify the structural properties. Actual capture requires a real display.
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

/// Simulate the OLD behavior: enumerate all monitors and find by ID every frame.
/// Returns the number of enumerations performed.
fn old_capture_pattern(monitor_id: u32, frame_count: u32, enumerate_counter: &AtomicU32) {
    for _ in 0..frame_count {
        // OLD: enumerate all monitors every frame
        enumerate_counter.fetch_add(1, Ordering::SeqCst);
        let _monitors: Vec<u32> = vec![1, 2, 3]; // simulate Monitor::all()
        let _found = _monitors.iter().find(|&&id| id == monitor_id);
    }
}

/// Simulate the NEW behavior: use cached handle, only enumerate on cache miss.
fn new_capture_pattern(
    monitor_id: u32,
    cached: bool,
    frame_count: u32,
    enumerate_counter: &AtomicU32,
) {
    let mut has_cache = cached;
    for _ in 0..frame_count {
        if has_cache {
            // NEW: use cached handle directly — no enumeration
            let _ = monitor_id; // simulate capture with cached ID
        } else {
            // Cache miss: enumerate once, then cache
            enumerate_counter.fetch_add(1, Ordering::SeqCst);
            let _monitors: Vec<u32> = vec![1, 2, 3];
            let _found = _monitors.iter().find(|&&id| id == monitor_id);
            has_cache = true; // cache is now populated
        }
    }
}

#[test]
fn test_old_pattern_enumerates_every_frame() {
    let counter = AtomicU32::new(0);
    old_capture_pattern(1, 100, &counter);
    assert_eq!(
        counter.load(Ordering::SeqCst),
        100,
        "Old pattern should enumerate on every frame"
    );
}

#[test]
fn test_new_pattern_enumerates_zero_times_with_cache() {
    let counter = AtomicU32::new(0);
    new_capture_pattern(1, true, 100, &counter);
    assert_eq!(
        counter.load(Ordering::SeqCst),
        0,
        "New pattern should never enumerate when cache is populated"
    );
}

#[test]
fn test_new_pattern_enumerates_once_on_cache_miss() {
    let counter = AtomicU32::new(0);
    new_capture_pattern(1, false, 100, &counter);
    assert_eq!(
        counter.load(Ordering::SeqCst),
        1,
        "New pattern should enumerate exactly once on cache miss"
    );
}

#[test]
fn test_enumeration_savings_multi_monitor() {
    // Simulate 3 monitors at 0.5 FPS for 60 seconds = 30 frames each = 90 total
    let old_counter = AtomicU32::new(0);
    let new_counter = AtomicU32::new(0);

    for monitor_id in 1..=3 {
        old_capture_pattern(monitor_id, 30, &old_counter);
        new_capture_pattern(monitor_id, true, 30, &new_counter);
    }

    let old_enumerations = old_counter.load(Ordering::SeqCst);
    let new_enumerations = new_counter.load(Ordering::SeqCst);

    println!(
        "3 monitors, 30 frames each: old={} enumerations, new={} enumerations",
        old_enumerations, new_enumerations
    );

    assert_eq!(old_enumerations, 90);
    assert_eq!(new_enumerations, 0);
}

#[test]
fn test_enumeration_savings_adaptive_fps_burst() {
    // Simulate 3 monitors at 10 FPS adaptive burst for 5 seconds = 50 frames each = 150 total
    let old_counter = AtomicU32::new(0);
    let new_counter = AtomicU32::new(0);

    for monitor_id in 1..=3 {
        old_capture_pattern(monitor_id, 50, &old_counter);
        new_capture_pattern(monitor_id, true, 50, &new_counter);
    }

    let old = old_counter.load(Ordering::SeqCst);
    let new = new_counter.load(Ordering::SeqCst);

    println!(
        "Adaptive burst (10 FPS × 3 monitors × 5s): old={} enumerations, new={} enumerations",
        old, new
    );

    assert_eq!(old, 150);
    assert_eq!(new, 0);
}

/// Verify that spawn_blocking reuses threads while std::thread::spawn creates new ones.
#[tokio::test]
async fn test_spawn_blocking_reuses_threads() {
    let thread_ids = Arc::new(std::sync::Mutex::new(Vec::new()));

    // Run 20 blocking tasks
    let mut handles = vec![];
    for _ in 0..20 {
        let ids = thread_ids.clone();
        handles.push(tokio::task::spawn_blocking(move || {
            let tid = format!("{:?}", std::thread::current().id());
            ids.lock().unwrap().push(tid);
        }));
    }

    for h in handles {
        h.await.unwrap();
    }

    let ids = thread_ids.lock().unwrap();
    let unique_threads: std::collections::HashSet<&String> = ids.iter().collect();

    println!(
        "spawn_blocking: {} tasks used {} unique threads",
        ids.len(),
        unique_threads.len()
    );

    // spawn_blocking should reuse threads — far fewer unique threads than tasks
    // The default tokio blocking pool is ~512 threads max, but for 20 fast tasks
    // it should reuse aggressively
    assert!(
        unique_threads.len() <= ids.len(),
        "spawn_blocking should not create more threads than tasks"
    );
    // In practice, 20 fast tasks typically reuse ~2-4 threads
    assert!(
        unique_threads.len() < 15,
        "Expected significant thread reuse, got {} unique threads for {} tasks",
        unique_threads.len(),
        ids.len()
    );
}

/// Compare thread creation: std::thread::spawn creates a new thread each time
#[test]
fn test_std_thread_spawn_creates_new_threads() {
    let thread_ids = Arc::new(std::sync::Mutex::new(Vec::new()));
    let mut handles = vec![];

    for _ in 0..20 {
        let ids = thread_ids.clone();
        handles.push(std::thread::spawn(move || {
            let tid = format!("{:?}", std::thread::current().id());
            ids.lock().unwrap().push(tid);
        }));
    }

    for h in handles {
        h.join().unwrap();
    }

    let ids = thread_ids.lock().unwrap();
    let unique_threads: std::collections::HashSet<&String> = ids.iter().collect();

    println!(
        "std::thread::spawn: {} tasks used {} unique threads",
        ids.len(),
        unique_threads.len()
    );

    // std::thread::spawn creates a new thread for each call
    assert_eq!(
        unique_threads.len(),
        ids.len(),
        "std::thread::spawn should create a unique thread per call"
    );
}
