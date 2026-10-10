// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
//! Batched semantic conditions over persisted recent observations. Never runs on
//! capture threads. Delivery uses the same addressed events as spoken phrases.
use super::{connection_triggers::subscription_key, PipeConfig, SourceTrigger};
use crate::agents::AgentExecutor;
use anyhow::{anyhow, Result};
use chrono::{Datelike, Duration as ChronoDuration, Local, Timelike, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, path::Path};

pub const LIMIT: usize = 3;
pub const INTERVAL_SECS: u64 = 2;
const STATE_FILE: &str = ".semantic-triggers.json";
const MAX_CONDITION_CHARS: usize = 1000;

pub fn sources(config: &PipeConfig) -> Vec<&SourceTrigger> {
    config
        .trigger
        .as_ref()
        .map(|t| t.sources.iter().filter(|s| s.app == "semantic").collect())
        .unwrap_or_default()
}

pub fn validate(src: &SourceTrigger) -> Result<()> {
    let id = src.filter.get("id").map(String::as_str).unwrap_or("");
    let condition = src
        .filter
        .get("condition")
        .map(String::as_str)
        .unwrap_or("");
    if src.kind != "condition"
        || id.is_empty()
        || id.len() > 100
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        || condition.trim().is_empty()
        || condition.chars().count() > MAX_CONDITION_CHARS
    {
        return Err(anyhow!(
            "invalid_semantic_trigger: provide an id and a condition of up to 1000 characters"
        ));
    }
    Ok(())
}

pub async fn cloud(
    http: &reqwest::Client,
    executor: &dyn AgentExecutor,
    body: Value,
) -> Result<Value> {
    let token = executor
        .user_token()
        .ok_or_else(|| anyhow!("semantic_sign_in_required"))?;
    let base = executor
        .screenpipe_api_url()
        .trim_end_matches('/')
        .trim_end_matches("/v1");
    let response = http
        .post(format!("{base}/v1/semantic-triggers"))
        .bearer_auth(token)
        .header("X-Screenpipe-Workload", "background")
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            anyhow!(if e.is_timeout() {
                "semantic_timeout"
            } else {
                "semantic_transport_error"
            })
        })?;
    let status = response.status();
    if !status.is_success() {
        return Err(anyhow!("semantic_http_{}", status.as_u16()));
    }
    response
        .json()
        .await
        .map_err(|_| anyhow!("semantic_invalid_response"))
}

/// Same deterministic flat-capture projection used by the replay parser: retain
/// text and provenance, normalize line endings, omit geometry and empty layout.
/// A flat capture cannot prove visibility, so no words are removed heuristically.
pub fn observations(rows: &[Value]) -> Value {
    let mut records = Vec::new();
    for row in rows {
        let mut out = serde_json::Map::new();
        for key in [
            "frame_id",
            "timestamp",
            "app_name",
            "window_name",
            "browser_url",
        ] {
            if let Some(v) = row.get(key).filter(|v| !v.is_null()) {
                out.insert(key.into(), v.clone());
            }
        }
        let mut text = row
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .replace("\r\n", "\n")
            .replace('\r', "\n")
            .trim()
            .to_string();
        if text.is_empty() {
            continue;
        }
        if text.len() > 4000 {
            let mut end = 4000;
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            text.truncate(end);
            out.insert("truncated".into(), Value::Bool(true));
        }
        out.insert("text".into(), Value::String(text));
        if row.get("truncated").and_then(Value::as_i64) == Some(1) {
            out.insert("truncated".into(), Value::Bool(true));
        }
        records.push(Value::Object(out));
    }
    json!({"previous_records": [], "current_records": records})
}

