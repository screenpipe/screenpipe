use super::get_base_dir;
use std::sync::Arc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use specta::Type;
use tauri::AppHandle;
use tauri_plugin_store::StoreBuilder;
use tracing::error;

pub fn get_store(
    app: &AppHandle,
    _profile_name: Option<String>, // Keep parameter for API compatibility but ignore it
) -> anyhow::Result<Arc<tauri_plugin_store::Store<tauri::Wry>>> {
    let base_dir = get_base_dir(app, None)?;
    let store_path = base_dir.join("store.bin");

    // Build and return the store wrapped in Arc
    StoreBuilder::new(app, store_path)
        .build()
        .map_err(|e| anyhow::anyhow!(e))
}

#[derive(Serialize, Deserialize, Type, Clone)]
#[serde(default)]
pub struct OnboardingStore {
    #[serde(rename = "isCompleted")]
    pub is_completed: bool,
    #[serde(rename = "completedAt")]
    pub completed_at: Option<String>,
    /// Current step in onboarding flow (login, intro, usecases, status)
    /// Used to resume after app restart (e.g., after granting permissions)
    #[serde(rename = "currentStep", default)]
    pub current_step: Option<String>,
}

impl Default for OnboardingStore {
    fn default() -> Self {
        Self {
            is_completed: false,
            completed_at: None,
            current_step: None,
        }
    }
}

impl OnboardingStore {
    pub fn get(app: &AppHandle) -> Result<Option<Self>, String> {
        let store = get_store(app, None).map_err(|e| e.to_string())?;

        match store.is_empty() {
            true => Ok(None),
            false => {
                let onboarding = serde_json::from_value(store.get("onboarding").unwrap_or(Value::Null));
                match onboarding {
                    Ok(onboarding) => Ok(onboarding),
                    Err(e) => {
                        error!("Failed to deserialize onboarding: {}", e);
                        Err(e.to_string())
                    }
                }
            }
        }
    }

    pub fn update(app: &AppHandle, update: impl FnOnce(&mut OnboardingStore)) -> Result<(), String> {
        let Ok(store) = get_store(app, None) else {
            return Err("Failed to get onboarding store".to_string());
        };

        let mut onboarding = Self::get(app)?.unwrap_or_default();
        update(&mut onboarding);
        store.set("onboarding", json!(onboarding));
        store.save().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn save(&self, app: &AppHandle) -> Result<(), String> {
        let Ok(store) = get_store(app, None) else {
            return Err("Failed to get onboarding store".to_string());
        };

        store.set("onboarding", json!(self));
        store.save().map_err(|e| e.to_string())
    }

    pub fn complete(&mut self) {
        self.is_completed = true;
        self.completed_at = Some(chrono::Utc::now().to_rfc3339());
    }

    pub fn reset(&mut self) {
        self.is_completed = false;
        self.completed_at = None;
        self.current_step = None;
    }
}

#[derive(Serialize, Deserialize,Type,Clone)]
#[serde(default)]
pub struct SettingsStore {
    #[serde(rename = "aiPresets")]
    pub ai_presets: Vec<AIPreset>,

    #[serde(rename = "deepgramApiKey")]
    pub deepgram_api_key: String,
    #[serde(rename = "isLoading")]
    pub is_loading: bool,

    #[serde(rename = "userId")]
    pub user_id: String,

    /// Persistent analytics ID used for PostHog tracking (both frontend and backend)
    #[serde(rename = "analyticsId")]
    pub analytics_id: String,
  
