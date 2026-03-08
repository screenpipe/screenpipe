/// Standalone test for health check debouncing logic.
/// This mirrors the core logic from apps/screenpipe-app-tauri/src-tauri/src/health.rs
/// so we can test it without the full Tauri build.
use std::time::Duration;

const STARTUP_GRACE_PERIOD: Duration = Duration::from_secs(30);
const CONSECUTIVE_FAILURES_THRESHOLD: u32 = 3;

#[derive(Clone, Copy, PartialEq, Debug)]
enum RecordingStatus {
    Starting,
    Recording,
    Stopped,
    Error,
}

#[derive(Debug)]
struct HealthCheckResponse {
    status: String,
}

fn decide_status(
    health_result: &Result<HealthCheckResponse, anyhow::Error>,
    elapsed_since_start: Duration,
    grace_period: Duration,
    ever_connected: bool,
    consecutive_failures: u32,
    failure_threshold: u32,
    current_status: RecordingStatus,
) -> RecordingStatus {
    match health_result {
        Ok(health) if health.status == "unhealthy" || health.status == "error" => {
            RecordingStatus::Error
        }
        Ok(_) => RecordingStatus::Recording,
        Err(_) => {
            if !ever_connected && elapsed_since_start < grace_period {
                RecordingStatus::Starting
            } else if current_status == RecordingStatus::Recording
                && consecutive_failures < failure_threshold
            {
                RecordingStatus::Recording
            } else {
                RecordingStatus::Stopped
            }
        }
    }
}

fn status_to_icon_key(status: RecordingStatus) -> &'static str {
    match status {
        RecordingStatus::Starting => "starting",
        RecordingStatus::Recording => "healthy",
        RecordingStatus::Stopped => "error",
        RecordingStatus::Error => "unhealthy",
    }
}

fn is_unhealthy_icon(icon_key: &str) -> bool {
    icon_key == "unhealthy" || icon_key == "error"
}

// ============ helpers ============

fn make_healthy_response() -> Result<HealthCheckResponse, anyhow::Error> {
    Ok(HealthCheckResponse {
        status: "healthy".to_string(),
    })
}

fn make_unhealthy_response() -> Result<HealthCheckResponse, anyhow::Error> {
    Ok(HealthCheckResponse {
        status: "unhealthy".to_string(),
    })
}

fn make_connection_error() -> Result<HealthCheckResponse, anyhow::Error> {
    Err(anyhow::anyhow!("connection refused"))
}

fn decide_no_debounce(
    health_result: &Result<HealthCheckResponse, anyhow::Error>,
    elapsed: Duration,
    grace: Duration,
    ever_connected: bool,
) -> RecordingStatus {
    decide_status(
        health_result,
        elapsed,
        grace,
        ever_connected,
        CONSECUTIVE_FAILURES_THRESHOLD,
        CONSECUTIVE_FAILURES_THRESHOLD,
        RecordingStatus::Stopped,
    )
}

// ============ tests ============

#[test]
fn test_healthy_response_always_recording() {
    let result = make_healthy_response();
    let status = decide_no_debounce(&result, Duration::from_secs(0), STARTUP_GRACE_PERIOD, false);
    assert_eq!(status, RecordingStatus::Recording);
}

#[test]
fn test_unhealthy_response_always_error() {
    let result = make_unhealthy_response();
    let status = decide_no_debounce(&result, Duration::from_secs(0), STARTUP_GRACE_PERIOD, false);
    assert_eq!(status, RecordingStatus::Error);
}

#[test]
fn test_connection_error_during_grace_period_is_starting() {
    for secs in [0, 15, 29] {
        let result = make_connection_error();
        let status = decide_no_debounce(
            &result,
            Duration::from_secs(secs),
            STARTUP_GRACE_PERIOD,
            false,
        );
        assert_eq!(status, RecordingStatus::Starting, "at {}s", secs);
    }
}

#[test]
fn test_connection_error_after_grace_period_is_stopped() {
    for secs in [31, 120] {
        let result = make_connection_error();
        let status = decide_no_debounce(
            &result,
            Duration::from_secs(secs),
            STARTUP_GRACE_PERIOD,
            false,
        );
        assert_eq!(status, RecordingStatus::Stopped, "at {}s", secs);
    }
}

