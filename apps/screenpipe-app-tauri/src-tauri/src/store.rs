use super::get_base_dir;
use super::secrets;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use specta::Type;
use std::path::Path;
use std::sync::{Arc, Mutex, RwLock};
use tauri::AppHandle;
use tauri_plugin_store::StoreBuilder;
use tracing::{error, warn};
use screenpipe_secrets::keychain;

/// Process-lifetime cache for the resolved API auth key.
///
/// `to_recording_config` is a sync function called many times per second
/// (frontend polls `local_api_context_from_app`). Resolving the key —
/// which requires async I/O against `db.sqlite` — happens once per
/// recording start via `screenpipe_engine::auth_key::resolve_api_auth_key`,
/// and the result is seeded here so every subsequent sync read is cheap and
/// every caller agrees on the same value.
///
/// Uses RwLock (not OnceLock) so the key can be updated on every restart
/// within the same process — OnceLock would silently ignore the second
/// seed call and keep the original key forever.
static RESOLVED_API_AUTH_KEY: RwLock<Option<String>> = RwLock::new(None);

/// Seed the resolved API auth key. Overwrites any previously seeded value
/// so that "Apply & Restart" picks up the new key on the next server start.
pub fn seed_api_auth_key(key: String) {
    if let Ok(mut guard) = RESOLVED_API_AUTH_KEY.write() {
        *guard = Some(key);
    }
}

/// Read the resolved API auth key if it has been seeded.
pub fn resolved_api_auth_key() -> Option<String> {
    RESOLVED_API_AUTH_KEY.read().ok()?.clone()
}

/// Magic header for encrypted store.bin files.
const STORE_MAGIC: &[u8; 8] = b"SPSTORE1";

// ---------------------------------------------------------------------------
// Settings-loss recovery
//
// Goal: a user can never be silently reset to default settings on update.
// 4 layers, defense in depth:
//   L1: snapshot `store.bin.last-good` after every successful save (only if
//       the snapshot has aiPresets — never freeze a degraded state).
//   L2: at boot, before the Tauri store plugin opens the file, auto-restore
//       from `.last-good` IFF the current file is degraded (parses but no
//       aiPresets) AND last-good is healthy. The bad file is moved to
//       `store.bin.pre-restore-<ts>` for forensics.
//   L3: refuse `create_new()` over a healthy on-disk file (would otherwise
//       create a fresh in-memory store that overwrites disk on next save).
//   L4: stop writing `b"{}"` on encryption-key failures — keep the encrypted
//       file in place and let the load fail loudly instead.
// ---------------------------------------------------------------------------

/// Suffix for the most-recent known-healthy snapshot.
const LAST_GOOD_SUFFIX: &str = "bin.last-good";

/// Did this store JSON parse and contain a non-empty `settings.aiPresets`?
/// Used as the "is this a real user state" signal — empty presets means the
/// migration in use-settings.tsx will seed defaults, which is the wipe trigger.
fn store_json_has_presets(data: &[u8]) -> bool {
    serde_json::from_slice::<Value>(data)
        .ok()
        .and_then(|v| {
            v.pointer("/settings/aiPresets")
                .and_then(|p| p.as_array())
                .map(|a| !a.is_empty())
        })
        .unwrap_or(false)
}

/// L1 — copy `store.bin` → `store.bin.last-good` if the current file parses
/// and has aiPresets. Skipped silently otherwise so we never freeze a wiped
/// state as the recovery source. Called after every successful save.
pub fn snapshot_last_good(store_path: &Path) {
    let data = match std::fs::read(store_path) {
        Ok(d) => d,
        Err(_) => return,
    };
    if !store_json_has_presets(&data) {
        return;
    }
    let last_good = store_path.with_extension(LAST_GOOD_SUFFIX);
    if let Err(e) = std::fs::write(&last_good, &data) {
        tracing::warn!(
            "snapshot_last_good: failed to write {}: {}",
            last_good.display(),
            e
        );
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&last_good, std::fs::Permissions::from_mode(0o600));
    }
}

/// L2 — if `store.bin` is degraded (parses but missing aiPresets) and
/// `.last-good` is healthy, restore it before anything else touches the file.
/// The bad current file is preserved as `.pre-restore-<UTC ts>` so we have
/// forensics if a user reports the restore was wrong.
///
/// Returns `true` when a restore happened (telemetry hook). Logged loudly so
/// it shows up in screenpipe-app.YYYY-MM-DD.log.
pub fn auto_restore_if_wiped(store_path: &Path) -> bool {
    // Only act on plain-JSON files. Encrypted files are handled by the
    // decrypt path; we don't want to restore over a still-encrypted blob.
    let cur = match std::fs::read(store_path) {
        Ok(d) => d,
        Err(_) => return false,
    };
    if cur.len() >= 8 && &cur[..8] == STORE_MAGIC {
        return false;
    }
    if store_json_has_presets(&cur) {
        return false; // current state is healthy, nothing to do
    }
    let last_good = store_path.with_extension(LAST_GOOD_SUFFIX);
    let Ok(lg) = std::fs::read(&last_good) else {
        return false;
    };
    if !store_json_has_presets(&lg) {
        return false; // last-good is also wiped (shouldn't happen — L1 guards this)
    }

    // Move the bad file aside before overwriting it
    let ts = chrono::Utc::now().format("%Y%m%d-%H%M%S");
    let pre_restore = store_path.with_extension(format!("bin.pre-restore-{}", ts));
    if let Err(e) = std::fs::copy(store_path, &pre_restore) {
        tracing::warn!(
            "auto_restore_if_wiped: failed to back up {} to {}: {} — aborting restore",
            store_path.display(),
            pre_restore.display(),
            e
        );
        return false;
    }

    if let Err(e) = std::fs::write(store_path, &lg) {
        tracing::error!(
            "auto_restore_if_wiped: failed to restore {} from {}: {}",
            store_path.display(),
            last_good.display(),
            e
        );
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(store_path, std::fs::Permissions::from_mode(0o600));
    }
    tracing::warn!(
        "auto_restore_if_wiped: restored {} from {} (was missing aiPresets); \
         pre-restore copy at {}",
        store_path.display(),
        last_good.display(),
        pre_restore.display()
    );
    true
}

