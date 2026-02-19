//! Obsidian Sync Module
//!
//! Syncs screenpipe activity data to an Obsidian vault using pi as the AI agent.
//! The agent queries screenpipe API in chunks and generates markdown summaries.

use crate::pi;
use crate::store::{ObsidianSettingsStore, SettingsStore};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use tracing::{info, warn};

/// Obsidian sync settings stored in the app store
#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct ObsidianSyncSettings {
    /// Whether sync is enabled
    pub enabled: bool,
    /// Path to the Obsidian vault
    pub vault_path: String,
    /// Subfolder within vault for notes (e.g., "screenpipe/logs" or "daily/activity")
    #[serde(default = "default_notes_path")]
    pub notes_path: String,
    /// Sync interval in minutes (0 = manual only)
    pub sync_interval_minutes: u32,
    /// Custom user prompt to append to system prompt
    pub custom_prompt: String,
    /// Last successful sync timestamp (ISO 8601)
    pub last_sync_time: Option<String>,
    /// Number of hours to sync (how far back to look)
    pub sync_hours: u32,
}

fn default_notes_path() -> String {
    "screenpipe/logs".to_string()
}

/// Status of an ongoing or completed sync
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ObsidianSyncStatus {
    pub is_syncing: bool,
    pub last_sync_time: Option<String>,
    pub last_error: Option<String>,
    pub notes_created_today: u32,
    /// Next scheduled run time (ISO 8601) - for UI display
    pub next_scheduled_run: Option<String>,
}

impl Default for ObsidianSyncStatus {
    fn default() -> Self {
        Self {
            is_syncing: false,
            last_sync_time: None,
            last_error: None,
            notes_created_today: 0,
            next_scheduled_run: None,
        }
    }
}

/// State for managing obsidian sync
pub struct ObsidianSyncState {
    pub status: Arc<Mutex<ObsidianSyncStatus>>,
    pub scheduler_handle: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    pub current_pid: Arc<Mutex<Option<u32>>>,
}

impl ObsidianSyncState {
    pub fn new() -> Self {
        Self {
            status: Arc::new(Mutex::new(ObsidianSyncStatus::default())),
            current_pid: Arc::new(Mutex::new(None)),
            scheduler_handle: Arc::new(Mutex::new(None)),
        }
    }
}

/// System prompt for the pi agent with screenpipe API docs
const SYSTEM_PROMPT: &str = r#"You are syncing screenpipe activity data to an Obsidian vault.

## Screenpipe API Reference

Base URL: http://localhost:3030
Full API reference (60+ endpoints): https://docs.screenpi.pe/llms-full.txt

### Search Endpoint
```
GET /search
```

Query parameters:
- `content_type`: "ocr" | "audio" | "input" | "accessibility" | "all" (default: all)
  - `ocr` — screen text from screenshots
  - `audio` — transcribed speech
  - `input` — user actions: clicks, keystrokes, clipboard, app switches
  - `accessibility` — accessibility tree text (richer than OCR for UI elements)
  - `all` — combines ocr + audio + accessibility
- `start_time`: ISO 8601 timestamp (e.g., 2025-02-01T10:00:00Z)
- `end_time`: ISO 8601 timestamp
- `limit`: max results per request (default: 50, max: 1000)
- `offset`: pagination offset
- `q`: text search query (optional, filters results by keyword)
- `app_name`: filter by app (e.g., "Arc", "Slack", "zoom")
- `min_length`: minimum content length in chars (use 50 to skip noise)
- `speaker_name`: filter audio by speaker name

Example:
```bash
curl "http://localhost:3030/search?content_type=ocr&start_time=2025-02-01T10:00:00Z&end_time=2025-02-01T10:30:00Z&limit=200&min_length=50"
```

### Querying Strategy

For best results, query each modality separately per 30-min chunk:
1. `content_type=ocr&min_length=50` — what was on screen (apps, documents, code)
2. `content_type=audio` — what was said (meetings, voice notes)
3. `content_type=input` — what the user did (typed text, clicks, app switches, clipboard)
4. `content_type=accessibility` — UI element tree (buttons, labels, menus — richer than OCR for understanding UI interactions)

This gives you richer context than a single `all` query. Use `input` data to understand workflow, `audio` for meeting summaries, and `accessibility` for precise UI context.

