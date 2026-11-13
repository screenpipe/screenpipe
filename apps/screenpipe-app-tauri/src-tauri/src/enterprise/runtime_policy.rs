// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Apply authenticated workspace desired state without a webview. Recording
//! authorization is a separate decision; a paused recorder still receives policy.

use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::path::{Component, Path};

use std::sync::atomic::{AtomicBool, Ordering};
static FILES_RUNNING: AtomicBool = AtomicBool::new(false);
static FILES_DIRTY: AtomicBool = AtomicBool::new(false);

pub(crate) fn file_policy(extra: &Map<String, Value>, current: &Value) -> Value {
    let mut desired = current.as_object().cloned().unwrap_or_default();
    for key in ["managedPipes", "managedSkills"] {
        if let Some(value) = extra.get(key).filter(|value| value.is_array()) {
            desired.insert(key.into(), value.clone());
        }
    }
    Value::Object(desired)
}

/// Filesystem processing cannot delay recording admission, policy revocation,
/// or the next refresh. Desired state is saved first and replayed after restart.
pub(crate) fn queue_saved_files(app: &tauri::AppHandle) {
    FILES_DIRTY.store(true, Ordering::SeqCst);
    if FILES_RUNNING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || loop {
        FILES_DIRTY.store(false, Ordering::SeqCst);
        let root = crate::db_relaunch::active_data_dir();
        let result = (|| -> Result<(), String> {
            let store = crate::store::get_store(&app, None).map_err(|error| error.to_string())?;
            let Some(settings) = store.get("settings") else {
                return Err("settings unavailable".into());
            };
            let Some(desired) = settings
                .get("enterpriseRuntimePolicy")
                .and_then(Value::as_object)
            else {
                return Ok(());
            };
            let home = dirs::home_dir().ok_or("home directory unavailable")?;
            let skills = screenpipe_core::paths::default_screenpipe_data_dir().join("skills");
            apply_files(desired, &root, &home, &skills);
            Ok(())
        })();
        if let Err(error) = result {
            failure(&root, "managed_files", &error);
        }
        if FILES_DIRTY.load(Ordering::SeqCst) {
            continue;
        }
        FILES_RUNNING.store(false, Ordering::SeqCst);
        // Close the enqueue/exit race: either this worker claims the new work,
        // or the enqueuer has already started its replacement.
        if !FILES_DIRTY.load(Ordering::SeqCst)
            || FILES_RUNNING
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_err()
        {
            break;
        }
    });
}

fn text(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or_default().trim().to_string()
}

fn managed(preset: &Value) -> bool {
    preset["enterpriseManaged"] == true
        || preset["id"]
            .as_str()
            .is_some_and(|id| id.starts_with("enterprise-managed"))
}