/// Decrypt store.bin in place if it's encrypted and keychain key is available.
/// No-op if the file is already plain JSON or keychain is unavailable.
fn decrypt_store_file(path: &Path) {
    let data = match std::fs::read(path) {
        Ok(d) => d,
        Err(_) => return,
    };
    if data.len() < 8 || &data[..8] != STORE_MAGIC {
        return; // already plain JSON (or empty)
    }
    // File is encrypted, so user must have encryption enabled
    // Use get_key_if_encryption_enabled to prevent prompts if encryption is somehow disabled
    let key = match secrets::get_key_if_encryption_enabled() {
        secrets::KeyResult::Found(k) => k,
        secrets::KeyResult::AccessDenied => {
            tracing::warn!(
                "store.bin is encrypted but keychain access was denied — \
                 please grant keychain access and restart. \
                 Your settings are preserved in the encrypted file."
            );
            // Don't overwrite — the file is still valid, user just needs to grant access
            return;
        }
        secrets::KeyResult::NotFound | secrets::KeyResult::Unavailable => {
            // L4 — DO NOT wipe. Previously this branch wrote `b"{}"` over
            // store.bin and lost the user's settings on every signed update
            // (macOS code-signing identity changes can evict keychain keys).
            // The encrypted file still has the user's data; leave it in
            // place and let the load fall through to L2 auto_restore from
            // store.bin.last-good. Manual recovery: re-grant keychain
            // access in System Settings → Privacy & Security → Keychain.
            let backup = path.with_extension("bin.encrypted.bak");
            let _ = std::fs::copy(path, &backup);
            tracing::error!(
                "store.bin is encrypted but keychain key not found — \
                 leaving the encrypted file in place ({}). Restore from \
                 store.bin.last-good or grant keychain access and restart.",
                backup.display()
            );
            return;
        }
    };
    match screenpipe_vault::crypto::decrypt_small(&data[8..], &key) {
        Ok(plaintext) => {
            let tmp = path.with_extension("bin.dec.tmp");
            if std::fs::write(&tmp, &plaintext).is_ok() {
                let _ = std::fs::rename(&tmp, path);
            }
        }
        Err(e) => {
            // L4 — DO NOT wipe. Same rationale as the missing-key branch
            // above: keep the encrypted file (now backed up under .encrypted.bak)
            // so the user has a recovery path, and let the load fall
            // through to L2 auto_restore.
            let backup = path.with_extension("bin.encrypted.bak");
            let _ = std::fs::copy(path, &backup);
            tracing::error!(
                "failed to decrypt store.bin: {} — backed up as {}, leaving \
                 in place. Restore from store.bin.last-good if available.",
                e,
                backup.display()
            );
        }
    }
}

/// Encrypt store.bin in place if keychain key is available AND encryption is opted-in.
///
/// DISABLED BY DEFAULT — the macOS keychain doesn't reliably persist keys across
/// app updates (code signing identity changes), causing settings loss on every update.
/// The 0o600 file permissions are sufficient protection for now.
///
/// To opt in: create ~/.screenpipe/.encrypt-store or set SCREENPIPE_ENCRYPT_STORE=1.
fn encrypt_store_file(path: &Path) {
    // Check opt-in flag
    let opted_in = std::env::var("SCREENPIPE_ENCRYPT_STORE")
        .map(|v| v == "1")
        .unwrap_or(false)
        || path
            .parent()
            .map(|p| p.join(".encrypt-store").exists())
            .unwrap_or(false);
    if !opted_in {
        return;
    }

    let data = match std::fs::read(path) {
        Ok(d) => d,
        Err(_) => return,
    };
    if data.len() >= 8 && &data[..8] == STORE_MAGIC {
        return; // already encrypted
    }
    // Use read-only get_key() instead of get_or_create_key() to avoid triggering
    // keychain modal on every store save. The key should already exist if encryption
    // was enabled; if not, we just skip encryption and leave the file unencrypted.
    let key = match keychain::get_key() {
        keychain::KeyResult::Found(k) => k,
        keychain::KeyResult::AccessDenied => {
            // Keychain access denied — disable encryption
            // and remove the opt-in flag so user isn't stuck in a broken state
            if let Some(parent) = path.parent() {
                let flag = parent.join(".encrypt-store");
                if flag.exists() {
                    let _ = std::fs::remove_file(&flag);
                    tracing::warn!(
                        "store encryption disabled — keychain access denied. \
                         re-enable in Settings > Privacy after granting keychain access."
                    );
                }
            }
            return;
        }
        keychain::KeyResult::NotFound | keychain::KeyResult::Unavailable => {
            // Key doesn't exist or keychain unavailable — can't encrypt
            return;
        }
    };
    match screenpipe_vault::crypto::encrypt_small(&data, &key) {
        Ok(ciphertext) => {
            let mut out = Vec::with_capacity(8 + ciphertext.len());
            out.extend_from_slice(STORE_MAGIC);
            out.extend(ciphertext);
            let tmp = path.with_extension("bin.enc.tmp");
            if std::fs::write(&tmp, &out).is_ok() {
                let _ = std::fs::rename(&tmp, path);
            }
        }
        Err(e) => {
            tracing::error!("failed to encrypt store.bin: {}", e);
        }
    }
}

/// Re-encrypt store.bin on disk. Called after the Tauri store plugin writes plain JSON.
/// Also syncs the .encrypt-store flag file from the encryptStore setting.
pub fn reencrypt_store_file(app: &AppHandle) {
    if let Ok(base_dir) = get_base_dir(app, None) {
        // Sync the flag file from the store's encryptStore setting
        let flag_path = base_dir.join(".encrypt-store");
        let store_path = base_dir.join("store.bin");

        // Read the setting from the store JSON on disk
        let encrypt_enabled = std::fs::read(&store_path)
            .ok()
            .and_then(|data| serde_json::from_slice::<serde_json::Value>(&data).ok())
            .and_then(|json| {
                json.get("settings")
                    .and_then(|s| s.get("encryptStore"))
                    .and_then(|v| v.as_bool())
            })
            .unwrap_or(false);

        if encrypt_enabled && !flag_path.exists() {
            let _ = std::fs::write(&flag_path, b"");
        } else if !encrypt_enabled && flag_path.exists() {
            let _ = std::fs::remove_file(&flag_path);
        }

        // L1 — snapshot the current state to .last-good IFF it's healthy
        // (parses + has aiPresets). Runs BEFORE encryption so the snapshot
        // is plain JSON and recoverable even if keychain access is lost on
        // the next update. No-op for degraded states so we never freeze
        // bad data as the recovery source.
        snapshot_last_good(&store_path);

        encrypt_store_file(&store_path);
    }
}

/// Tauri command: re-encrypt store.bin after frontend saves.
#[tauri::command]
#[specta::specta]
pub fn reencrypt_store(app: AppHandle) -> Result<(), String> {
    reencrypt_store_file(&app);
    Ok(())
}

/// Cached store instance — reusable across the process lifetime.
/// Uses Mutex instead of OnceLock so the cache can be invalidated when the
/// Tauri resource table drops the underlying store (e.g. after an in-place
/// update restart on Windows where resource IDs become stale).
static STORE_CACHE: Mutex<Option<Arc<tauri_plugin_store::Store<tauri::Wry>>>> = Mutex::new(None);