Response format:
```json
{
  "data": [
    {
      "type": "OCR",
      "content": {
        "frame_id": 123,
        "text": "screen text content...",
        "app_name": "Arc",
        "window_name": "GitHub - Pull Request",
        "timestamp": "2025-02-01T10:05:00Z"
      }
    },
    {
      "type": "Audio",
      "content": {
        "transcription": "spoken words...",
        "timestamp": "2025-02-01T10:05:30Z"
      }
    }
  ],
  "pagination": { "total": 500, "limit": 200, "offset": 0 }
}
```

## Your Task

1. Read the existing daily note file first (if it exists) — you will merge into it
2. Query the screenpipe API for the specified time range in 30-minute chunks
3. Use `min_length=50` to skip noisy/short OCR fragments
4. Synthesize activities, extract action items, and write the note

## Output Format

Write the daily note with these sections:

```markdown
# Activity Log - YYYY-MM-DD

## Timeline

| Time | Activity | Apps | Tags |
|------|----------|------|------|
| 10:00-10:30 | Reviewed PR #123 for auth module | GitHub, VSCode | #coding #review |
| 10:30-11:00 | Call with team about roadmap | Zoom, Notion | #meeting #planning |

## Action Items

- [ ] Follow up with [[Alice]] on API design — from 10:30 meeting
- [ ] Review deployment checklist before Friday
- [ ] Visit https://example.com/docs for reference

## Key Moments

- [10:32 AM](screenpipe://timeline?timestamp=2025-02-01T10:32:00Z) — [[Bob]] mentioned Q2 deadline is March 15
- [11:15 AM](screenpipe://timeline?timestamp=2025-02-01T11:15:00Z) — decided to use PostgreSQL for new service

## Summary

Brief 2-3 sentence summary of the day's main themes and accomplishments.
```

## Accumulation Rules (critical for hourly syncs)

- ALWAYS read the existing note file first before writing
- MERGE new time ranges into the existing timeline — do not overwrite earlier entries
- DEDUPLICATE: if a time range already exists, skip or update it, don't duplicate
- MERGE action items: keep existing TODOs, add new ones, don't remove completed items
- REWRITE the Summary section to cover the full day so far (not just the latest chunk)

## Privacy Rules

- NEVER dump raw OCR text — always synthesize into activity descriptions
- REDACT passwords, API keys, tokens, secrets, and credentials if they appear in OCR
- SKIP banking, financial, and medical content — just note "personal/private activity"
- MINIMIZE personally identifiable information — use [[Name]] links, don't include full emails/phone numbers
- DO NOT include full audio transcripts — summarize conversations instead

## Embedding Media & Deep Links

- **Timeline links**: `[10:30 AM](screenpipe://timeline?timestamp=2025-02-01T10:30:00Z)` — opens screenpipe at that moment
- **Frame links**: `[screenshot](screenpipe://frame/12345)` — links a specific captured frame
- **Video files**: `![video](/path/to/file.mp4)` using the exact file_path from search results
- **Audio files**: `![audio](/path/to/file.mp4)` using audio_file_path from search results

## Best Practices

