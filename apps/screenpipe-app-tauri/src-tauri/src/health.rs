use anyhow::Result;
use dark_light::Mode;
use once_cell::sync::Lazy;
use serde::Deserialize;
use std::sync::RwLock;
use std::time::Instant;
use tauri::{path::BaseDirectory, Manager};
use tokio::time::{interval, Duration};
use tracing::error;

/// How long after startup to treat connection errors as "starting up" instead of "error".
/// The recording server needs time to load whisper models, FFmpeg, etc.
const STARTUP_GRACE_PERIOD: Duration = Duration::from_secs(30);

/// Number of consecutive failures required before transitioning from Recording to Stopped/Error.
/// This prevents transient timeouts or momentary server busyness from flickering the tray icon.
const CONSECUTIVE_FAILURES_THRESHOLD: u32 = 3;

// Shared recording status that can be read by the tray menu
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum RecordingStatus {
    Starting,
    Recording,
    Stopped,
    Error,
}

/// Kind of recording device
#[derive(Clone, PartialEq, Debug)]
pub enum DeviceKind {
    Monitor,
    AudioInput,
    AudioOutput,
}

/// Per-device status info for tray display
#[derive(Clone, PartialEq, Debug)]
pub struct DeviceInfo {
    pub name: String,
    pub kind: DeviceKind,
    pub active: bool,
    pub last_seen_secs_ago: u64,
}

/// Full recording info including per-device status
#[derive(Clone, PartialEq, Debug)]
pub struct RecordingInfo {
    pub status: RecordingStatus,
    pub devices: Vec<DeviceInfo>,
}

static RECORDING_INFO: Lazy<RwLock<RecordingInfo>> = Lazy::new(|| {
    RwLock::new(RecordingInfo {
        status: RecordingStatus::Starting,
        devices: Vec::new(),
    })
});

pub fn get_recording_status() -> RecordingStatus {
    RECORDING_INFO.read().unwrap_or_else(|e| e.into_inner()).status
}

pub fn get_recording_info() -> RecordingInfo {
    RECORDING_INFO.read().unwrap_or_else(|e| e.into_inner()).clone()
}

#[allow(dead_code)]
fn set_recording_status(status: RecordingStatus) {
    RECORDING_INFO.write().unwrap_or_else(|e| e.into_inner()).status = status;
}

fn set_recording_info(status: RecordingStatus, devices: Vec<DeviceInfo>) {
    let mut info = RECORDING_INFO.write().unwrap_or_else(|e| e.into_inner());
    info.status = status;
    info.devices = devices;
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct HealthCheckResponse {
    status: String,
    #[serde(default)]
    status_code: Option<i32>,
    #[serde(rename = "last_frame_timestamp")]
    last_frame_timestamp: Option<String>,
    #[serde(rename = "last_audio_timestamp")]
    last_audio_timestamp: Option<String>,
    #[serde(rename = "last_ui_timestamp", default)]
    last_ui_timestamp: Option<String>,
    #[serde(default)]
    frame_status: Option<String>,
    #[serde(default)]
    audio_status: Option<String>,
    #[serde(default)]
    ui_status: Option<String>,
    #[serde(default)]
    message: Option<String>,
    #[serde(rename = "verbose_instructions", default)]
    verbose_instructions: Option<String>,
    #[serde(default)]
    device_status_details: Option<String>,
    /// Monitor names from the server
    #[serde(default)]
    monitors: Option<Vec<String>>,
}

/// Decide recording status based on health check result and time since startup.
///
/// During the grace period, connection errors are treated as "starting up"
/// rather than errors, to avoid false-positive unhealthy indicators while
/// the recording server is still loading.
///
/// When transitioning away from Recording, we require `consecutive_failures`
/// to meet or exceed `failure_threshold` to prevent flickering caused by
/// transient timeouts or momentary server busyness.
fn decide_status(
    health_result: &Result<HealthCheckResponse>,
    elapsed_since_start: Duration,
    grace_period: Duration,
    ever_connected: bool,
    consecutive_failures: u32,
    failure_threshold: u32,
    current_status: RecordingStatus,
) -> RecordingStatus {
    match health_result {
        Ok(health) if health.status == "unhealthy" || health.status == "error" => {
            // Explicit unhealthy from the server — no debouncing needed,
            // the server itself is confirming the problem.
            RecordingStatus::Error
        }
        Ok(_) => RecordingStatus::Recording,
        Err(_) => {
            // Connection error — is the server still starting up?
            if !ever_connected && elapsed_since_start < grace_period {
                RecordingStatus::Starting
            } else if current_status == RecordingStatus::Recording
                && consecutive_failures < failure_threshold
            {
                // We were recording and haven't hit enough consecutive failures yet.
                // Hold the Recording status to avoid flickering.
                RecordingStatus::Recording
            } else {
                RecordingStatus::Stopped
            }
        }
    }
}

/// Map RecordingStatus to tray icon status string
fn status_to_icon_key(status: RecordingStatus) -> &'static str {
    match status {
        RecordingStatus::Starting => "starting",
        RecordingStatus::Recording => "healthy",
        RecordingStatus::Stopped => "error",
        RecordingStatus::Error => "unhealthy",
    }
}

