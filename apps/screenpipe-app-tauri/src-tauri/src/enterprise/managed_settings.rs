// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Fleet recording policy belongs to the native process, not a webview.

use once_cell::sync::Lazy;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use tauri::Manager;

const PENDING_RESTART: &str = "enterpriseManagedSettingsPendingRestart";
static APPLY_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static DEFINITIONS: Lazy<Vec<Definition>> = Lazy::new(|| {
    serde_json::from_str(include_str!("managed-settings.json"))
        .expect("managed settings catalog must be valid")
});

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Definition {
    policy_key: String,
    device_key: String,
    apply: String,
    kind: String,
    default_value: Option<Value>,
    #[serde(default)]
    true_only: bool,
    #[serde(default)]
    values: Vec<String>,
    min: Option<f64>,
    max: Option<f64>,
    #[serde(default)]
    integer: bool,
    #[serde(default)]
    required_values: Vec<String>,
}

fn hostname(raw: &Value) -> Option<String> {
    let input = raw.as_str()?.trim();
    let url = reqwest::Url::parse(&if input.contains("://") {
        input.to_string()
    } else {
        format!("https://{input}")
    })
    .ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let host = url
        .host_str()?
        .to_lowercase()
        .trim_end_matches('.')
        .to_string();
    host.contains('.').then_some(host)
}

fn domain_rule(raw: &Value) -> Option<Value> {
    let object = raw.as_object()?;
    if object.keys().any(|key| {
        !matches!(
            key.as_str(),
            "domain" | "includeSubdomains" | "excludedSubdomains"
        )
    }) {
        return None;
    }
    let domain = hostname(object.get("domain")?)?;
    let include = object.get("includeSubdomains")?.as_bool()?;
    let empty = json!([]);
    let exceptions = object
        .get("excludedSubdomains")
        .filter(|value| !value.is_null())
        .unwrap_or(&empty)
        .as_array()?;
    if !include && !exceptions.is_empty() {
        return None;
    }
    let mut excluded = Vec::new();
    for exception in exceptions {
        let exception = hostname(exception)?;
        if !exception.ends_with(&format!(".{domain}")) {
            return None;
        }
        if !excluded.contains(&exception) {
            excluded.push(exception);
        }
    }
    Some(json!({"domain": domain, "includeSubdomains": include, "excludedSubdomains": excluded}))
}

fn parse(def: &Definition, raw: &Value) -> Option<Value> {
    match def.kind.as_str() {
        "boolean" if def.true_only => (raw.as_str() == Some("true")).then_some(json!(true)),
        "boolean" => match raw {
            Value::Bool(_) => Some(raw.clone()),
            Value::String(value) if value == "true" => Some(json!(true)),
            Value::String(value) if value == "false" => Some(json!(false)),
            _ => None,
        },
        "enum" => def
            .values
            .iter()
            .any(|value| Some(value.as_str()) == raw.as_str())
            .then(|| raw.clone()),
        "number" => {
            let value = raw.as_f64()?;
            if value < def.min? || value > def.max? || (def.integer && value.fract() != 0.0) {
                return None;
            }
            Some(if def.integer {
                json!(value as u64)
            } else {
                raw.clone()
            })
        }
        "string-array" => {
            let mut values = Vec::new();
            for value in raw
                .as_array()?
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty() && value.encode_utf16().count() <= 200)
                .take(100)
            {
                if !values.iter().any(|existing| existing == value) {
                    values.push(value.to_string());
                }
            }
            for required in &def.required_values {
                if !values.contains(required) {
                    values.push(required.clone());
                }
            }
            Some(json!(values))
        }
        "domain-rule-array" | "url-rule-array" => {
            let values = raw.as_array()?;
            if values.len() > 100 {
                return None;
            }
            let mut parsed = Vec::new();
            for value in values {
                if def.kind == "url-rule-array" {
                    if let Some(value) = value.as_str() {
                        let value = value.trim();
                        if !value.is_empty() && value.encode_utf16().count() <= 200 {
                            let value = json!(value);
                            if !parsed.contains(&value) {
                                parsed.push(value);
                            }
                        }
                        continue;
                    }
                    if !value.is_object() {
                        continue;
                    }
                }
                parsed.push(domain_rule(value)?);
            }
            Some(Value::Array(parsed))
        }
        _ => None,
    }
}