/// Build (or rebuild) the store, retrying on TOCTOU races and stale resource IDs.
fn build_store(app: &AppHandle) -> anyhow::Result<Arc<tauri_plugin_store::Store<tauri::Wry>>> {
    let base_dir = get_base_dir(app, None)?;
    let store_path = base_dir.join("store.bin");

    // Decrypt store.bin before the plugin reads it (no-op if plain JSON or keychain unavailable)
    if store_path.exists() {
        decrypt_store_file(&store_path);
    }

    // L2 — if the file is degraded (parses but has no aiPresets), restore
    // from .last-good before the plugin reads it. Runs after decrypt so
    // we operate on the plain-JSON form. No-op if the current state is
    // already healthy or no .last-good exists yet.
    if store_path.exists() {
        let _ = auto_restore_if_wiped(&store_path);
    }

    let mut last_err = None;
    // Ensure store.bin has restrictive permissions (contains API keys)
    #[cfg(unix)]
    if store_path.exists() {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&store_path, std::fs::Permissions::from_mode(0o600));
    }

    for attempt in 0..3u32 {
        match StoreBuilder::new(app, store_path.clone()).build() {
            Ok(s) => {
                // Re-encrypt immediately after the plugin loaded the file
                encrypt_store_file(&store_path);
                return Ok(s);
            }
            Err(e) => {
                let msg = e.to_string();
                if msg.contains("os error 17") || msg.contains("File exists") {
                    tracing::warn!(
                        "store build race (attempt {}): {}, retrying",
                        attempt + 1,
                        msg
                    );
                    std::thread::sleep(std::time::Duration::from_millis(
                        100 * (attempt as u64 + 1),
                    ));
                    last_err = Some(e);
                    continue;
                }
                // After cleanup_before_exit or in-place update on Windows, the
                // resources_table is cleared but StoreState.stores still holds the
                // old resource ID. Force a fresh store via create_new to evict it.
                if msg.contains("resource id") && msg.contains("invalid") {
                    // L3 — refuse `create_new()` over a healthy on-disk
                    // file. The fresh in-memory store would later flush
                    // empty defaults to disk and silently overwrite the
                    // user's settings (verified root cause for Louis's
                    // 2026-05-09 wipe). If the file has aiPresets, surface
                    // the error so the retry loop runs again instead.
                    let disk_healthy = std::fs::read(&store_path)
                        .map(|d| store_json_has_presets(&d))
                        .unwrap_or(false);
                    if disk_healthy {
                        tracing::error!(
                            "store resource stale (attempt {}): {}, but disk \
                             has aiPresets — refusing create_new() to avoid \
                             overwriting user data; will retry .build()",
                            attempt + 1,
                            msg
                        );
                        last_err = Some(e);
                        std::thread::sleep(std::time::Duration::from_millis(
                            200 * (attempt as u64 + 1),
                        ));
                        continue;
                    }
                    tracing::warn!(
                        "store resource stale (attempt {}): {}, rebuilding fresh \
                         (disk file empty/missing presets, safe to create_new)",
                        attempt + 1,
                        msg
                    );
                    match StoreBuilder::new(app, store_path.clone())
                        .create_new()
                        .build()
                    {
                        Ok(s) => {
                            encrypt_store_file(&store_path);
                            return Ok(s);
                        }
                        Err(e2) => {
                            tracing::warn!("fresh store build also failed: {}", e2);
                            last_err = Some(e);
                            continue;
                        }
                    }
                }
                return Err(anyhow::anyhow!(e));
            }
        }
    }
    Err(anyhow::anyhow!(last_err.unwrap()))
}

pub fn get_store(
    app: &AppHandle,
    _profile_name: Option<String>, // Keep parameter for API compatibility but ignore it
) -> anyhow::Result<Arc<tauri_plugin_store::Store<tauri::Wry>>> {
    {
        let guard = STORE_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(ref cached) = *guard {
            return Ok(cached.clone());
        }
    }

    let in_tokio = tokio::runtime::Handle::try_current().is_ok();
    let store = if in_tokio {
        tokio::task::block_in_place(|| build_store(app))?
    } else {
        build_store(app)?
    };

    let mut guard = STORE_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(ref cached) = *guard {
        return Ok(cached.clone());
    }
    *guard = Some(store.clone());
    Ok(store)
}

/// Invalidate the cached store so the next `get_store` call rebuilds it.
/// Called when a "resource id … is invalid" error is detected.
pub fn invalidate_store_cache() {
    if let Ok(mut guard) = STORE_CACHE.lock() {
        if guard.is_some() {
            tracing::warn!("store cache invalidated — will rebuild on next access");
            *guard = None;
        }
    }
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
                let onboarding =
                    serde_json::from_value(store.get("onboarding").unwrap_or(Value::Null));
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

    pub fn update(
        app: &AppHandle,
        update: impl FnOnce(&mut OnboardingStore),
    ) -> Result<(), String> {
        let Ok(store) = get_store(app, None) else {
            return Err("Failed to get onboarding store".to_string());
        };

        let mut onboarding = Self::get(app)?.unwrap_or_default();
        update(&mut onboarding);
        store.set("onboarding", json!(onboarding));
        store.save().map_err(|e| e.to_string())?;
        reencrypt_store_file(app);
        Ok(())
    }

    pub fn save(&self, app: &AppHandle) -> Result<(), String> {
        let Ok(store) = get_store(app, None) else {
            return Err("Failed to get onboarding store".to_string());
        };

        store.set("onboarding", json!(self));
        store.save().map_err(|e| e.to_string())?;
        reencrypt_store_file(app);
        Ok(())
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

fn deserialize_null_as_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    T: Default + Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    let opt = Option::deserialize(deserializer)?;
    Ok(opt.unwrap_or_default())
}

#[derive(Serialize, Deserialize, Type, Clone)]
#[serde(default)]
pub struct SettingsStore {
    // ── Recording settings (shared source of truth) ──────────────────────
    /// All recording/capture config lives here. Flattened so the JSON shape
    /// is unchanged — `disableAudio`, `port`, `fps`, etc. stay at the top level.
    #[serde(flatten)]
    pub recording: screenpipe_config::RecordingSettings,

    // ── App-only fields (UI, shortcuts, metadata) ────────────────────────
    #[serde(rename = "aiPresets", deserialize_with = "deserialize_null_as_default")]
    pub ai_presets: Vec<AIPreset>,

    #[serde(rename = "isLoading")]
    pub is_loading: bool,

    #[serde(rename = "devMode")]
    pub dev_mode: bool,
    #[serde(rename = "ocrEngine")]
    pub ocr_engine: String,
    #[serde(rename = "dataDir")]
    pub data_dir: String,
    #[serde(
        rename = "embeddedLLM",
        deserialize_with = "deserialize_null_as_default"
    )]
    pub embedded_llm: EmbeddedLLM,
    #[serde(rename = "autoStartEnabled")]
    pub auto_start_enabled: bool,
    #[serde(rename = "platform")]
    pub platform: String,
    #[serde(
        rename = "disabledShortcuts",
        deserialize_with = "deserialize_null_as_default"
    )]
    pub disabled_shortcuts: Vec<String>,
    #[serde(rename = "user", deserialize_with = "deserialize_null_as_default")]
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
    #[serde(rename = "lockVaultShortcut", default)]
    pub lock_vault_shortcut: String,
    /// When true, screen capture continues but OCR text extraction is skipped.
    /// Reduces CPU usage significantly while still recording video.
    #[serde(rename = "disableOcr", default)]
    pub disable_ocr: bool,
    #[serde(rename = "showShortcutOverlay", default = "default_true")]
    pub show_shortcut_overlay: bool,
    /// Overlay size: "small" (default), "medium" (1.5x), "large" (2x)
    #[serde(rename = "shortcutOverlaySize", default = "default_overlay_size")]
    pub shortcut_overlay_size: String,
    /// Unique device ID for AI usage tracking (generated on first launch)
    #[serde(rename = "deviceId", default = "generate_device_id")]
    pub device_id: String,
    /// Auto-install updates and restart when a new version is available.
    /// When disabled, users must click "update now" in the tray menu.
    #[serde(rename = "autoUpdate", default = "default_true")]
    pub auto_update: bool,
    /// Auto-update store-installed pipes that haven't been locally modified.
    #[serde(rename = "autoUpdatePipes", default = "default_true")]
    pub auto_update_pipes: bool,
    /// Use screenpipe cloud for AI-powered features like suggestions.
    /// Better quality but sends activity context to the cloud (zero data retention).
    #[serde(rename = "enhancedAI", default)]
    pub enhanced_ai: bool,
    /// Timeline overlay mode: "fullscreen" (floating panel above everything) or
    /// "window" (normal resizable window with title bar).
    #[serde(rename = "overlayMode", default = "default_overlay_mode")]
    pub overlay_mode: String,
    /// Allow screen recording apps to capture the overlay.
    /// Disabled by default so the overlay doesn't appear in screenpipe's own recordings.
    #[serde(rename = "showOverlayInScreenRecording", default)]
    pub show_overlay_in_screen_recording: bool,

    /// When true, the chat window stays above all other windows (default: true).
    #[serde(rename = "chatAlwaysOnTop", default = "default_true")]
    pub chat_always_on_top: bool,

    /// Show restart notifications when audio/vision capture stalls.
    /// Disabled by default for now until the stall detector is more reliable.
    #[serde(rename = "showRestartNotifications", default)]
    pub show_restart_notifications: bool,

    /// When true, apply macOS vibrancy effect to the sidebar for a translucent look.
    #[serde(rename = "translucentSidebar", default)]
    pub translucent_sidebar: bool,

    /// When true (default), hide model "thinking" reasoning blocks in the chat
    /// transcript. The model still emits them server-side; we just don't
    /// render the collapsible block in the UI.
    #[serde(rename = "hideThinkingBlocks", default = "default_true")]
    pub hide_thinking_blocks: bool,

    /// UI theme: "light", "dark", or "system".
    #[serde(rename = "uiTheme", default = "default_ui_theme")]
    pub ui_theme: String,

    /// Catch-all for fields added by the frontend (e.g. chatHistory)
    /// that the Rust struct doesn't know about. Without this, `save()` would
    /// serialize only known fields and silently wipe frontend-only data.
    #[serde(flatten)]
    pub extra: std::collections::HashMap<String, serde_json::Value>,
}