- Link people names with [[Name]] (Obsidian wiki-links)
- Link projects/concepts with [[concept-name]]
- Extract TODOs: explicit tasks, follow-ups, URLs to visit, deadlines, purchases mentioned
- Keep summaries concise but capture key activities
- Group related activities together
- Add semantic tags (#coding, #meeting, #research, etc.)
- Include timeline deep links for key moments
- Skip idle periods or duplicates

## Important

- Query in chunks to avoid context overflow
- Use curl to fetch data from the API
- Write files using the write tool
- Create the subfolder structure if it doesn't exist
- ONLY create/modify the single daily log file (YYYY-MM-DD.md) - DO NOT create any other files
- Use the user's LOCAL timezone for all times displayed in the log (convert UTC timestamps)
"#;

/// Build the full prompt for pi
fn build_prompt(settings: &ObsidianSyncSettings, start_time: &str, end_time: &str) -> String {
    let local_now = chrono::Local::now();
    let today = local_now.format("%Y-%m-%d").to_string();
    let timezone = local_now.format("%Z").to_string(); // e.g., "PST", "EST"
    let timezone_offset = local_now.format("%:z").to_string(); // e.g., "-08:00"
    
    let notes_path = if settings.notes_path.is_empty() {
        "screenpipe/logs".to_string()
    } else {
        settings.notes_path.trim_matches('/').to_string()
    };
    let note_path = format!(
        "{}/{}/{}.md",
        settings.vault_path.trim_end_matches('/'),
        notes_path,
        today
    );

    // Static system prompt first (cacheable by LLM providers), dynamic context last
    let mut prompt = SYSTEM_PROMPT.to_string();

    // Append user's custom prompt if provided
    if !settings.custom_prompt.is_empty() {
        prompt.push_str("\n\n## Additional Instructions from User\n\n");
        prompt.push_str(&settings.custom_prompt);
    }

    prompt.push_str(&format!(
        r#"

## Current Task

Sync my screenpipe activity to Obsidian.

Time range: {} to {}
Output file: {}
User's timezone: {} (UTC{})"#,
        start_time, end_time, note_path, timezone, timezone_offset
    ));

    prompt
}

/// Save obsidian settings to persistent store (called when settings change)
#[tauri::command]
#[specta::specta]
pub async fn obsidian_save_settings(
    app: AppHandle,
    settings: ObsidianSyncSettings,
) -> Result<(), String> {
    // Preserve existing next_scheduled_run when saving settings from UI
    let existing_next_run = ObsidianSettingsStore::get(&app)
        .ok()
        .flatten()
        .and_then(|s| s.next_scheduled_run);

    let store_settings = ObsidianSettingsStore {
        enabled: settings.enabled,
        vault_path: settings.vault_path,
        notes_path: settings.notes_path,
        sync_interval_minutes: settings.sync_interval_minutes,
        custom_prompt: settings.custom_prompt,
        sync_hours: settings.sync_hours,
        next_scheduled_run: existing_next_run,
    };
    store_settings.save(&app)?;
    info!("Obsidian settings saved to store (preserved next_scheduled_run)");
    Ok(())
}

/// Validate that a path is a valid Obsidian vault (has .obsidian folder)
#[tauri::command]
#[specta::specta]
pub async fn obsidian_validate_vault(path: String) -> Result<bool, String> {
    let vault_path = PathBuf::from(&path);
    let obsidian_folder = vault_path.join(".obsidian");
    Ok(obsidian_folder.exists() && obsidian_folder.is_dir())
}

/// Get suggested Obsidian vault paths by scanning common locations
#[tauri::command]
#[specta::specta]
pub async fn obsidian_get_vault_paths() -> Result<Vec<String>, String> {
    let mut paths = Vec::new();

    // Common Obsidian vault locations
    if let Some(home) = dirs::home_dir() {
        let candidates = vec![home.join("Documents"), home.join("Obsidian"), home.clone()];

        for candidate in candidates {
            if let Ok(entries) = std::fs::read_dir(&candidate) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_dir() {
                        let obsidian_folder = path.join(".obsidian");
                        if obsidian_folder.exists() {
                            if let Some(path_str) = path.to_str() {
                                paths.push(path_str.to_string());
                            }
                        }
                    }
                }
            }
        }
    }

    // Also check iCloud on macOS
    #[cfg(target_os = "macos")]
    if let Some(home) = dirs::home_dir() {
        let icloud_obsidian = home.join("Library/Mobile Documents/iCloud~md~obsidian/Documents");
        if let Ok(entries) = std::fs::read_dir(&icloud_obsidian) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    let obsidian_folder = path.join(".obsidian");
                    if obsidian_folder.exists() {
                        if let Some(path_str) = path.to_str() {
                            paths.push(path_str.to_string());
                        }
                    }
                }
            }
        }
    }

    Ok(paths)
}

/// Get current sync status
#[tauri::command]
#[specta::specta]
pub async fn obsidian_get_sync_status(
    app: AppHandle,
    state: tauri::State<'_, ObsidianSyncState>,
) -> Result<ObsidianSyncStatus, String> {
    let mut status = state.status.lock().await.clone();
    
    // Load next_scheduled_run from persistent store
    if let Ok(Some(settings)) = ObsidianSettingsStore::get(&app) {
        status.next_scheduled_run = settings.next_scheduled_run;
    }
    
    Ok(status)
}