#[test]
fn test_connection_error_after_previous_connection_is_stopped() {
    let result = make_connection_error();
    let status = decide_status(
        &result,
        Duration::from_secs(5),
        STARTUP_GRACE_PERIOD,
        true,
        CONSECUTIVE_FAILURES_THRESHOLD,
        CONSECUTIVE_FAILURES_THRESHOLD,
        RecordingStatus::Recording,
    );
    assert_eq!(status, RecordingStatus::Stopped);
}

#[test]
fn test_grace_period_boundary() {
    let grace = Duration::from_secs(30);
    let status = decide_no_debounce(
        &make_connection_error(),
        Duration::from_secs(29),
        grace,
        false,
    );
    assert_eq!(status, RecordingStatus::Starting);

    let status = decide_no_debounce(
        &make_connection_error(),
        Duration::from_secs(30),
        grace,
        false,
    );
    assert_eq!(status, RecordingStatus::Stopped);
}

// ============ debouncing / anti-flicker tests ============

#[test]
fn test_single_failure_while_recording_holds_recording() {
    let status = decide_status(
        &make_connection_error(),
        Duration::from_secs(60),
        STARTUP_GRACE_PERIOD,
        true,
        1,
        CONSECUTIVE_FAILURES_THRESHOLD,
        RecordingStatus::Recording,
    );
    assert_eq!(
        status,
        RecordingStatus::Recording,
        "single failure while recording should NOT flip to Stopped"
    );
}

#[test]
fn test_two_failures_while_recording_holds_recording() {
    let status = decide_status(
        &make_connection_error(),
        Duration::from_secs(60),
        STARTUP_GRACE_PERIOD,
        true,
        2,
        CONSECUTIVE_FAILURES_THRESHOLD,
        RecordingStatus::Recording,
    );
    assert_eq!(
        status,
        RecordingStatus::Recording,
        "two failures while recording should NOT flip to Stopped"
    );
}

#[test]
fn test_threshold_failures_while_recording_transitions_to_stopped() {
    let status = decide_status(
        &make_connection_error(),
        Duration::from_secs(60),
        STARTUP_GRACE_PERIOD,
        true,
        CONSECUTIVE_FAILURES_THRESHOLD,
        CONSECUTIVE_FAILURES_THRESHOLD,
        RecordingStatus::Recording,
    );
    assert_eq!(
        status,
        RecordingStatus::Stopped,
        "should transition to Stopped after reaching failure threshold"
    );
}

#[test]
fn test_debounce_does_not_apply_when_not_recording() {
    let status = decide_status(
        &make_connection_error(),
        Duration::from_secs(60),
        STARTUP_GRACE_PERIOD,
        true,
        1,
        CONSECUTIVE_FAILURES_THRESHOLD,
        RecordingStatus::Stopped,
    );
    assert_eq!(status, RecordingStatus::Stopped);
}

#[test]
fn test_healthy_response_resets_after_failures() {
    let status = decide_status(
        &make_healthy_response(),
        Duration::from_secs(60),
        STARTUP_GRACE_PERIOD,
        true,
        2,
        CONSECUTIVE_FAILURES_THRESHOLD,
        RecordingStatus::Recording,
    );
    assert_eq!(status, RecordingStatus::Recording);
}

#[test]
fn test_unhealthy_response_bypasses_debounce() {
    let status = decide_status(
        &make_unhealthy_response(),
        Duration::from_secs(60),
        STARTUP_GRACE_PERIOD,
        true,
        0,
        CONSECUTIVE_FAILURES_THRESHOLD,
        RecordingStatus::Recording,
    );
    assert_eq!(
        status,
        RecordingStatus::Error,
        "explicit unhealthy should bypass debounce"
    );
}

