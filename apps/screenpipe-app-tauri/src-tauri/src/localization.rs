// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Offline interface text. Source messages stay in English at call sites.
//! This module never handles captured content, prompts, or interpolation values.

use once_cell::sync::Lazy;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::sync::RwLock;
use tauri::{AppHandle, Listener};

static SNAPSHOT: Lazy<Value> = Lazy::new(|| {
    serde_json::from_str(include_str!(concat!(env!("OUT_DIR"), "/localization.json")))
        .expect("build-validated localization snapshot")
});

#[derive(Default)]
struct LocaleState {
    configured: String,
    resolved: String,
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

fn refresh(configured: &str) {
    let default = SNAPSHOT["defaultLocale"].as_str().unwrap_or("en");
    let mut available = vec![default.to_string()];
    if let Some(locales) = SNAPSHOT["locales"].as_array() {
        available.extend(locales.iter().filter_map(Value::as_str).map(String::from));
    }
    let system: Vec<String> = sys_locale::get_locales().collect();
    let resolved = resolve_locale(configured, &system, &available, default);
    let mut state = STATE.write().unwrap_or_else(|e| e.into_inner());
    state.configured = configured.to_string();
    state.resolved = resolved;
}

pub fn initialize(app: &AppHandle, configured: &str) {
    refresh(configured);
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
                refresh(&settings.ui_locale);
            }
        });
    });
}

pub fn resolved_locale() -> String {
    STATE.read().unwrap_or_else(|e| e.into_inner()).resolved.clone()
}

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
        settings.ui_locale = "fr".into();
        let saved = serde_json::to_vec(&settings).unwrap();
        let restored: crate::store::SettingsStore = serde_json::from_slice(&saved).unwrap();
        assert_eq!(restored.ui_locale, "fr");
        let mut after = serde_json::to_value(&restored).unwrap();
        after["uiLocale"] = json!("system");
        assert_eq!(before, after);
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
            let state = LocaleState { configured: "system".into(), resolved: "fr".into(), ..Default::default() };
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
