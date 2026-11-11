// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use super::{
    search::OptionalPipePerms,
    workflows::{read_catalog, WorkflowCatalogSource},
};
use crate::server::AppState;
use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    Extension, Json,
};
use oasgen::oasgen;
use screenpipe_core::workflows::workspace;
use serde_json::{json, Value};
use std::sync::Arc;
type ApiError = (StatusCode, Json<Value>);

// Handoffs reuse the normal Pipe event scheduler. Idle pipe completions must not
// trigger one another or create an endless all-to-all completion loop.
pub(super) fn notify_ready(ws: &Value, sender: &str) {
    for task in workspace::TASKS {
        if task != sender && workspace::ready(ws, task) {
            let _ = screenpipe_events::send_event(
                "workflow_event",
                json!({
                    "event_type":format!("workflow_ready:{task}"),
                    "event_id":format!("{}:{}:{task}",ws["cycle"]["id"],workspace::revision(ws)),
                    "workspace_revision":workspace::revision(ws)
                }),
            );
        }
    }
}
fn error(status: StatusCode, message: &str) -> ApiError {
    (status, Json(json!({"error":message})))
}

#[oasgen]
pub(crate) async fn context(
    State(state): State<Arc<AppState>>,
    Extension(source): Extension<WorkflowCatalogSource>,
    perms: OptionalPipePerms,
    Query(query): Query<super::workflow_pipeline::StageQuery>,
) -> Result<Json<Value>, ApiError> {
    super::workflow_catalog::allowed(&state, &perms)?;
    if perms.0.as_ref().is_some_and(|p| p.pipe_name != query.task)
        || !workspace::is_task(&query.task)
    {
        return Err(error(
            StatusCode::FORBIDDEN,
            "Read context as your assigned workflow agent.",
        ));
    }
    let catalog = read_catalog(&source).await?;
    let ws = workspace::state(&catalog);
    Ok(Json(
        json!({"task":query.task,"ready":workspace::ready(&ws,&query.task),"canFinish":workspace::can_finish(&ws),"workspace":ws,"starredSources":workspace::starred_queue(&ws, &super::starred::stamp(chrono::Utc::now())),
        "catalogRevision":catalog["revision"].as_u64().unwrap_or(0),
        "receiptRevision":ws["receipts"][&query.task]["revision"].as_u64().unwrap_or(0)}),
    ))
}

