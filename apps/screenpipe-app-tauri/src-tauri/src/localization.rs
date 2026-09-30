// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Offline interface text. Source messages stay in English at call sites.
//! This module never handles captured content, prompts, or interpolation values.

use once_cell::sync::Lazy;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::sync::{Mutex, RwLock};
use tauri::{AppHandle, Listener};
use tauri::menu::{Menu, MenuItem, MenuItemKind};

type MenuLabel = (MenuItemKind<tauri::Wry>, String, Vec<(String, String)>);
static APP_MENU: Lazy<Mutex<Vec<MenuLabel>>> = Lazy::new(|| Mutex::new(Vec::new()));

/// Capture source labels once, before the persisted locale is applied. Retain
/// menu handles so a language switch changes text without replacing menus.
pub fn register_app_menu(menu: &Menu<tauri::Wry>) -> tauri::Result<()> {
    fn collect(items: Vec<MenuItemKind<tauri::Wry>>, output: &mut Vec<MenuLabel>) -> tauri::Result<()> {
        for item in items {
            let text = match &item {
                MenuItemKind::MenuItem(item) => item.text()?,
                MenuItemKind::Predefined(item) => item.text()?,
                MenuItemKind::Submenu(item) => { collect(item.items()?, output)?; item.text()? },
                _ => continue,
            };
            if !text.is_empty() && text != "screenpipe" { output.push((item, text, Vec::new())); }
        }
        Ok(())
    }
    collect(menu.items()?, &mut APP_MENU.lock().unwrap_or_else(|e| e.into_inner()))
}

/// Dynamic native labels retain their source so switching locale also updates
/// a download in progress. Values remain in memory, never in diagnostics.
pub fn ui_menu(english: &str, values: &[(&str, String)], item: &MenuItem<tauri::Wry>) -> tauri::Result<()> {
    let mut labels = APP_MENU.lock().unwrap_or_else(|e| e.into_inner());
    labels.retain(|(existing, _, _)| existing.id() != item.id());
    labels.push((MenuItemKind::MenuItem(item.clone()), english.to_owned(), values.iter().map(|(key, value)| ((*key).to_owned(), value.clone())).collect()));
    item.set_text(ui_format(english, values))
}

static SNAPSHOT: Lazy<Value> = Lazy::new(|| {
    serde_json::from_str(include_str!(concat!(env!("OUT_DIR"), "/localization.json")))
        .expect("build-validated localization snapshot")
});

#[derive(Default)]
struct LocaleState {
    configured: String,
    resolved: String,
    rollout_enabled: bool,
    fallbacks: BTreeMap<String, &'static str>,
}
static STATE: Lazy<RwLock<LocaleState>> = Lazy::new(|| RwLock::new(LocaleState::default()));

pub fn resolve_locale(configured: &str, system: &[String], available: &[String], default: &str) -> String {
    let explicit = [configured.to_string()];
    let candidates = if configured == "system" { system } else { &explicit };
    for candidate in candidates {
        let candidate = candidate.replace('_', "-");
        for value in [candidate.as_str(), candidate.split('-').next().unwrap_or_default()] {
            if let Some(found) = available.iter().find(|locale| locale.eq_ignore_ascii_case(value)) {
                return found.clone();
            }
        }
    }
    default.to_string()
}

impl LocaleState {
    fn update(&mut self, configured: &str, rollout_enabled: bool, system: &[String], available: &[String], default: &str) -> bool {
        let resolved = if rollout_enabled { resolve_locale(configured, system, available, default) } else { default.to_string() };
        let changed = self.resolved != resolved;
        self.configured = configured.to_string();
        self.resolved = resolved;
        self.rollout_enabled = rollout_enabled;
        changed
    }
}

fn refresh(configured: &str, rollout_enabled: bool) -> bool {
    let default = SNAPSHOT["defaultLocale"].as_str().unwrap_or("en");
    let mut available = vec![default.to_string()];
    if let Some(locales) = SNAPSHOT["locales"].as_array() {
        available.extend(locales.iter().filter_map(Value::as_str).map(String::from));
    }
    let system: Vec<String> = sys_locale::get_locales().collect();
    let mut state = STATE.write().unwrap_or_else(|e| e.into_inner());
    state.update(configured, rollout_enabled, &system, &available, default)
}