fn generate_device_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn default_true() -> bool {
    true
}

fn default_overlay_size() -> String {
    "small".to_string()
}

fn default_ui_theme() -> String {
    "system".to_string()
}

fn default_overlay_mode() -> String {
    #[cfg(target_os = "macos")]
    {
        "fullscreen".to_string()
    }
    #[cfg(not(target_os = "macos"))]
    {
        "window".to_string()
    }
}

#[derive(Serialize, Deserialize, Type, Clone, Default)]
pub enum AIProviderType {
    #[default]
    #[serde(rename = "openai")]
    OpenAI,
    #[serde(rename = "openai-chatgpt")]
    OpenAIChatGPT,
    #[serde(rename = "native-ollama")]
    NativeOllama,
    #[serde(rename = "custom")]
    Custom,
    #[serde(rename = "screenpipe-cloud", alias = "claude-code")]
    ScreenpipeCloud,
    #[serde(rename = "pi", alias = "opencode")]
    Pi,
    #[serde(rename = "anthropic")]
    Anthropic,
}

#[derive(Serialize, Deserialize, Type, Clone)]
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
    #[serde(rename = "maxTokens", default = "default_max_tokens")]
    pub max_tokens: i32,
}

fn default_max_tokens() -> i32 {
    4096
}

impl Default for AIPreset {
    fn default() -> Self {
        Self {
            id: String::new(),
            prompt: String::new(),
            provider: AIProviderType::ScreenpipeCloud,
            url: "https://api.screenpi.pe/v1".to_string(),
            model: "qwen/qwen3.5-flash-02-23".to_string(),
            default_preset: false,
            api_key: None,
            max_context_chars: 512000,
            max_tokens: 4096,
        }
    }
}

#[derive(Serialize, Deserialize, Type, Clone)]
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

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AudioEngineFallbackReason {
    NotLoggedIn,
    NotSubscribed,
    MissingDeepgramKey,
}