#[derive(Clone, Serialize, Deserialize)]
struct Delivery {
    id: String,
    pipe: String,
    source: SourceTrigger,
    context: Value,
    attempts: u32,
    sent_at: i64,
}
#[derive(Default, Serialize, Deserialize)]
pub struct State {
    matched: HashMap<String, bool>,
    #[serde(default)]
    definitions: HashMap<String, String>,
    pending: HashMap<String, Delivery>,
    #[serde(skip)]
    last_input: String,
    #[serde(skip)]
    pub last_error: Option<String>,
    #[serde(skip)]
    saved: String,
}
impl State {
    pub fn load(dir: &Path) -> Result<Self> {
        match std::fs::read_to_string(dir.join(STATE_FILE)) {
            Ok(text) => {
                let mut state: Self = serde_json::from_str(&text)?;
                state.saved = serde_json::to_string(&state)?;
                for delivery in state.pending.values_mut() {
                    delivery.sent_at = 0;
                }
                Ok(state)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let mut state = Self::default();
                state.saved = serde_json::to_string(&state)?;
                Ok(state)
            }
            Err(e) => Err(e.into()),
        }
    }
    fn save(&mut self, dir: &Path) -> Result<()> {
        let text = serde_json::to_string(self)?;
        if text != self.saved {
            super::atomic_write(&dir.join(STATE_FILE), &text)?;
            self.saved = text;
        }
        Ok(())
    }
    fn classify(&mut self, id: &str, choice: &str) -> bool {
        match choice {
            "supported" => !self.matched.insert(id.into(), true).unwrap_or(false),
            "contradicted" => {
                self.matched.insert(id.into(), false);
                false
            }
            _ => false, // Unknown / unavailable evidence must not re-arm a true condition.
        }
    }
}

fn emit(delivery: &Delivery) -> Result<()> {
    screenpipe_events::send_event(
        "connection_trigger",
        screenpipe_events::ConnectionTriggerEvent {
            pipe: delivery.pipe.clone(),
            app: "semantic".into(),
            kind: "condition".into(),
            path: None,
            count: 1,
            timestamp: Utc::now(),
            delivery_id: Some(delivery.id.clone()),
            subscription_key: Some(subscription_key(&delivery.pipe, &delivery.source)),
            context: Some(delivery.context.clone()),
        },
    )
    .map_err(|_| anyhow!("semantic_delivery_failed"))
}

