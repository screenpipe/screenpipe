// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! A narrow commit boundary for the existing scheduled-task harness. The agent
//! investigates and proposes changes; the engine verifies and persists them.
use super::{
    search::OptionalPipePerms,
    workflows::{read_catalog, workflow_id, WorkflowCatalogSource},
};
use crate::server::AppState;
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    Extension, Json,
};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use oasgen::{oasgen, OaSchema};
use screenpipe_core::workflows::*;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::HashSet, sync::Arc, time::Duration};

type ApiError = (StatusCode, Json<Value>);
pub(super) static WRITER: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
pub(super) fn error(status: StatusCode, message: &str) -> ApiError {
    (status, Json(json!({"error": message})))
}
pub(super) fn allowed(state: &AppState, perms: &OptionalPipePerms) -> Result<(), ApiError> {
    if state.history_access.is_restricted()
        || perms.0.as_ref().is_some_and(|p| {
            p.has_data_restrictions() || p.has_content_type_restrictions() || p.privacy_filter
        })
    {
        return Err(error(
            StatusCode::FORBIDDEN,
            "Workflow maintenance requires access to the catalog's source history.",
        ));
    }
    Ok(())
}

#[derive(Deserialize, OaSchema)]
pub(crate) struct RolloutRequest {
    enabled: bool,
}

#[oasgen]
pub(crate) async fn rollout(
    perms: OptionalPipePerms,
    Json(request): Json<RolloutRequest>,
) -> Result<Json<Value>, ApiError> {
    // Pipe capabilities cannot grant themselves rollout access. This route
    // shares the local API's owner authentication, without source-history reads.
    if perms.0.is_some() {
        return Err(error(
            StatusCode::FORBIDDEN,
            "Only the desktop can update workflow rollout access.",
        ));
    }
    screenpipe_core::workflows::pipeline::set_rollout_enabled(request.enabled);
    Ok(Json(json!({"enabled": request.enabled})))
}

#[oasgen]
pub(crate) async fn catalog(
    State(state): State<Arc<AppState>>,
    Extension(source): Extension<WorkflowCatalogSource>,
    perms: OptionalPipePerms,
) -> Result<Json<Value>, ApiError> {
    // The authenticated desktop owner keeps the derived catalog after a
    // downgrade. Scoped agent reads still enforce source-history restrictions.
    if perms.0.is_some() {
        allowed(&state, &perms)?;
    }
    let mut value = read_catalog(&source).await?;
    for workflow in value["analysis"]["workflows"]
        .as_array_mut()
        .into_iter()
        .flatten()
    {
        workflow["id"] = json!(workflow_id(workflow));
    }
    Ok(Json(value))
}

#[oasgen]
pub(crate) async fn context(
    State(state): State<Arc<AppState>>,
    Extension(source): Extension<WorkflowCatalogSource>,
    perms: OptionalPipePerms,
) -> Result<Json<Value>, ApiError> {
    allowed(&state, &perms)?;
    let value = read_catalog(&source).await?;
    let dir = source.0.as_ref().ok_or_else(|| {
        error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Workflow storage is unavailable.",
        )
    })?;
    let profile = match tokio::fs::read(dir.join("profile.json")).await {
        Ok(bytes) => Some(
            serde_json::from_slice::<Value>(&bytes)
                .map_err(|_| error(StatusCode::CONFLICT, "Saved Context is unreadable."))?,
        ),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => {
            return Err(error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Could not read Context.",
            ))
        }
    };
    let workflows: Vec<Value> = value["analysis"]["workflows"].as_array().into_iter().flatten().map(|w| json!({
        "id":workflow_id(w), "title":w["title"], "trigger":w["trigger"], "outcome":w["outcome"],
        "description":w["description"], "userCorrection":w["userCorrection"], "lastReviewedAt":w["lastReviewedAt"],
        "confidence":w["confidence"], "people":w["people"], "teams":w["teams"], "handoffs":w["handoffs"], "variations":w["variations"], "bottlenecks":w["bottlenecks"], "captureSequence":w["captureSequence"],
        "timingRuns":w["timing"]["runs"], "limitations":w["limitations"], "openQuestions":w["openQuestions"], "quality":w["quality"], "apps":w["apps"],
        "evidence":context_source_refs(&w["evidence"]),
        "stages":w["stages"].as_array().into_iter().flatten().map(|s| json!({"name":s["name"],"description":s["description"],"apps":s["apps"],"confidence":s["confidence"],"procedure":s["procedure"],"evidence":context_source_refs(&s["evidence"]),"openQuestions":s["openQuestions"]})).collect::<Vec<_>>()
    })).collect();
    Ok(Json(
        json!({"revision":value["revision"].as_u64().unwrap_or(0), "now":Utc::now().to_rfc3339(),
        "historyStart":(Utc::now()-ChronoDuration::days(90)).to_rfc3339(), "checkedThrough":value["checkedThrough"],
        "profile":work_profile_payload(profile.as_ref()), "workflows":workflows,
        "outputContract":include_str!("../../../screenpipe-core/assets/pipes/workflow-discovery/output.md")}),
    ))
}

