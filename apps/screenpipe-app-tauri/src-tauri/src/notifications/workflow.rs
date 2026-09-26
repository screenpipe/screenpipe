// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Workflow suggestions share the ordinary notification transport and settings.
//! Persist attention decisions independently of the deletable notification inbox.
use super::routes::NotifyPayload;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::Path};
use tauri::{AppHandle, Emitter, Manager};

pub static WRITER: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Ledger {
    pub last_accepted_at: Option<i64>,
    // The supported-step high water mark ignores wording, citations and revisions.
    pub workflows: BTreeMap<String, usize>,
}

/// The main app owns this task once per process, including tray-only mode.
/// The catalog is the durable queue: paused notifications stay eligible, and
/// saved receipts survive restart/inbox dismissal. No extra AI run or scheduler.
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            if !screenpipe_core::workflows::pipeline::rollout_enabled() {
                continue;
            }
            let Ok(dir) = app.path().app_local_data_dir().map(|p| p.join("workflows")) else {
                continue;
            };
            let Ok(catalog) = read_catalog(&dir) else {
                continue;
            };
            let Ok(ledger) = read_ledger(&dir.join("notification-ledger.json")) else {
                continue;
            };
            let ids: Vec<String> = catalog["analysis"]["workflows"]
                .as_array()
                .into_iter()
                .flatten()
                .map(screenpipe_engine::routes::workflows::workflow_id)
                .collect();
            let mut payload: NotifyPayload = match serde_json::from_value(json!({
                "title":"A workflow is ready to review", "body":"Review the mapped steps.",
                "pipe_name":"workflow-review", "type":"pipe", "workflow_ids":ids
            })) {
                Ok(p) => p,
                Err(_) => continue,
            };
            let ready = candidates(&payload, &catalog, &ledger);
            if let Some(reason) =
                suppression(&ledger, chrono::Utc::now().timestamp_millis(), &ready)
            {
                if !ready.is_empty() {
                    track(
                        &app,
                        "workflow_notification_suppressed",
                        reason,
                        ready.len(),
                    );
                }
                continue;
            }
            prepare(&mut payload, &ready);
            // The native route owns the atomic recheck, quota and existing
            // notification preferences. Never send directly to the panel.
            if super::client::post_notification(&serde_json::to_value(payload).unwrap())
                .await
                .is_err()
            {
                track(
                    &app,
                    "workflow_notification_failed",
                    "transport_failed",
                    ready.len(),
                );
            }
        }
    });
}

fn valid_id(id: &str) -> bool {
    id.strip_prefix("wf-").is_some_and(|suffix| {
        !suffix.is_empty()
            && suffix.len() <= 128
            && suffix
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    })
}

fn review_query(value: &str, key: &str) -> Option<String> {
    let url = url::Url::parse(value).ok()?;
    if url.scheme() != "screenpipe"
        || url.host_str() != Some("workflows")
        || !matches!(url.path(), "" | "/")
    {
        return None;
    }
    let mut query = url::form_urlencoded::Serializer::new(String::new());
    query
        .append_pair("mode", "workflows")
        .append_pair("reviewRequest", key);
    for (name, value) in url.query_pairs() {
        if name == "workflow" {
            if !valid_id(&value) {
                return None;
            }
            query.append_pair(&name, &value);
        } else if name == "workflows" {
            let ids: Vec<_> = value.split(',').collect();
            if ids.len() > 100 || !ids.iter().all(|id| valid_id(id)) {
                return None;
            }
            query.append_pair(&name, &value);
        }
    }
    Some(query.finish())
}

/// Native buttons bypass the webview's action router. Put the destination in
/// the initial Home URL as well as the warm-window event; both use one key.
pub fn open_review(app: &AppHandle, value: &str) -> bool {
    let Some(query) = review_query(value, &uuid::Uuid::new_v4().to_string()) else {
        return false;
    };
    track(app, "workflow_notification_clicked", "native_action", 0);
    let page = format!("home&{query}");
    let target = format!("/home?{query}");
    let app_for_show = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Err(error) =
            (crate::window::ShowRewindWindow::Home { page: Some(page) }).show(&app_for_show)
        {
            tracing::warn!("Could not open workflow review: {error}");
        }
    });
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        for delay in [0_u64, 250, 750, 1500] {
            tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
            let _ = app.emit("navigate", json!({"url": target}));
        }
    });
    true
}