    #[serde(rename = "devMode")]
    pub dev_mode: bool,
    #[serde(rename = "audioTranscriptionEngine")]
    pub audio_transcription_engine: String,
    #[serde(rename = "ocrEngine")]
    pub ocr_engine: String,
    #[serde(rename = "monitorIds")]
    pub monitor_ids: Vec<String>,
    #[serde(rename = "audioDevices")]
    pub audio_devices: Vec<String>,
    /// When true, automatically follow system default audio devices
    #[serde(rename = "useSystemDefaultAudio", default = "default_true")]
    pub use_system_default_audio: bool,
    #[serde(rename = "usePiiRemoval")]
    pub use_pii_removal: bool,
    #[serde(rename = "port")]
    pub port: u16,
    #[serde(rename = "dataDir")]
    pub data_dir: String,
    #[serde(rename = "disableAudio")]
    pub disable_audio: bool,
    #[serde(rename = "ignoredWindows")]
    pub ignored_windows: Vec<String>,
    #[serde(rename = "includedWindows")]
    pub included_windows: Vec<String>,
    #[serde(rename = "ignoredUrls", default)]
    pub ignored_urls: Vec<String>,

    #[serde(rename = "fps")]
    pub fps: f32,
    #[serde(rename = "vadSensitivity")]
    pub vad_sensitivity: String,
    #[serde(rename = "analyticsEnabled")]
    pub analytics_enabled: bool,
    #[serde(rename = "audioChunkDuration")]
    pub audio_chunk_duration: i32,
    #[serde(rename = "useChineseMirror")]
    pub use_chinese_mirror: bool,
    #[serde(rename = "languages")]
    pub languages: Vec<String>,
    #[serde(rename = "embeddedLLM")]
    pub embedded_llm: EmbeddedLLM,
    #[serde(rename = "autoStartEnabled")]
    pub auto_start_enabled: bool,
    #[serde(rename = "platform")]
    pub platform: String,
    #[serde(rename = "disabledShortcuts")]
    pub disabled_shortcuts: Vec<String>,
    #[serde(rename = "user")]
    pub user: User,
    #[serde(rename = "showScreenpipeShortcut")]
    pub show_screenpipe_shortcut: String,
    #[serde(rename = "startRecordingShortcut")]
    pub start_recording_shortcut: String,
    #[serde(rename = "stopRecordingShortcut")]
    pub stop_recording_shortcut: String,
    #[serde(rename = "startAudioShortcut")]
    pub start_audio_shortcut: String,
    #[serde(rename = "stopAudioShortcut")]
    pub stop_audio_shortcut: String,
    #[serde(rename = "showChatShortcut")]
    pub show_chat_shortcut: String,
    #[serde(rename = "searchShortcut")]
    pub search_shortcut: String,
    #[serde(rename = "realtimeAudioTranscriptionEngine")]
    pub realtime_audio_transcription_engine: String,
    #[serde(rename = "disableVision")]
    pub disable_vision: bool,
    /// When true, screen capture continues but OCR text extraction is skipped.
    /// Reduces CPU usage significantly while still recording video.
    #[serde(rename = "disableOcr", default)]
    pub disable_ocr: bool,
    #[serde(rename = "useAllMonitors")]
    pub use_all_monitors: bool,
    #[serde(rename = "adaptiveFps", default)]
    pub adaptive_fps: bool,
    #[serde(rename = "showShortcutOverlay", default = "default_true")]
    pub show_shortcut_overlay: bool,
    /// Unique device ID for AI usage tracking (generated on first launch)
    #[serde(rename = "deviceId", default = "generate_device_id")]
    pub device_id: String,
    /// Enable input event capture (keyboard, mouse, clipboard).
    /// Requires input monitoring permission on macOS.
    #[serde(rename = "enableInputCapture", default)]
    pub enable_input_capture: bool,
    /// Enable accessibility text capture (AX tree walker).
    /// Requires accessibility permission on macOS.
    #[serde(rename = "enableAccessibility", alias = "enableUiEvents", default = "default_true")]
    pub enable_accessibility: bool,
    /// Auto-install updates and restart when a new version is available.
    /// When disabled, users must click "update now" in the tray menu.
    #[serde(rename = "autoUpdate", default = "default_true")]
    pub auto_update: bool,
    /// Timeline overlay mode: "fullscreen" (floating panel above everything) or
    /// "window" (normal resizable window with title bar).
    #[serde(rename = "overlayMode", default = "default_overlay_mode")]
    pub overlay_mode: String,
    /// Allow screen recording apps to capture the overlay.
    /// Disabled by default so the overlay doesn't appear in screenpipe's own recordings.
    #[serde(rename = "showOverlayInScreenRecording", default)]
    pub show_overlay_in_screen_recording: bool,
    /// Video quality preset controlling storage vs quality tradeoff.
    /// Affects H.265 CRF during recording and JPEG quality during frame extraction.
    /// Values: "low", "balanced", "high", "max". Default: "balanced".
    #[serde(rename = "videoQuality", default = "default_video_quality")]
    pub video_quality: String,