// Keep source addresses available for targeted research without duplicating
// full captured documents or screenshot payloads in the context index.
fn context_source_refs(value: &Value) -> Vec<Value> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .map(|e| json!({"timestamp":e["timestamp"],"app":e["app"],"source":e["source"],"speaker":e["speaker"]}))
        .collect()
}

#[derive(Deserialize, OaSchema)]
pub struct CommitRequest {
    pub expected_revision: u64,
    pub checked_through: String,
    pub workflows: Vec<Value>,
    #[serde(default)]
    pub pipeline_revision: Option<u64>,
    #[serde(default)]
    pub workspace_revision: Option<u64>,
    #[serde(default)]
    pub draft_id: Option<String>,
}

/// Preserve identity and user-owned corrections. Absence from a partial scan
/// never removes an existing workflow. No semantic matching in infrastructure.
pub fn reconcile(mut previous: Value, updates: Vec<Value>, through: &str) -> Result<Value, String> {
    let old = previous["analysis"]["workflows"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let mut current: Vec<Value> = old
        .into_iter()
        .map(|mut w| {
            w["id"] = json!(workflow_id(&w));
            w
        })
        .collect();
    let mut seen = HashSet::new();
    let mut created = 0;
    let mut updated = 0;
    for mut w in updates {
        let supplied = w["id"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        if let Some(id) = supplied {
            if !seen.insert(id.clone()) {
                return Err("A workflow can only be updated once per commit.".into());
            }
            let prior = current
                .iter_mut()
                .find(|p| p["id"] == id)
                .ok_or("Unknown workflow ID. Read the current catalog before updating.")?;
            w["userCorrection"] = prior["userCorrection"].clone();
            super::workflow_edits::preserve_edits(prior, &mut w);
            w["revision"] = json!(prior["revision"].as_u64().unwrap_or(0) + 1);
            w["createdAt"] = prior["createdAt"].clone();
            w["lastReviewedAt"] = json!(through);
            w["catalogStatus"] = json!("current");
            *prior = w;
            updated += 1;
        } else {
            if let Some(fields) = w.as_object_mut() {
                fields.remove("userEdits");
                fields.remove("userEditedAt");
            }
            w["id"] = json!(format!("wf-{}", uuid::Uuid::new_v4()));
            w["revision"] = json!(1);
            w["createdAt"] = json!(through);
            w["lastReviewedAt"] = json!(through);
            w["catalogStatus"] = json!("current");
            current.push(w);
            created += 1;
        }
    }
    for (i, w) in current.iter_mut().enumerate() {
        w["rank"] = json!(i + 1);
    }
    previous["schemaVersion"] = json!(5);
    previous["revision"] = json!(previous["revision"].as_u64().unwrap_or(0) + 1);
    previous["checkedThrough"] = json!(through);
    previous["analyzedAt"] = json!(through);
    previous["days"] = json!(90);
    if previous["source"].is_null() {
        previous["source"] = json!("screenpipe");
    }
    if previous["bundleCount"].is_null() {
        previous["bundleCount"] = json!(0);
    }
    if previous["observedActiveMinutes"].is_null() {
        previous["observedActiveMinutes"] = json!(0);
    }
    previous["analysis"] = json!({"workflows":current});
    previous["changes"] = json!({"created":created,"updated":updated});
    Ok(previous)
}

pub(super) async fn persist(
    source: &WorkflowCatalogSource,
    previous: &Value,
    next: &Value,
) -> Result<(), ApiError> {
    let dir = source.0.clone().ok_or_else(|| {
        error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Workflow storage is unavailable.",
        )
    })?;
    let before = serde_json::to_vec(previous).unwrap();
    let after = serde_json::to_vec(next).unwrap();
    tokio::task::spawn_blocking(move || {
        let _lock = crate::atomic_file::lock(&dir.join("catalog.lock"))?;
        crate::atomic_file::replace(&dir.join("catalog.backup.json"), &before)?;
        crate::atomic_file::replace(&dir.join("catalog.json"), &after)
    })
    .await
    .map_err(|_| {
        error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Could not save workflows.",
        )
    })?
    .map_err(|_| {
        error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Could not save workflows. Previous catalog kept.",
        )
    })
}