/// Whether the tray icon should show the "failed" variant
fn is_unhealthy_icon(icon_key: &str) -> bool {
    icon_key == "unhealthy" || icon_key == "error"
}

/// Parse device info from a health check response for tray display.
fn parse_devices_from_health(health_result: &Result<HealthCheckResponse>) -> Vec<DeviceInfo> {
    let health = match health_result {
        Ok(h) => h,
        Err(_) => return Vec::new(),
    };

    let mut devices = Vec::new();

    // Parse monitors
    if let Some(monitors) = &health.monitors {
        for name in monitors {
            devices.push(DeviceInfo {
                name: name.clone(),
                kind: DeviceKind::Monitor,
                active: health.frame_status.as_deref() == Some("ok"),
                last_seen_secs_ago: 0,
            });
        }
    }

    // Parse audio devices from device_status_details
    // Format: "DeviceName (input): active (last activity: 2s ago), DeviceName (output): inactive (last activity: 30s ago)"
    if let Some(details) = &health.device_status_details {
        for part in details.split(", ") {
            // e.g. "MacBook Pro Microphone (input): active (last activity: 2s ago)"
            let (name_and_type, rest) = match part.split_once(": ") {
                Some(pair) => pair,
                None => continue,
            };
            let active = rest.starts_with("active");
            let last_seen = rest
                .split("last activity: ")
                .nth(1)
                .and_then(|s| s.trim_end_matches(')').trim_end_matches("s ago").parse::<u64>().ok())
                .unwrap_or(0);

            let kind = if name_and_type.contains("(input)") {
                DeviceKind::AudioInput
            } else if name_and_type.contains("(output)") {
                DeviceKind::AudioOutput
            } else {
                // Guess from name
                DeviceKind::AudioInput
            };

            let name = name_and_type
                .replace("(input)", "")
                .replace("(output)", "")
                .trim()
                .to_string();

            devices.push(DeviceInfo {
                name,
                kind,
                active,
                last_seen_secs_ago: last_seen,
            });
        }
    }

    devices
}