/// Preserve employee presets when restricted so relaxing policy restores their
/// choices. Explicitly empty allowed sets must remain empty after a restart.
pub(crate) fn ai_settings(raw: &Value, current: &Value) -> Value {
    let legacy = raw["provider"].is_string() && raw["model"].is_string();
    let allow_cloud = !legacy && raw["allow_screenpipe_cloud"] != false || legacy;
    let allow_custom = !legacy && raw["allow_employee_custom_presets"] != false;
    let lock_default = legacy || raw["lock_default_preset"] == true;
    let source = if legacy {
        vec![raw.clone()]
    } else {
        raw["managed_presets"]
            .as_array()
            .cloned()
            .unwrap_or_default()
    };
    let mut owned = Vec::new();
    for (index, preset) in source.iter().enumerate() {
        let provider = text(preset, "provider");
        if !matches!(
            provider.as_str(),
            "openai"
                | "openai-chatgpt"
                | "anthropic"
                | "native-ollama"
                | "custom"
                | "screenpipe-cloud"
        ) {
            continue;
        }
        let model = if provider == "screenpipe-cloud" && text(preset, "model").is_empty() {
            "screenpipe-cloud".to_string()
        } else {
            text(preset, "model")
        };
        if model.is_empty() {
            continue;
        }
        let id = if text(preset, "id").is_empty() {
            if legacy {
                "enterprise-managed".to_string()
            } else {
                format!("enterprise-managed-{}", index + 1)
            }
        } else {
            text(preset, "id")
        };
        let key = if matches!(
            provider.as_str(),
            "screenpipe-cloud" | "native-ollama" | "openai-chatgpt"
        ) {
            String::new()
        } else {
            preset
                .get("api_key")
                .or_else(|| preset.get("apiKey"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string()
        };
        owned.push(json!({
            "id": id, "provider": provider, "model": model,
            "url": if provider == "screenpipe-cloud" { String::new() } else { text(preset, "url") },
            "prompt": text(preset, "prompt"), "apiKey": key,
            "maxContextChars": preset.get("max_context_chars").or_else(|| preset.get("maxContextChars")).filter(|v| v.as_i64().is_some_and(|n| n != 0)).cloned().unwrap_or(json!(512000)),
            "maxTokens": preset.get("max_tokens").or_else(|| preset.get("maxTokens")).filter(|v| v.as_i64().is_some_and(|n| n != 0)).cloned().unwrap_or(json!(4096)),
            "enterpriseManaged": true, "defaultPreset": false,
        }));
    }
    let mut default_id = if legacy {
        owned.first().map(|p| text(p, "id")).unwrap_or_default()
    } else {
        text(raw, "default_preset_id")
    };
    if !(allow_cloud && default_id == "screenpipe-cloud")
        && !owned.iter().any(|p| p["id"] == default_id)
    {
        default_id = owned.first().map(|p| text(p, "id")).unwrap_or_else(|| {
            if allow_cloud {
                "screenpipe-cloud".into()
            } else {
                String::new()
            }
        });
    }
    let mut seen = HashSet::new();
    let mut allowed = Vec::new();
    let mut suppressed = Vec::new();
    for preset in ["aiPresets", "enterpriseSuppressedAiPresets"]
        .iter()
        .flat_map(|key| current[*key].as_array().into_iter().flatten())
    {
        if managed(preset) || !seen.insert(text(preset, "id").to_lowercase()) {
            continue;
        }
        if if preset["provider"] == "screenpipe-cloud" {
            allow_cloud
        } else {
            allow_custom
        } {
            if !owned
                .iter()
                .any(|p| text(p, "id").eq_ignore_ascii_case(&text(preset, "id")))
            {
                allowed.push(preset.clone());
            }
        } else {
            suppressed.push(preset.clone());
        }
    }
    owned.extend(allowed);
    if lock_default && owned.iter().any(|p| p["id"] == default_id) {
        for preset in &mut owned {
            preset["defaultPreset"] = json!(preset["id"] == default_id);
        }
    } else if !owned.iter().any(|p| p["defaultPreset"] == true) {
        let fallback = owned
            .iter()
            .find(|p| p["id"] == default_id)
            .or(owned.first())
            .map(|p| text(p, "id"));
        for preset in &mut owned {
            preset["defaultPreset"] = json!(Some(text(preset, "id")) == fallback);
        }
    }
    let mut next = current.clone();
    next["aiPresets"] = json!(owned);
    next["enterpriseSuppressedAiPresets"] = json!(suppressed);
    next["enterpriseAiPresetPolicy"] = json!({
        "version": 2, "allow_screenpipe_cloud": allow_cloud,
        "allow_employee_custom_presets": allow_custom, "lock_default_preset": lock_default,
        "default_preset_id": if default_id.is_empty() { Value::Null } else { json!(default_id) },
        "managed_presets": source,
    });
    next
}

#[derive(Deserialize)]
struct ManagedPipe {
    name: String,
    prompt_body: String,
    schedule: String,
    model: Option<String>,
    provider: Option<String>,
    preset: Option<String>,
    timeout: u64,
    enabled: bool,
    version: u64,
}

const PIPE_MARKER: &str = "# enterprise-managed:v";

fn pipe_content(pipe: &ManagedPipe) -> Result<String, String> {
    let mut components = Path::new(&pipe.name).components();
    if !matches!(components.next(), Some(Component::Normal(_)))
        || components.next().is_some()
        || pipe.name.contains(['/', '\\'])
    {
        return Err("managed task name must be one directory component".into());
    }
    let mut body = format!(
        "---\nschedule: {}\nenabled: {}\n",
        json!(pipe.schedule),
        pipe.enabled
    );
    if let Some(preset) = pipe.preset.as_deref().filter(|p| !p.is_empty()) {
        body.push_str(&format!("preset: [{}]\n", json!(preset)));
    }
    body.push_str("enterprise_managed: true\n");
    if pipe.preset.as_deref().is_none_or(str::is_empty) {
        for (key, value) in [("model", &pipe.model), ("provider", &pipe.provider)] {
            if let Some(value) = value.as_deref().filter(|v| !v.is_empty()) {
                body.push_str(&format!("{key}: {}\n", json!(value)));
            }
        }
    }
    body.push_str(&format!(
        "timeout: {}\n---\n\n{PIPE_MARKER}{}\n\n{}",
        pipe.timeout, pipe.version, pipe.prompt_body
    ));
    Ok(body)
}

fn reject_symlink(path: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => Err("managed task path is a symlink".into()),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn sync_pipes(root: &Path, raw: &Value) -> Result<(), String> {
    let pipes: Vec<ManagedPipe> =
        serde_json::from_value(raw.clone()).map_err(|_| "invalid managedPipes desired state")?;
    // Validate the complete desired state before changing files or pruning.
    let desired: Vec<_> = pipes
        .iter()
        .map(|p| pipe_content(p).map(|body| (p.name.as_str(), body)))
        .collect::<Result<_, _>>()?;
    reject_symlink(root)?;
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let mut failures = Vec::new();
    for (name, body) in &desired {
        let result = (|| -> Result<(), String> {
            let dir = root.join(name);
            let path = dir.join("pipe.md");
            reject_symlink(&dir)?;
            reject_symlink(&path)?;
            if path.exists()
                && !std::fs::read_to_string(&path)
                    .map_err(|e| e.to_string())?
                    .lines()
                    .any(|line| line.starts_with(PIPE_MARKER))
            {
                return Err("managed task conflicts with an employee-owned task".into());
            }
            screenpipe_core::memories::external_sync::write_atomic_full(&path, body)
                .map_err(|e| e.to_string())?;
            Ok(())
        })();
        if let Err(error) = result {
            failures.push(format!("task={name}; {error}"));
        }
    }
    // A failed item does not strand independent tasks. Defer pruning until all
    // desired installations are safe; the saved policy remains available to retry.
    if !failures.is_empty() {
        return Err(failures.join("; "));
    }
    for entry in std::fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_dir()
            || desired
                .iter()
                .any(|(name, _)| *name == entry.file_name().to_string_lossy())
        {
            continue;
        }
        let path = entry.path().join("pipe.md");
        reject_symlink(&path)?;
        if !path.exists() {
            continue;
        }
        let body = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        if body.lines().any(|line| line.starts_with(PIPE_MARKER)) {
            let next = body
                .lines()
                .map(|line| {
                    if line == "enabled: true" {
                        "enabled: false"
                    } else {
                        line
                    }
                })
                .collect::<Vec<_>>()
                .join("\n");
            screenpipe_core::memories::external_sync::write_atomic_full(&path, &next)
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub(crate) fn failure(root: &Path, stage: &str, cause: &str) {
    let detail = format!("stage={stage}; outcome=policy_not_applied; retry=next_enterprise_policy_poll; cause={cause}");
    tracing::warn!("enterprise: {detail}");
    crate::recording::recovery_log::append(root, "enterprise_policy_failed", &detail);
}

/// Omission preserves existing installs. Only an explicit returned empty list
/// authorizes removal of organization-managed tasks or skill destinations.
pub(crate) fn apply_files(
    extra: &Map<String, Value>,
    root: &Path,
    home: &Path,
    skill_store: &Path,
) {
    if let Some(raw) = extra.get("managedPipes") {
        if let Err(error) = sync_pipes(&root.join("pipes"), raw) {
            failure(root, "managed_tasks", &error);
        }
    }
    if let Some(raw) = extra.get("managedSkills") {
        match serde_json::from_value::<Vec<crate::skills::ManagedTeamSkill>>(raw.clone()) {
            Ok(skills) => {
                for receipt in
                    crate::skills::sync_managed_team_skills_in(home, skill_store, &skills, true)
                {
                    if receipt.status == "error" {
                        failure(
                            root,
                            "managed_skills",
                            receipt
                                .detail
                                .as_deref()
                                .unwrap_or("skill installation failed"),
                        );
                    }
                }
            }
            Err(_) => failure(
                root,
                "managed_skills",
                "invalid managedSkills desired state; existing installations retained",
            ),
        }
    }
}

pub(crate) fn apply_team(
    extra: &Map<String, Value>,
    account: bool,
    path: &Path,
) -> Result<(), String> {
    if !account {
        return Ok(());
    }
    let Some(is_admin) = extra.get("isAdmin").and_then(Value::as_bool) else {
        return Ok(());
    };
    crate::enterprise_config_file::update(path, |config| {
        config.insert("is_admin".into(), json!(is_admin));
        config.insert("license_active".into(), json!(true));
        if !is_admin {
            config.insert("gateway_url".into(), Value::Null);
        } else if let Some(url) = extra.get("gatewayUrl") {
            if url.is_null() {
                config.insert("gateway_url".into(), Value::Null);
            } else {
                let url = url
                    .as_str()
                    .and_then(|url| reqwest::Url::parse(url).ok())
                    .filter(|url| {
                        matches!(url.scheme(), "http" | "https")
                            && url.has_host()
                            && url.username().is_empty()
                            && url.password().is_none()
                    })
                    .ok_or("invalid enterprise gateway URL")?;
                config.insert(
                    "gateway_url".into(),
                    json!(url.as_str().trim_end_matches('/')),
                );
            }
        }
        Ok(())
    })
    .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restrictions_restore_employee_presets_and_allow_explicitly_empty_sets() {
        let current = json!({"aiPresets":[{"id":"personal","provider":"custom","defaultPreset":true},{"id":"cloud","provider":"screenpipe-cloud"}],"unrelated":7});
        let restricted = ai_settings(
            &json!({"allow_screenpipe_cloud":false,"allow_employee_custom_presets":false}),
            &current,
        );
        assert_eq!(restricted["aiPresets"], json!([]));
        assert_eq!(
            restricted["enterpriseSuppressedAiPresets"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        let restored = ai_settings(&json!({}), &restricted);
        assert_eq!(restored["aiPresets"], current["aiPresets"]);
        assert_eq!(restored["unrelated"], 7);
    }

    #[test]
    fn native_task_install_update_removal_preserves_personal_tasks_and_failed_state() {
        let dir = tempfile::tempdir().unwrap();
        let task = json!({"name":"work","prompt_body":"first","schedule":"0 * * * *","model":null,"provider":null,"preset":"managed","timeout":600,"enabled":true,"version":1});
        sync_pipes(dir.path(), &json!([task])).unwrap();
        let path = dir.path().join("work/pipe.md");
        assert!(std::fs::read_to_string(&path).unwrap().contains("first"));
        let mut next = task.clone();
        next["prompt_body"] = json!("second");
        sync_pipes(dir.path(), &json!([next])).unwrap();
        assert!(std::fs::read_to_string(&path).unwrap().contains("second"));
        std::fs::create_dir(dir.path().join("personal")).unwrap();
        std::fs::write(
            dir.path().join("personal/pipe.md"),
            "enabled: true\nuser text",
        )
        .unwrap();
        assert!(sync_pipes(dir.path(), &json!([{"name":"../escape"}])).is_err());
        assert!(std::fs::read_to_string(&path)
            .unwrap()
            .contains("enabled: true"));
        sync_pipes(dir.path(), &json!([])).unwrap();
        assert!(std::fs::read_to_string(&path)
            .unwrap()
            .contains("enabled: false"));
        assert_eq!(
            std::fs::read_to_string(dir.path().join("personal/pipe.md")).unwrap(),
            "enabled: true\nuser text"
        );
    }

    #[test]
    fn returned_skills_apply_and_explicit_empty_state_prunes_after_reloading_desired_state() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let store = root.path().join("skills");
        let skill = crate::skills::tests::managed_skill_fixture(
            "native-policy-test",
            1,
            &["screenpipe", "codex"],
        );
        let desired = json!({"managedSkills":[skill]})
            .as_object()
            .unwrap()
            .clone();
        apply_files(&desired, root.path(), &home, &store);
        let path = store.join("screenpipe-team-native-policy-test/SKILL.md");
        assert!(path.is_file());
        apply_files(&Map::new(), root.path(), &home, &store);
        assert!(
            path.is_file(),
            "omission must preserve the last valid install"
        );
        let persisted = serde_json::to_vec(&json!({"managedSkills":[]})).unwrap();
        let reloaded: Map<String, Value> = serde_json::from_slice(&persisted).unwrap();
        apply_files(&reloaded, root.path(), &home, &store);
        assert!(!path.exists());
        assert!(!home
            .join(".codex/skills/screenpipe-team-native-policy-test")
            .exists());
    }

    #[tokio::test]
    async fn filesystem_failure_reaches_redacted_support_report_and_recovers_on_retry() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("pipes"), "blocked").unwrap();
        let task = json!({"managedPipes":[{"name":"work","prompt_body":"password=hunter2","schedule":"0 * * * *","timeout":60,"enabled":true,"version":1}]}).as_object().unwrap().clone();
        apply_files(
            &task,
            root.path(),
            &root.path().join("home"),
            &root.path().join("skills"),
        );
        let report = crate::diagnostic_logs::collect_redacted_from_dirs_at_root(
            &[root.path().to_path_buf()],
            root.path().to_path_buf(),
        )
        .await
        .unwrap();
        assert!(report.contains("enterprise_policy_failed"), "{report}");
        assert!(report.contains("stage=managed_tasks"), "{report}");
        assert!(
            report.contains("retry=next_enterprise_policy_poll"),
            "{report}"
        );
        assert!(report.contains("cause="), "{report}");
        assert!(!report.contains("hunter2"));
        std::fs::remove_file(root.path().join("pipes")).unwrap();
        apply_files(
            &task,
            root.path(),
            &root.path().join("home"),
            &root.path().join("skills"),
        );
        assert!(root.path().join("pipes/work/pipe.md").is_file());
    }

    #[test]
    fn organization_preset_binding_never_falls_back_to_a_task_provider() {
        let task: ManagedPipe = serde_json::from_value(json!({"name":"daily","prompt_body":"review","schedule":"every 30m","model":"should-not-appear","provider":"should-not-appear","preset":"org-ai","timeout":60,"enabled":true,"version":4})).unwrap();
        let body = pipe_content(&task).unwrap();
        assert!(body.contains("preset: [\"org-ai\"]"));
        assert!(body.contains("enterprise_managed: true"));
        assert!(!body.contains("should-not-appear"));
    }

    #[test]
    fn team_changes_distinguish_omission_null_revocation_and_key_only_fetches() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("enterprise.json");
        let data = |value: Value| value.as_object().unwrap().clone();
        apply_team(
            &data(json!({"isAdmin":true,"gatewayUrl":"https://first.example"})),
            true,
            &path,
        )
        .unwrap();
        apply_team(&data(json!({"isAdmin":false})), false, &path).unwrap();
        apply_team(&data(json!({"isAdmin":true})), true, &path).unwrap();
        let read = || serde_json::from_slice::<Value>(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(read()["gateway_url"], "https://first.example");
        apply_team(
            &data(json!({"isAdmin":true,"gatewayUrl":null})),
            true,
            &path,
        )
        .unwrap();
        assert!(read()["gateway_url"].is_null());
        apply_team(&data(json!({"isAdmin":false})), true, &path).unwrap();
        assert_eq!(read()["is_admin"], false);
    }
}