pub async fn tick(
    dir: &Path,
    pipes: &[(String, PipeConfig)],
    state: &mut State,
    http: &reqwest::Client,
    api_base: &str,
    api_key: Option<&str>,
    executor: &dyn AgentExecutor,
    completions: &[(String, bool, Option<String>)],
) -> Result<()> {
    let subscriptions: Vec<_> = pipes
        .iter()
        .filter(|(_, c)| c.enabled)
        .flat_map(|(name, c)| sources(c).into_iter().map(move |s| (name, s)))
        .collect();
    // Configuration/import cannot turn the cap into several smaller inference batches.
    if subscriptions.len() > LIMIT {
        return Err(anyhow!("semantic_trigger_limit"));
    }
    for (_, src) in &subscriptions {
        validate(src)?;
    }
    let active: Vec<_> = subscriptions
        .iter()
        .map(|(_, s)| s.filter["id"].clone())
        .collect();
    if active
        .iter()
        .collect::<std::collections::HashSet<_>>()
        .len()
        != active.len()
    {
        return Err(anyhow!("duplicate_semantic_trigger_id"));
    }
    state.definitions.retain(|id, _| active.contains(id));
    for (_, src) in &subscriptions {
        let id = &src.filter["id"];
        let condition = &src.filter["condition"];
        if state
            .definitions
            .get(id)
            .is_some_and(|old| old != condition)
        {
            state.matched.remove(id);
            state.pending.remove(id);
        }
        state.definitions.insert(id.clone(), condition.clone());
    }
    state.matched.retain(|id, _| active.contains(id));
    state.pending.retain(|id, _| active.contains(id));
    for (pipe, success, delivery_id) in completions {
        let id = state
            .pending
            .iter()
            .find(|(_, d)| &d.pipe == pipe && delivery_id.as_deref() == Some(d.id.as_str()))
            .map(|(id, _)| id.clone());
        if let Some(id) = id {
            if *success {
                state.pending.remove(&id);
            } else if let Some(d) = state.pending.get_mut(&id) {
                d.sent_at = 0;
            }
        }
    }
    let now = Utc::now().timestamp();
    if subscriptions.is_empty()
        && state.pending.is_empty()
        && state.matched.is_empty()
        && state.last_input.is_empty()
    {
        state.save(dir)?;
        return Ok(());
    }
    let mut retry = Vec::new();
    let mut abandoned = Vec::new();
    for (id, delivery) in &mut state.pending {
        let timeout = pipes
            .iter()
            .find(|(name, _)| name == &delivery.pipe)
            .and_then(|(_, c)| c.timeout)
            .unwrap_or(super::DEFAULT_TIMEOUT_SECS)
            .max(600) as i64;
        if now - delivery.sent_at >= timeout {
            if delivery.attempts >= 5 {
                abandoned.push(id.clone());
                continue;
            }
            delivery.attempts += 1;
            delivery.sent_at = now;
            retry.push(id.clone());
        }
    }
    for id in abandoned {
        state.pending.remove(&id);
        tracing::warn!(
            outcome = "delivery_abandoned",
            "semantic_trigger_delivery_failed"
        );
    }
    // Persist before publishing; a restart replays the same immutable delivery.
    state.save(dir)?;
    for id in retry {
        emit(&state.pending[&id])?;
    }
    if subscriptions.is_empty() {
        state.last_input.clear();
        return Ok(());
    }
    if executor.user_token().is_none() {
        return Err(anyhow!("semantic_sign_in_required"));
    }
    // Read through the existing bounded search/PII path, never the live DB.
    let since = (Utc::now() - ChronoDuration::seconds(30)).to_rfc3339();
    let filter_pii = pipes
        .iter()
        .any(|(_, c)| c.enabled && !sources(c).is_empty() && c.privacy_filter);
    let mut request = http.get(format!("{api_base}/search")).query(&[
        ("content_type", "ocr"),
        ("limit", "6"),
        ("start_time", since.as_str()),
        ("max_content_length", "4001"),
        ("include_cloud", "false"),
        ("filter_pii", if filter_pii { "true" } else { "false" }),
    ]);
    if let Some(key) = api_key {
        request = request.bearer_auth(key);
    }
    let response = request
        .send()
        .await
        .map_err(|_| anyhow!("semantic_capture_read_failed"))?;
    if !response.status().is_success() {
        return Err(anyhow!(
            "semantic_capture_http_{}",
            response.status().as_u16()
        ));
    }
    let response: Value = response
        .json()
        .await
        .map_err(|_| anyhow!("semantic_capture_invalid_response"))?;
    let rows = response
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("semantic_capture_invalid_response"))?;
    let mut by_trigger = serde_json::Map::new();
    for (name, src) in &subscriptions {
        let config = &pipes.iter().find(|(n, _)| n == *name).unwrap().1;
        let perms = super::permissions::PipePermissions::from_config(config);
        let allowed: Vec<_> = rows
            .iter()
            .rev()
            .filter_map(|row| row.get("content"))
            .filter(|row| {
                let captured_at = row
                    .get("timestamp")
                    .and_then(Value::as_str)
                    .and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok());
                if captured_at.is_none() && (perms.time_range.is_some() || perms.days.is_some()) {
                    return false;
                }
                let local = captured_at
                    .map(|v| v.with_timezone(&Local))
                    .unwrap_or_else(Local::now);
                perms.is_endpoint_allowed("GET", "/search")
                    && perms.is_item_allowed(
                        row.get("app_name").and_then(Value::as_str),
                        row.get("window_name").and_then(Value::as_str),
                        if row
                            .get("text_source")
                            .and_then(Value::as_str)
                            .is_some_and(|v| v.eq_ignore_ascii_case("accessibility"))
                        {
                            "accessibility"
                        } else {
                            "ocr"
                        },
                        local.hour(),
                        local.minute(),
                        local.weekday(),
                    )
            })
            .cloned()
            .collect();
        by_trigger.insert(src.filter["id"].clone(), observations(&allowed));
    }
    if by_trigger
        .values()
        .all(|v| v["current_records"].as_array().is_none_or(|r| r.is_empty()))
    {
        return Ok(());
    }
    let input = json!({"by_trigger":by_trigger});
    let conditions: serde_json::Map<String, Value> = subscriptions
        .iter()
        .map(|(_, s)| (s.filter["id"].clone(), json!(s.filter["condition"])))
        .collect();
    let fingerprint = serde_json::to_string(&json!([&input, &conditions]))?;
    if fingerprint == state.last_input {
        return Ok(());
    }
    // Establish a baseline when the watcher starts; don't launch on historical text.
    if state.last_input.is_empty() {
        state.last_input = fingerprint;
        return Ok(());
    }
    let result = cloud(
        http,
        executor,
        json!({"op":"evaluate", "conditions":conditions,"state":input}),
    )
    .await?;
    let answers = result
        .get("answers")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("semantic_invalid_response"))?;
    // Validate the whole batch before changing any trigger state.
    if !active.iter().all(|id| {
        matches!(
            answers
                .get(id)
                .and_then(|a| a.get("choice"))
                .and_then(Value::as_str),
            Some("supported" | "contradicted" | "unknown")
        )
    }) {
        return Err(anyhow!("semantic_invalid_response"));
    }
    let mut added = Vec::new();
    for (pipe, src) in subscriptions {
        let id = &src.filter["id"];
        if state.pending.contains_key(id) {
            continue;
        }
        let choice = if input["by_trigger"][id]["current_records"]
            .as_array()
            .is_none_or(|r| r.is_empty())
        {
            "unknown"
        } else {
            answers[id]["choice"].as_str().unwrap()
        };
        if state.classify(id, choice) {
            added.push(id.clone());
            state.pending.insert(id.clone(), Delivery {id:uuid::Uuid::new_v4().to_string(), pipe:pipe.clone(), source:src.clone(), context:json!({"app":"semantic","kind":"condition","condition":src.filter["condition"],"observations":input["by_trigger"][id],"decision":answers[id]}),attempts:1,sent_at:now});
        }
    }
    state.save(dir)?;
    for id in added {
        emit(&state.pending[&id])?;
    }
    state.last_input = fingerprint;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn semantic_edge_is_persistent_and_unknown_does_not_rearm() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = State::default();
        assert!(s.classify("one", "supported"));
        s.save(dir.path()).unwrap();
        let mut s = State::load(dir.path()).unwrap();
        assert!(!s.classify("one", "supported"));
        assert!(!s.classify("one", "unknown"));
        assert!(!s.classify("one", "supported"));
        assert!(!s.classify("one", "contradicted"));
        assert!(s.classify("one", "supported"));
    }
    #[test]
    fn observation_projection_preserves_flat_evidence_without_geometry() {
        let value = observations(&[
            json!({"frame_id":1,"text":"  Alice: proposed\r\nBob: not done  ","x":34,"width":500,"app_name":"Slack"}),
        ]);
        assert_eq!(
            value["current_records"][0],
            json!({"frame_id":1,"app_name":"Slack","text":"Alice: proposed\nBob: not done"})
        );
    }
}