impl AudioEngineFallbackReason {
    pub fn notification_title(&self) -> &'static str {
        match self {
            Self::NotLoggedIn | Self::NotSubscribed => "Screenpipe Cloud unavailable",
            Self::MissingDeepgramKey => "Deepgram unavailable",
        }
    }

    pub fn notification_body(&self) -> &'static str {
        match self {
            Self::NotLoggedIn => {
                "You are not logged in, so audio is being transcribed locally with Whisper Turbo (fast). Log in to use Screenpipe Cloud."
            }
            Self::NotSubscribed => {
                "Screenpipe Cloud requires an active subscription, so audio is being transcribed locally with Whisper Turbo (fast)."
            }
            Self::MissingDeepgramKey => {
                "Deepgram has no API key configured, so audio is being transcribed locally with Whisper Turbo (fast)."
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AudioEngineResolution {
    pub requested: String,
    pub active: String,
    pub fallback_reason: Option<AudioEngineFallbackReason>,
}

#[derive(Serialize, Deserialize, Type, Clone)]
#[serde(default)]
pub struct Credits {
    pub amount: i32,
}

impl Default for Credits {
    fn default() -> Self {
        Self { amount: 0 }
    }
}

#[derive(Serialize, Deserialize, Type, Clone)]
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
            "vault".to_string(),
            "OBS Studio".to_string(),
            "screenpipe".to_string(),
        ];

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
            "LockApp.exe".to_string(),
            "SearchHost.exe".to_string(),
            "ShellExperienceHost.exe".to_string(),
            "PickerHost.exe".to_string(),
            "Taskmgr.exe".to_string(),
            "SnippingTool.exe".to_string(),
        ]);

        #[cfg(target_os = "linux")]
        ignored_windows.extend([
            "Info center".to_string(),
            "Discover".to_string(),
            "Parted".to_string(),
        ]);

        // Default AI preset - works without login
        let default_free_preset = AIPreset {
            id: "screenpipe-cloud".to_string(),
            prompt: r#"IMPORTANT: At the start of every conversation, read the files in .pi/skills/ directory (e.g. .pi/skills/screenpipe-api/SKILL.md and .pi/skills/screenpipe-cli/SKILL.md) before responding.
Rules:
- Media: use standard markdown ![description](/path/to/file.mp4) for videos and ![description](/path/to/image.jpg) for images
- Always answer my question/intent, do not make up things
"#.to_string(),
            provider: AIProviderType::ScreenpipeCloud,
            url: "https://api.screenpi.pe/v1".to_string(),
            model: "auto".to_string(),
            default_preset: true,
            api_key: None,
            max_context_chars: 128000,
            max_tokens: 4096,
        };

        Self {
            // App-specific defaults override RecordingSettings::default() where needed
            recording: screenpipe_config::RecordingSettings {
                audio_transcription_engine: "whisper-large-v3-turbo-quantized".to_string(),
                monitor_ids: vec!["default".to_string()],
                audio_devices: vec!["default".to_string()],
                use_pii_removal: true,
                analytics_id: uuid::Uuid::new_v4().to_string(),
                ignored_windows,
                ..screenpipe_config::RecordingSettings::default()
            },
            ai_presets: vec![default_free_preset],
            is_loading: false,
            dev_mode: false,
            #[cfg(target_os = "macos")]
            ocr_engine: "apple-native".to_string(),
            #[cfg(target_os = "windows")]
            ocr_engine: "windows-native".to_string(),
            #[cfg(target_os = "linux")]
            ocr_engine: "tesseract".to_string(),
            data_dir: "default".to_string(),
            embedded_llm: EmbeddedLLM::default(),
            auto_start_enabled: true,
            platform: "unknown".to_string(),
            disabled_shortcuts: vec![],
            user: User::default(),
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
            #[cfg(target_os = "windows")]
            start_audio_shortcut: "Alt+Shift+A".to_string(),
            #[cfg(not(target_os = "windows"))]
            start_audio_shortcut: "Super+Ctrl+A".to_string(),
            #[cfg(target_os = "windows")]
            stop_audio_shortcut: "Alt+Shift+Z".to_string(),
            #[cfg(not(target_os = "windows"))]
            stop_audio_shortcut: "Super+Ctrl+Z".to_string(),
            #[cfg(target_os = "windows")]
            show_chat_shortcut: "Alt+L".to_string(),
            #[cfg(not(target_os = "windows"))]
            show_chat_shortcut: "Control+Super+L".to_string(),
            #[cfg(target_os = "windows")]
            search_shortcut: "Alt+K".to_string(),
            #[cfg(not(target_os = "windows"))]
            search_shortcut: "Control+Super+K".to_string(),
            #[cfg(target_os = "windows")]
            lock_vault_shortcut: "Ctrl+Shift+L".to_string(),
            #[cfg(not(target_os = "windows"))]
            lock_vault_shortcut: "Super+Shift+L".to_string(),
            disable_ocr: false,
            show_shortcut_overlay: true,
            shortcut_overlay_size: "small".to_string(),
            device_id: uuid::Uuid::new_v4().to_string(),
            auto_update: true,
            auto_update_pipes: true,
            enhanced_ai: false,
            #[cfg(target_os = "macos")]
            overlay_mode: "fullscreen".to_string(),
            #[cfg(not(target_os = "macos"))]
            overlay_mode: "window".to_string(),
            show_overlay_in_screen_recording: false,
            chat_always_on_top: true,
            show_restart_notifications: false,
            #[cfg(target_os = "macos")]
            translucent_sidebar: true,
            #[cfg(not(target_os = "macos"))]
            translucent_sidebar: false,
            hide_thinking_blocks: true,
            ui_theme: "system".to_string(),
            extra: std::collections::HashMap::new(),
        }
    }
}

impl SettingsStore {
    /// Remove legacy field aliases that conflict with their renamed counterparts.
    /// e.g. `enableUiEvents` was renamed to `enableAccessibility` — if both exist
    /// in the stored JSON, serde rejects it as a duplicate field.
    /// Also sanitize unknown AI provider types to prevent deserialization failures
    /// (e.g. synced settings from a newer version with a provider this version doesn't know).
    fn sanitize_legacy_fields(mut val: Value) -> Value {
        if let Some(obj) = val.as_object_mut() {
            if obj.contains_key("enableAccessibility") {
                obj.remove("enableUiEvents");
            } else if let Some(v) = obj.remove("enableUiEvents") {
                obj.insert("enableAccessibility".to_string(), v);
            }

            // Temporary one-time migration: disable restart notifications for all
            // existing users until the stall detector is more reliable. Users can
            // still opt back in manually from Settings; once they've seen this
            // version, we stop overriding their choice.
            if !obj.contains_key("restartNotificationsDefaultedOff") {
                obj.insert("showRestartNotifications".to_string(), Value::Bool(false));
                obj.insert(
                    "restartNotificationsDefaultedOff".to_string(),
                    Value::Bool(true),
                );
            }

            // Sanitize unknown provider types in aiPresets to prevent deserialization failures
            let known_providers = [
                "openai",
                "openai-chatgpt",
                "native-ollama",
                "custom",
                "screenpipe-cloud",
                "opencode",
                "pi",
                "anthropic",
            ];
            if let Some(presets) = obj.get_mut("aiPresets") {
                if let Some(arr) = presets.as_array_mut() {
                    for preset in arr.iter_mut() {
                        if let Some(provider) = preset.get("provider").and_then(|p| p.as_str()) {
                            if !known_providers.contains(&provider) {
                                tracing::warn!(
                                    "unknown AI provider '{}' in preset, falling back to 'custom'",
                                    provider
                                );
                                if let Some(obj) = preset.as_object_mut() {
                                    obj.insert(
                                        "provider".to_string(),
                                        Value::String("custom".to_string()),
                                    );
                                }
                            }
                        }
                    }
                }
            }
        }
        val
    }