/// Run a sync operation (manual trigger or from scheduler)
#[tauri::command]
#[specta::specta]
pub async fn obsidian_run_sync(
    app: AppHandle,
    state: tauri::State<'_, ObsidianSyncState>,
    settings: ObsidianSyncSettings,
    user_token: Option<String>,
) -> Result<ObsidianSyncStatus, String> {
    // Check if already syncing
    {
        let status = state.status.lock().await;
        if status.is_syncing {
            return Err("Sync already in progress".to_string());
        }
    }

    // Validate vault path
    if settings.vault_path.is_empty() {
        return Err("Vault path not configured".to_string());
    }

    // Note: vault validation is non-blocking - any folder works, Obsidian is optional

    // Update status to syncing
    {
        let mut status = state.status.lock().await;
        status.is_syncing = true;
        status.last_error = None;
    }

    // Emit event for UI
    let _ = app.emit("obsidian_sync_started", ());

    // Calculate time range
    let end_time = chrono::Utc::now();
    let start_time = end_time - chrono::Duration::hours(settings.sync_hours as i64);
    let start_time_str = start_time.to_rfc3339();
    let end_time_str = end_time.to_rfc3339();

    // Build prompt
    let prompt = build_prompt(&settings, &start_time_str, &end_time_str);

    // Debug: check if token is passed
    info!("obsidian_run_sync: user_token present = {}, vault_path = {}", user_token.is_some(), settings.vault_path);
    
    // Create channel to receive PID
    let (pid_tx, pid_rx) = tokio::sync::oneshot::channel();
    let current_pid = state.current_pid.clone();
    
    // Spawn task to store PID when received
    tokio::spawn(async move {
        if let Ok(pid) = pid_rx.await {
            *current_pid.lock().await = Some(pid);
        }
    });
    
    // Run pi in the vault directory
    let result = pi::run(&prompt, user_token.as_deref(), &settings.vault_path, Some(pid_tx)).await.map(|_| ());
    
    // Clear PID when done
    *state.current_pid.lock().await = None;

    // Update status based on result
    {
        let mut status = state.status.lock().await;
        status.is_syncing = false;

        match &result {
            Ok(_) => {
                status.last_sync_time = Some(chrono::Utc::now().to_rfc3339());
                status.last_error = None;
                status.notes_created_today += 1;
                let _ = app.emit("obsidian_sync_completed", status.clone());
            }
            Err(e) => {
                status.last_error = Some(e.clone());
                let _ = app.emit("obsidian_sync_error", e.clone());
            }
        }
    }

    let status = state.status.lock().await;
    result.map(|_| status.clone())
}

/// Start the background scheduler for periodic syncs
#[tauri::command]
#[specta::specta]
pub async fn obsidian_start_scheduler(
    app: AppHandle,
    state: tauri::State<'_, ObsidianSyncState>,
    settings: ObsidianSyncSettings,
    user_token: Option<String>,
) -> Result<(), String> {
    // Stop existing scheduler if any
    obsidian_stop_scheduler(state.clone()).await?;

    if !settings.enabled || settings.sync_interval_minutes == 0 {
        info!("Obsidian sync scheduler not started (disabled or interval=0)");
        return Ok(());
    }

    let interval_mins = settings.sync_interval_minutes;
    
    // Calculate next scheduled run time
    let next_run = chrono::Utc::now() + chrono::Duration::minutes(interval_mins as i64);
    
    // Save settings with next_scheduled_run to persistent store
    let store_settings = ObsidianSettingsStore {
        enabled: settings.enabled,
        vault_path: settings.vault_path.clone(),
        notes_path: settings.notes_path.clone(),
        sync_interval_minutes: settings.sync_interval_minutes,
        custom_prompt: settings.custom_prompt.clone(),
        sync_hours: settings.sync_hours,
        next_scheduled_run: Some(next_run.to_rfc3339()),
    };
    if let Err(e) = store_settings.save(&app) {
        warn!("Failed to save obsidian settings to store: {}", e);
    }

    let settings_clone = settings.clone();
    let status_arc = state.status.clone();
    let current_pid_arc = state.current_pid.clone();
    let app_handle = app.clone();
    let token_clone = user_token.clone();

    info!(
        "Starting obsidian sync scheduler with {}min interval, next run at {}",
        interval_mins, next_run
    );

    let handle = tokio::spawn(async move {
        info!("Obsidian scheduler task started (manual), interval: {}min", interval_mins);
        
        let interval_duration = tokio::time::Duration::from_secs(interval_mins as u64 * 60);
        
        // First sync: wait the full interval (user just started/restarted the scheduler)
        info!("Obsidian scheduler: waiting {}min for first sync...", interval_mins);
        tokio::time::sleep(interval_duration).await;

        loop {
            let now = chrono::Utc::now();
            info!("Obsidian scheduler: tick received at {:?}", now);

            // Check if we should sync
            {
                let status = status_arc.lock().await;
                if status.is_syncing {
                    info!("Obsidian scheduler: skipping - already syncing");
                    tokio::time::sleep(interval_duration).await;
                    continue;
                }
            }

            info!("Running scheduled obsidian sync (manual)");

            let (result, retry_secs) = run_scheduled_sync_with_reschedule(
                &app_handle, 
                &settings_clone, 
                &status_arc, 
                &current_pid_arc, 
                token_clone.as_deref(),
                interval_mins,
            ).await;

            match &result {
                Ok(_) => info!("Scheduled obsidian sync completed successfully"),
                Err(e) => warn!("Scheduled obsidian sync failed: {}", e),
            }

            let wait = match retry_secs {
                Some(secs) => {
                    info!("Obsidian scheduler: retrying in {}s...", secs);
                    tokio::time::Duration::from_secs(secs)
                }
                None => {
                    info!("Obsidian scheduler: waiting {}min for next sync...", interval_mins);
                    interval_duration
                }
            };
            tokio::time::sleep(wait).await;
        }
    });

    // Store the handle
    let mut scheduler_handle = state.scheduler_handle.lock().await;
    *scheduler_handle = Some(handle);

    Ok(())
}

