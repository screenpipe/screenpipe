use once_cell::sync::Lazy;
use reqwest::Client;
use serde_json::{json, Value};
use std::env;
use std::sync::atomic::{AtomicBool, Ordering};
use tracing::{debug, trace};

#[cfg(target_os = "macos")]
use sysinfo::{System, SystemExt};
#[cfg(target_os = "macos")]
use tracing::warn;

const POSTHOG_API_KEY: &str = "phc_Bt8GoTBPgkCpDrbaIZzJIEYt0CrJjhBiuLaBck1clce";
const POSTHOG_HOST: &str = "https://eu.i.posthog.com";

static TELEMETRY_ENABLED: AtomicBool = AtomicBool::new(false);

static ANALYTICS: Lazy<Analytics> = Lazy::new(Analytics::new);

pub struct Analytics {
    client: Client,
    distinct_id: String,
}

impl Analytics {
    fn new() -> Self {
        // Try to get analytics ID from env var (passed from Tauri app)
        // Fall back to random UUID for standalone CLI usage
        let distinct_id = env::var("SCREENPIPE_ANALYTICS_ID")
            .unwrap_or_else(|_| uuid::Uuid::new_v4().to_string());

        debug!("Analytics initialized with distinct_id: {}", distinct_id);

        Self {
            client: Client::new(),
            distinct_id,
        }
    }

    pub fn distinct_id(&self) -> &str {
        &self.distinct_id
    }
}

/// Initialize analytics with telemetry enabled/disabled
pub fn init(telemetry_enabled: bool) {
    TELEMETRY_ENABLED.store(telemetry_enabled, Ordering::SeqCst);
    // Force lazy initialization
    let _ = &*ANALYTICS;
    debug!(
        "Analytics initialized, telemetry_enabled: {}",
        telemetry_enabled
    );
}

/// Get the current distinct_id
pub fn get_distinct_id() -> &'static str {
    ANALYTICS.distinct_id()
}

/// Capture an analytics event
pub async fn capture_event(event: &str, properties: Value) {
    if !TELEMETRY_ENABLED.load(Ordering::SeqCst) {
        return;
    }

    let mut props = properties;
    if let Some(obj) = props.as_object_mut() {
        obj.insert("distinct_id".to_string(), json!(ANALYTICS.distinct_id));
        obj.insert("$lib".to_string(), json!("screenpipe-engine"));
        obj.insert("release".to_string(), json!(env!("CARGO_PKG_VERSION")));
    }

    let payload = json!({
        "api_key": POSTHOG_API_KEY,
        "event": event,
        "properties": props,
    });

    trace!(target: "analytics", "Capturing event: {} {:?}", event, payload);

    let client = &ANALYTICS.client;
    if let Err(e) = client
        .post(format!("{}/capture/", POSTHOG_HOST))
        .json(&payload)
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
    {
        debug!("failed to send analytics event: {}", e);
    }
}

/// Capture event without blocking (fire and forget)
pub fn capture_event_nonblocking(event: &'static str, properties: Value) {
    if !TELEMETRY_ENABLED.load(Ordering::SeqCst) {
        return;
    }

    tokio::spawn(async move {
        capture_event(event, properties).await;
    });
}

/// Parse macOS version string (e.g., "14.5" or "10.15.7") into major version number
#[cfg(target_os = "macos")]
fn parse_macos_major_version(version_str: &str) -> Option<u32> {
    version_str.split('.').next()?.parse().ok()
}

/// Check macOS version and send telemetry event if below recommended versions.
/// This helps track users on older macOS versions that may have compatibility issues.
///
/// Thresholds:
/// - Below 12 (Monterey): ScreenCaptureKit not available at all
/// - Below 14 (Sonoma): sck-rs may have issues, recommended to upgrade
#[cfg(target_os = "macos")]
pub fn check_macos_version() {
    if !TELEMETRY_ENABLED.load(Ordering::SeqCst) {
        return;
    }

    let sys = System::new();
    let os_version = sys.os_version().unwrap_or_default();
    let os_name = sys.name().unwrap_or_default();

    // Only check on macOS
    if !os_name.to_lowercase().contains("mac") {
        return;
    }

    let major_version = match parse_macos_major_version(&os_version) {
        Some(v) => v,
        None => {
            debug!("Could not parse macOS version: {}", os_version);
            return;
        }
    };

    // Determine version category
    let (below_12, below_14) = (major_version < 12, major_version < 14);

    if !below_12 && !below_14 {
        debug!("macOS version {} is supported", os_version);
        return;
    }

    // Log warning for user
    if below_12 {
        warn!(
            "macOS {} detected. Screen recording requires macOS 12.3+ (Monterey). \
            Please upgrade your macOS for screen capture to work.",
            os_version
        );
    } else if below_14 {
        warn!(
            "macOS {} detected. For best screen capture performance, \
            macOS 14+ (Sonoma) is recommended.",
            os_version
        );
    }

    // Send telemetry event
    let event_name: &'static str = if below_12 {
        "macos_version_below_12"
    } else {
        "macos_version_below_14"
    };

    capture_event_nonblocking(
        event_name,
        json!({
            "os_version": os_version,
            "major_version": major_version,
            "below_12": below_12,
            "below_14": below_14,
            "screen_capture_supported": !below_12,
        }),
    );

    debug!("Sent {} event for macOS {}", event_name, os_version);
}

/// No-op on non-macOS platforms
#[cfg(not(target_os = "macos"))]
pub fn check_macos_version() {
    // Only relevant on macOS
}

/// Track API usage (called periodically from the server router).
/// Fires a PostHog event with the number of API requests in the last interval.
pub fn track_api_usage(request_count: usize) {
    capture_event_nonblocking(
        "api_usage_5min",
        json!({
            "request_count": request_count,
        }),
    );
}