    pub fn get(app: &AppHandle) -> Result<Option<Self>, String> {
        let store = get_store(app, None).map_err(|e| format!("Failed to get store: {}", e))?;

        match store.is_empty() {
            true => Ok(None),
            false => {
                let raw = store.get("settings").unwrap_or(Value::Null);
                let sanitized = Self::sanitize_legacy_fields(raw.clone());
                // Persist sanitized fields back to store so the migration only warns once
                if sanitized != raw {
                    store.set("settings", sanitized.clone());
                    let _ = store.save();
                    reencrypt_store_file(app);
                }
                let settings = serde_json::from_value(sanitized);
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

    /// Build a `RecordingSettings` from this settings store.
    ///
    /// Since RecordingSettings is now embedded via flatten, this is mostly a
    /// clone with overrides for fields that need special handling (e.g. user_id
    /// comes from the User auth object, user_name has a fallback chain).
    pub fn to_recording_settings(&self) -> screenpipe_config::RecordingSettings {
        let mut settings = self.recording.clone();
        // Override user_id with the Clerk JWT token from the auth user object.
        // This token is used as the Bearer credential for screenpipe cloud
        // (transcription proxy, Pi agent, etc.), not as a database ID.
        // Fallback to user.id if token is unavailable.
        settings.user_id = self
            .user
            .token
            .as_ref()
            .filter(|t| !t.is_empty())
            .or(self.user.id.as_ref().filter(|id| !id.is_empty()))
            .cloned()
            .unwrap_or_default();
        // Fallback chain: userName setting → cloud name → cloud email
        settings.user_name = settings
            .user_name
            .filter(|s| !s.trim().is_empty())
            .or_else(|| self.user.name.clone().filter(|s| !s.trim().is_empty()))
            .or_else(|| self.user.email.clone().filter(|s| !s.trim().is_empty()));
        settings
    }

    /// Build a unified `RecordingConfig` from this settings store.
    pub fn to_recording_config(
        &self,
        data_dir: std::path::PathBuf,
    ) -> screenpipe_engine::RecordingConfig {
        let resolved_engine = self.audio_engine_resolution().active;
        let settings = self.to_recording_settings();
        let mut config = screenpipe_engine::RecordingConfig::from_settings(
            &settings,
            data_dir,
            Some(&resolved_engine),
        );
        // Resolve the API auth key from the seeded cache. The cache is populated
        // asynchronously by `recording::spawn_screenpipe` via the shared helper
        // (`screenpipe_engine::auth_key::resolve_api_auth_key`) — which is the
        // single source of truth used by the CLI path, the auth CLI, and MCP.
        // If this function is called before the server has spawned (e.g. an
        // early frontend poll), fall back to the settings value if present;
        // otherwise leave `api_auth_key` as `None` so the caller knows the
        // key hasn't been resolved yet rather than receiving a fresh UUID
        // that would drift from every other reader.
        if config.api_auth {
            let settings_key = settings.api_key.as_str();
            config.api_auth_key = resolved_api_auth_key().or_else(|| {
                if settings_key.is_empty() {
                    None
                } else {
                    Some(settings_key.to_string())
                }
            });
        }
        config
    }

    pub fn audio_engine_resolution(&self) -> AudioEngineResolution {
        let engine = self.recording.audio_transcription_engine.clone();
        let has_cloud_auth = self
            .user
            .token
            .as_ref()
            .map_or(false, |token| !token.is_empty())
            || self.user.id.as_ref().map_or(false, |id| !id.is_empty());
        let is_subscribed = self.user.cloud_subscribed == Some(true);
        let has_deepgram_key = !self.recording.deepgram_api_key.is_empty()
            && self.recording.deepgram_api_key != "default";
        let fallback = "whisper-large-v3-turbo-quantized".to_string();
        let mut resolution = AudioEngineResolution {
            requested: engine.clone(),
            active: engine.clone(),
            fallback_reason: None,
        };

        match engine.as_str() {
            "screenpipe-cloud" if !has_cloud_auth => {
                tracing::warn!("screenpipe-cloud selected but user not logged in, falling back to whisper-large-v3-turbo-quantized");
                resolution.active = fallback;
                resolution.fallback_reason = Some(AudioEngineFallbackReason::NotLoggedIn);
            }
            "screenpipe-cloud" if !is_subscribed => {
                tracing::warn!("screenpipe-cloud selected but user is not a pro subscriber, falling back to whisper-large-v3-turbo-quantized");
                resolution.active = fallback;
                resolution.fallback_reason = Some(AudioEngineFallbackReason::NotSubscribed);
            }
            "deepgram" if !has_deepgram_key => {
                tracing::warn!("deepgram selected but no API key configured, falling back to whisper-large-v3-turbo-quantized");
                resolution.active = fallback;
                resolution.fallback_reason = Some(AudioEngineFallbackReason::MissingDeepgramKey);
            }
            _ => {}
        };

        resolution
    }

    pub fn save(&self, app: &AppHandle) -> Result<(), String> {
        let Ok(store) = get_store(app, None) else {
            return Err("Failed to get store".to_string());
        };

        store.set("settings", json!(self));
        store.save().map_err(|e| e.to_string())?;
        reencrypt_store_file(app);
        Ok(())
    }
}

pub fn init_store(app: &AppHandle) -> Result<SettingsStore, String> {
    println!("Initializing settings store");

    let raw_obj = get_store(app, None)
        .ok()
        .and_then(|store| store.get("settings"))
        .and_then(|raw| raw.as_object().cloned());

    let should_persist_restart_notification_migration = raw_obj
        .as_ref()
        .map(|obj| !obj.contains_key("restartNotificationsDefaultedOff"))
        .unwrap_or(false);

    let is_new_store;
    let (mut store, mut should_save) = match SettingsStore::get(app) {
        Ok(Some(store)) => {
            is_new_store = false;
            (store, should_persist_restart_notification_migration)
        }
        Ok(None) => {
            is_new_store = true;
            (SettingsStore::default(), true) // New store, save defaults
        }
        Err(e) => {
            is_new_store = false;
            // Fallback to defaults when deserialization fails (e.g., corrupted store)
            // DON'T save - preserve original store in case it can be manually recovered
            // This prevents crashes from invalid values like negative integers in u32 fields
            // Non-fatal — logged as warn (not error) so Sentry doesn't pick it up.
            warn!(
                "Failed to deserialize settings, using defaults (store not overwritten): {}",
                e
            );
            (SettingsStore::default(), false)
        }
    };

    // Tier detection. Two cases:
    // - New install: detect tier AND apply tier defaults (video_quality, power_mode, etc.)
    // - Existing user upgrading: detect tier for DB/channel config but do NOT override
    //   their existing capture settings (they may have customized video_quality etc.)
    // Also re-detect if the stored tier doesn't match current hardware classification
    // (e.g. tier boundaries changed in an update).
    {
        let detected = screenpipe_config::detect_tier();
        let stored_tier = store
            .recording
            .device_tier
            .as_deref()
            .and_then(screenpipe_config::DeviceTier::from_str_loose);
        if stored_tier != Some(detected) {
            tracing::info!("hardware tier changed: {:?} -> {:?}", stored_tier, detected);
            if is_new_store || store.recording.device_tier.is_none() {
                screenpipe_config::apply_tier_defaults(&mut store.recording, detected);
            }
            store.recording.device_tier = Some(detected.as_str().to_string());
            should_save = true;
        }

        // Unconditional safety guard: prevent parakeet/parakeet-mlx on platforms
        // where it will crash (Low tier = OOM, macOS < 26 = MLX segfault).
        if screenpipe_config::is_engine_unsafe(
            &store.recording.audio_transcription_engine,
            detected,
        ) {
            let safe = screenpipe_config::best_engine_for_platform(detected);
            tracing::warn!(
                "engine {} is unsafe on this platform (tier={:?}, macOS={:?}) — switching to {}",
                store.recording.audio_transcription_engine,
                detected,
                screenpipe_config::macos_major_version(),
                safe,
            );
            store.recording.audio_transcription_engine = safe.to_string();
            should_save = true;
        }
    }

    if should_save {
        if let Err(e) = store.save(app) {
            // Non-fatal — logged as warn (not error) so Sentry doesn't pick it up.
            // Common cause on Windows: antivirus / Controlled Folder Access / OneDrive
            // blocks the first write; we retry on subsequent saves so the user isn't
            // actually stuck. Not worth paging Louis about.
            warn!("Failed to save initial settings store (non-fatal): {}", e);
        }
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
            // Non-fatal — logged as warn (not error) so Sentry doesn't pick it up.
            warn!(
                "Failed to deserialize onboarding, using defaults (store not overwritten): {}",
                e
            );
            (OnboardingStore::default(), false)
        }
    };

    if should_save {
        if let Err(e) = onboarding.save(app) {
            // Non-fatal — logged as warn (not error) so Sentry doesn't pick it up.
            // See matching comment in init_settings_store.
            warn!("Failed to save initial onboarding store (non-fatal): {}", e);
        }
    }
    Ok(onboarding)
}

// ─── Cloud Sync Settings ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudSyncSettingsStore {
    pub enabled: bool,
    /// Base64-encoded encryption password for auto-init on startup
    #[serde(default)]
    pub encrypted_password: String,
}

impl CloudSyncSettingsStore {
    #[allow(dead_code)]
    pub fn get(app: &AppHandle) -> Result<Option<Self>, String> {
        let store = get_store(app, None).map_err(|e| e.to_string())?;
        if store.is_empty() {
            return Ok(None);
        }
        let settings = serde_json::from_value(store.get("cloud_sync").unwrap_or(Value::Null));
        match settings {
            Ok(settings) => Ok(settings),
            Err(_) => Ok(None),
        }
    }