/// Stop the background scheduler
#[tauri::command]
#[specta::specta]
pub async fn obsidian_stop_scheduler(
    state: tauri::State<'_, ObsidianSyncState>,
) -> Result<(), String> {
    let mut handle = state.scheduler_handle.lock().await;
    if let Some(h) = handle.take() {
        h.abort();
        info!("Obsidian sync scheduler stopped");
    }
    Ok(())
}

/// Auto-start the scheduler on app launch if it was previously enabled
pub async fn auto_start_scheduler(app: AppHandle, state: &ObsidianSyncState) {
    info!("Checking if obsidian scheduler should auto-start...");
    
    // Load obsidian settings from store
    let obsidian_settings = match ObsidianSettingsStore::get(&app) {
        Ok(Some(s)) => s,
        Ok(None) => {
            info!("No obsidian settings found, skipping auto-start");
            return;
        }
        Err(e) => {
            warn!("Failed to load obsidian settings: {}", e);
            return;
        }
    };

    if !obsidian_settings.enabled {
        info!("Obsidian scheduler is disabled, skipping auto-start");
        return;
    }

    if obsidian_settings.vault_path.is_empty() {
        info!("Obsidian vault path is empty, skipping auto-start");
        return;
    }

    if obsidian_settings.sync_interval_minutes == 0 {
        info!("Obsidian sync interval is 0, skipping auto-start");
        return;
    }

    // Get user token from settings store
    let user_token = match SettingsStore::get(&app) {
        Ok(Some(s)) => s.user.token,
        _ => None,
    };

    if user_token.is_none() {
        info!("No user token found, skipping obsidian auto-start (requires login)");
        return;
    }

    // Convert store settings to sync settings
    let settings = ObsidianSyncSettings {
        enabled: obsidian_settings.enabled,
        vault_path: obsidian_settings.vault_path.clone(),
        notes_path: obsidian_settings.notes_path.clone(),
        sync_interval_minutes: obsidian_settings.sync_interval_minutes,
        custom_prompt: obsidian_settings.custom_prompt.clone(),
        last_sync_time: None,
        sync_hours: obsidian_settings.sync_hours,
    };

    let interval_mins = settings.sync_interval_minutes;
    let settings_clone = settings.clone();
    let status_arc = state.status.clone();
    let current_pid_arc = state.current_pid.clone();
    let app_handle = app.clone();
    let token_clone = user_token.clone();

    // Check if we have a scheduled run time and calculate initial delay
    let now = chrono::Utc::now();
    let (initial_delay, next_run_time) = if let Some(ref next_run_str) = obsidian_settings.next_scheduled_run {
        match chrono::DateTime::parse_from_rfc3339(next_run_str) {
            Ok(next_run) => {
                let next_run_utc = next_run.with_timezone(&chrono::Utc);
                if next_run_utc <= now {
                    // Missed the scheduled time - run immediately, then continue with normal interval
                    info!("Obsidian scheduler: missed scheduled run at {}, will run immediately", next_run_str);
                    // Next run will be now (immediate) + interval
                    let next = now + chrono::Duration::minutes(interval_mins as i64);
                    (tokio::time::Duration::from_secs(0), next)
                } else {
                    // Wait until the scheduled time
                    let delay = (next_run_utc - now).to_std().unwrap_or(tokio::time::Duration::from_secs(0));
                    info!("Obsidian scheduler: resuming, next run in {:?} (at {})", delay, next_run_str);
                    (delay, next_run_utc)
                }
            }
            Err(e) => {
                warn!("Failed to parse next_scheduled_run '{}': {}, using full interval", next_run_str, e);
                let next = now + chrono::Duration::minutes(interval_mins as i64);
                (tokio::time::Duration::from_secs(interval_mins as u64 * 60), next)
            }
        }
    } else {
        // No scheduled time, use full interval and save it
        info!("Obsidian scheduler: no previous schedule, waiting full interval");
        let next = now + chrono::Duration::minutes(interval_mins as i64);
        (tokio::time::Duration::from_secs(interval_mins as u64 * 60), next)
    };

    // Always save next_scheduled_run to store (so UI can display it)
    let updated_settings = ObsidianSettingsStore {
        enabled: obsidian_settings.enabled,
        vault_path: obsidian_settings.vault_path.clone(),
        notes_path: obsidian_settings.notes_path.clone(),
        sync_interval_minutes: obsidian_settings.sync_interval_minutes,
        custom_prompt: obsidian_settings.custom_prompt.clone(),
        sync_hours: obsidian_settings.sync_hours,
        next_scheduled_run: Some(next_run_time.to_rfc3339()),
    };
    if let Err(e) = updated_settings.save(&app) {
        warn!("Failed to save next_scheduled_run on auto-start: {}", e);
    }

    // Stop any existing scheduler before starting (prevents duplicate tasks)
    {
        let mut handle = state.scheduler_handle.lock().await;
        if let Some(h) = handle.take() {
            h.abort();
            info!("Stopped existing obsidian scheduler before auto-start");
        }
    }

    info!("Auto-starting obsidian scheduler with {}min interval, initial delay: {:?}, next run at {}", interval_mins, initial_delay, next_run_time);

    let handle = tokio::spawn(async move {
        info!("Obsidian scheduler task started (auto-start), interval: {}min", interval_mins);
        
        let interval_duration = tokio::time::Duration::from_secs(interval_mins as u64 * 60);
        
        // Wait for initial delay (could be 0 if we missed a sync, or remaining time until next scheduled)
        if !initial_delay.is_zero() {
            info!("Obsidian scheduler: waiting {:?} before first sync...", initial_delay);
            tokio::time::sleep(initial_delay).await;
        }

        loop {
            let now = chrono::Utc::now();
            info!("Obsidian scheduler: tick received at {:?}", now);

            // Check if we should sync
            {
                let status = status_arc.lock().await;
                if status.is_syncing {
                    info!("Obsidian scheduler: skipping - already syncing");
                    tokio::time::sleep(interval_duration).await;
                    continue;
                }
            }

            info!("Running scheduled obsidian sync (auto-start)");

            let (result, retry_secs) = run_scheduled_sync_with_reschedule(
                &app_handle, 
                &settings_clone, 
                &status_arc, 
                &current_pid_arc, 
                token_clone.as_deref(),
                interval_mins,
            ).await;

            match &result {
                Ok(_) => info!("Scheduled obsidian sync completed successfully"),
                Err(e) => warn!("Scheduled obsidian sync failed: {}", e),
            }

            let wait = match retry_secs {
                Some(secs) => {
                    info!("Obsidian scheduler: retrying in {}s...", secs);
                    tokio::time::Duration::from_secs(secs)
                }
                None => {
                    info!("Obsidian scheduler: waiting {}min for next sync...", interval_mins);
                    interval_duration
                }
            };
            tokio::time::sleep(wait).await;
        }
    });

    // Store the handle
    let mut scheduler_handle = state.scheduler_handle.lock().await;
    *scheduler_handle = Some(handle);
    
    info!("Obsidian scheduler auto-started successfully");
}