fn refresh_surfaces(app: &AppHandle) {
    crate::tray::request_menu_refresh();
    let locale = resolved_locale();
    let payload = json!({"locale": locale, "messages": SNAPSHOT["native"][&locale].as_object().cloned().unwrap_or_default()}).to_string();
    if let Err(error) = app.run_on_main_thread(move || {
        for (item, english, values) in APP_MENU.lock().unwrap_or_else(|e| e.into_inner()).iter() {
            let values: Vec<_> = values.iter().map(|(key, value)| (key.as_str(), value.clone())).collect();
            let text = ui_format(english, &values);
            let result = match item {
                MenuItemKind::MenuItem(item) => item.set_text(&text),
                MenuItemKind::Predefined(item) => item.set_text(&text),
                MenuItemKind::Submenu(item) => item.set_text(&text),
                _ => Ok(()),
            };
            if let Err(error) = result { tracing::warn!("localization: app menu update failed: {error}"); }
        }
        crate::native_timeline::set_ui_locale(&payload);
        crate::native_notification::set_ui_locale(&payload);
        crate::native_shortcut_reminder::set_ui_locale(&payload);
    }) { tracing::warn!("localization: native locale dispatch failed: {error}"); }
}

pub fn initialize(app: &AppHandle, configured: &str, rollout_enabled: bool) {
    refresh(configured, rollout_enabled);
    refresh_surfaces(app);
    let app = app.clone();
    let handle = app.clone();
    app.listen("store://change", move |event| {
        let Ok(payload) = serde_json::from_str::<Value>(event.payload()) else { return; };
        if payload["key"] != "settings" { return; }
        // Follow the authoritative store rather than accepting another window's
        // claimed locale. Disk reads stay away from the native menu/main thread.
        let app = handle.clone();
        tauri::async_runtime::spawn_blocking(move || {
            if let Ok(Some(settings)) = crate::store::SettingsStore::get(&app) {
                if refresh(&settings.ui_locale, settings.ui_localization_enabled) { refresh_surfaces(&app); }
            }
        });
    });
}

pub fn resolved_locale() -> String {
    STATE.read().unwrap_or_else(|e| e.into_inner()).resolved.clone()
}

/// Mark a deferred native label for extraction, retaining its English source.
pub fn source_text(english: &str) -> &str { english }

pub fn ui_text(english: &str) -> String {
    let id = format!("{:x}", Sha256::digest(english.as_bytes()))[..16].to_string();
    let mut state = STATE.write().unwrap_or_else(|e| e.into_inner());
    if state.resolved == SNAPSHOT["defaultLocale"].as_str().unwrap_or("en") || state.resolved.is_empty() {
        return english.to_string();
    }
    if let Some(translated) = SNAPSHOT["native"][&state.resolved][&id].as_str() {
        return translated.to_string();
    }
    state.fallbacks.insert(id, "missing_native_translation");
    english.to_string()
}

pub fn ui_format(english: &str, values: &[(&str, String)]) -> String {
    interpolate(&ui_text(english), values)
}

fn interpolate(message: &str, values: &[(&str, String)]) -> String {
    let mut result = String::with_capacity(message.len());
    let mut rest = message;
    while let Some(start) = rest.find('{') {
        result.push_str(&rest[..start]);
        let Some(end) = rest[start..].find('}').map(|end| start + end) else {
            result.push_str(&rest[start..]);
            return result;
        };
        let key = &rest[start + 1..end];
        if let Some((_, value)) = values.iter().find(|(name, _)| *name == key) { result.push_str(value); }
        else { result.push_str(&rest[start..=end]); }
        rest = &rest[end + 1..];
    }
    result.push_str(rest);
    result
}

/// Called when collecting feedback, so missing entries remain diagnosable after
/// log rotation/restart even if no affected menu has been opened in this session.
pub fn diagnostics() -> String {
    let state = STATE.read().unwrap_or_else(|e| e.into_inner());
    diagnostics_for(&SNAPSHOT, &state)
}

fn diagnostics_for(snapshot: &Value, state: &LocaleState) -> String {
    json!({
        "configured": state.configured,
        "resolved": state.resolved,
        "rolloutEnabled": state.rollout_enabled,
        "revision": snapshot["revision"],
        "mode": snapshot["mode"],
        "coverage": snapshot["coverage"],
        "causes": snapshot["causes"],
        "fallbacks": snapshot["fallbacks"],
        "nativeFallbacks": state.fallbacks,
    }).to_string()
}

#[cfg(test)]
mod tests {
    use super::{resolve_locale, diagnostics_for, LocaleState};
    use serde_json::json;

    #[test]
    fn interpolation_never_reinterprets_private_values() {
        let values = [("name", "{error}".to_string()), ("error", "private diagnostic".to_string())];
        assert_eq!(super::interpolate("Hello {name}; {missing}", &values), "Hello {error}; {missing}");
    }