/// Starts a background task that periodically checks the health of the sidecar
/// and updates the tray icon accordingly.
pub async fn start_health_check(app: tauri::AppHandle) -> Result<()> {
    let mut interval = interval(Duration::from_secs(1));
    let client = reqwest::Client::new();
    let mut last_status = String::new();
    let mut last_theme = dark_light::detect().unwrap_or(Mode::Dark);
    let start_time = Instant::now();
    let mut ever_connected = false;
    let mut consecutive_failures: u32 = 0;

    tokio::spawn(async move {
        loop {
            interval.tick().await;

            let theme = dark_light::detect().unwrap_or(Mode::Dark);
            let health_result = check_health(&client).await;

            // Track if we've ever successfully connected
            if health_result.is_ok() {
                ever_connected = true;
                consecutive_failures = 0;
            } else {
                consecutive_failures = consecutive_failures.saturating_add(1);
            }

            let current_status = get_recording_status();
            let status = decide_status(
                &health_result,
                start_time.elapsed(),
                STARTUP_GRACE_PERIOD,
                ever_connected,
                consecutive_failures,
                CONSECUTIVE_FAILURES_THRESHOLD,
                current_status,
            );

            // Parse device info from health response
            let devices = parse_devices_from_health(&health_result);
            set_recording_info(status, devices);

            let current_status = status_to_icon_key(status);

            // Update icon if either health status OR theme changes
            if current_status != last_status || theme != last_theme {
                last_status = current_status.to_string();
                last_theme = theme;

                if let Some(main_tray) = app.tray_by_id("screenpipe_main") {
                    let icon_path = if is_unhealthy_icon(current_status) {
                        if theme == Mode::Light {
                            "assets/screenpipe-logo-tray-black-failed.png"
                        } else {
                            "assets/screenpipe-logo-tray-white-failed.png"
                        }
                    } else {
                        if theme == Mode::Light {
                            "assets/screenpipe-logo-tray-black.png"
                        } else {
                            "assets/screenpipe-logo-tray-white.png"
                        }
                    };

                    let icon_path = match app
                        .path()
                        .resolve(icon_path, BaseDirectory::Resource) {
                        Ok(p) => p,
                        Err(e) => {
                            error!("failed to resolve icon path: {}", e);
                            continue;
                        }
                    };

                    match tauri::image::Image::from_path(&icon_path) {
                        Ok(image) => {
                            if let Err(e) = crate::safe_icon::safe_set_icon_as_template(&main_tray, image) {
                                error!("failed to set tray icon: {}", e);
                            }
                        }
                        Err(e) => {
                            error!("failed to load tray icon from {:?}: {}", icon_path, e);
                        }
                    }
                }
            }
        }
    });

    Ok(())
}