pub fn is_workflow_pipe(name: Option<&str>) -> bool {
    matches!(
        name,
        Some(
            "workflow-discovery"
                | "workflow-discover"
                | "workflow-review"
                | "workflow-maintain"
                | "workflow-deepen"
        )
    )
}

pub fn track(app: &AppHandle, event: &'static str, reason: &'static str, count: usize) {
    let coalesced = matches!(
        event,
        "workflow_notification_suppressed"
            | "workflow_notification_failed"
            | "workflow_notification_eligible"
    );
    if coalesced {
        static SEEN: std::sync::Mutex<Option<(i64, std::collections::HashSet<String>)>> =
            std::sync::Mutex::new(None);
        let hour = chrono::Utc::now().timestamp() / 3600;
        let Ok(mut seen) = SEEN.lock() else { return };
        let (bucket, keys) = seen.get_or_insert_with(|| (hour, Default::default()));
        if *bucket != hour {
            *bucket = hour;
            keys.clear();
        }
        if !keys.insert(format!("{event}:{reason}")) {
            return;
        }
    }
    if let Some(analytics) = app.try_state::<std::sync::Arc<crate::analytics::AnalyticsManager>>() {
        analytics.send_event_nonblocking(
            event,
            Some(json!({
                "notification_category": "workflow_review", "reason": reason,
                "workflow_count": count.min(100), "decision_coalesced_hourly": coalesced,
                "analytics_schema_version": "workflow_notification_v1"
            })),
        );
    }
}

pub fn read_ledger(path: &Path) -> Result<Ledger, String> {
    match std::fs::read(path) {
        Ok(bytes) if bytes.len() <= 1024 * 1024 => {
            serde_json::from_slice(&bytes).map_err(|_| "ledger_unreadable".into())
        }
        Ok(_) => Err("ledger_unreadable".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Ledger::default()),
        Err(_) => Err("ledger_unreadable".into()),
    }
}
pub fn write_ledger(path: &Path, ledger: &Ledger) -> Result<(), String> {
    let text = serde_json::to_string(ledger).map_err(|_| "ledger_write_failed")?;
    screenpipe_core::memories::external_sync::write_atomic_full(path, &text)
        .map(|_| ())
        .map_err(|_| "ledger_write_failed".into())
}

pub fn reviewing_workflows(app: &AppHandle) -> bool {
    app.webview_windows().values().any(|window| {
        window.is_focused().unwrap_or(false)
            && window.url().is_ok_and(|url| {
                url.path().trim_end_matches('/') == "/home"
                    && url
                        .query_pairs()
                        .any(|(key, value)| key == "mode" && value == "workflows")
            })
    })
}

pub fn read_catalog(dir: &Path) -> Result<Value, String> {
    use std::io::Read;
    for name in ["catalog.json", "catalog.backup.json"] {
        let Ok(file) = std::fs::File::open(dir.join(name)) else {
            continue;
        };
        let mut bytes = Vec::new();
        if file
            .take(32 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .is_err()
            || bytes.len() > 32 * 1024 * 1024
        {
            continue;
        }
        if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
            if value["schemaVersion"] == 5 && value["analysis"]["workflows"].is_array() {
                return Ok(value);
            }
        }
    }
    Err("catalog_unavailable".into())
}

fn supported_steps(workflow: &Value) -> usize {
    workflow["stages"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|step| {
            !step["name"].as_str().unwrap_or("").trim().is_empty()
                && step["procedure"].as_array().is_some_and(|blocks| {
                    blocks.iter().any(|block| {
                        !block["text"].as_str().unwrap_or("").trim().is_empty()
                            && (!block["quote"].as_str().unwrap_or("").trim().is_empty()
                                || block["userEdited"] == true)
                    })
                })
        })
        .count()
}

