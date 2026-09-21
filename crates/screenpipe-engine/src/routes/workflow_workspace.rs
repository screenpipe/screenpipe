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
        json!({"task":query.task,"ready":workspace::ready(&ws,&query.task),"canFinish":workspace::can_finish(&ws),"workspace":ws,
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
        let rev = body["expected_revision"].as_u64().ok_or_else(|| {
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
        return super::workflow_catalog::commit(
            State(state),
            Extension(source),
            perms,
            headers,
            Json(super::workflow_catalog::CommitRequest {
                expected_revision: body["catalog_revision"].as_u64().ok_or_else(|| {
                    error(
                        StatusCode::BAD_REQUEST,
                        "Read the current catalog revision.",
                    )
                })?,
                checked_through: through.into(),
                workflows,
                pipeline_revision: None,
                workspace_revision: Some(rev),
                draft_id: id.map(str::to_owned),
            }),
        )
        .await;
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
        workspace::start(&mut ws, &previous);
        json!({"revision":workspace::revision(&ws),"cycle":ws["cycle"]})
    } else {
        let change = serde_json::from_value(body.clone())
            .map_err(|_| error(StatusCode::BAD_REQUEST, "Invalid workspace change."))?;
        workspace::apply(&mut ws, task, &change).map_err(|e| error(StatusCode::CONFLICT, &e))?
    };
    let mut next = previous.clone();
    next["agentWorkspace"] = ws.clone();
    super::workflow_catalog::persist(&source, &previous, &next).await?;
    notify_ready(&ws, task);
    Ok(Json(receipt))
}
