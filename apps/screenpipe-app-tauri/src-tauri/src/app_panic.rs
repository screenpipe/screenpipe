// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Persist desktop panics even before app setup creates the data directory.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

static APP_SETUP_STARTED: AtomicBool = AtomicBool::new(false);

pub fn mark_setup_started() {
    APP_SETUP_STARTED.store(true, Ordering::Relaxed);
}

pub fn setup_started() -> bool {
    APP_SETUP_STARTED.load(Ordering::Relaxed)
}

pub fn write_report(
    dir: &Path,
    thread_name: &str,
    location: &str,
    payload: &str,
    backtrace: &dyn std::fmt::Display,
    setup_started: bool,
) -> String {
    // A worker-thread panic need not terminate the app. Only identify the
    // launch outcome when the main thread panics before setup has begun.
    let launch_outcome = if thread_name == "main" && !setup_started {
        "\nLaunch outcome: main thread panicked before app setup"
    } else {
        ""
    };
    let report = format!(
        "PANIC on thread '{}' at {}: {}{}\n\nBacktrace:\n{}",
        thread_name, location, payload, launch_outcome, backtrace
    );
    let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
    // This shared writer creates the directory, appends (including a later
    // panic_cannot_unwind), and fsyncs before an abort can end the process.
    screenpipe_engine::crash_log::write_panic_log(dir, &format!("[{}] {}", timestamp, report));
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_main_thread_panic_before_setup_is_a_failed_launch() {
        let dir = tempfile::tempdir().unwrap();
        for (thread, setup) in [("capture", false), ("main", true)] {
            let report = write_report(dir.path(), thread, "test.rs:1", "failure", &"trace", setup);
            assert!(!report.contains("Launch outcome:"));
        }
    }
}
