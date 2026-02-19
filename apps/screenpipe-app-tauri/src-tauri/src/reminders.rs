//! Apple Reminders integration — Tauri commands + background scheduler.
//!
//! Provides typed commands for the frontend to check auth, authorize,
//! create reminders, list them, and trigger AI scans.
//! Background scheduler runs every 30 min (persists across page navigations).
//! All EventKit calls go through `spawn_blocking` (EKEventStore is !Send).

use serde::{Deserialize, Serialize};
use specta::Type;
use std::sync::Arc;
use tauri::AppHandle;
use tokio::sync::Mutex;
use tracing::{debug, error, info, warn};

use crate::store::RemindersSettingsStore;

// ─── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RemindersStatus {
    pub available: bool,
    pub authorized: bool,
    pub authorization_status: String,
    pub scheduler_running: bool,
    pub reminder_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReminderItem {
    pub identifier: String,
    pub title: String,
    pub notes: Option<String>,
    pub completed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub reminders_created: usize,
    pub items: Vec<ReminderItem>,
    pub context_chars: usize,
    pub error: Option<String>,
}

// ─── Managed state ──────────────────────────────────────────────────────────

pub struct RemindersState {
    pub scheduler_handle: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
}

impl RemindersState {
    pub fn new() -> Self {
        Self {
            scheduler_handle: Arc::new(Mutex::new(None)),
        }
    }
}

// ─── Commands ───────────────────────────────────────────────────────────────

/// Check Reminders authorization + scheduler status (no popup).
#[tauri::command]
#[specta::specta]
pub async fn reminders_status(
    _app: AppHandle,
    state: tauri::State<'_, RemindersState>,
) -> Result<RemindersStatus, String> {
    #[cfg(target_os = "macos")]
    {
        use screenpipe_integrations::reminders::ScreenpipeReminders;

        let auth_status = ScreenpipeReminders::authorization_status();
        let status_str = format!("{}", auth_status);
        let authorized = status_str == "Full Access";

        let scheduler_running = state.scheduler_handle.lock().await.is_some();

        let reminder_count = if authorized {
            tokio::task::spawn_blocking(|| {
                let r = ScreenpipeReminders::new();
                let _ = r.ensure_list("Screenpipe");
                r.list_reminders(Some("Screenpipe"))
                    .map(|items| items.len() as u32)
                    .unwrap_or(0)
            })
            .await
            .unwrap_or(0)
        } else {
            0
        };

        Ok(RemindersStatus {
            available: true,
            authorized,
            authorization_status: status_str,
            scheduler_running,
            reminder_count,
        })
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (_app, state);
        Ok(RemindersStatus {
            available: false,
            authorized: false,
            authorization_status: "not_supported".into(),
            scheduler_running: false,
            reminder_count: 0,
        })
    }
}

/// Request Reminders permission (shows one-time macOS popup).
/// Returns "granted", "denied", or an error message.
#[tauri::command]
#[specta::specta]
pub async fn reminders_authorize() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        use screenpipe_integrations::reminders::ScreenpipeReminders;
        let result = tokio::task::spawn_blocking(|| {
            let r = ScreenpipeReminders::new();
            r.request_access()
        })
        .await
        .map_err(|e| format!("task failed: {}", e))?;

        match result {
            Ok(true) => {
                info!("reminders: user granted access");
                Ok("granted".into())
            }
            Ok(false) => {
                warn!("reminders: user denied access");
                Ok("denied".into())
            }
            Err(e) => Err(format!("{}", e)),
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err("only available on macOS".into())
    }
}