/// Cancel the currently running sync
#[tauri::command]
#[specta::specta]
pub async fn obsidian_cancel_sync(
    app: AppHandle,
    state: tauri::State<'_, ObsidianSyncState>,
) -> Result<(), String> {
    let mut pid = state.current_pid.lock().await;
    if let Some(p) = pid.take() {
        crate::pi::kill(p)?;
        
        // Update status
        let mut status = state.status.lock().await;
        status.is_syncing = false;
        status.last_error = Some("Cancelled by user".to_string());
        
        let _ = app.emit("obsidian_sync_error", "Cancelled by user");
        info!("Obsidian sync cancelled");
    }
    Ok(())
}

/// Internal function to run a scheduled sync
async fn run_scheduled_sync(
    app: &AppHandle,
    settings: &ObsidianSyncSettings,
    status: &Arc<Mutex<ObsidianSyncStatus>>,
    current_pid: &Arc<Mutex<Option<u32>>>,
    user_token: Option<&str>,
) -> Result<(), String> {
    // Update status
    {
        let mut s = status.lock().await;
        s.is_syncing = true;
        s.last_error = None;
    }

    let _ = app.emit("obsidian_sync_started", ());

    // Calculate time range
    let end_time = chrono::Utc::now();
    let start_time = end_time - chrono::Duration::hours(settings.sync_hours as i64);

    let prompt = build_prompt(settings, &start_time.to_rfc3339(), &end_time.to_rfc3339());
    
    // Create channel to receive PID
    let (pid_tx, pid_rx) = tokio::sync::oneshot::channel();
    let pid_clone = current_pid.clone();
    tokio::spawn(async move {
        if let Ok(pid) = pid_rx.await {
            *pid_clone.lock().await = Some(pid);
        }
    });
    
    let result = pi::run(&prompt, user_token, &settings.vault_path, Some(pid_tx)).await.map(|_| ());
    
    // Clear PID when done
    *current_pid.lock().await = None;

    // Update status
    {
        let mut s = status.lock().await;
        s.is_syncing = false;

        match &result {
            Ok(_) => {
                s.last_sync_time = Some(chrono::Utc::now().to_rfc3339());
                s.last_error = None;
                s.notes_created_today += 1;
                let _ = app.emit("obsidian_sync_completed", s.clone());
            }
            Err(e) => {
                s.last_error = Some(e.clone());
                let _ = app.emit("obsidian_sync_error", e.clone());
            }
        }
    }

    result
}