    pub fn save(&self, app: &AppHandle) -> Result<(), String> {
        let store = get_store(app, None).map_err(|e| e.to_string())?;
        store.set("cloud_sync", json!(self));
        store.save().map_err(|e| e.to_string())?;
        reencrypt_store_file(app);
        Ok(())
    }
}

// ─── Cloud Archive Settings ──────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudArchiveSettingsStore {
    pub enabled: bool,
    #[serde(default = "default_archive_retention")]
    pub retention_days: u32,
}

fn default_archive_retention() -> u32 {
    7
}

impl CloudArchiveSettingsStore {
    pub fn get(app: &AppHandle) -> Result<Option<Self>, String> {
        let store = get_store(app, None).map_err(|e| e.to_string())?;
        if store.is_empty() {
            return Ok(None);
        }
        let settings = serde_json::from_value(store.get("cloud_archive").unwrap_or(Value::Null));
        match settings {
            Ok(settings) => Ok(settings),
            Err(_) => Ok(None),
        }
    }

    pub fn save(&self, app: &AppHandle) -> Result<(), String> {
        let store = get_store(app, None).map_err(|e| e.to_string())?;
        store.set("cloud_archive", json!(self));
        store.save().map_err(|e| e.to_string())?;
        reencrypt_store_file(app);
        Ok(())
    }
}

// ─── ICS Calendar Settings ───────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct IcsCalendarEntry {
    pub name: String,
    pub url: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IcsCalendarSettingsStore {
    pub entries: Vec<IcsCalendarEntry>,
}

impl IcsCalendarSettingsStore {
    pub fn get(app: &AppHandle) -> Result<Option<Self>, String> {
        let store = get_store(app, None).map_err(|e| e.to_string())?;
        if store.is_empty() {
            return Ok(None);
        }
        let settings = serde_json::from_value(store.get("ics_calendars").unwrap_or(Value::Null));
        match settings {
            Ok(settings) => Ok(settings),
            Err(_) => Ok(None),
        }
    }

    pub fn save(&self, app: &AppHandle) -> Result<(), String> {
        let store = get_store(app, None).map_err(|e| e.to_string())?;
        store.set("ics_calendars", json!(self));
        store.save().map_err(|e| e.to_string())?;
        reencrypt_store_file(app);
        Ok(())
    }
}

// ─── Pipe Suggestions Settings ───────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PipeSuggestionsSettingsStore {
    pub enabled: bool,
    #[serde(default = "default_pipe_suggestion_frequency")]
    pub frequency_hours: u32,
    #[serde(default)]
    pub last_shown_at: Option<String>,
}

fn default_pipe_suggestion_frequency() -> u32 {
    24
}

impl Default for PipeSuggestionsSettingsStore {
    fn default() -> Self {
        Self {
            enabled: true,
            frequency_hours: 24,
            last_shown_at: None,
        }
    }
}

impl PipeSuggestionsSettingsStore {
    pub fn get(app: &AppHandle) -> Result<Option<Self>, String> {
        let store = get_store(app, None).map_err(|e| e.to_string())?;
        if store.is_empty() {
            return Ok(None);
        }
        let settings = serde_json::from_value(store.get("pipe_suggestions").unwrap_or(Value::Null));
        match settings {
            Ok(settings) => Ok(settings),
            Err(_) => Ok(None),
        }
    }