/// List existing reminders in the "Screenpipe" list.
#[tauri::command]
#[specta::specta]
pub async fn reminders_list() -> Result<Vec<ReminderItem>, String> {
    #[cfg(target_os = "macos")]
    {
        use screenpipe_integrations::reminders::ScreenpipeReminders;
        tokio::task::spawn_blocking(|| {
            let r = ScreenpipeReminders::new();
            let _ = r.ensure_list("Screenpipe");
            let items = r
                .list_reminders(Some("Screenpipe"))
                .map_err(|e| format!("{}", e))?;
            Ok(items
                .into_iter()
                .map(|i| ReminderItem {
                    identifier: i.identifier,
                    title: i.title,
                    notes: i.notes,
                    completed: i.completed,
                })
                .collect())
        })
        .await
        .map_err(|e| format!("task failed: {}", e))?
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err("only available on macOS".into())
    }
}

/// Create a single reminder.
#[tauri::command]
#[specta::specta]
pub async fn reminders_create(
    title: String,
    notes: Option<String>,
    due: Option<String>,
) -> Result<ReminderItem, String> {
    #[cfg(target_os = "macos")]
    {
        use screenpipe_integrations::reminders::ScreenpipeReminders;
        tokio::task::spawn_blocking(move || {
            let r = ScreenpipeReminders::new();
            let _ = r.ensure_list("Screenpipe");
            let item = r
                .create_reminder(&title, notes.as_deref(), Some("Screenpipe"), due.as_deref())
                .map_err(|e| format!("{}", e))?;
            Ok(ReminderItem {
                identifier: item.identifier,
                title: item.title,
                notes: item.notes,
                completed: item.completed,
            })
        })
        .await
        .map_err(|e| format!("task failed: {}", e))?
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (title, notes, due);
        Err("only available on macOS".into())
    }
}

/// Scan recent activity and create reminders from action items.
/// Optional custom_prompt appended to the AI instructions.
#[tauri::command]
#[specta::specta]
pub async fn reminders_scan(custom_prompt: Option<String>, audio_only: Option<bool>) -> Result<ScanResult, String> {
    #[cfg(target_os = "macos")]
    {
        do_scan(custom_prompt.as_deref(), audio_only.unwrap_or(true)).await
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (custom_prompt, audio_only);
        Err("only available on macOS".into())
    }
}

/// Get the saved custom prompt.
#[tauri::command]
#[specta::specta]
pub async fn reminders_get_custom_prompt(app: AppHandle) -> Result<String, String> {
    Ok(RemindersSettingsStore::get(&app)?
        .map(|s| s.custom_prompt)
        .unwrap_or_default())
}

/// Save a custom prompt.
#[tauri::command]
#[specta::specta]
pub async fn reminders_set_custom_prompt(app: AppHandle, prompt: String) -> Result<(), String> {
    let mut settings = RemindersSettingsStore::get(&app)?.unwrap_or(RemindersSettingsStore {
        enabled: false,
        custom_prompt: String::new(),
        audio_only: true,
    });
    settings.custom_prompt = prompt;
    settings.save(&app)
}

/// Get the audio_only setting.
#[tauri::command]
#[specta::specta]
pub async fn reminders_get_audio_only(app: AppHandle) -> Result<bool, String> {
    Ok(RemindersSettingsStore::get(&app)?
        .map(|s| s.audio_only)
        .unwrap_or(true))
}

/// Set the audio_only setting.
#[tauri::command]
#[specta::specta]
pub async fn reminders_set_audio_only(app: AppHandle, audio_only: bool) -> Result<(), String> {
    let mut settings = RemindersSettingsStore::get(&app)?.unwrap_or(RemindersSettingsStore {
        enabled: false,
        custom_prompt: String::new(),
        audio_only: true,
    });
    settings.audio_only = audio_only;
    settings.save(&app)
}