    /// Catch-all for fields added by the frontend (e.g. chatHistory, deviceId)
    /// that the Rust struct doesn't know about. Without this, `save()` would
    /// serialize only known fields and silently wipe frontend-only data.
    #[serde(flatten)]
    pub extra: std::collections::HashMap<String, serde_json::Value>,
}

fn default_video_quality() -> String {
    "balanced".to_string()
}

fn generate_device_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn default_true() -> bool {
    true
}

fn default_overlay_mode() -> String {
    "fullscreen".to_string()
}

#[derive(Serialize, Deserialize, Type,Clone,Default)]
pub enum AIProviderType {
    #[default]
    #[serde(rename = "openai")]
    OpenAI,
    #[serde(rename = "native-ollama")]
    NativeOllama,
    #[serde(rename = "custom")]
    Custom,
    #[serde(rename = "screenpipe-cloud")]
    ScreenpipeCloud,
    #[serde(rename = "pi", alias = "opencode")]
    Pi,
}

#[derive(Serialize, Deserialize,Type,Clone)]
#[serde(default)]
pub struct AIPreset {
    pub id: String,
    pub prompt: String,
    pub provider: AIProviderType,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub model: String,
    #[serde(rename = "defaultPreset")]
    pub default_preset: bool,
    #[serde(rename = "apiKey")]
    pub api_key: Option<String>,
    #[serde(rename = "maxContextChars")]
    pub max_context_chars: i32,
}

impl Default for AIPreset {
    fn default() -> Self {
        Self {
            id: String::new(),
            prompt: String::new(),
            provider: AIProviderType::ScreenpipeCloud,
            url: "https://api.screenpi.pe/v1".to_string(),
            model: "claude-haiku-4-5@20251001".to_string(),
            default_preset: false,
            api_key: None,
            max_context_chars: 512000,
        }
    }
}

#[derive(Serialize, Deserialize,Type,Clone)]
#[serde(default)]
pub struct User {
    pub id: Option<String>,
    pub name: Option<String>,
    pub email: Option<String>,
    pub image: Option<String>,
    pub token: Option<String>,
    pub clerk_id: Option<String>,
    pub api_key: Option<String>,
    pub credits: Option<Credits>,
    pub stripe_connected: Option<bool>,
    pub stripe_account_status: Option<String>,
    pub github_username: Option<String>,
    pub bio: Option<String>,
    pub website: Option<String>,
    pub contact: Option<String>,
    pub cloud_subscribed: Option<bool>,
    pub credits_balance: Option<i32>,
}

impl Default for User {
    fn default() -> Self {
        Self {
            id: None,
            name: None,
            email: None,
            image: None,
            token: None,
            clerk_id: None,
            api_key: None,
            credits: None,
            stripe_connected: None,
            stripe_account_status: None,
            github_username: None,
            bio: None,
            website: None,
            contact: None,
            cloud_subscribed: None,
            credits_balance: None,
        }
    }
}

#[derive(Serialize, Deserialize,Type,Clone)]
#[serde(default)]
pub struct Credits {
    pub amount: i32,
}

impl Default for Credits {
    fn default() -> Self {
        Self {
            amount: 0,
        }
    }
}

#[derive(Serialize, Deserialize,Type,Clone)]
#[serde(default)]
pub struct EmbeddedLLM {
    pub enabled: bool,
    pub model: String,
    pub port: u16,
}

impl Default for EmbeddedLLM {
    fn default() -> Self {
        Self {
            enabled: false,
            model: "ministral-3:latest".to_string(),
            port: 11434,
        }
    }
}

impl Default for SettingsStore {
    fn default() -> Self {
        // Default ignored windows for all OS
        let mut ignored_windows = vec![
            "bit".to_string(),
            "VPN".to_string(),
            "Trash".to_string(),
            "Private".to_string(),
            "Incognito".to_string(),
            "Wallpaper".to_string(),
            "Settings".to_string(),
            "Keepass".to_string(),
            "Recorder".to_string(),
            "Vaults".to_string(),
            "OBS Studio".to_string(),
            "screenpipe".to_string(),
        ];

        // Add platform-specific ignored windows
        // Note: In a real implementation, you'd detect the actual platform
        // For now, we'll include common ones or you can detect platform here
        #[cfg(target_os = "macos")]
        ignored_windows.extend([
            ".env".to_string(),
            "Item-0".to_string(),
            "App Icon Window".to_string(),
            "Battery".to_string(),
            "Shortcuts".to_string(),
            "WiFi".to_string(),
            "BentoBox".to_string(),
            "Clock".to_string(),
            "Dock".to_string(),
            "DeepL".to_string(),
            "Control Center".to_string(),
        ]);

        #[cfg(target_os = "windows")]
        ignored_windows.extend([
            "Nvidia".to_string(),
            "Control Panel".to_string(),
            "System Properties".to_string(),
        ]);

        #[cfg(target_os = "linux")]
        ignored_windows.extend([
            "Info center".to_string(),
            "Discover".to_string(),
            "Parted".to_string(),
        ]);

        // Default free AI preset - works without login
        let default_free_preset = AIPreset {
            id: "screenpipe-free".to_string(),
            prompt: r#"Rules:
- You can analyze/view/show/access videos to the user by putting .mp4 files in a code block (we'll render it) like this: `/users/video.mp4`, use the exact, absolute, file path from file_path property
- Do not try to embed video in links (e.g. [](.mp4) or https://.mp4) instead put the file_path in a code block using backticks
- Do not put video in multiline code block it will not render the video (e.g. ```bash\n.mp4```) instead using inline code block with single backtick
- Always answer my question/intent, do not make up things
"#.to_string(),
            provider: AIProviderType::ScreenpipeCloud,
            url: "https://api.screenpi.pe/v1".to_string(),
            model: "claude-haiku-4-5@20251001".to_string(),
            default_preset: true,
            api_key: None,
            max_context_chars: 128000,
        };

        Self {
            ai_presets: vec![default_free_preset],
            deepgram_api_key: "".to_string(),
            is_loading: false,
            user_id: "".to_string(),
            analytics_id: uuid::Uuid::new_v4().to_string(),
         
            dev_mode: false,
            audio_transcription_engine: "whisper-large-v3-turbo-quantized".to_string(),
            #[cfg(target_os = "macos")]
            ocr_engine: "apple-native".to_string(),
            #[cfg(target_os = "windows")]
            ocr_engine: "windows-native".to_string(),
            #[cfg(target_os = "linux")]
            ocr_engine: "tesseract".to_string(),
            monitor_ids: vec!["default".to_string()],
            audio_devices: vec!["default".to_string()],
            use_system_default_audio: true,
            use_pii_removal: true,
            port: 3030,
            data_dir: "default".to_string(),
            disable_audio: false,
            ignored_windows,
            included_windows: vec![],
            ignored_urls: vec![],

            fps: 0.5,
            vad_sensitivity: "high".to_string(),
            analytics_enabled: true,
            audio_chunk_duration: 30,
            use_chinese_mirror: false,
            languages: vec![],
            embedded_llm: EmbeddedLLM::default(),
            auto_start_enabled: true,
            platform: "unknown".to_string(),
            disabled_shortcuts: vec![],
            user: User {
                id: None,
                name: None,
                email: None,
                image: None,
                token: None,
                clerk_id: None,
                api_key: None,
                credits: None,
                stripe_connected: None,
                stripe_account_status: None,
                github_username: None,
                bio: None,
                website: None,
                contact: None,
                cloud_subscribed: None,
                credits_balance: None,
            },
            #[cfg(target_os = "windows")]
            show_screenpipe_shortcut: "Alt+S".to_string(),
            #[cfg(not(target_os = "windows"))]
            show_screenpipe_shortcut: "Super+Ctrl+S".to_string(),
            #[cfg(target_os = "windows")]
            start_recording_shortcut: "Alt+Shift+U".to_string(),
            #[cfg(not(target_os = "windows"))]
            start_recording_shortcut: "Super+Ctrl+U".to_string(),
            #[cfg(target_os = "windows")]
            stop_recording_shortcut: "Alt+Shift+X".to_string(),
            #[cfg(not(target_os = "windows"))]
            stop_recording_shortcut: "Super+Ctrl+X".to_string(),
            start_audio_shortcut: "".to_string(),
            stop_audio_shortcut: "".to_string(),
            #[cfg(target_os = "windows")]
            show_chat_shortcut: "Alt+L".to_string(),
            #[cfg(not(target_os = "windows"))]
            show_chat_shortcut: "Control+Super+L".to_string(),
            #[cfg(target_os = "windows")]
            search_shortcut: "Alt+K".to_string(),
            #[cfg(not(target_os = "windows"))]
            search_shortcut: "Control+Super+K".to_string(),
            realtime_audio_transcription_engine: "deepgram".to_string(),
            disable_vision: false,
            disable_ocr: false,
            use_all_monitors: true,  // Match CLI default - dynamic monitor detection
            show_shortcut_overlay: true,
            device_id: uuid::Uuid::new_v4().to_string(),
            adaptive_fps: false,
            enable_input_capture: false,
            enable_accessibility: true,
            auto_update: true,
            overlay_mode: "fullscreen".to_string(),
            show_overlay_in_screen_recording: false,
            video_quality: "balanced".to_string(),
            extra: std::collections::HashMap::new(),
        }
    }
}

impl SettingsStore {
    pub fn get(app: &AppHandle) -> Result<Option<Self>, String> {
        let store = get_store(app, None).map_err(|e| format!("Failed to get store: {}", e))?;

        match store.is_empty() {
            true => Ok(None),
            false => {
                let settings = serde_json::from_value(store.get("settings").unwrap_or(Value::Null));
                match settings {
                    Ok(settings) => Ok(settings),
                    Err(e) => {
                        error!("Failed to deserialize settings: {}", e);
                        Err(e.to_string())
                    }
                }
            }
        }
    }

    pub fn save(&self,app: &AppHandle) -> Result<(), String> {
        let Ok(store) = get_store(app, None) else {
            return Err("Failed to get store".to_string());
        };

        store.set("settings", json!(self));
        store.save().map_err(|e| e.to_string())
    }
}

pub fn init_store(app: &AppHandle) -> Result<SettingsStore, String> {
    println!("Initializing settings store");

    let (store, should_save) = match SettingsStore::get(app) {
        Ok(Some(store)) => (store, false), // Loaded successfully, don't overwrite
        Ok(None) => (SettingsStore::default(), true), // New store, save defaults
        Err(e) => {
            // Fallback to defaults when deserialization fails (e.g., corrupted store)
            // DON'T save - preserve original store in case it can be manually recovered
            // This prevents crashes from invalid values like negative integers in u32 fields
            error!("Failed to deserialize settings, using defaults (store not overwritten): {}", e);
            (SettingsStore::default(), false)
        }
    };

    if should_save {
        store.save(app).unwrap();
    }
    Ok(store)
}

pub fn init_onboarding_store(app: &AppHandle) -> Result<OnboardingStore, String> {
    println!("Initializing onboarding store");

    let (onboarding, should_save) = match OnboardingStore::get(app) {
        Ok(Some(onboarding)) => (onboarding, false),
        Ok(None) => (OnboardingStore::default(), true),
        Err(e) => {
            // Fallback to defaults when deserialization fails
            // DON'T save - preserve original store
            error!("Failed to deserialize onboarding, using defaults (store not overwritten): {}", e);
            (OnboardingStore::default(), false)
        }
    };

    if should_save {
        onboarding.save(app).unwrap();
    }
    Ok(onboarding)
}

/// Obsidian sync settings stored persistently
#[derive(Serialize, Deserialize, Type, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ObsidianSettingsStore {
    pub enabled: bool,
    pub vault_path: String,
    #[serde(default = "default_notes_path")]
    pub notes_path: String,
    pub sync_interval_minutes: u32,
    pub custom_prompt: String,
    pub sync_hours: u32,
    /// Next scheduled run time (ISO 8601) - used to resume scheduler after app restart
    #[serde(default)]
    pub next_scheduled_run: Option<String>,
}

fn default_notes_path() -> String {
    "screenpipe/logs".to_string()
}

impl ObsidianSettingsStore {
    pub fn get(app: &AppHandle) -> Result<Option<Self>, String> {
        let store = get_store(app, None).map_err(|e| e.to_string())?;

        match store.is_empty() {
            true => Ok(None),
            false => {
                let settings = serde_json::from_value(store.get("obsidian").unwrap_or(Value::Null));
                match settings {
                    Ok(settings) => Ok(settings),
                    Err(_) => Ok(None),
                }
            }
        }
    }