/// Resolve only durable workflow identities. Legacy installed prompts name the
/// ID in a chat action; newer callers can supply workflow_ids directly.
pub fn candidates(
    payload: &NotifyPayload,
    catalog: &Value,
    ledger: &Ledger,
) -> Vec<(String, usize)> {
    let prompts: Vec<&str> = payload
        .actions
        .iter()
        .filter_map(|a| a["prompt"].as_str())
        .collect();
    catalog["analysis"]["workflows"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|workflow| {
            let id = screenpipe_engine::routes::workflows::workflow_id(workflow);
            if !valid_id(&id) {
                return None;
            }
            let named = payload.workflow_ids.contains(&id)
                || prompts.iter().any(|prompt| {
                    prompt
                        .split(|c: char| !c.is_ascii_alphanumeric() && c != '-' && c != '_')
                        .any(|word| word == id)
                });
            let steps = supported_steps(workflow);
            // lastReviewedAt is the agent review, not a human dismissal.
            (named && steps > 0 && steps > ledger.workflows.get(&id).copied().unwrap_or(0))
                .then_some((id, steps))
        })
        .take(100)
        .collect()
}

pub fn suppression(
    ledger: &Ledger,
    now: i64,
    candidates: &[(String, usize)],
) -> Option<&'static str> {
    if candidates.is_empty() {
        return Some("no_meaningful_change");
    }
    if ledger.workflows.len() >= 10_000 {
        return Some("ledger_full");
    }
    // Clock rollback must never reopen the quota.
    if ledger
        .last_accepted_at
        .is_some_and(|last| now.saturating_sub(last) < DAY_MS)
    {
        return Some("daily_limit");
    }
    None
}

pub fn prepare(payload: &mut NotifyPayload, candidates: &[(String, usize)]) {
    let count = candidates.len();
    payload.id = Some(format!(
        "workflow-review:{}:{}",
        candidates[0].0, candidates[0].1
    ));
    payload.title = if count == 1 {
        "A workflow is ready to review".into()
    } else {
        format!("{count} workflows are ready to review")
    };
    payload.body = "Review the mapped steps, add feedback, or create an SOP.".into();
    payload.notification_type = Some("pipe".into());
    payload.priority = Some(super::store::NotificationPriority::Normal);
    payload.transient = Some(false);
    payload.source_session_id = None;
    payload.source_message_id = None;
    let mut url = url::Url::parse("screenpipe://workflows").unwrap();
    // A batch goes to the catalog, a single suggestion opens its saved map.
    if count == 1 {
        url.query_pairs_mut()
            .append_pair("workflow", &candidates[0].0);
    } else {
        url.query_pairs_mut().append_pair(
            "workflows",
            &candidates
                .iter()
                .map(|(id, _)| id.as_str())
                .collect::<Vec<_>>()
                .join(","),
        );
    }
    url.query_pairs_mut().append_pair("source", "notification");
    payload.source_url = Some(url.to_string());
    payload.actions = vec![
        json!({"type":"deeplink", "label":if count == 1 {"Review workflow"} else {"Review workflows"}, "url":url.as_str(), "primary":true}),
    ];
}