#[test]
fn test_flicker_scenario_simulation() {
    let grace = Duration::from_secs(30);
    let threshold = CONSECUTIVE_FAILURES_THRESHOLD;
    let mut current = RecordingStatus::Recording;
    let mut consecutive_failures: u32 = 0;

    // tick 1: healthy
    current = decide_status(
        &make_healthy_response(),
        Duration::from_secs(60),
        grace,
        true,
        0,
        threshold,
        current,
    );
    consecutive_failures = 0;
    assert_eq!(current, RecordingStatus::Recording);

    // tick 2: timeout (failure 1)
    consecutive_failures += 1;
    current = decide_status(
        &make_connection_error(),
        Duration::from_secs(61),
        grace,
        true,
        consecutive_failures,
        threshold,
        current,
    );
    assert_eq!(current, RecordingStatus::Recording, "tick 2: should hold");

    // tick 3: healthy again
    consecutive_failures = 0;
    current = decide_status(
        &make_healthy_response(),
        Duration::from_secs(62),
        grace,
        true,
        consecutive_failures,
        threshold,
        current,
    );
    assert_eq!(current, RecordingStatus::Recording);

    // tick 4-5: two more timeouts
    consecutive_failures += 1;
    current = decide_status(
        &make_connection_error(),
        Duration::from_secs(63),
        grace,
        true,
        consecutive_failures,
        threshold,
        current,
    );
    assert_eq!(current, RecordingStatus::Recording, "tick 4: hold");

    consecutive_failures += 1;
    current = decide_status(
        &make_connection_error(),
        Duration::from_secs(64),
        grace,
        true,
        consecutive_failures,
        threshold,
        current,
    );
    assert_eq!(current, RecordingStatus::Recording, "tick 5: hold");

    // tick 6: healthy
    consecutive_failures = 0;
    current = decide_status(
        &make_healthy_response(),
        Duration::from_secs(65),
        grace,
        true,
        consecutive_failures,
        threshold,
        current,
    );
    assert_eq!(current, RecordingStatus::Recording);
    // NO flickering through this whole sequence!
}

#[test]
fn test_real_crash_still_detected() {
    let grace = Duration::from_secs(30);
    let threshold = CONSECUTIVE_FAILURES_THRESHOLD;
    let mut current = RecordingStatus::Recording;

    for i in 1..=3 {
        current = decide_status(
            &make_connection_error(),
            Duration::from_secs(59 + i),
            grace,
            true,
            i as u32,
            threshold,
            current,
        );
    }
    assert_eq!(
        current,
        RecordingStatus::Stopped,
        "should detect real crash after threshold"
    );
}

// ============ icon mapping tests ============

#[test]
fn test_starting_shows_healthy_icon() {
    let key = status_to_icon_key(RecordingStatus::Starting);
    assert!(!is_unhealthy_icon(key));
}

#[test]
fn test_recording_shows_healthy_icon() {
    let key = status_to_icon_key(RecordingStatus::Recording);
    assert!(!is_unhealthy_icon(key));
}

#[test]
fn test_stopped_shows_failed_icon() {
    assert!(is_unhealthy_icon(status_to_icon_key(
        RecordingStatus::Stopped
    )));
}

#[test]
fn test_error_shows_failed_icon() {
    assert!(is_unhealthy_icon(status_to_icon_key(
        RecordingStatus::Error
    )));
}

// ============ boot sequence ============

#[test]
fn test_boot_sequence_no_false_positive() {
    let grace = Duration::from_secs(30);

    let s = decide_no_debounce(
        &make_connection_error(),
        Duration::from_secs(0),
        grace,
        false,
    );
    assert_eq!(s, RecordingStatus::Starting);
    assert!(!is_unhealthy_icon(status_to_icon_key(s)));

    let s = decide_no_debounce(
        &make_connection_error(),
        Duration::from_secs(1),
        grace,
        false,
    );
    assert_eq!(s, RecordingStatus::Starting);

    let s = decide_no_debounce(
        &make_healthy_response(),
        Duration::from_secs(5),
        grace,
        false,
    );
    assert_eq!(s, RecordingStatus::Recording);
}

#[test]
fn test_server_crash_after_boot_shows_error() {
    let status = decide_status(
        &make_connection_error(),
        Duration::from_secs(60),
        Duration::from_secs(30),
        true,
        CONSECUTIVE_FAILURES_THRESHOLD,
        CONSECUTIVE_FAILURES_THRESHOLD,
        RecordingStatus::Recording,
    );
    assert_eq!(status, RecordingStatus::Stopped);
    assert!(is_unhealthy_icon(status_to_icon_key(status)));
}

#[test]
fn test_server_never_starts_shows_error_after_grace() {
    let status = decide_no_debounce(
        &make_connection_error(),
        Duration::from_secs(35),
        Duration::from_secs(30),
        false,
    );
    assert_eq!(status, RecordingStatus::Stopped);
    assert!(is_unhealthy_icon(status_to_icon_key(status)));
}