#[oasgen]
pub(crate) async fn commit(
    State(state): State<Arc<AppState>>,
    Extension(source): Extension<WorkflowCatalogSource>,
    perms: OptionalPipePerms,
    headers: HeaderMap,
    Json(body): Json<CommitRequest>,
) -> Result<Json<Value>, ApiError> {
    allowed(&state, &perms)?;
    if perms
        .0
        .as_ref()
        .is_some_and(|p| workspace::is_task(&p.pipe_name))
        && body.workspace_revision.is_none()
    {
        return Err(error(
            StatusCode::FORBIDDEN,
            "Publish through the workflow workspace.",
        ));
    }
    if perms
        .0
        .as_ref()
        .is_some_and(|p| p.pipe_name == "workflow-discovery")
        && body.pipeline_revision.is_none()
    {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "Final review requires its upstream pipeline revision.",
        ));
    }

    if body.workspace_revision.is_some()
        && perms
            .0
            .as_ref()
            .is_some_and(|p| p.pipe_name != "workflow-review")
    {
        return Err(error(
            StatusCode::FORBIDDEN,
            "Only Review can publish workspace drafts.",
        ));
    }
    let through = DateTime::parse_from_rfc3339(&body.checked_through)
        .map_err(|_| error(StatusCode::BAD_REQUEST, "Invalid checkpoint."))?
        .with_timezone(&Utc);
    let now = Utc::now();
    if through > now || through < now - ChronoDuration::days(90) || body.workflows.len() > 30 {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "Invalid workflow update range or size.",
        ));
    }
    let previous = read_catalog(&source).await?;
    if let Some(rev) = body.workspace_revision {
        let ws = workspace::state(&previous);
        workspace::check_publish(&ws, rev, body.draft_id.as_deref())
            .map_err(|e| error(StatusCode::CONFLICT, &e))?;
        if let Some(id) = body.draft_id.as_deref() {
            if ws["drafts"][id]["status"] == "published" {
                workspace::publication_payload(&ws, id, body.workflows.first())
                    .map_err(|e| error(StatusCode::CONFLICT, &e))?;
                return Ok(Json(ws["drafts"][id]["receipt"].clone()));
            }
            if body.workflows.len() != 1 {
                return Err(error(
                    StatusCode::CONFLICT,
                    "Publish exactly one reviewed workflow for the owned draft.",
                ));
            }
        } else if !body.workflows.is_empty() {
            return Err(error(
                StatusCode::CONFLICT,
                "Finish cannot introduce unreviewed changes.",
            ));
        }
        if ws["cycle"]["end"] != body.checked_through {
            return Err(error(
                StatusCode::CONFLICT,
                "Preserve the requested update boundary.",
            ));
        }
    }
    if previous["revision"].as_u64().unwrap_or(0) != body.expected_revision {
        return Err(error(
            StatusCode::CONFLICT,
            "Catalog changed. Read it again before proposing updates.",
        ));
    }
    if previous["checkedThrough"]
        .as_str()
        .and_then(|v| DateTime::parse_from_rfc3339(v).ok())
        .is_some_and(|v| v > through)
    {
        return Err(error(
            StatusCode::CONFLICT,
            "Checkpoint cannot move backwards.",
        ));
    }
    let pm = state.pipe_manager.as_ref().ok_or_else(|| {
        error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Scheduled tasks are unavailable.",
        )
    })?;
    let port = pm.lock().await.api_port();
    let token = headers
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .ok_or_else(|| {
            error(
                StatusCode::UNAUTHORIZED,
                "Recorder authentication is required.",
            )
        })?;
    let endpoint = RecorderEndpoint {
        source: "screenpipe",
        base_url: format!("http://127.0.0.1:{port}"),
        api_key: Some(token.to_owned()),
        health: Value::Null,
    };
    let raw = json!({"evidenceVersion":2,"workflows":body.workflows});
    let bounds = vec![
        json!({"start":(through-ChronoDuration::days(90)).to_rfc3339(),"end":through.to_rfc3339()}),
    ];
    let (evidence, reads) = tokio::time::timeout(
        Duration::from_secs(120),
        evidence::resolve_references(&endpoint, &raw, EvidenceCatalog::default(), &bounds),
    )
    .await
    .map_err(|_| {
        error(
            StatusCode::GATEWAY_TIMEOUT,
            "Source verification timed out.",
        )
    })?
    .map_err(|e| error(StatusCode::UNPROCESSABLE_ENTITY, &e))?;
    let mut normalized = normalize_updates(raw.clone(), &evidence)
        .map_err(|e| error(StatusCode::UNPROCESSABLE_ENTITY, &e))?;
    if body.workspace_revision.is_some() {
        workspace::validate_publication(&raw, &normalized)
            .map_err(|e| error(StatusCode::UNPROCESSABLE_ENTITY, &e))?;
    }
    let updates = normalized["workflows"].as_array_mut().unwrap();
    if updates.len() != body.workflows.len()
        || updates.iter().any(|w| {
            !w["stages"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|s| s["procedure"].as_array().is_some_and(|p| !p.is_empty()))
        })
    {
        return Err(error(StatusCode::UNPROCESSABLE_ENTITY,"Only save useful steps supported by source quotes. Investigate further or leave the catalog unchanged."));
    }
    // The agent inspects images with the normal harness tools. Independently
    // enforce exact source/frame identity here; never guess a nearby frame.
    for w in updates.iter_mut() {
        if let Some(proposed) = body.workflows.iter().find(|p| p["title"] == w["title"]) {
            for stage in w["stages"].as_array_mut().into_iter().flatten() {
                let frame = proposed["stages"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .find(|s| s["name"] == stage["name"])
                    .and_then(|s| s["screenshotFrameId"].as_i64());
                if let Some(id) = frame.filter(|n| *n > 0) {
                    if let Some((timestamp, app)) = evidence.frames.get(&id) {
                        let matches = stage["evidence"].as_array().into_iter().flatten().any(|e| {
                            e["app"]
                                .as_str()
                                .is_some_and(|a| a.eq_ignore_ascii_case(app))
                                && e["timestamp"]
                                    .as_str()
                                    .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                                    .is_some_and(|at| at == *timestamp)
                        });
                        if matches {
                            let response = apply_auth(&endpoint,reqwest::Client::new().get(format!("{}/frames/{id}/thumbnail?width=640&quality=68&fallback=false",endpoint.base_url)).timeout(Duration::from_secs(10))).send().await;
                            if let Ok(response) = response {
                                if response.status().is_success() {
                                    if let Ok(bytes) = response.bytes().await {
                                        if !bytes.is_empty() && bytes.len() <= 500_000 {
                                            use base64::Engine;
                                            stage["screenshot"] = json!({"frameId":id,"timestamp":timestamp.to_rfc3339(),"app":app,"matchDistanceSeconds":0,"visualVerified":true,"dataUrl":format!("data:image/jpeg;base64,{}",base64::engine::general_purpose::STANDARD.encode(bytes))});
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    attach_screenshot_quality(&mut normalized);
    // Validate outside the writer so human edits stay responsive. Recheck the
    // revision under the writer immediately before committing.
    let _guard = WRITER.lock().await;
    let previous = read_catalog(&source).await?;
    if let Some(rev) = body.workspace_revision {
        let ws = workspace::state(&previous);
        workspace::check_publish(&ws, rev, body.draft_id.as_deref())
            .map_err(|e| error(StatusCode::CONFLICT, &e))?;
        if let Some(id) = body.draft_id.as_deref() {
            if ws["drafts"][id]["status"] == "published" {
                workspace::publication_payload(&ws, id, body.workflows.first())
                    .map_err(|e| error(StatusCode::CONFLICT, &e))?;
                return Ok(Json(ws["drafts"][id]["receipt"].clone()));
            }
            if body.workflows.len() != 1 {
                return Err(error(
                    StatusCode::CONFLICT,
                    "Publish exactly one reviewed workflow for the owned draft.",
                ));
            }
        } else if !body.workflows.is_empty() {
            return Err(error(
                StatusCode::CONFLICT,
                "Finish cannot introduce unreviewed changes.",
            ));
        }
        if ws["cycle"]["end"] != body.checked_through {
            return Err(error(
                StatusCode::CONFLICT,
                "Preserve the requested update boundary.",
            ));
        }
    }
    if previous["revision"].as_u64().unwrap_or(0) != body.expected_revision {
        return Err(error(
            StatusCode::CONFLICT,
            "Catalog changed. Read it again before proposing updates.",
        ));
    }
    if token.starts_with("sp_pipe_") && !state.pipe_permissions.contains_key(token) {
        return Err(error(
            StatusCode::CONFLICT,
            "Workflow task stopped before saving.",
        ));
    }
    if let Some(revision) = body.pipeline_revision {
        let pipeline = super::workflow_pipeline::read(&source).await?;
        let input = &pipeline["stages"]["workflow-timing"];
        if input["revision"] != revision || input["checkedThrough"] != body.checked_through {
            return Err(error(
                StatusCode::CONFLICT,
                "Enrichment changed. Review the latest result before publishing.",
            ));
        }
    }
    let mut next = reconcile(
        previous.clone(),
        normalized["workflows"].as_array().unwrap().clone(),
        &body.checked_through,
    )
    .map_err(|e| error(StatusCode::UNPROCESSABLE_ENTITY, &e))?;
    if let Some(revision) = body.pipeline_revision {
        next["pipelineRevision"] = json!(revision);
        next["needsWorkflowReview"] = json!(false);
        next["analyzedAt"] = json!(Utc::now().to_rfc3339());
    }
    next["quality"] = analysis_quality(&[], 90, &next["analysis"]);
    next["diagnostics"] = json!({"sourceReads":reads,"executor":"scheduled-task"});
    if body.workspace_revision.is_some() {
        let mut ws = workspace::state(&previous);
        if body.draft_id.is_some() {
            // A single reviewed draft does not claim the whole requested period is done.
            next["checkedThrough"] = previous["checkedThrough"].clone();
        }
        let receipt = json!({"revision":next["revision"],"changes":next["changes"],"checkedThrough":next["checkedThrough"]});
        workspace::published(
            &mut ws,
            body.draft_id.as_deref(),
            body.workflows.first(),
            &receipt,
        );
        if body.draft_id.is_none() {
            next["changes"] = ws["cycle"]["changes"].clone();
            next["needsWorkflowReview"] = json!(false);
        }
        next["analyzedAt"] = json!(Utc::now().to_rfc3339());
        next["agentWorkspace"] = ws;
    }
    persist(&source, &previous, &next).await?;
    if body.workspace_revision.is_some() {
        super::workflow_workspace::notify_ready(&next["agentWorkspace"], "workflow-review");
    }
    Ok(Json(
        json!({"revision":next["revision"],"changes":next["changes"],"checkedThrough":next["checkedThrough"]}),
    ))
}

// A catalog commit is incremental. An explicit empty proposal records a
// successful investigation; full-analysis normalization still rejects empty or
// unsupported generated catalogs everywhere else.
fn normalize_updates(raw: Value, evidence: &EvidenceCatalog) -> Result<Value, String> {
    if raw["workflows"].as_array().is_some_and(Vec::is_empty) {
        return Ok(raw);
    }
    normalize_analysis(raw, 90, evidence)
}

#[derive(Deserialize, OaSchema)]
pub struct CorrectionRequest {
    pub id: String,
    pub correction: Value,
    pub expected_revision: Option<u64>,
    pub changes: Option<Value>,
}
fn apply_feedback(workflow: &mut Value, body: &CorrectionRequest) -> Result<(), ApiError> {
    if let Some(changes) = &body.changes {
        if body.expected_revision != Some(workflow["revision"].as_u64().unwrap_or(0)) {
            return Err(error(
                StatusCode::CONFLICT,
                "Workflow changed. Retry feedback against the latest version.",
            ));
        }
        let fields = changes
            .as_object()
            .ok_or_else(|| error(StatusCode::BAD_REQUEST, "Invalid workflow changes."))?;
        if fields.iter().any(|(key, value)| {
            !["title", "description", "trigger", "outcome"].contains(&key.as_str())
                || !value
                    .as_str()
                    .is_some_and(|s| !s.trim().is_empty() && s.len() <= 8000)
        }) {
            return Err(error(
                StatusCode::BAD_REQUEST,
                "Only small descriptive workflow corrections are allowed.",
            ));
        }
        if fields.keys().any(|key| workflow["userEdits"].get(key).is_some()) {
            return Err(error(StatusCode::CONFLICT, "This field was manually edited. Use Edit workflow to change it."));
        }
        for (key, value) in fields {
            workflow[key] = value.clone();
        }
    }
    workflow["userCorrection"] = body.correction.clone();
    workflow["revision"] = json!(workflow["revision"].as_u64().unwrap_or(0) + 1);
    Ok(())
}

#[oasgen]
pub(crate) async fn correct(
    State(state): State<Arc<AppState>>,
    Extension(source): Extension<WorkflowCatalogSource>,
    perms: OptionalPipePerms,
    Json(body): Json<CorrectionRequest>,
) -> Result<Json<Value>, ApiError> {
    allowed(&state, &perms)?;
    if !body.correction.is_null()
        && !body
            .correction
            .as_str()
            .is_some_and(|text| text.len() <= 20_000)
    {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "Correction must be text of at most 20,000 bytes.",
        ));
    }
    let _guard = WRITER.lock().await;
    let before = read_catalog(&source).await?;
    let mut next = before.clone();
    let workflow = next["analysis"]["workflows"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|w| workflow_id(w) == body.id)
        .ok_or_else(|| error(StatusCode::NOT_FOUND, "Workflow was not found."))?;
    workflow["id"] = json!(body.id);
    apply_feedback(workflow, &body)?;
    let updated_workflow = workflow.clone();
    next["needsWorkflowReview"] = json!(true);
    if matches!(
        next["agentWorkspace"]["cycle"]["status"].as_str(),
        Some("running" | "paused")
    ) {
        next["agentWorkspace"]["cycle"]["finished"]["workflow-maintain"] = json!(false);
        let revision = workspace::revision(&next["agentWorkspace"]) + 1;
        next["agentWorkspace"]["revision"] = json!(revision);
    }
    next["revision"] = json!(before["revision"].as_u64().unwrap_or(0) + 1);
    persist(&source, &before, &next).await?;
    if next["agentWorkspace"]["cycle"]["status"] == "running" {
        super::workflow_workspace::notify_ready(&next["agentWorkspace"], "desktop");
    }
    Ok(Json(json!({"success":true,"workflow":updated_workflow})))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn context_preserves_source_addresses_without_capture_payloads() {
        let refs = context_source_refs(&json!([{
            "timestamp":"2026-09-19T10:00:00Z", "app":"Notes",
            "source":"screen", "speaker":null,
            "detail":"A long private document", "screenshot":"base64-image"
        }]));
        assert_eq!(
            refs,
            vec![json!({
                "timestamp":"2026-09-19T10:00:00Z", "app":"Notes",
                "source":"screen", "speaker":null
            })]
        );
        assert!(context_source_refs(&Value::Null).is_empty());
    }

    #[tokio::test]
    async fn pipe_cannot_grant_itself_rollout_access() {
        use screenpipe_core::pipes::permissions::PipePermissions;
        let perms = PipePermissions {
            pipe_name: "workflow-activity".into(),
            allow_rules: vec![],
            deny_rules: vec![],
            use_default_allowlist: true,
            time_range: None,
            days: None,
            pipe_token: None,
            pipe_dir: None,
            privacy_filter: false,
        };
        let result = rollout(
            OptionalPipePerms(Some(Arc::new(perms))),
            Json(RolloutRequest { enabled: true }),
        )
        .await;
        assert_eq!(result.unwrap_err().0, StatusCode::FORBIDDEN);
    }

    #[test]
    fn feedback_refinement_is_scoped_and_revision_checked() {
        let original = json!({"id":"wf-a","revision":2,"description":"Old","timing":{"average":10},"stages":[{"name":"Recorded"}]});
        let mut workflow = original.clone();
        let mut request = CorrectionRequest {
            id: "wf-a".into(),
            correction: json!("User feedback: CRM is reference only."),
            expected_revision: Some(1),
            changes: Some(json!({"description":"Corrected"})),
        };
        assert!(apply_feedback(&mut workflow, &request).is_err());
        assert_eq!(workflow, original);
        request.expected_revision = Some(2);
        request.changes = Some(json!({"description":"Corrected", "timing":null}));
        assert!(apply_feedback(&mut workflow, &request).is_err());
        assert_eq!(workflow, original);
        request.changes = Some(json!({"description":"Corrected"}));
        apply_feedback(&mut workflow, &request).unwrap();
        assert_eq!(workflow["description"], "Corrected");
        assert_eq!(workflow["revision"], 3);
        assert_eq!(workflow["timing"], original["timing"]);
        assert_eq!(workflow["stages"], original["stages"]);
        assert_eq!(workflow["userCorrection"], request.correction);
    }

    #[test]
    fn empty_commit_checkpoints_without_replacing_saved_workflows() {
        let old = json!({"revision":4,"analysis":{"workflows":[{"id":"wf-a","title":"Original","userCorrection":"Keep this","rank":1}]},"changes":{"created":0,"updated":2}});
        let normalized = normalize_updates(
            json!({"evidenceVersion":2,"workflows":[]}),
            &EvidenceCatalog::default(),
        )
        .unwrap();
        let result = reconcile(
            old.clone(),
            normalized["workflows"].as_array().unwrap().clone(),
            "2026-09-15T00:00:00Z",
        )
        .unwrap();
        assert_eq!(
            result["analysis"]["workflows"],
            old["analysis"]["workflows"]
        );
        assert_eq!(result["checkedThrough"], "2026-09-15T00:00:00Z");
        assert_eq!(result["revision"], 5);
        assert_eq!(result["changes"], json!({"created":0,"updated":0}));
        assert!(normalize_updates(
            json!({"workflows":[{"title":"Unsupported claim"}]}),
            &EvidenceCatalog::default()
        )
        .is_err());
        assert!(
            normalize_analysis(json!({"workflows":[]}), 90, &EvidenceCatalog::default()).is_err()
        );
    }
    #[test]
    fn updates_preserve_identity_corrections_and_unmentioned_workflows() {
        let old = json!({"revision":4,"analysis":{"workflows":[{"id":"wf-a","title":"Old title","userCorrection":{"notes":"Keep this"}},{"id":"wf-b","title":"Other"}]}});
        let result = reconcile(
            old,
            vec![json!({"id":"wf-a","title":"Better title"})],
            "2026-09-15T00:00:00Z",
        )
        .unwrap();
        assert_eq!(result["analysis"]["workflows"][0]["id"], "wf-a");
        assert_eq!(
            result["analysis"]["workflows"][0]["userCorrection"]["notes"],
            "Keep this"
        );
        assert_eq!(result["analysis"]["workflows"].as_array().unwrap().len(), 2);
        assert_eq!(result["revision"], 5);
        assert_eq!(result["changes"], json!({"created":0,"updated":1}));
    }
    #[test]
    fn invalid_identity_cannot_create_an_alias_and_empty_update_keeps_catalog() {
        let old = json!({"analysis":{"workflows":[{"id":"wf-a","title":"Original"}]}});
        assert!(reconcile(old.clone(), vec![json!({"id":"wf-missing"})], "now").is_err());
        let result = reconcile(old, vec![], "now").unwrap();
        assert_eq!(result["analysis"]["workflows"].as_array().unwrap().len(), 1);
        assert_eq!(result["changes"], json!({"created":0,"updated":0}));
    }
}