/// Start the background scheduler (30-min interval). Persists across page navigation.
/// Saves enabled=true to persistent store so it auto-starts on app relaunch.
#[tauri::command]
#[specta::specta]
pub async fn reminders_start_scheduler(
    app: AppHandle,
    state: tauri::State<'_, RemindersState>,
) -> Result<(), String> {
    // Stop existing if any
    reminders_stop_scheduler(state.clone()).await?;

    // Preserve custom_prompt, set enabled
    let mut settings = RemindersSettingsStore::get(&app)?.unwrap_or(RemindersSettingsStore {
        enabled: false,
        custom_prompt: String::new(),
        audio_only: true,
    });
    settings.enabled = true;
    settings.save(&app)?;

    let custom_prompt = if settings.custom_prompt.is_empty() {
        None
    } else {
        Some(settings.custom_prompt.clone())
    };
    let audio_only = settings.audio_only;

    let handle_arc = state.scheduler_handle.clone();

    let handle = tokio::spawn(async move {
        info!("reminders scheduler: started (30-min interval)");
        let interval = tokio::time::Duration::from_secs(30 * 60);

        // Wait before first scan
        tokio::time::sleep(interval).await;

        loop {
            info!("reminders scheduler: running scan");
            #[cfg(target_os = "macos")]
            match do_scan(custom_prompt.as_deref(), audio_only).await {
                Ok(result) => {
                    if result.reminders_created > 0 {
                        info!(
                            "reminders scheduler: created {} reminders",
                            result.reminders_created
                        );
                    }
                    if let Some(err) = &result.error {
                        warn!("reminders scheduler: {}", err);
                    }
                }
                Err(e) => {
                    error!("reminders scheduler: scan failed: {}", e);
                }
            }

            tokio::time::sleep(interval).await;
        }
    });

    let mut guard = handle_arc.lock().await;
    *guard = Some(handle);
    info!("reminders scheduler: registered");

    Ok(())
}

/// Stop the background scheduler. Saves enabled=false to persistent store.
#[tauri::command]
#[specta::specta]
pub async fn reminders_stop_scheduler(
    state: tauri::State<'_, RemindersState>,
) -> Result<(), String> {
    let mut handle = state.scheduler_handle.lock().await;
    if let Some(h) = handle.take() {
        h.abort();
        info!("reminders scheduler: stopped");
    }
    Ok(())
}

/// Auto-start the scheduler on app launch if previously enabled.
pub async fn auto_start_scheduler(app: AppHandle, state: &RemindersState) {
    match RemindersSettingsStore::get(&app) {
        Ok(Some(settings)) if settings.enabled => {
            info!("reminders: auto-starting scheduler from saved settings");

            // Verify still authorized
            #[cfg(target_os = "macos")]
            {
                use screenpipe_integrations::reminders::ScreenpipeReminders;
                let status = ScreenpipeReminders::authorization_status();
                if format!("{}", status) != "Full Access" {
                    warn!(
                        "reminders: skipping auto-start, not authorized ({})",
                        status
                    );
                    return;
                }
            }

            let custom_prompt = if settings.custom_prompt.is_empty() {
                None
            } else {
                Some(settings.custom_prompt.clone())
            };
            let audio_only = settings.audio_only;

            let handle_arc = state.scheduler_handle.clone();
            let handle = tokio::spawn(async move {
                info!("reminders scheduler: auto-started (30-min interval)");
                let interval = tokio::time::Duration::from_secs(30 * 60);
                tokio::time::sleep(interval).await;

                loop {
                    info!("reminders scheduler: running scan");
                    #[cfg(target_os = "macos")]
                    match do_scan(custom_prompt.as_deref(), audio_only).await {
                        Ok(result) => {
                            if result.reminders_created > 0 {
                                info!(
                                    "reminders scheduler: created {} reminders",
                                    result.reminders_created
                                );
                            }
                            if let Some(err) = &result.error {
                                warn!("reminders scheduler: {}", err);
                            }
                        }
                        Err(e) => {
                            error!("reminders scheduler: scan failed: {}", e);
                        }
                    }

                    tokio::time::sleep(interval).await;
                }
            });

            let mut guard = handle_arc.lock().await;
            *guard = Some(handle);
        }
        _ => {
            debug!("reminders: auto-start skipped (not enabled)");
        }
    }
}