/// Preserve the fleet normalization contract. Removing a lock
/// releases it without restoring an older value or enabling more capture.
fn reconcile(locked: &HashMap<String, Value>, current: &Value) -> (Value, bool) {
    let mut managed = Map::new();
    for def in DEFINITIONS.iter() {
        if def.policy_key == "autoStartEnabled"
            && !cfg!(any(target_os = "macos", target_os = "windows"))
        {
            continue;
        }
        if let Some(value) = locked.get(&def.policy_key).and_then(|raw| parse(def, raw)) {
            managed.insert(def.device_key.clone(), value);
        }
    }
    if managed.get("usePiiRemoval") == Some(&json!(false)) {
        managed.insert("asyncPiiRedaction".into(), json!(false));
        managed.insert("asyncImagePiiRedaction".into(), json!(false));
    } else if managed.get("asyncPiiRedaction") == Some(&json!(true))
        || managed.get("asyncImagePiiRedaction") == Some(&json!(true))
    {
        managed.insert("usePiiRemoval".into(), json!(true));
    }
    let engine_changed = DEFINITIONS
        .iter()
        .filter(|def| def.apply == "engine")
        .any(|def| {
            managed.get(&def.device_key).is_some_and(|value| {
                current.get(&def.device_key).or(def.default_value.as_ref()) != Some(value)
            })
        });
    let mut next = current.clone();
    for (key, value) in &managed {
        next[key] = value.clone();
    }
    next["enterpriseManagedSettings"] = Value::Object(managed);
    next[PENDING_RESTART] = json!(engine_changed || current[PENDING_RESTART] == true);
    (next, engine_changed)
}

fn report_failure(root: &std::path::Path, stage: &str, error: &str) {
    let detail = format!(
        "stage={stage}; managed recording settings not applied; retry pending; cause={error}"
    );
    tracing::warn!("enterprise: {detail}");
    crate::recording::recovery_log::append(root, "enterprise_settings_failed", &detail);
}

/// Persist before granting recording at boot or manual enrollment. Startup
/// has no old engine, so the first spawn consumes the saved values directly.
pub(crate) fn persist(
    app: &tauri::AppHandle,
    locked: &HashMap<String, Value>,
    startup: bool,
) -> Result<bool, String> {
    let result = (|| {
        let store = crate::store::get_store(app, None).map_err(|error| error.to_string())?;
        persist_store(store.as_ref(), locked, startup, || {
            crate::store::save_store_with_permission_repair(app, store.as_ref())?;
            crate::store::reencrypt_store_file(app);
            Ok(())
        })
    })();
    if let Err(error) = &result {
        report_failure(&crate::db_relaunch::active_data_dir(), "persist", error);
    }
    result
}

fn persist_store<R: tauri::Runtime>(
    store: &tauri_plugin_store::Store<R>,
    locked: &HashMap<String, Value>,
    startup: bool,
    save: impl FnOnce() -> Result<(), String>,
) -> Result<bool, String> {
    let current = store
        .get("settings")
        .filter(Value::is_object)
        .ok_or("settings unavailable")?;
    let (mut next, _) = reconcile(locked, &current);
    if startup {
        next[PENDING_RESTART] = json!(false);
    }
    // Validate the actual engine's input before committing a policy.
    serde_json::from_value::<crate::store::SettingsStore>(next.clone())
        .map_err(|error| error.to_string())?;
    let pending = next[PENDING_RESTART] == true;
    if next != current {
        store.set("settings", next);
        if let Err(error) = save() {
            store.set("settings", current);
            return Err(error);
        }
        tracing::info!(
            "enterprise: native managed settings saved; recorder restart pending={pending}"
        );
    }
    Ok(pending)
}

