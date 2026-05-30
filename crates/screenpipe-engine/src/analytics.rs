use once_cell::sync::Lazy;
use reqwest::Client;
use serde_json::{json, Map, Value};
use std::env;
use std::sync::atomic::{AtomicBool, Ordering};
use tracing::{debug, trace};

#[cfg(target_os = "macos")]
use sysinfo::{System, SystemExt};
#[cfg(target_os = "macos")]
use tracing::warn;

const POSTHOG_API_KEY: &str = "phc_z7FZXE8vmXtdTQ78LMy3j1BQWW4zP6PGDUP46rgcdnb";
const POSTHOG_HOST: &str = "https://us.i.posthog.com";
const OTLP_LOGS_PATH: &str = "/v1/logs";

static TELEMETRY_ENABLED: AtomicBool = AtomicBool::new(false);

static ANALYTICS: Lazy<Analytics> = Lazy::new(Analytics::new);

pub struct Analytics {
    client: Client,
    distinct_id: String,
    user_posthog: Option<UserPostHogConfig>,
    otlp: Option<OtlpConfig>,
}

#[derive(Clone, Debug)]
struct UserPostHogConfig {
    api_key: String,
    host: String,
}

#[derive(Clone, Debug)]
struct OtlpConfig {
    logs_endpoint: String,
    service_name: String,
    resource_attributes: Vec<(String, String)>,
    headers: Vec<(String, String)>,
}

impl Analytics {
    fn new() -> Self {
        // Try to get analytics ID from env var (passed from Tauri app)
        // Fall back to random UUID for standalone CLI usage
        let distinct_id = env::var("SCREENPIPE_ANALYTICS_ID")
            .unwrap_or_else(|_| uuid::Uuid::new_v4().to_string());

        let user_posthog = user_posthog_config();
        let otlp = otlp_config();

        debug!(
            "Analytics initialized with distinct_id: {}, user_posthog: {}, otlp: {}",
            distinct_id,
            user_posthog.is_some(),
            otlp.is_some()
        );

        Self {
            client: Client::new(),
            distinct_id,
            user_posthog,
            otlp,
        }
    }

    pub fn distinct_id(&self) -> &str {
        &self.distinct_id
    }
}

/// Initialize analytics with telemetry enabled/disabled.
///
/// Screenpipe-owned product analytics still obey the existing opt-in flag. User-configured
/// observability sinks are controlled only by their own env vars so self-hosted operators can
/// keep operational telemetry even when product analytics is disabled.
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

/// Capture an operational analytics event.
///
/// Existing Screenpipe PostHog telemetry is sent only when the user opted in. User-configured
/// PostHog and OTLP sinks mirror the same operational event when their env vars are present.
pub async fn capture_event(event: &str, properties: Value) {
    let screenpipe_telemetry_enabled = TELEMETRY_ENABLED.load(Ordering::SeqCst);
    let has_user_sink = ANALYTICS.user_posthog.is_some() || ANALYTICS.otlp.is_some();
    if !screenpipe_telemetry_enabled && !has_user_sink {
        return;
    }

    let props = enrich_properties(properties);

    trace!(target: "analytics", "Capturing event: {} {:?}", event, props);

    let client = &ANALYTICS.client;

    if screenpipe_telemetry_enabled {
        send_posthog_event(client, POSTHOG_HOST, POSTHOG_API_KEY, event, props.clone()).await;
    }

    if let Some(config) = ANALYTICS.user_posthog.clone() {
        send_posthog_event(client, &config.host, &config.api_key, event, props.clone()).await;
    }

    if let Some(config) = ANALYTICS.otlp.clone() {
        send_otlp_event(client, &config, event, props).await;
    }
}

/// Capture event without blocking (fire and forget)
pub fn capture_event_nonblocking(event: &'static str, properties: Value) {
    let screenpipe_telemetry_enabled = TELEMETRY_ENABLED.load(Ordering::SeqCst);
    let has_user_sink = ANALYTICS.user_posthog.is_some() || ANALYTICS.otlp.is_some();
    if !screenpipe_telemetry_enabled && !has_user_sink {
        return;
    }

    tokio::spawn(async move {
        capture_event(event, properties).await;
    });
}

fn enrich_properties(mut properties: Value) -> Value {
    if let Some(obj) = properties.as_object_mut() {
        obj.insert("distinct_id".to_string(), json!(ANALYTICS.distinct_id));
        obj.insert("$lib".to_string(), json!("screenpipe-engine"));
        obj.insert("release".to_string(), json!(env!("CARGO_PKG_VERSION")));
    }
    properties
}

async fn send_posthog_event(client: &Client, host: &str, api_key: &str, event: &str, props: Value) {
    let payload = json!({
        "api_key": api_key,
        "event": event,
        "properties": props,
    });

    if let Err(e) = client
        .post(format!("{}/capture/", host.trim_end_matches('/')))
        .json(&payload)
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
    {
        debug!("failed to send PostHog analytics event to {}: {}", host, e);
    }
}