/// Checks the health of the sidecar by making a request to its health endpoint.
/// Returns an error if the sidecar is not running or not responding.
async fn check_health(client: &reqwest::Client) -> Result<HealthCheckResponse> {
    match client
        .get("http://localhost:3030/health")
        .header("Cache-Control", "no-cache")
        .header("Pragma", "no-cache")
        .timeout(Duration::from_secs(5)) // on windows it never times out
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => response
            .json::<HealthCheckResponse>()
            .await
            .map_err(|e| anyhow::anyhow!("failed to parse sidecar response: {}", e)),
        Ok(response) => {
            anyhow::bail!("health check failed with status: {}", response.status())
        }
        Err(e) if e.is_timeout() => {
            anyhow::bail!("health check timeout, sidecar may not be running")
        }
        Err(e) if e.is_connect() => {
            anyhow::bail!("sidecar connection refused, it may not be running")
        }
        Err(e) => {
            anyhow::bail!("sidecar health check error: {}", e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_healthy_response() -> Result<HealthCheckResponse> {
        Ok(HealthCheckResponse {
            status: "healthy".to_string(),
            status_code: Some(200),
            last_frame_timestamp: None,
            last_audio_timestamp: None,
            last_ui_timestamp: None,
            frame_status: None,
            audio_status: None,
            ui_status: None,
            message: None,
            verbose_instructions: None,
            device_status_details: None,
            monitors: None,
        })
    }

    fn make_unhealthy_response() -> Result<HealthCheckResponse> {
        Ok(HealthCheckResponse {
            status: "unhealthy".to_string(),
            status_code: Some(500),
            last_frame_timestamp: None,
            last_audio_timestamp: None,
            last_ui_timestamp: None,
            frame_status: None,
            audio_status: None,
            ui_status: None,
            message: None,
            verbose_instructions: None,
            device_status_details: None,
            monitors: None,
        })
    }

    fn make_connection_error() -> Result<HealthCheckResponse> {
        Err(anyhow::anyhow!("connection refused"))
    }

    // Helper: call decide_status with default debounce params (no debouncing active)
    // Used for tests that don't care about debouncing behavior
    fn decide_no_debounce(
        health_result: &Result<HealthCheckResponse>,
        elapsed: Duration,
        grace: Duration,
        ever_connected: bool,
    ) -> RecordingStatus {
        // consecutive_failures >= threshold means debouncing won't hold Recording
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

    // ==================== decide_status tests ====================

    #[test]
    fn test_healthy_response_always_recording() {
        let result = make_healthy_response();
        // Even at 0s elapsed, a healthy response means recording
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
        // During the grace period, connection errors should show "starting"
        let result = make_connection_error();
        let status = decide_no_debounce(&result, Duration::from_secs(0), STARTUP_GRACE_PERIOD, false);
        assert_eq!(status, RecordingStatus::Starting);

        let result = make_connection_error();
        let status = decide_no_debounce(&result, Duration::from_secs(15), STARTUP_GRACE_PERIOD, false);
        assert_eq!(status, RecordingStatus::Starting);

        let result = make_connection_error();
        let status = decide_no_debounce(&result, Duration::from_secs(29), STARTUP_GRACE_PERIOD, false);
        assert_eq!(status, RecordingStatus::Starting);
    }

    #[test]
    fn test_connection_error_after_grace_period_is_stopped() {
        let result = make_connection_error();
        let status = decide_no_debounce(&result, Duration::from_secs(31), STARTUP_GRACE_PERIOD, false);
        assert_eq!(status, RecordingStatus::Stopped);

        let result = make_connection_error();
        let status = decide_no_debounce(&result, Duration::from_secs(120), STARTUP_GRACE_PERIOD, false);
        assert_eq!(status, RecordingStatus::Stopped);
    }

    #[test]
    fn test_connection_error_after_previous_connection_is_stopped() {
        // If we connected before and now get enough consecutive errors, it's stopped
        let result = make_connection_error();
        let status = decide_status(
            &result,
            Duration::from_secs(5),
            STARTUP_GRACE_PERIOD,
            true,
            CONSECUTIVE_FAILURES_THRESHOLD, // enough failures
            CONSECUTIVE_FAILURES_THRESHOLD,
            RecordingStatus::Recording,
        );
        assert_eq!(status, RecordingStatus::Stopped);
    }

    #[test]
    fn test_grace_period_boundary() {
        let grace = Duration::from_secs(30);

        // Exactly at boundary = still within grace
        let result = make_connection_error();
        let status = decide_no_debounce(&result, Duration::from_secs(29), grace, false);
        assert_eq!(status, RecordingStatus::Starting);

        // One second past = no longer in grace
        let result = make_connection_error();
        let status = decide_no_debounce(&result, Duration::from_secs(30), grace, false);
        assert_eq!(status, RecordingStatus::Stopped);
    }

    // ==================== debouncing / anti-flicker tests ====================

    #[test]
    fn test_single_failure_while_recording_holds_recording() {
        // THE KEY FIX: a single transient failure should NOT flip to Stopped
        let result = make_connection_error();
        let status = decide_status(
            &result,
            Duration::from_secs(60),
            STARTUP_GRACE_PERIOD,
            true,
            1, // only 1 consecutive failure
            CONSECUTIVE_FAILURES_THRESHOLD,
            RecordingStatus::Recording,
        );
        assert_eq!(status, RecordingStatus::Recording,
            "single failure while recording should NOT flip to Stopped");
    }

    #[test]
    fn test_two_failures_while_recording_holds_recording() {
        // 2 failures < threshold of 3 — still hold Recording
        let result = make_connection_error();
        let status = decide_status(
            &result,
            Duration::from_secs(60),
            STARTUP_GRACE_PERIOD,
            true,
            2,
            CONSECUTIVE_FAILURES_THRESHOLD,
            RecordingStatus::Recording,
        );
        assert_eq!(status, RecordingStatus::Recording,
            "two failures while recording should NOT flip to Stopped");
    }

    #[test]
    fn test_threshold_failures_while_recording_transitions_to_stopped() {
        // Exactly at threshold — now we transition
        let result = make_connection_error();
        let status = decide_status(
            &result,
            Duration::from_secs(60),
            STARTUP_GRACE_PERIOD,
            true,
            CONSECUTIVE_FAILURES_THRESHOLD,
            CONSECUTIVE_FAILURES_THRESHOLD,
            RecordingStatus::Recording,
        );
        assert_eq!(status, RecordingStatus::Stopped,
            "should transition to Stopped after reaching failure threshold");
    }

    #[test]
    fn test_debounce_does_not_apply_when_not_recording() {
        // If we're already Stopped, failures don't get debounced
        let result = make_connection_error();
        let status = decide_status(
            &result,
            Duration::from_secs(60),
            STARTUP_GRACE_PERIOD,
            true,
            1, // even just 1 failure
            CONSECUTIVE_FAILURES_THRESHOLD,
            RecordingStatus::Stopped, // already stopped
        );
        assert_eq!(status, RecordingStatus::Stopped);
    }

    #[test]
    fn test_healthy_response_resets_after_failures() {
        // After failures, a healthy response immediately restores Recording
        let result = make_healthy_response();
        let status = decide_status(
            &result,
            Duration::from_secs(60),
            STARTUP_GRACE_PERIOD,
            true,
            2, // had some failures
            CONSECUTIVE_FAILURES_THRESHOLD,
            RecordingStatus::Recording,
        );
        assert_eq!(status, RecordingStatus::Recording);
    }

    #[test]
    fn test_unhealthy_response_bypasses_debounce() {
        // An explicit "unhealthy" from the server should always be Error,
        // regardless of debounce state
        let result = make_unhealthy_response();
        let status = decide_status(
            &result,
            Duration::from_secs(60),
            STARTUP_GRACE_PERIOD,
            true,
            0, // no failures yet
            CONSECUTIVE_FAILURES_THRESHOLD,
            RecordingStatus::Recording,
        );
        assert_eq!(status, RecordingStatus::Error,
            "explicit unhealthy should bypass debounce");
    }

    #[test]
    fn test_flicker_scenario_simulation() {
        // Simulate the exact scenario from the user report:
        // Server is running, but under load causes intermittent timeouts
        let grace = Duration::from_secs(30);
        let threshold = CONSECUTIVE_FAILURES_THRESHOLD;
        let mut current = RecordingStatus::Recording;
        let mut consecutive_failures: u32 = 0;

        // tick 1: healthy
        let status = decide_status(&make_healthy_response(), Duration::from_secs(60), grace, true, 0, threshold, current);
        assert_eq!(status, RecordingStatus::Recording);
        current = status;
        consecutive_failures = 0;

        // tick 2: timeout (failure 1)
        consecutive_failures += 1;
        let status = decide_status(&make_connection_error(), Duration::from_secs(61), grace, true, consecutive_failures, threshold, current);
        assert_eq!(status, RecordingStatus::Recording, "tick 2: should hold Recording after 1 failure");
        current = status;

        // tick 3: healthy again — reset
        consecutive_failures = 0;
        let status = decide_status(&make_healthy_response(), Duration::from_secs(62), grace, true, consecutive_failures, threshold, current);
        assert_eq!(status, RecordingStatus::Recording, "tick 3: healthy again");
        current = status;

        // tick 4: timeout (failure 1)
        consecutive_failures += 1;
        let status = decide_status(&make_connection_error(), Duration::from_secs(63), grace, true, consecutive_failures, threshold, current);
        assert_eq!(status, RecordingStatus::Recording, "tick 4: should hold Recording");
        current = status;

        // tick 5: timeout (failure 2)
        consecutive_failures += 1;
        let status = decide_status(&make_connection_error(), Duration::from_secs(64), grace, true, consecutive_failures, threshold, current);
        assert_eq!(status, RecordingStatus::Recording, "tick 5: should still hold Recording");
        current = status;

        // tick 6: healthy — all good
        consecutive_failures = 0;
        let status = decide_status(&make_healthy_response(), Duration::from_secs(65), grace, true, consecutive_failures, threshold, current);
        assert_eq!(status, RecordingStatus::Recording, "tick 6: healthy");

        // The user would have seen NO flickering through this whole sequence!
    }

    #[test]
    fn test_real_crash_still_detected() {
        // Server truly crashes — consecutive failures exceed threshold
        let grace = Duration::from_secs(30);
        let threshold = CONSECUTIVE_FAILURES_THRESHOLD;
        let mut current = RecordingStatus::Recording;

        // Failure 1
        let status = decide_status(&make_connection_error(), Duration::from_secs(60), grace, true, 1, threshold, current);
        assert_eq!(status, RecordingStatus::Recording);
        current = status;

        // Failure 2
        let status = decide_status(&make_connection_error(), Duration::from_secs(61), grace, true, 2, threshold, current);
        assert_eq!(status, RecordingStatus::Recording);
        current = status;

        // Failure 3 — at threshold, transitions
        let status = decide_status(&make_connection_error(), Duration::from_secs(62), grace, true, 3, threshold, current);
        assert_eq!(status, RecordingStatus::Stopped, "should detect real crash after threshold failures");
    }

    // ==================== icon mapping tests ====================

    #[test]
    fn test_starting_shows_healthy_icon() {
        let key = status_to_icon_key(RecordingStatus::Starting);
        assert_eq!(key, "starting");
        assert!(!is_unhealthy_icon(key));
    }

    #[test]
    fn test_recording_shows_healthy_icon() {
        let key = status_to_icon_key(RecordingStatus::Recording);
        assert_eq!(key, "healthy");
        assert!(!is_unhealthy_icon(key));
    }

    #[test]
    fn test_stopped_shows_failed_icon() {
        let key = status_to_icon_key(RecordingStatus::Stopped);
        assert_eq!(key, "error");
        assert!(is_unhealthy_icon(key));
    }

    #[test]
    fn test_error_shows_failed_icon() {
        let key = status_to_icon_key(RecordingStatus::Error);
        assert_eq!(key, "unhealthy");
        assert!(is_unhealthy_icon(key));
    }

    // ==================== realistic boot sequence simulation ====================

    #[test]
    fn test_boot_sequence_no_false_positive() {
        let grace = Duration::from_secs(30);

        // t=0s: first health check, server not started yet
        let status = decide_no_debounce(&make_connection_error(), Duration::from_secs(0), grace, false);
        assert_eq!(status, RecordingStatus::Starting);
        assert!(!is_unhealthy_icon(status_to_icon_key(status)), "should NOT show failed icon at boot");

        // t=1s: still starting
        let status = decide_no_debounce(&make_connection_error(), Duration::from_secs(1), grace, false);
        assert_eq!(status, RecordingStatus::Starting);
        assert!(!is_unhealthy_icon(status_to_icon_key(status)));

        // t=5s: server is up, healthy response
        let status = decide_no_debounce(&make_healthy_response(), Duration::from_secs(5), grace, false);
        assert_eq!(status, RecordingStatus::Recording);
        assert!(!is_unhealthy_icon(status_to_icon_key(status)));
    }

    #[test]
    fn test_server_crash_after_boot_shows_error() {
        let grace = Duration::from_secs(30);

        // Server was healthy, now crashes — after threshold failures
        let status = decide_status(
            &make_connection_error(),
            Duration::from_secs(60),
            grace,
            true,
            CONSECUTIVE_FAILURES_THRESHOLD,
            CONSECUTIVE_FAILURES_THRESHOLD,
            RecordingStatus::Recording,
        );
        assert_eq!(status, RecordingStatus::Stopped);
        assert!(is_unhealthy_icon(status_to_icon_key(status)), "should show failed icon after crash");
    }

    #[test]
    fn test_server_never_starts_shows_error_after_grace() {
        let grace = Duration::from_secs(30);

        // Server never starts — after grace period, show the error
        let status = decide_no_debounce(&make_connection_error(), Duration::from_secs(35), grace, false);
        assert_eq!(status, RecordingStatus::Stopped);
        assert!(is_unhealthy_icon(status_to_icon_key(status)), "should show failed icon if server never started");
    }
}