/// Save before returning a recording grant; the caller schedules application
/// after granting access so authentication IPC never waits for engine startup.
pub(crate) async fn prepare(
    app: &tauri::AppHandle,
    locked: &HashMap<String, Value>,
) -> Result<(), String> {
    let _apply = APPLY_LOCK.lock().await;
    persist(app, locked, false)?;
    Ok(())
}

/// Serialize policy changes with the recorder lifecycle. Internal stop/start
/// preserves capture intent, including a user pause during the restart.
pub(crate) async fn apply(app: &tauri::AppHandle) -> Result<(), String> {
    let _apply = APPLY_LOCK.lock().await;
    let state = app.state::<crate::recording::RecordingState>();
    // Policy was saved before granting access. A queued restart consumes the
    // latest store, never an older response over a newer watcher decision.
    let pending = crate::store::get_store(app, None)
        .map_err(|error| error.to_string())?
        .get("settings")
        .ok_or("settings unavailable")?[PENDING_RESTART]
        == true;
    if !pending {
        return Ok(());
    }
    let _lifecycle = state.server_lifecycle.lock().await;
    let result = async {
        if state.capture_intended() || state.server.lock().await.is_some() {
            crate::recording::stop_screenpipe_inner(&state).await?;
            crate::recording::spawn_screenpipe_inner(&state, app.clone()).await?;
        }
        let store = crate::store::get_store(app, None).map_err(|error| error.to_string())?;
        let mut current = store.get("settings").ok_or("settings unavailable")?;
        let before = current.clone();
        current[PENDING_RESTART] = json!(false);
        store.set("settings", current);
        if let Err(error) = crate::store::save_store_with_permission_repair(app, store.as_ref()) {
            store.set("settings", before);
            return Err(error);
        }
        crate::store::reencrypt_store_file(app);
        crate::recording::recovery_log::append(
            &crate::db_relaunch::active_data_dir(),
            "enterprise_settings_applied",
            "native recording policy applied; capture pause state preserved",
        );
        Ok(())
    }
    .await;
    if let Err(error) = &result {
        report_failure(&crate::db_relaunch::active_data_dir(), "restart", error);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(value: Value) -> HashMap<String, Value> {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn native_policy_updates_store_and_engine_config_without_a_webview() {
        let root = tempfile::tempdir().unwrap();
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_store::Builder::default().build())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        assert!(app.webview_windows().is_empty());
        let path = root.path().join("store.bin");
        let store = tauri_plugin_store::StoreBuilder::new(app.handle(), &path)
            .disable_auto_save()
            .build()
            .unwrap();
        let mut initial = json!(crate::store::SettingsStore::default());
        initial["deviceId"] = json!("unchanged-device");
        initial["personalPreference"] = json!("keep");
        store.set("settings", initial);
        let locked = policy(json!({
            "disableAudio": "true", "disableVision": "true",
            "ignoredWindows": ["Private"], "audioChunkDuration": 60,
            "localRetentionEnabled": "true", "localRetentionDays": 7,
            "listen_on_lan": "true"
        }));
        assert!(persist_store(store.as_ref(), &locked, false, || store
            .save()
            .map_err(|e| e.to_string()))
        .unwrap());
        let saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let settings: crate::store::SettingsStore =
            serde_json::from_value(saved["settings"].clone()).unwrap();
        let config = settings.to_recording_settings();
        assert!(config.disable_audio);
        assert!(config.disable_vision);
        assert!(config.listen_on_lan);
        assert_eq!(config.audio_chunk_duration, 60);
        assert_eq!(config.ignored_windows, vec!["Private"]);
        assert_eq!(saved["settings"]["localRetentionDays"], 7);
        assert_eq!(saved["settings"]["listenOnLan"], true);
        assert_eq!(saved["settings"]["deviceId"], "unchanged-device");
        assert_eq!(saved["settings"]["personalPreference"], "keep");
        // Steady-state polls do not write again. A failed restart remains
        // pending even though the desired values already match the store.
        assert!(persist_store(store.as_ref(), &locked, false, || panic!(
            "unchanged policy saved again"
        ))
        .unwrap());
        // A fresh process consumes the saved values on its first engine spawn.
        assert!(!persist_store(store.as_ref(), &locked, true, || store
            .save()
            .map_err(|e| e.to_string()))
        .unwrap());
        assert!(!persist_store(store.as_ref(), &locked, false, || panic!(
            "unchanged policy saved again"
        ))
        .unwrap());
    }

    #[test]
    fn live_changes_and_policy_removal_do_not_restart_or_restore_old_values() {
        let current = json!({"disableAudio": true, "analyticsEnabled": true});
        let (next, changed) = reconcile(&policy(json!({"analyticsEnabled": "false"})), &current);
        assert!(!changed);
        assert_eq!(next["disableAudio"], true);
        assert_eq!(next["analyticsEnabled"], false);
        let (released, changed) = reconcile(&HashMap::new(), &next);
        assert!(!changed);
        assert_eq!(released["enterpriseManagedSettings"], json!({}));
        assert_eq!(released["disableAudio"], true);
        assert_eq!(released["analyticsEnabled"], false);
    }

    #[test]
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    fn startup_enforcement_is_live_and_false_releases_the_lock() {
        let (enabled, changed) = reconcile(
            &policy(json!({"autoStartEnabled": "true"})),
            &json!({"autoStartEnabled": false}),
        );
        assert!(!changed);
        assert_eq!(enabled["autoStartEnabled"], true);
        assert_eq!(
            enabled["enterpriseManagedSettings"]["autoStartEnabled"],
            true
        );
        let (released, changed) =
            reconcile(&policy(json!({"autoStartEnabled": "false"})), &enabled);
        assert!(!changed);
        assert_eq!(released["autoStartEnabled"], true);
        assert_eq!(released["enterpriseManagedSettings"], json!({}));
    }

    #[test]
    fn invalid_values_are_ignored_and_pii_hierarchy_remains_coherent() {
        let (next, _) = reconcile(
            &policy(json!({
                "disableAudio": "invalid", "audioChunkDuration": 3,
                "videoQuality": "unknown", "deviceId": "attacker",
                "usePiiRemoval": "false", "asyncImagePiiRedaction": "true",
                "piiRedactionLabels": [" email ", "email", 12],
                "ignoredUrls": [" EXAMPLE.com ", {"domain":"https://Private.Example.com/", "includeSubdomains":true, "excludedSubdomains":["a.private.example.com"]}]
            })),
            &json!({"deviceId":"original"}),
        );
        assert_eq!(next["deviceId"], "original");
        for key in ["disableAudio", "audioChunkDuration", "videoQuality"] {
            assert!(next.get(key).is_none(), "{key}");
        }
        assert_eq!(next["usePiiRemoval"], false);
        assert_eq!(next["asyncPiiRedaction"], false);
        assert_eq!(next["asyncImagePiiRedaction"], false);
        assert_eq!(next["piiRedactionLabels"], json!(["email", "secret"]));
        assert_eq!(next["ignoredUrls"][1]["domain"], "private.example.com");
        let (enabled, _) = reconcile(&policy(json!({"asyncPiiRedaction": "true"})), &json!({}));
        assert_eq!(enabled["usePiiRemoval"], true);
    }

    #[test]
    fn policy_values_match_the_engine_contract() {
        let current = json!(crate::store::SettingsStore::default());
        for def in DEFINITIONS.iter() {
            // Every supported enum and the numeric boundaries must still
            // deserialize through the real engine settings, not just JSON.
            let values = match def.kind.as_str() {
                "enum" => def.values.iter().map(|value| json!(value)).collect(),
                "number" => vec![json!(def.min.unwrap()), json!(def.max.unwrap())],
                "boolean" => vec![json!("true"), json!("false")],
                "string-array" => vec![json!(["sample", "sample"])],
                _ => vec![json!([])],
            };
            for value in values {
                let locked = HashMap::from([(def.policy_key.clone(), value)]);
                let (next, _) = reconcile(&locked, &current);
                serde_json::from_value::<crate::store::SettingsStore>(next)
                    .unwrap_or_else(|error| panic!("{}: {error}", def.policy_key));
            }
        }
        let (next, changed) = reconcile(
            &policy(json!({
                "disableVision": "false", "disableScreenshots": "false",
                "disableAudio": "", "analyticsEnabled": "",
                "retiredPolicyToggle": "true", "enableSemanticContext": "false",
                "maxSnapshotWidth": 99999, "visualChangeThreshold": -1,
                "audioChunkDuration": 5.5, "localRetentionDays": 0,
                "localRetentionMode": "wipe", "ignoredUrls": "example.com"
            })),
            &json!({}),
        );
        assert!(!changed, "effective defaults must not trigger a restart");
        assert_eq!(
            next["enterpriseManagedSettings"],
            json!({
                "disableVision": false, "disableScreenshots": false
            })
        );
    }

    #[test]
    fn structured_domains_keep_exceptions_and_reject_invalid_rules() {
        let (next, _) = reconcile(
            &policy(json!({"includedUrls": [{
                "domain": " HTTPS://WorkTrace.AI/path ", "includeSubdomains": true,
                "excludedSubdomains": ["ABC.worktrace.ai", "abc.worktrace.ai"]
            }]})),
            &json!({}),
        );
        assert_eq!(
            next["includedUrls"],
            json!([{
                "domain": "worktrace.ai", "includeSubdomains": true,
                "excludedSubdomains": ["abc.worktrace.ai"]
            }])
        );
        for rule in [
            json!({"domain": "worktrace", "includeSubdomains": true}),
            json!({"domain": "worktrace.ai", "includeSubdomains": false, "excludedSubdomains": ["abc.worktrace.ai"]}),
            json!({"domain": "worktrace.ai", "includeSubdomains": true, "excludedSubdomains": ["example.com"]}),
            json!({"domain": "worktrace.ai", "includeSubdomains": true, "unknown": true}),
        ] {
            let (next, _) = reconcile(&policy(json!({"includedUrls": [rule]})), &json!({}));
            assert_eq!(next["enterpriseManagedSettings"], json!({}));
        }
        let policy_keys: std::collections::HashSet<_> =
            DEFINITIONS.iter().map(|def| &def.policy_key).collect();
        let device_keys: std::collections::HashSet<_> =
            DEFINITIONS.iter().map(|def| &def.device_key).collect();
        assert_eq!(policy_keys.len(), DEFINITIONS.len());
        assert_eq!(device_keys.len(), DEFINITIONS.len());
    }

    #[tokio::test]
    async fn failed_save_retries_and_survives_support_collection_after_rotation() {
        let root = tempfile::tempdir().unwrap();
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_store::Builder::default().build())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let path = root.path().join("store.bin");
        let store = tauri_plugin_store::StoreBuilder::new(app.handle(), &path)
            .disable_auto_save()
            .build()
            .unwrap();
        let initial = json!(crate::store::SettingsStore::default());
        store.set("settings", initial.clone());
        store.save().unwrap();
        // A directory at the store path makes the actual plugin save fail.
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        let locked = policy(json!({"disableAudio":"true"}));
        let error = persist_store(store.as_ref(), &locked, false, || {
            store.save().map_err(|e| e.to_string())
        })
        .unwrap_err();
        assert_eq!(store.get("settings").unwrap(), initial);
        report_failure(root.path(), "persist", &error);
        std::fs::remove_dir(&path).unwrap();
        assert!(persist_store(store.as_ref(), &locked, false, || store
            .save()
            .map_err(|e| e.to_string()))
        .unwrap());
        for day in 1..=7 {
            std::fs::write(
                root.path()
                    .join(format!("screenpipe-app.2026-09-{day:02}.log")),
                "app restarted\npassword=hunter2\n",
            )
            .unwrap();
        }
        let report =
            crate::diagnostic_logs::collect_redacted_from_dirs(&[root.path().to_path_buf()])
                .await
                .unwrap();
        assert!(report.contains("enterprise_settings_failed"));
        assert!(report.contains("managed recording settings not applied; retry pending"));
        assert!(report.contains(&error), "{report}");
        assert!(!report.contains("hunter2"));
    }
}