#[oasgen]
pub(crate) async fn update(
    State(state): State<Arc<AppState>>,
    Extension(source): Extension<WorkflowCatalogSource>,
    perms: OptionalPipePerms,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    super::workflow_catalog::allowed(&state, &perms)?;
    let task = body["task"]
        .as_str()
        .filter(|t| workspace::is_task(t))
        .ok_or_else(|| error(StatusCode::BAD_REQUEST, "Unknown workflow agent."))?;
    if perms.0.as_ref().is_some_and(|p| p.pipe_name != task) {
        return Err(error(StatusCode::FORBIDDEN, "Use your own agent identity."));
    }
    let action = body["action"].as_str().unwrap_or_default();
    if action == "publish" || (action == "finish" && task == workspace::TASKS[2]) {
        if task != workspace::TASKS[2] {
            return Err(error(
                StatusCode::FORBIDDEN,
                "Only Review can publish workflows.",
            ));
        }
        if body["note"].as_str().is_none_or(|s| s.trim().is_empty()) {
            return Err(error(
                StatusCode::BAD_REQUEST,
                "Explain the review decision.",
            ));
        }
        let catalog = read_catalog(&source).await?;
        let ws = workspace::state(&catalog);
        let mut rev = body["expected_revision"].as_u64().ok_or_else(|| {
            error(
                StatusCode::BAD_REQUEST,
                "Read the current workspace revision.",
            )
        })?;
        let id = if action == "publish" {
            Some(
                body["draft_id"]
                    .as_str()
                    .ok_or_else(|| error(StatusCode::BAD_REQUEST, "draft_id is required."))?,
            )
        } else {
            None
        };
        workspace::check_publish(&ws, rev, id).map_err(|e| error(StatusCode::CONFLICT, &e))?;
        let workflows = if let Some(id) = id {
            vec![workspace::publication_payload(&ws, id, body.get("payload"))
                .map_err(|e| error(StatusCode::BAD_REQUEST, &e))?]
        } else {
            Vec::new()
        };
        if let Some(id) = id {
            if ws["drafts"][id]["status"] == "published" {
                return Ok(Json(ws["drafts"][id]["receipt"].clone()));
            }
        }
        let through = ws["cycle"]["end"]
            .as_str()
            .ok_or_else(|| error(StatusCode::CONFLICT, "Start an update first."))?;
        let catalog_revision = body["catalog_revision"].as_u64().ok_or_else(|| {
            error(
                StatusCode::BAD_REQUEST,
                "Read the current catalog revision.",
            )
        })?;
        let draft_version = id.and_then(|id| ws["drafts"][id]["version"].as_u64());
        if let (Some(id), Some(version)) = (id, draft_version) {
            let _guard = super::workflow_catalog::WRITER.lock().await;
            let previous = read_catalog(&source).await?;
            let mut current = workspace::state(&previous);
            workspace::check_publish(&current, rev, Some(id))
                .map_err(|e| error(StatusCode::CONFLICT, &e))?;
            if previous["revision"].as_u64().unwrap_or(0) != catalog_revision {
                return Err(error(
                    StatusCode::CONFLICT,
                    "Catalog changed. Read context again.",
                ));
            }
            if headers
                .get("authorization")
                .and_then(|h| h.to_str().ok())
                .and_then(|h| h.strip_prefix("Bearer "))
                .is_some_and(|token| {
                    token.starts_with("sp_pipe_") && !state.pipe_permissions.contains_key(token)
                })
            {
                return Err(error(
                    StatusCode::CONFLICT,
                    "Task stopped before publication.",
                ));
            }
            // Persist before verification: a client disconnect, task cancellation,
            // or outer request timeout may never reach the error handler below.
            if workspace::set_publication_retry(&mut current, version, id, true) {
                rev = workspace::revision(&current);
                let mut next = previous.clone();
                next["agentWorkspace"] = current;
                super::workflow_catalog::persist(&source, &previous, &next).await?;
            }
        }
        let result = super::workflow_catalog::commit(
            State(state.clone()),
            Extension(source.clone()),
            perms,
            headers.clone(),
            Json(super::workflow_catalog::CommitRequest {
                expected_revision: catalog_revision,
                checked_through: through.into(),
                workflows,
                pipeline_revision: None,
                workspace_revision: Some(rev),
                draft_id: id.map(str::to_owned),
            }),
        )
        .await;
        if let (Some(id), Some(version), Err((status, _))) = (id, draft_version, &result) {
            if status.is_server_error() || *status == StatusCode::UNPROCESSABLE_ENTITY {
                let _guard = super::workflow_catalog::WRITER.lock().await;
                // A late failure must not overwrite another edit or undo Stop.
                let stopped = headers
                    .get("authorization")
                    .and_then(|h| h.to_str().ok())
                    .and_then(|h| h.strip_prefix("Bearer "))
                    .is_some_and(|token| {
                        token.starts_with("sp_pipe_") && !state.pipe_permissions.contains_key(token)
                    });
                let previous = read_catalog(&source).await?;
                let mut ws = workspace::state(&previous);
                if !stopped
                    && workspace::set_publication_retry(
                        &mut ws,
                        version,
                        id,
                        status.is_server_error(),
                    )
                {
                    let mut next = previous.clone();
                    next["agentWorkspace"] = ws;
                    super::workflow_catalog::persist(&source, &previous, &next).await?;
                }
            }
        }
        return result;
    }
    let _guard = super::workflow_catalog::WRITER.lock().await;
    if headers
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .is_some_and(|token| {
            token.starts_with("sp_pipe_") && !state.pipe_permissions.contains_key(token)
        })
    {
        return Err(error(StatusCode::CONFLICT, "Task stopped before saving."));
    }
    let previous = read_catalog(&source).await?;
    let mut ws = workspace::state(&previous);
    let mut source_decisions = previous
        .get("starredDiscoveryDecisions")
        .cloned()
        .unwrap_or_else(|| json!({}));
    workspace::archive_starred(&mut ws, &mut source_decisions);
    let receipt = if action == "pause" {
        // A model may finish its own work, but only the owner can stop the group.
        if perms.0.is_some() {
            return Err(error(
                StatusCode::FORBIDDEN,
                "Only the owner can stop workflow updates.",
            ));
        }
        workspace::pause(&mut ws);
        json!({"revision":workspace::revision(&ws),"cycle":ws["cycle"]})
    } else if action == "start" {
        if task != workspace::TASKS[0] {
            return Err(error(
                StatusCode::FORBIDDEN,
                "Discover starts or resumes updates.",
            ));
        }
        if perms.0.is_some() && ws["cycle"]["status"] == "paused" && !workspace::ready(&ws, task) {
            return Err(error(
                StatusCode::CONFLICT,
                "This update was stopped. Resume from Workflows or wait for the next daily update.",
            ));
        }
        if !ws["starredIntake"].is_object() {
            ws["starredIntake"] = json!({"sources":{}});
        }
        for (id, source) in source_decisions
            .as_object()
            .into_iter()
            .flat_map(|s| s.iter())
        {
            if ws["starredIntake"]["sources"][id].is_null() {
                ws["starredIntake"]["sources"][id] = source.clone();
            }
        }
        workspace::archive_starred(&mut ws, &mut source_decisions);
        workspace::start(&mut ws, &previous);
        let after = ws["starredIntake"]["after"].as_i64().unwrap_or(0);
        let pending: Vec<_> = ws["starredIntake"]["sources"]
            .as_object()
            .into_iter()
            .flat_map(|s| s.values())
            .filter(|s| s["revision"] != s["processedRevision"])
            .filter_map(|s| s["id"].as_str())
            .map(str::to_owned)
            .collect();
        match state
            .db
            .starred_sessions_for_discovery(after, &json!(pending).to_string(), 100)
            .await
        {
            Ok(rows) => {
                ws["starredIntake"].as_object_mut().unwrap().remove("error");
                // A missing source was deleted or expired. Do not investigate stale metadata.
                for id in &pending {
                    if !rows.iter().any(|s| &s.id == id) {
                        ws["starredIntake"]["sources"]
                            .as_object_mut()
                            .unwrap()
                            .remove(id);
                        source_decisions.as_object_mut().unwrap().remove(id);
                    }
                }
                // Restore prior source ownership/decisions when an edited source returns,
                // including the other intervals of the same Capture demonstration.
                for source in source_decisions
                    .as_object()
                    .into_iter()
                    .flat_map(|s| s.values())
                {
                    if rows.iter().any(|row| {
                        source["id"] == row.id
                            || row
                                .recording_id
                                .as_ref()
                                .is_some_and(|g| source["recording_id"] == *g)
                    }) {
                        let id = source["id"].as_str().unwrap();
                        if ws["starredIntake"]["sources"][id].is_null() {
                            if !ws["starredIntake"].is_object() {
                                ws["starredIntake"] = json!({"sources":{}});
                            }
                            ws["starredIntake"]["sources"][id] = source.clone();
                        }
                    }
                }
                let has_more = rows.iter().filter(|s| s.sequence > after).count() == 100;
                let rows: Vec<_> = rows
                    .into_iter()
                    .map(|s| serde_json::to_value(s).expect("starred source serializes"))
                    .collect();
                workspace::intake_starred(
                    &mut ws,
                    &rows,
                    has_more,
                    &super::starred::stamp(chrono::Utc::now()),
                    state
                        .history_access
                        .cutoff(chrono::Utc::now())
                        .map(super::starred::stamp)
                        .as_deref(),
                );
            }
            Err(e) => {
                tracing::warn!(error=%e, "optional starred intake unavailable; preserving discovery cursor");
                ws["revision"] = json!(workspace::revision(&ws) + 1);
                ws["starredIntake"]["error"] = json!({"message":"Starred intake unavailable. Pending sources and cursor are kept; background research may continue.","checkedAt":super::starred::stamp(chrono::Utc::now())});
            }
        }
        json!({"revision":workspace::revision(&ws),"cycle":ws["cycle"]})
    } else {
        let change = serde_json::from_value(body.clone())
            .map_err(|_| error(StatusCode::BAD_REQUEST, "Invalid workspace change."))?;
        workspace::apply(&mut ws, task, &change).map_err(|e| error(StatusCode::CONFLICT, &e))?
    };
    workspace::project_starred(
        &mut ws,
        &mut source_decisions,
        &super::starred::stamp(chrono::Utc::now()),
    );
    if serde_json::to_vec(&ws).map_or(true, |data| data.len() > 2_000_000) {
        return Err(error(
            StatusCode::CONFLICT,
            "Workspace is full. Resolve current drafts before loading more sources.",
        ));
    }
    let mut next = previous.clone();
    next["starredDiscoveryDecisions"] = source_decisions;
    next["agentWorkspace"] = ws.clone();
    super::workflow_catalog::persist(&source, &previous, &next).await?;
    notify_ready(&ws, task);
    Ok(Json(receipt))
}