// ─── Scan implementation ────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
async fn do_scan(custom_prompt: Option<&str>, audio_only: bool) -> Result<ScanResult, String> {
    use screenpipe_integrations::reminders::ScreenpipeReminders;

    // 1. Check authorization
    let status = ScreenpipeReminders::authorization_status();
    if format!("{}", status) != "Full Access" {
        return Ok(ScanResult {
            reminders_created: 0,
            items: vec![],
            context_chars: 0,
            error: Some(format!("Reminders not authorized: {}", status)),
        });
    }

    // 2. Check AI availability
    let ai_available = check_ai_available().await;
    if !ai_available {
        return Ok(ScanResult {
            reminders_created: 0,
            items: vec![],
            context_chars: 0,
            error: Some("Apple Intelligence not available".into()),
        });
    }

    // 3. Fetch recent data from screenpipe API
    let context = fetch_recent_context(audio_only).await?;
    if context.is_empty() {
        return Ok(ScanResult {
            reminders_created: 0,
            items: vec![],
            context_chars: 0,
            error: None,
        });
    }

    let context_chars = context.len();
    info!("reminders scan: {} chars of context", context_chars);

    // 4. Call Apple Intelligence
    let ai_response = call_ai_for_reminders(&context, custom_prompt).await?;

    // 5. Parse action items
    let action_items = parse_action_items(&ai_response);
    if action_items.is_empty() {
        debug!("reminders scan: no action items found");
        return Ok(ScanResult {
            reminders_created: 0,
            items: vec![],
            context_chars,
            error: None,
        });
    }

    info!("reminders scan: found {} action items", action_items.len());

    // 6. Deduplicate + create (all in spawn_blocking — EKEventStore is !Send)
    let created = tokio::task::spawn_blocking(move || {
        let r = ScreenpipeReminders::new();
        let _ = r.ensure_list("Screenpipe");
        let existing = r.list_reminders(Some("Screenpipe")).unwrap_or_default();
        let existing_titles: Vec<String> =
            existing.iter().map(|r| r.title.to_lowercase()).collect();

        let mut created = Vec::new();
        for item in &action_items {
            if existing_titles
                .iter()
                .any(|t| t == &item.title.to_lowercase())
            {
                debug!("reminders scan: skipping duplicate '{}'", item.title);
                continue;
            }

            match r.create_reminder(
                &item.title,
                item.notes.as_deref(),
                Some("Screenpipe"),
                item.due.as_deref(),
            ) {
                Ok(reminder) => {
                    info!("reminders scan: created '{}'", reminder.title);
                    created.push(ReminderItem {
                        identifier: reminder.identifier,
                        title: reminder.title,
                        notes: reminder.notes,
                        completed: reminder.completed,
                    });
                }
                Err(e) => {
                    warn!("reminders scan: failed to create '{}': {}", item.title, e);
                }
            }
        }
        created
    })
    .await
    .map_err(|e| format!("task failed: {}", e))?;

    Ok(ScanResult {
        reminders_created: created.len(),
        items: created,
        context_chars,
        error: None,
    })
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const API: &str = "http://localhost:3030";

/// Check if Apple Intelligence API is available.
#[cfg(target_os = "macos")]
async fn check_ai_available() -> bool {
    let resp = reqwest::Client::new()
        .get(format!("{}/ai/status", API))
        .timeout(std::time::Duration::from_secs(3))
        .send()
        .await;

    match resp {
        Ok(r) if r.status().is_success() => {
            let data: serde_json::Value = r.json().await.unwrap_or_default();
            data["available"].as_bool().unwrap_or(false)
        }
        _ => false,
    }
}

/// Fetch the last 30 minutes of screen + audio from the screenpipe API.
/// When `audio_only` is true, skip screen/OCR data entirely.
#[cfg(target_os = "macos")]
async fn fetch_recent_context(audio_only: bool) -> Result<String, String> {
    let client = reqwest::Client::new();
    let now = chrono::Utc::now();
    let thirty_min_ago = now - chrono::Duration::minutes(30);

    let mut parts = Vec::new();

    // Screen data (OCR) — skip when audio_only
    if !audio_only { if let Ok(resp) = client
        .get(format!("{}/search", API))
        .query(&[
            ("content_type", "ocr"),
            ("limit", "100"),
            ("start_time", &thirty_min_ago.to_rfc3339()),
            ("end_time", &now.to_rfc3339()),
        ])
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
    {
        if let Ok(data) = resp.json::<serde_json::Value>().await {
            let mut last_app = String::new();
            if let Some(items) = data["data"].as_array() {
                for item in items {
                    if item["type"] == "OCR" {
                        let content = &item["content"];
                        let app = content["app_name"].as_str().unwrap_or("");
                        let window = content["window_name"].as_str().unwrap_or("");

                        if app == last_app {
                            continue;
                        }
                        last_app = app.to_string();

                        let text = content["text"].as_str().unwrap_or("");
                        let truncated = if text.len() > 50 {
                            // find a valid char boundary at or before byte 50
                            let mut end = 50;
                            while !text.is_char_boundary(end) { end -= 1; }
                            &text[..end]
                        } else { text };
                        parts.push(format!("[screen] {} — {} | {}", app, window, truncated));
                    }
                }
            }
        }
    } }

    // Audio data
    if let Ok(resp) = client
        .get(format!("{}/search", API))
        .query(&[
            ("content_type", "audio"),
            ("limit", "50"),
            ("start_time", &thirty_min_ago.to_rfc3339()),
            ("end_time", &now.to_rfc3339()),
            ("min_length", "10"),
        ])
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
    {
        if let Ok(data) = resp.json::<serde_json::Value>().await {
            if let Some(items) = data["data"].as_array() {
                for item in items {
                    if item["type"] == "Audio" {
                        let content = &item["content"];
                        let text = content["transcription"].as_str().unwrap_or("").trim();
                        if text.len() > 10 {
                            let speaker = content["speaker"]
                                .as_object()
                                .and_then(|s| s["name"].as_str())
                                .unwrap_or("");
                            parts.push(format!(
                                "[audio] {}{}",
                                if speaker.is_empty() {
                                    String::new()
                                } else {
                                    format!("{}: ", speaker)
                                },
                                text
                            ));
                        }
                    }
                }
            }
        }
    }

    Ok(parts.join("\n"))
}

const REMINDERS_PROMPT: &str = r#"Extract actionable reminders from screen and audio activity. Respond with ONLY a single-line JSON object.

Format: {"reminders":[{"title":"short task","notes":"where this was mentioned","due":"today"}]}

Rules:
- ONLY extract tasks that are EXPLICITLY mentioned in the activity data below
- NEVER invent tasks — if nothing actionable exists, return {"reminders":[]}
- titles: short imperative phrases using words from the actual data
- notes: MUST reference the specific app or conversation where the task was mentioned
- due dates: only if a deadline was explicitly stated. Omit "due" field if no deadline mentioned.
- Maximum 5 reminders
- Output ONLY the JSON on a SINGLE LINE

IMPORTANT: Do NOT copy these examples. Every reminder must come from the data below."#;

/// Call Apple Intelligence (via local /ai/chat/completions) to extract action items.
#[cfg(target_os = "macos")]
async fn call_ai_for_reminders(
    context: &str,
    custom_prompt: Option<&str>,
) -> Result<String, String> {
    // Truncate to fit context window (~10K chars max)
    let context = if context.len() > 6000 {
        let mut end = 6000;
        while !context.is_char_boundary(end) {
            end -= 1;
        }
        &context[..end]
    } else {
        context
    };

    // Build system prompt with optional custom instructions
    let system_prompt = match custom_prompt {
        Some(cp) if !cp.trim().is_empty() => {
            format!("{}\n\nAdditional user instructions:\n{}", REMINDERS_PROMPT, cp.trim())
        }
        _ => REMINDERS_PROMPT.to_string(),
    };

    let client = reqwest::Client::new();

    let do_request = |ctx: String| {
        let client = client.clone();
        let prompt = system_prompt.clone();
        async move {
            let resp = client
                .post(format!("{}/ai/chat/completions", API))
                .json(&serde_json::json!({
                    "messages": [
                        {"role": "system", "content": prompt},
                        {"role": "user", "content": ctx}
                    ]
                }))
                .timeout(std::time::Duration::from_secs(30))
                .send()
                .await
                .map_err(|e| format!("AI API failed: {}", e))?;

            if !resp.status().is_success() {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                return Err(format!("AI API error {}: {}", status, body));
            }

            let data: serde_json::Value = resp
                .json()
                .await
                .map_err(|e| format!("AI response parse failed: {}", e))?;

            Ok(data["choices"][0]["message"]["content"]
                .as_str()
                .unwrap_or("{}")
                .to_string())
        }
    };

    match do_request(context.to_string()).await {
        Ok(response) => Ok(response),
        Err(e) if e.contains("unsafe") => {
            warn!("reminders: safety filter hit, retrying with sanitized context");
            let sanitized = sanitize_context(context);
            do_request(sanitized).await
        }
        Err(e) => Err(e),
    }
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct ActionItemParsed {
    title: String,
    notes: Option<String>,
    due: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AiRemindersResponse {
    reminders: Vec<ActionItemParsed>,
}

/// Parse AI response JSON into action items.
/// Handles: valid JSON, JSON wrapped in markdown, partial JSON, empty/garbage.
pub(crate) fn parse_action_items(response: &str) -> Vec<ActionItemParsed> {
    let response = response.trim();
    if response.is_empty() {
        return Vec::new();
    }

    // Strip markdown code fences if present
    let cleaned = if response.starts_with("```") {
        response
            .lines()
            .skip(1)
            .take_while(|l| !l.starts_with("```"))
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        response.to_string()
    };

    // Extract JSON object
    let json_str = match cleaned.find('{') {
        Some(start) => match cleaned.rfind('}') {
            Some(end) if end >= start => &cleaned[start..=end],
            _ => return Vec::new(),
        },
        None => return Vec::new(),
    };

    // Try standard format: {"reminders":[...]}
    if let Ok(parsed) = serde_json::from_str::<AiRemindersResponse>(json_str) {
        return parsed
            .reminders
            .into_iter()
            .filter(|item| !item.title.trim().is_empty())
            .take(5)
            .collect();
    }

    // Try single bare object: {"title":"...","notes":"...","due":"..."}
    if let Ok(item) = serde_json::from_str::<ActionItemParsed>(json_str) {
        if !item.title.trim().is_empty() {
            return vec![item];
        }
    }

    // Try comma-separated objects: {"title":"..."},{"title":"..."}
    let wrapped = format!("{{\"reminders\":[{}]}}", json_str);
    if let Ok(parsed) = serde_json::from_str::<AiRemindersResponse>(&wrapped) {
        let items: Vec<ActionItemParsed> = parsed
            .reminders
            .into_iter()
            .filter(|item| !item.title.trim().is_empty())
            .take(5)
            .collect();
        if !items.is_empty() {
            return items;
        }
    }

    warn!(
        "reminders: failed to parse AI response | raw: {}",
        {
            let mut end = response.len().min(200);
            while !response.is_char_boundary(end) { end -= 1; }
            &response[..end]
        }
    );
    Vec::new()
}

/// Strip URLs and emails to reduce safety filter triggers.
#[cfg(target_os = "macos")]
fn sanitize_context(context: &str) -> String {
    context
        .split_whitespace()
        .map(|word| {
            if word.starts_with("http://") || word.starts_with("https://") {
                "[url]"
            } else if word.contains('@') && word.contains('.') {
                "[email]"
            } else {
                word
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_valid_json() {
        let input = r#"{"reminders":[{"title":"Buy groceries","notes":"Mentioned in meeting","due":"tomorrow"}]}"#;
        let items = parse_action_items(input);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "Buy groceries");
        assert_eq!(items[0].notes.as_deref(), Some("Mentioned in meeting"));
        assert_eq!(items[0].due.as_deref(), Some("tomorrow"));
    }

    #[test]
    fn test_parse_multiple_items() {
        let input = r#"{"reminders":[
            {"title":"Task 1","notes":null,"due":"today"},
            {"title":"Task 2","notes":"context","due":"friday"},
            {"title":"Task 3","notes":null,"due":null}
        ]}"#;
        let items = parse_action_items(input);
        assert_eq!(items.len(), 3);
        assert_eq!(items[0].title, "Task 1");
        assert_eq!(items[2].due, None);
    }

    #[test]
    fn test_parse_empty_reminders() {
        let input = r#"{"reminders":[]}"#;
        let items = parse_action_items(input);
        assert!(items.is_empty());
    }

    #[test]
    fn test_parse_markdown_wrapped() {
        let input = "```json\n{\"reminders\":[{\"title\":\"Do thing\",\"notes\":null,\"due\":\"today\"}]}\n```";
        let items = parse_action_items(input);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "Do thing");
    }

    #[test]
    fn test_parse_text_before_json() {
        let input = "Here are the reminders I found:\n{\"reminders\":[{\"title\":\"Call dentist\",\"notes\":\"mentioned at 2pm\",\"due\":\"tomorrow\"}]}";
        let items = parse_action_items(input);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "Call dentist");
    }

    #[test]
    fn test_parse_empty_titles_filtered() {
        let input = r#"{"reminders":[{"title":"","notes":null,"due":null},{"title":"  ","notes":null,"due":null},{"title":"Real task","notes":null,"due":null}]}"#;
        let items = parse_action_items(input);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "Real task");
    }

    #[test]
    fn test_parse_max_5_items() {
        let input = r#"{"reminders":[
            {"title":"T1","notes":null,"due":null},
            {"title":"T2","notes":null,"due":null},
            {"title":"T3","notes":null,"due":null},
            {"title":"T4","notes":null,"due":null},
            {"title":"T5","notes":null,"due":null},
            {"title":"T6","notes":null,"due":null},
            {"title":"T7","notes":null,"due":null}
        ]}"#;
        let items = parse_action_items(input);
        assert_eq!(items.len(), 5);
    }

    #[test]
    fn test_parse_garbage_input() {
        assert!(parse_action_items("").is_empty());
        assert!(parse_action_items("not json at all").is_empty());
        assert!(parse_action_items("{}").is_empty());
        assert!(parse_action_items("{\"wrong_key\": []}").is_empty());
    }

    #[test]
    fn test_parse_truncated_json() {
        // AI sometimes truncates output
        let input = r#"{"reminders":[{"title":"Do thing","no"#;
        let items = parse_action_items(input);
        assert!(items.is_empty()); // graceful failure
    }

    #[test]
    fn test_parse_real_ai_response() {
        // Realistic Apple Intelligence output (sometimes adds explanation)
        let input = r#"Based on the activity data, here are the actionable items:

{"reminders":[{"title":"Review PR #2205","notes":"Seen in GitHub - screenpipe repo","due":"today"},{"title":"Reply to John's message about deployment","notes":"Slack conversation at 2:15 PM","due":"today"},{"title":"Update documentation for reminders feature","notes":"Discussion in terminal about missing docs","due":"tomorrow"}]}

These are the key action items I identified."#;
        let items = parse_action_items(input);
        assert_eq!(items.len(), 3);
        assert_eq!(items[0].title, "Review PR #2205");
        assert_eq!(items[1].title, "Reply to John's message about deployment");
        assert_eq!(items[2].due.as_deref(), Some("tomorrow"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn test_sanitize_context() {
        let input = "Check https://github.com/screenpipe and email john@example.com about it";
        let result = sanitize_context(input);
        assert!(result.contains("[url]"));
        assert!(result.contains("[email]"));
        assert!(!result.contains("github.com"));
        assert!(!result.contains("john@example.com"));
        assert!(result.contains("Check"));
        assert!(result.contains("about"));
    }
}