    pub fn save(&self, app: &AppHandle) -> Result<(), String> {
        let store = get_store(app, None).map_err(|e| e.to_string())?;
        store.set("obsidian", json!(self));
        store.save().map_err(|e| e.to_string())
    }
}

// ─── Reminders Settings ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemindersSettingsStore {
    pub enabled: bool,
    #[serde(default)]
    pub custom_prompt: String,
    /// When true, only audio/transcript data is used (no screen OCR).
    #[serde(default = "reminders_audio_only_default")]
    pub audio_only: bool,
}

fn reminders_audio_only_default() -> bool { true }

// ─── Cloud Sync Settings ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudSyncSettingsStore {
    pub enabled: bool,
    /// Base64-encoded encryption password for auto-init on startup
    #[serde(default)]
    pub encrypted_password: String,
}

impl CloudSyncSettingsStore {
    pub fn get(app: &AppHandle) -> Result<Option<Self>, String> {
        let store = get_store(app, None).map_err(|e| e.to_string())?;
        if store.is_empty() {
            return Ok(None);
        }
        let settings =
            serde_json::from_value(store.get("cloud_sync").unwrap_or(Value::Null));
        match settings {
            Ok(settings) => Ok(settings),
            Err(_) => Ok(None),
        }
    }

    pub fn save(&self, app: &AppHandle) -> Result<(), String> {
        let store = get_store(app, None).map_err(|e| e.to_string())?;
        store.set("cloud_sync", json!(self));
        store.save().map_err(|e| e.to_string())
    }
}

impl RemindersSettingsStore {
    pub fn get(app: &AppHandle) -> Result<Option<Self>, String> {
        let store = get_store(app, None).map_err(|e| e.to_string())?;
        if store.is_empty() {
            return Ok(None);
        }
        let settings = serde_json::from_value(store.get("reminders").unwrap_or(Value::Null));
        match settings {
            Ok(settings) => Ok(settings),
            Err(_) => Ok(None),
        }
    }

    pub fn save(&self, app: &AppHandle) -> Result<(), String> {
        let store = get_store(app, None).map_err(|e| e.to_string())?;
        store.set("reminders", json!(self));
        store.save().map_err(|e| e.to_string())
    }
}