async fn send_otlp_event(client: &Client, config: &OtlpConfig, event: &str, props: Value) {
    let mut attributes = vec![
        otlp_attribute("event.name", Value::String(event.to_string())),
        otlp_attribute("screenpipe.signal", Value::String("event".to_string())),
    ];

    if let Some(obj) = props.as_object() {
        for (key, value) in obj {
            attributes.push(otlp_attribute(
                &format!("screenpipe.{}", sanitize_attr_key(key)),
                value.clone(),
            ));
        }
    }

    let payload = json!({
        "resourceLogs": [{
            "resource": {
                "attributes": resource_attributes(config),
            },
            "scopeLogs": [{
                "scope": {
                    "name": "screenpipe-engine",
                    "version": env!("CARGO_PKG_VERSION"),
                },
                "logRecords": [{
                    "timeUnixNano": unix_time_nanos(),
                    "severityText": "INFO",
                    "body": { "stringValue": event },
                    "attributes": attributes,
                }]
            }]
        }]
    });

    let mut req = client
        .post(&config.logs_endpoint)
        .json(&payload)
        .timeout(std::time::Duration::from_secs(5));
    for (key, value) in &config.headers {
        req = req.header(key, value);
    }

    if let Err(e) = req.send().await {
        debug!(
            "failed to send OTLP analytics event to {}: {}",
            config.logs_endpoint, e
        );
    }
}

fn user_posthog_config() -> Option<UserPostHogConfig> {
    let api_key = env::var("SCREENPIPE_USER_POSTHOG_KEY")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())?;
    let host = env::var("SCREENPIPE_USER_POSTHOG_HOST")
        .ok()
        .map(|v| v.trim().trim_end_matches('/').to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| POSTHOG_HOST.to_string());

    Some(UserPostHogConfig { api_key, host })
}

fn otlp_config() -> Option<OtlpConfig> {
    let logs_endpoint = env::var("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .or_else(|| {
            env::var("OTEL_EXPORTER_OTLP_ENDPOINT")
                .ok()
                .filter(|v| !v.trim().is_empty())
                .map(|endpoint| format!("{}{}", endpoint.trim_end_matches('/'), OTLP_LOGS_PATH))
        })?;

    let service_name = env::var("OTEL_SERVICE_NAME")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| "screenpipe".to_string());

    let mut resource_attributes = parse_key_value_list(
        &env::var("OTEL_RESOURCE_ATTRIBUTES").unwrap_or_default(),
        ',',
    );
    if !resource_attributes
        .iter()
        .any(|(key, _)| key == "service.name")
    {
        resource_attributes.push(("service.name".to_string(), service_name.clone()));
    }
    resource_attributes.push((
        "service.version".to_string(),
        env!("CARGO_PKG_VERSION").to_string(),
    ));

    let headers = parse_key_value_list(
        &env::var("OTEL_EXPORTER_OTLP_HEADERS").unwrap_or_default(),
        ',',
    );

    Some(OtlpConfig {
        logs_endpoint: logs_endpoint.trim().to_string(),
        service_name,
        resource_attributes,
        headers,
    })
}

fn parse_key_value_list(input: &str, separator: char) -> Vec<(String, String)> {
    input
        .split(separator)
        .filter_map(|pair| {
            let (key, value) = pair.split_once('=')?;
            let key = key.trim();
            if key.is_empty() {
                return None;
            }
            Some((key.to_string(), value.trim().to_string()))
        })
        .collect()
}

fn resource_attributes(config: &OtlpConfig) -> Vec<Value> {
    let mut attrs: Vec<Value> = config
        .resource_attributes
        .iter()
        .map(|(key, value)| otlp_attribute(key, Value::String(value.clone())))
        .collect();
    attrs.push(otlp_attribute(
        "telemetry.sdk.language",
        Value::String("rust".to_string()),
    ));
    attrs.push(otlp_attribute(
        "screenpipe.service_name",
        Value::String(config.service_name.clone()),
    ));
    attrs
}

fn otlp_attribute(key: &str, value: Value) -> Value {
    json!({
        "key": key,
        "value": otlp_any_value(value),
    })
}

fn otlp_any_value(value: Value) -> Value {
    match value {
        Value::Bool(v) => json!({ "boolValue": v }),
        Value::Number(n) => {
            if let Some(v) = n.as_i64() {
                json!({ "intValue": v.to_string() })
            } else if let Some(v) = n.as_u64() {
                json!({ "intValue": v.to_string() })
            } else if let Some(v) = n.as_f64() {
                json!({ "doubleValue": v })
            } else {
                json!({ "stringValue": n.to_string() })
            }
        }
        Value::String(v) => json!({ "stringValue": v }),
        Value::Array(values) => json!({
            "arrayValue": {
                "values": values.into_iter().map(otlp_any_value).collect::<Vec<_>>()
            }
        }),
        Value::Object(obj) => json!({ "kvlistValue": { "values": otlp_kv_list(obj) } }),
        Value::Null => json!({ "stringValue": "" }),
    }
}

fn otlp_kv_list(obj: Map<String, Value>) -> Vec<Value> {
    obj.into_iter()
        .map(|(key, value)| otlp_attribute(&sanitize_attr_key(&key), value))
        .collect()
}

fn sanitize_attr_key(key: &str) -> String {
    key.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn unix_time_nanos() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos().to_string())
        .unwrap_or_else(|_| "0".to_string())
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