    pub fn save(&self, app: &AppHandle) -> Result<(), String> {
        let store = get_store(app, None).map_err(|e| e.to_string())?;
        store.set("pipe_suggestions", json!(self));
        store.save().map_err(|e| e.to_string())?;
        reencrypt_store_file(app);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const FALLBACK_ENGINE: &str = "whisper-large-v3-turbo-quantized";

    #[test]
    fn screenpipe_cloud_falls_back_when_not_logged_in() {
        let mut store = SettingsStore::default();
        store.recording.audio_transcription_engine = "screenpipe-cloud".to_string();
        store.user.id = None;
        store.user.token = None;
        store.user.cloud_subscribed = Some(true);

        let resolution = store.audio_engine_resolution();

        assert_eq!(resolution.requested, "screenpipe-cloud");
        assert_eq!(resolution.active, FALLBACK_ENGINE);
        assert_eq!(
            resolution.fallback_reason,
            Some(AudioEngineFallbackReason::NotLoggedIn)
        );
    }

    #[test]
    fn screenpipe_cloud_falls_back_when_not_subscribed() {
        let mut store = SettingsStore::default();
        store.recording.audio_transcription_engine = "screenpipe-cloud".to_string();
        store.user.token = Some("token".to_string());
        store.user.cloud_subscribed = Some(false);

        let resolution = store.audio_engine_resolution();

        assert_eq!(resolution.active, FALLBACK_ENGINE);
        assert_eq!(
            resolution.fallback_reason,
            Some(AudioEngineFallbackReason::NotSubscribed)
        );
    }

    #[test]
    fn screenpipe_cloud_stays_active_for_subscribed_users() {
        let mut store = SettingsStore::default();
        store.recording.audio_transcription_engine = "screenpipe-cloud".to_string();
        store.user.token = Some("token".to_string());
        store.user.cloud_subscribed = Some(true);

        let resolution = store.audio_engine_resolution();

        assert_eq!(resolution.active, "screenpipe-cloud");
        assert_eq!(resolution.fallback_reason, None);
    }

    #[test]
    fn deepgram_falls_back_without_api_key() {
        let mut store = SettingsStore::default();
        store.recording.audio_transcription_engine = "deepgram".to_string();
        store.recording.deepgram_api_key = String::new();

        let resolution = store.audio_engine_resolution();

        assert_eq!(resolution.active, FALLBACK_ENGINE);
        assert_eq!(
            resolution.fallback_reason,
            Some(AudioEngineFallbackReason::MissingDeepgramKey)
        );
    }

    // ---- Settings-loss recovery ----

    fn write_store(dir: &Path, contents: &Value) -> std::path::PathBuf {
        let p = dir.join("store.bin");
        std::fs::write(&p, serde_json::to_vec_pretty(contents).unwrap()).unwrap();
        p
    }

    fn write_last_good(dir: &Path, contents: &Value) -> std::path::PathBuf {
        let p = dir.join("store.bin.last-good");
        std::fs::write(&p, serde_json::to_vec_pretty(contents).unwrap()).unwrap();
        p
    }

    fn presets_n(n: usize) -> Vec<Value> {
        (0..n)
            .map(|i| json!({"id": format!("p{}", i), "model": "x", "provider": "screenpipe-cloud"}))
            .collect()
    }

    #[test]
    fn store_json_has_presets_recognises_healthy() {
        let healthy = serde_json::to_vec(&json!({"settings": {"aiPresets": presets_n(3)}})).unwrap();
        assert!(store_json_has_presets(&healthy));
    }

    #[test]
    fn store_json_has_presets_rejects_empty_or_missing() {
        let empty_arr = serde_json::to_vec(&json!({"settings": {"aiPresets": []}})).unwrap();
        let missing = serde_json::to_vec(&json!({"settings": {}})).unwrap();
        let no_settings = serde_json::to_vec(&json!({})).unwrap();
        let invalid_json = b"{not json".to_vec();
        assert!(!store_json_has_presets(&empty_arr));
        assert!(!store_json_has_presets(&missing));
        assert!(!store_json_has_presets(&no_settings));
        assert!(!store_json_has_presets(&invalid_json));
    }

    #[test]
    fn snapshot_last_good_writes_when_healthy() {
        let tmp = tempfile::tempdir().unwrap();
        let store_path = write_store(
            tmp.path(),
            &json!({"settings": {"aiPresets": presets_n(2)}}),
        );
        snapshot_last_good(&store_path);
        let lg = store_path.with_extension(LAST_GOOD_SUFFIX);
        assert!(lg.exists(), "should have written .last-good");
        let lg_data = std::fs::read(&lg).unwrap();
        assert!(store_json_has_presets(&lg_data));
    }

    #[test]
    fn snapshot_last_good_skips_degraded() {
        // L1's contract: never freeze a wiped state as the recovery source.
        let tmp = tempfile::tempdir().unwrap();
        let store_path = write_store(tmp.path(), &json!({"settings": {"aiPresets": []}}));
        snapshot_last_good(&store_path);
        let lg = store_path.with_extension(LAST_GOOD_SUFFIX);
        assert!(!lg.exists(), "must not snapshot a degraded store");
    }

    #[test]
    fn auto_restore_recovers_wiped_store_from_last_good() {
        let tmp = tempfile::tempdir().unwrap();
        // Simulate the wipe — current file has no presets, last-good has them
        let store_path = write_store(tmp.path(), &json!({"settings": {"aiPresets": []}}));
        write_last_good(
            tmp.path(),
            &json!({"settings": {"aiPresets": presets_n(5)}}),
        );

        let restored = auto_restore_if_wiped(&store_path);
        assert!(restored, "should report a restore happened");

        let now = std::fs::read(&store_path).unwrap();
        assert!(store_json_has_presets(&now), "store must be healthy after restore");

        // Forensic copy of the wiped file must exist
        let entries: Vec<_> = std::fs::read_dir(tmp.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().into_string().unwrap_or_default())
            .filter(|n| n.contains("pre-restore-"))
            .collect();
        assert_eq!(entries.len(), 1, "expected 1 pre-restore backup, got {entries:?}");
    }

    #[test]
    fn auto_restore_noop_when_current_is_healthy() {
        let tmp = tempfile::tempdir().unwrap();
        let store_path = write_store(
            tmp.path(),
            &json!({"settings": {"aiPresets": presets_n(3)}}),
        );
        // Even if last-good exists, current is fine — don't touch.
        write_last_good(
            tmp.path(),
            &json!({"settings": {"aiPresets": presets_n(99)}}),
        );

        let restored = auto_restore_if_wiped(&store_path);
        assert!(!restored);

        // Confirm the current file wasn't replaced by .last-good's 99 presets
        let now: Value = serde_json::from_slice(&std::fs::read(&store_path).unwrap()).unwrap();
        let n = now.pointer("/settings/aiPresets").unwrap().as_array().unwrap().len();
        assert_eq!(n, 3);
    }

    #[test]
    fn auto_restore_noop_when_last_good_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let store_path = write_store(tmp.path(), &json!({"settings": {"aiPresets": []}}));
        let restored = auto_restore_if_wiped(&store_path);
        assert!(!restored, "no last-good means no restore");
    }

    #[test]
    fn auto_restore_noop_when_last_good_is_also_degraded() {
        // Defense: even if .last-good somehow got written wiped (shouldn't
        // happen due to L1's guard, but belt + suspenders), don't restore
        // garbage over garbage.
        let tmp = tempfile::tempdir().unwrap();
        let store_path = write_store(tmp.path(), &json!({"settings": {"aiPresets": []}}));
        write_last_good(tmp.path(), &json!({"settings": {"aiPresets": []}}));
        let restored = auto_restore_if_wiped(&store_path);
        assert!(!restored);
    }

    #[test]
    fn auto_restore_skips_encrypted_files() {
        // L2 must not try to "restore" over a still-encrypted blob — the
        // decrypt path owns that case.
        let tmp = tempfile::tempdir().unwrap();
        let store_path = tmp.path().join("store.bin");
        let mut blob = STORE_MAGIC.to_vec();
        blob.extend_from_slice(b"<<encrypted ciphertext>>");
        std::fs::write(&store_path, &blob).unwrap();
        write_last_good(
            tmp.path(),
            &json!({"settings": {"aiPresets": presets_n(3)}}),
        );

        let restored = auto_restore_if_wiped(&store_path);
        assert!(!restored, "encrypted file must be left for the decrypt path");
        // And the file must be unchanged
        assert_eq!(std::fs::read(&store_path).unwrap(), blob);
    }

    // ---- Existing tests ----

    #[test]
    fn test_sanitize_legacy_fields_does_not_panic() {
        let corrupted = json!({
            "aiPresets": ["corrupted_string_not_an_object"]
        });

        let _sanitized = SettingsStore::sanitize_legacy_fields(corrupted);

        // And let's test a valid object with missing/unknown provider to prove it works
        let valid = json!({
            "aiPresets": [{"provider": "unknown_provider"}]
        });
        let sanitized2 = SettingsStore::sanitize_legacy_fields(valid);

        let presets = sanitized2.get("aiPresets").unwrap().as_array().unwrap();
        assert_eq!(
            presets[0].get("provider").unwrap().as_str().unwrap(),
            "custom"
        );
    }

    #[test]
    fn test_deserialize_settings_with_null_fields() {
        let json_data = json!({
            "recording": {
                "audio": true,
                "video": true
            },
            "user": null,
            "embeddedLLM": null,
            "aiPresets": null
        });

        let settings: Result<SettingsStore, _> = serde_json::from_value(json_data);
        if let Err(e) = &settings {
            println!("Deser error: {:?}", e);
        }
        assert!(
            settings.is_ok(),
            "Failed to deserialize settings with null fields"
        );
        let settings = settings.unwrap();

        assert_eq!(settings.user.token, None);
        assert_eq!(settings.embedded_llm.enabled, false);
        assert_eq!(settings.ai_presets.len(), 0);
    }
}