    #[test]
    fn locale_resolution_matches_bundled_exact_then_base_then_english() {
        let available = vec!["en".into(), "fr".into(), "fr-CA".into()];
        assert_eq!(resolve_locale("system", &["fr-CA".into()], &available, "en"), "fr-CA");
        assert_eq!(resolve_locale("system", &["fr_BE".into()], &available, "en"), "fr");
        assert_eq!(resolve_locale("en", &["fr".into()], &available, "en"), "en");
        assert_eq!(resolve_locale("de", &["fr".into()], &available, "en"), "en");
    }

    #[test]
    fn language_round_trips_in_settings_without_changing_recording_preferences() {
        let mut settings = crate::store::SettingsStore::default();
        let before = serde_json::to_value(&settings).unwrap();
        assert_eq!(settings.ui_locale, "system");
        assert!(!settings.ui_localization_enabled);
        settings.ui_locale = "fr".into();
        settings.ui_localization_enabled = true;
        let saved = serde_json::to_vec(&settings).unwrap();
        let restored: crate::store::SettingsStore = serde_json::from_slice(&saved).unwrap();
        assert_eq!(restored.ui_locale, "fr");
        assert!(restored.ui_localization_enabled);
        let mut after = serde_json::to_value(&restored).unwrap();
        after["uiLocale"] = json!("system");
        after["uiLocalizationEnabled"] = json!(false);
        assert_eq!(before, after);
    }

    #[test]
    fn localization_rollout_controls_native_locale_without_erasing_preference() {
        let available = vec!["en".into(), "ja".into()];
        let system = vec!["ja-JP".into()];
        for configured in ["system", "ja"] {
            let mut state = LocaleState::default();
            assert!(state.update(configured, false, &system, &available, "en"));
            assert_eq!(state.resolved, "en");
            assert!(state.update(configured, true, &system, &available, "en"));
            assert_eq!(state.resolved, "ja");
            assert!(state.update(configured, false, &system, &available, "en"));
            assert_eq!(state.resolved, "en");
            assert_eq!(state.configured, configured);
        }
        let mut legacy = serde_json::to_value(crate::store::SettingsStore::default()).unwrap();
        legacy["uiLocale"] = json!("ja");
        legacy.as_object_mut().unwrap().remove("uiLocalizationEnabled");
        let settings: crate::store::SettingsStore = serde_json::from_value(legacy).unwrap();
        assert!(!settings.ui_localization_enabled);
        assert_eq!(settings.ui_locale, "ja");
    }

    #[tokio::test]
    async fn localization_rollout_decision_reaches_redacted_support_after_restart() {
        let mut settings = crate::store::SettingsStore::default();
        settings.ui_locale = "ja".into();
        for enabled in [false, true, false] {
            settings.ui_localization_enabled = enabled;
            let saved = serde_json::to_vec(&settings).unwrap();
            let restarted: crate::store::SettingsStore = serde_json::from_slice(&saved).unwrap();
            let mut state = LocaleState::default();
            state.update(&restarted.ui_locale, restarted.ui_localization_enabled, &[], &["en".into(), "ja".into()], "en");
            let collected = crate::feedback_upload::append_localization_diagnostics(
                "[no log files found]".into(), &diagnostics_for(&json!({"revision": "rollout-test"}), &state),
            );
            let report = crate::feedback_redact::redact_diagnostics_locally(collected).await.unwrap();
            assert!(report.contains(&format!("\"rolloutEnabled\":{enabled}")));
            assert!(report.contains("\"configured\":\"ja\""));
            assert!(report.contains(if enabled { "\"resolved\":\"ja\"" } else { "\"resolved\":\"en\"" }));
        }
    }

    #[tokio::test]
    async fn localization_fallback_survives_support_collection_redaction_and_restart() {
        let snapshot = json!({
            "revision": "test-translation-revision", "mode": "cached",
            "coverage": {"fr": {"frontend": {"total": 2, "translated": 0, "fallback": 2}}},
            "causes": ["service_timeout"],
            "fallbacks": {"fr": {"88f019c0a50e17bd": "missing_translation", "bb391903b8950ffa": "invalid_placeholders"}}
        });
        // A fresh process has no in-memory fallback history and no old log file.
        for _restart in 0..2 {
            let state = LocaleState { configured: "system".into(), resolved: "fr".into(), rollout_enabled: true, ..Default::default() };
            let collected = crate::feedback_upload::append_localization_diagnostics(
                "[no log files found]".into(), &diagnostics_for(&snapshot, &state),
            );
            let report = crate::feedback_redact::redact_diagnostics_locally(collected).await.unwrap();
            for evidence in ["Localization Diagnostics", "test-translation-revision", "service_timeout", "88f019c0a50e17bd", "missing_translation", "invalid_placeholders"] {
                assert!(report.contains(evidence), "missing support evidence: {evidence}");
            }
        }
    }
}