#[cfg(test)]
mod tests {
    use super::*;
    fn payload() -> NotifyPayload {
        serde_json::from_value(json!({"title":"private title","body":"private body","pipe_name":"workflow-discovery","actions":[{"type":"chat","prompt":"Review saved wf-one"}]})).unwrap()
    }
    fn catalog() -> Value {
        json!({"schemaVersion":5,"analysis":{"workflows":[{"id":"wf-one","stages":[{"name":"Read request","procedure":[{"text":"Read the request","quote":"Request"}]}]}]}})
    }
    #[test]
    fn native_review_destination_survives_cold_home_mount() {
        assert_eq!(
            review_query(
                "screenpipe://workflows?workflow=wf-one&source=notification",
                "click-1"
            )
            .unwrap(),
            "mode=workflows&reviewRequest=click-1&workflow=wf-one"
        );
        assert!(review_query(
            "screenpipe://workflows?workflows=wf-one%2Cwf-two",
            "click-2"
        )
        .unwrap()
        .ends_with("workflows=wf-one%2Cwf-two"));
        for invalid in [
            "https://workflows",
            "screenpipe://workflows/other",
            "screenpipe://workflows?workflow=bad",
            "screenpipe://workflows?workflows=wf-one,bad",
        ] {
            assert!(review_query(invalid, "click").is_none());
        }
    }
    #[test]
    fn saved_supported_identity_is_required() {
        let mut c = catalog();
        assert_eq!(
            candidates(&payload(), &c, &Ledger::default()),
            vec![("wf-one".into(), 1)]
        );
        c["analysis"]["workflows"][0]["stages"][0]["procedure"] = json!([]);
        assert!(candidates(&payload(), &c, &Ledger::default()).is_empty());
        assert!(candidates(&payload(), &json!({}), &Ledger::default()).is_empty());
    }
    #[test]
    fn rewording_and_revisions_do_not_rearm_but_new_supported_steps_do() {
        let ledger = Ledger {
            workflows: [("wf-one".into(), 1)].into(),
            ..Default::default()
        };
        let mut c = catalog();
        c["revision"] = json!(999);
        c["analysis"]["workflows"][0]["stages"][0]["name"] = json!("New wording");
        assert!(candidates(&payload(), &c, &ledger).is_empty());
        let step = c["analysis"]["workflows"][0]["stages"][0].clone();
        c["analysis"]["workflows"][0]["stages"]
            .as_array_mut()
            .unwrap()
            .push(step);
        assert_eq!(candidates(&payload(), &c, &ledger).len(), 1);
    }
    #[test]
    fn daily_budget_survives_restart_and_clock_rollback() {
        let ledger = Ledger {
            last_accepted_at: Some(DAY_MS),
            ..Default::default()
        };
        let reloaded: Ledger =
            serde_json::from_str(&serde_json::to_string(&ledger).unwrap()).unwrap();
        let c = vec![("wf-one".into(), 1)];
        assert_eq!(suppression(&reloaded, DAY_MS - 1, &c), Some("daily_limit"));
        assert_eq!(
            suppression(&reloaded, 2 * DAY_MS - 1, &c),
            Some("daily_limit")
        );
        assert_eq!(suppression(&reloaded, 2 * DAY_MS, &c), None);
    }
    #[test]
    fn safe_review_action_contains_no_captured_content() {
        let mut p = payload();
        prepare(&mut p, &[("wf-one".into(), 1)]);
        assert_eq!(p.actions[0]["type"], "deeplink");
        assert_eq!(
            p.actions[0]["url"],
            "screenpipe://workflows?workflow=wf-one&source=notification"
        );
        assert!(!serde_json::to_string(&p).unwrap().contains("private"));
        prepare(&mut p, &[("wf-one".into(), 1), ("wf-two".into(), 2)]);
        assert_eq!(p.title, "2 workflows are ready to review");
        assert_eq!(
            p.actions[0]["url"],
            "screenpipe://workflows?workflows=wf-one%2Cwf-two&source=notification"
        );
    }
    #[test]
    fn corrupt_ledger_fails_closed_and_atomic_roundtrip_preserves_history() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ledger.json");
        let mut ledger = read_ledger(&path).unwrap();
        ledger.workflows.insert("wf-one".into(), 1);
        write_ledger(&path, &ledger).unwrap();
        assert_eq!(read_ledger(&path).unwrap().workflows.len(), 1);
        std::fs::write(&path, "broken").unwrap();
        assert!(read_ledger(&path).is_err());
    }
    #[test]
    fn agent_review_is_eligible_but_unknown_workflows_stay_quiet() {
        let mut c = catalog();
        c["analysis"]["workflows"][0]["lastReviewedAt"] = json!("2026-09-25");
        assert_eq!(candidates(&payload(), &c, &Ledger::default()).len(), 1);
        let mut p = payload();
        p.actions[0]["prompt"] = json!("Review wf-one-more");
        assert!(candidates(&p, &catalog(), &Ledger::default()).is_empty());
        c["analysis"]["workflows"][0]["id"] = json!("wf-invalid/id");
        p.workflow_ids = vec!["wf-invalid/id".into()];
        assert!(candidates(&p, &c, &Ledger::default()).is_empty());
    }
}