#[cfg(test)]
mod integration_tests {
    use super::*;
    use crate::agents::pi::PiExecutor;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use wiremock::{
        matchers::{method, path},
        Mock, MockServer, ResponseTemplate,
    };
    fn config(id: &str) -> PipeConfig {
        super::super::parse_frontmatter(&format!("---\nschedule: manual\nenabled: true\ntrigger:\n  sources:\n    - app: semantic\n      kind: condition\n      filter:\n        id: {id}\n        condition: A customer reports an error\n---\nHelp the customer.\n")).unwrap().0
    }
    #[tokio::test]
    async fn semantic_three_pipes_share_one_request_and_survive_repeated_matches_restart_and_failure(
    ) {
        let local = MockServer::start().await;
        let provider = MockServer::start().await;
        let generation = Arc::new(AtomicUsize::new(1));
        let current = generation.clone();
        Mock::given(method("GET")).and(path("/search")).respond_with(move |_: &wiremock::Request| ResponseTemplate::new(200).set_body_json(json!({"data":[{"content":{"frame_id":current.load(Ordering::SeqCst),"timestamp":"2026-10-06T12:00:00Z","app_name":"Slack","text":"A customer reports an error"}}]}))).mount(&local).await;
        let fail = Arc::new(AtomicUsize::new(0));
        let failing = fail.clone();
        Mock::given(method("POST"))
            .and(path("/v1/semantic-triggers"))
            .respond_with(move |r: &wiremock::Request| {
                if failing.load(Ordering::SeqCst) == 1 {
                    return ResponseTemplate::new(503);
                }
                let body: Value = serde_json::from_slice(&r.body).unwrap();
                let answers: serde_json::Map<String, Value> = body["conditions"]
                    .as_object()
                    .unwrap()
                    .keys()
                    .map(|k| (k.clone(), json!({"choice":"supported"})))
                    .collect();
                ResponseTemplate::new(200).set_body_json(json!({"answers":answers}))
            })
            .mount(&provider)
            .await;
        let executor = PiExecutor::new(Some("fixture-token".into())).with_api_url(provider.uri());
        let http = reqwest::Client::new();
        let dir = tempfile::tempdir().unwrap();
        let mut state = State::default();
        let pipes = vec![
            ("one".into(), config("one")),
            ("two".into(), config("two")),
            ("three".into(), config("three")),
        ];
        let _events = screenpipe_events::subscribe_to_event::<Value>("connection_trigger");
        tick(
            dir.path(),
            &pipes,
            &mut state,
            &http,
            &local.uri(),
            Some("local-key"),
            &executor,
            &[],
        )
        .await
        .unwrap();
        assert!(
            provider.received_requests().await.unwrap().is_empty(),
            "baseline must not replay history"
        );
        generation.store(2, Ordering::SeqCst);
        tick(
            dir.path(),
            &pipes,
            &mut state,
            &http,
            &local.uri(),
            Some("local-key"),
            &executor,
            &[],
        )
        .await
        .unwrap();
        let calls = provider.received_requests().await.unwrap();
        assert_eq!(calls.len(), 1);
        let request: Value = serde_json::from_slice(&calls[0].body).unwrap();
        assert_eq!(request["conditions"].as_object().unwrap().len(), 3);
        assert_eq!(state.pending.len(), 3);
        let deliveries: HashMap<_, _> = state
            .pending
            .iter()
            .map(|(id, d)| (id.clone(), d.id.clone()))
            .collect();
        let mut restored = State::load(dir.path()).unwrap();
        tick(
            dir.path(),
            &pipes,
            &mut restored,
            &http,
            &local.uri(),
            None,
            &executor,
            &[],
        )
        .await
        .unwrap();
        assert_eq!(restored.pending.len(), 3);
        for (id, d) in &restored.pending {
            assert_eq!(d.id, deliveries[id]);
        }
        let completions: Vec<_> = restored
            .pending
            .values()
            .map(|d| (d.pipe.clone(), true, Some(d.id.clone())))
            .collect();
        generation.store(3, Ordering::SeqCst);
        tick(
            dir.path(),
            &pipes,
            &mut restored,
            &http,
            &local.uri(),
            None,
            &executor,
            &completions,
        )
        .await
        .unwrap();
        assert!(
            restored.pending.is_empty(),
            "held true must not launch again after completion"
        );
        generation.store(4, Ordering::SeqCst);
        fail.store(1, Ordering::SeqCst);
        assert!(tick(
            dir.path(),
            &pipes,
            &mut restored,
            &http,
            &local.uri(),
            None,
            &executor,
            &[]
        )
        .await
        .is_err());
        assert!(
            restored.matched.values().all(|v| *v),
            "provider failure must not become false or re-arm"
        );
        assert!(restored.pending.is_empty());
        let mut fourth = pipes.clone();
        fourth.push(("four".into(), config("four")));
        let before = provider.received_requests().await.unwrap().len();
        assert!(tick(
            dir.path(),
            &fourth,
            &mut restored,
            &http,
            &local.uri(),
            None,
            &executor,
            &[]
        )
        .await
        .unwrap_err()
        .to_string()
        .contains("semantic_trigger_limit"));
        assert_eq!(provider.received_requests().await.unwrap().len(), before);
    }
    #[tokio::test]
    async fn semantic_batch_filters_each_pipes_evidence_and_never_fires_without_allowed_records() {
        let local = MockServer::start().await;
        let provider = MockServer::start().await;
        Mock::given(method("GET")).and(path("/search")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"data":[
            {"content":{"text":"Customer is blocked", "app_name":"Slack", "timestamp":Utc::now().to_rfc3339()}},
            {"content":{"text":"private-secret", "app_name":"1Password", "timestamp":Utc::now().to_rfc3339()}}
        ]}))).mount(&local).await;
        Mock::given(method("POST")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"answers":{"allowed":{"choice":"supported"},"blocked":{"choice":"supported"}}}))).mount(&provider).await;
        let restrict = |app: &str| super::super::PipePermissionsConfig::Rules {
            allow: vec![format!("App({app})")],
            deny: vec![],
            time: None,
            days: None,
        };
        let mut allowed = config("allowed");
        allowed.permissions = restrict("Slack");
        let mut blocked = config("blocked");
        blocked.permissions = restrict("Mail");
        let pipes = vec![("allowed".into(), allowed), ("blocked".into(), blocked)];
        let executor = PiExecutor::new(Some("fixture-token".into())).with_api_url(provider.uri());
        let mut state = State::default();
        state.last_input = "previous-window".into();
        let dir = tempfile::tempdir().unwrap();
        let _events = screenpipe_events::subscribe_to_event::<Value>("connection_trigger");
        tick(
            dir.path(),
            &pipes,
            &mut state,
            &reqwest::Client::new(),
            &local.uri(),
            None,
            &executor,
            &[],
        )
        .await
        .unwrap();
        let calls = provider.received_requests().await.unwrap();
        assert_eq!(calls.len(), 1);
        let request: Value = serde_json::from_slice(&calls[0].body).unwrap();
        assert!(!request.to_string().contains("private-secret"));
        assert_eq!(
            request["state"]["by_trigger"]["blocked"]["current_records"],
            json!([])
        );
        assert_eq!(state.pending.len(), 1);
        assert!(state.pending.contains_key("allowed"));
        assert!(!state.pending["allowed"]
            .context
            .to_string()
            .contains("private-secret"));
    }

    #[test]
    fn semantic_limit_counts_other_pipes_and_disabled_conditions() {
        let dir = tempfile::tempdir().unwrap();
        for id in ["one", "two", "three"] {
            let path = dir.path().join(id);
            std::fs::create_dir(&path).unwrap();
            let mut c = config(id);
            c.enabled = false;
            std::fs::write(
                path.join("pipe.md"),
                super::super::serialize_pipe(&c, "Do work").unwrap(),
            )
            .unwrap();
        }
        let manager = super::super::PipeManager::new(dir.path().into(), HashMap::new(), None, 0);
        let candidate = super::super::serialize_pipe(&config("four"), "Do work").unwrap();
        assert!(manager
            .ensure_pipe_write_allowed("four", Some(&candidate))
            .unwrap_err()
            .to_string()
            .contains("semantic_trigger_limit"));
        let existing = std::fs::read_to_string(dir.path().join("one/pipe.md")).unwrap();
        manager
            .ensure_pipe_write_allowed("one", Some(&existing))
            .unwrap();
    }
}