/// Internal function to run a scheduled sync and update next_scheduled_run.
/// Returns (result, retry_secs) — retry_secs is Some if should retry sooner than normal interval.
async fn run_scheduled_sync_with_reschedule(
    app: &AppHandle,
    settings: &ObsidianSyncSettings,
    status: &Arc<Mutex<ObsidianSyncStatus>>,
    current_pid: &Arc<Mutex<Option<u32>>>,
    user_token: Option<&str>,
    interval_mins: u32,
) -> (Result<(), String>, Option<u64>) {
    // Run the actual sync
    let result = run_scheduled_sync(app, settings, status, current_pid, user_token).await;

    let (next_run, retry_secs) = match &result {
        Ok(_) => {
            // Success — schedule next run at normal interval
            let next = chrono::Utc::now() + chrono::Duration::minutes(interval_mins as i64);
            (next, None)
        }
        Err(e) if e.contains("429") || e.contains("rate limit") => {
            // Rate limited — retry in 60 seconds, not the full interval
            let retry = 60u64;
            let next = chrono::Utc::now() + chrono::Duration::seconds(retry as i64);
            warn!("Obsidian sync rate limited, retrying in {}s", retry);
            (next, Some(retry))
        }
        Err(_) => {
            // Other failure — retry in 5 minutes, not the full interval
            let retry = 300u64;
            let next = chrono::Utc::now() + chrono::Duration::seconds(retry as i64);
            (next, Some(retry))
        }
    };

    // Save next_scheduled_run to persistent store
    // Preserve other fields from current store
    if let Ok(Some(mut store_settings)) = ObsidianSettingsStore::get(app) {
        store_settings.next_scheduled_run = Some(next_run.to_rfc3339());
        if let Err(e) = store_settings.save(app) {
            warn!("Failed to save next_scheduled_run: {}", e);
        } else {
            info!("Updated next_scheduled_run to {}", next_run);
        }
    }

    (result, retry_secs)
}
