// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Versioned intermediate results for the existing Pipe scheduler. No scheduler,
//! model calls or semantic grouping live here: agents own interpretation.
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
use chrono::{DateTime, Duration, Utc};
use oasgen::{oasgen, OaSchema};
use screenpipe_core::workflows::pipeline::{stage, TASKS};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::io::AsyncReadExt;

type ApiError = (StatusCode, Json<Value>);
const MAX_BYTES: u64 = 2 * 1024 * 1024;
fn error(status: StatusCode, message: &str) -> ApiError {
    (status, Json(json!({"error":message})))
}

pub(super) async fn read(source: &WorkflowCatalogSource) -> Result<Value, ApiError> {
    let dir = source.0.as_ref().ok_or_else(|| {
        error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Workflow storage unavailable.",
        )
    })?;
    let mut found = false;
    for name in ["pipeline.json", "pipeline.backup.json"] {
        match tokio::fs::File::open(dir.join(name)).await {
            Ok(file) => {
                found = true;
                let mut bytes = Vec::new();
                if file
                    .take(MAX_BYTES + 1)
                    .read_to_end(&mut bytes)
                    .await
                    .is_err()
                    || bytes.len() as u64 > MAX_BYTES
                {
                    continue;
                }
                if let Ok(v) = serde_json::from_slice::<Value>(&bytes) {
                    if v["schemaVersion"] == 1 && v["stages"].is_object() {
                        return Ok(v);
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => {
                return Err(error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Could not read workflow progress.",
                ))
            }
        }
    }
    if found {
        return Err(error(
            StatusCode::CONFLICT,
            "Saved workflow progress is unreadable. Previous catalog preserved.",
        ));
    }
    Ok(json!({"schemaVersion":1,"revision":0,"stages":{}}))
}

#[derive(Deserialize, OaSchema)]
pub struct StageQuery {
    pub task: String,
}

#[oasgen]
pub(crate) async fn context(
    State(state): State<Arc<AppState>>,
    Extension(source): Extension<WorkflowCatalogSource>,
    perms: OptionalPipePerms,
    Query(query): Query<StageQuery>,
) -> Result<Json<Value>, ApiError> {
    super::workflow_catalog::allowed(&state, &perms)?;
    if perms.0.as_ref().is_some_and(|p| p.pipe_name != query.task) {
        return Err(error(
            StatusCode::FORBIDDEN,
            "A task can only read its own enrichment context.",
        ));
    }
    let index = stage(&query.task)
        .ok_or_else(|| error(StatusCode::BAD_REQUEST, "Unknown workflow task."))?;
    let saved = read(&source).await?;
    let catalog = read_catalog(&source).await?;
    let previous = &saved["stages"][&query.task];
    let input = if index == 0 {
        Value::Null
    } else {
        saved["stages"][TASKS[index - 1]].clone()
    };
    let now = Utc::now();
    let last = saved["stages"][TASKS[0]]["checkedThrough"]
        .as_str()
        .or(catalog["checkedThrough"].as_str())
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|v| v.with_timezone(&Utc))
        .unwrap_or(now - Duration::days(2));
    // A bounded batch, with overlap for late captures. This is a coverage cursor,
    // not a claim that every moment in the last 90 days has been examined.
    let from = (last - Duration::hours(2)).max(now - Duration::days(90));
    let through = (last + Duration::days(2)).min(now);
    let input_revision = input["revision"].as_u64().unwrap_or(0);
    let applied = if index == 4 {
        catalog["pipelineRevision"].as_u64().unwrap_or(0)
    } else {
        previous["inputRevision"].as_u64().unwrap_or(0)
    };
    let mut blocked_reason: Option<String> = None;
    if let Some(manager) = &state.pipe_manager {
        let manager = manager.lock().await;
        for dependency in &TASKS[..index] {
            if !manager
                .get_pipe(dependency)
                .await
                .is_some_and(|pipe| pipe.config.enabled)
            {
                blocked_reason = Some(format!(
                    "Enable {dependency} in Scheduled tasks to continue enrichment."
                ));
                break;
            }
        }
    }
    let root_through = saved["stages"][TASKS[0]]["checkedThrough"]
        .as_str()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok());
    let published_through = catalog["checkedThrough"]
        .as_str()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok());
    let root_ready = root_through.is_none()
        || root_through
            .zip(published_through)
            .is_some_and(|(r, p)| p >= r);
    let latest_input =
        index < 2 || input["checkedThrough"] == saved["stages"][TASKS[0]]["checkedThrough"];
    Ok(Json(
        json!({"task":query.task,"stage":index,"revision":saved["revision"],
        "inputRevision":input_revision,"input":input,"previous":previous,
        "catalogRevision":catalog["revision"].as_u64().unwrap_or(0),
        "blockedReason":blocked_reason,
        "upToDate":root_ready && catalog["needsWorkflowReview"] != true,
        "reviewRequested":catalog["needsWorkflowReview"] == true,
        "ready":blocked_reason.is_none() && latest_input && ((index == 0 && root_ready) || (input_revision > 0 && (input_revision > applied || (index == 4 && catalog["needsWorkflowReview"] == true)))),
        "window":{"start":from.to_rfc3339(),"end":through.to_rfc3339()},
        "checkedThrough":if index == 0 {json!(through.to_rfc3339())} else {input["checkedThrough"].clone()},
        "tasks":TASKS}),
    ))
}

#[derive(Deserialize, OaSchema)]
pub struct StageCommit {
    pub task: String,
    pub expected_revision: u64,
    pub input_revision: u64,
    pub checked_through: String,
    pub items: Vec<Value>,
    /// Explicitly reviewed intervals. Empty or partial coverage cannot advance.
    pub coverage: Vec<Value>,
}

fn validate(saved: &Value, body: &StageCommit) -> Result<(), String> {
    let index = stage(&body.task)
        .filter(|i| *i < 4)
        .ok_or("Unknown enrichment stage.")?;
    if saved["revision"].as_u64().unwrap_or(0) != body.expected_revision {
        return Err("Workflow progress changed. Read it again.".into());
    }
    let through = DateTime::parse_from_rfc3339(&body.checked_through)
        .map_err(|_| "Invalid coverage checkpoint.")?;
    if through > Utc::now() || through < Utc::now() - Duration::days(90) {
        return Err("Invalid coverage checkpoint.".into());
    }
    if body.items.len() > 200
        || serde_json::to_vec(&body.items)
            .map_err(|_| "Invalid stage data.")?
            .len()
            > 300_000
    {
        return Err("Stage output too large. Process a smaller batch.".into());
    }
    if index > 0 {
        let parent = &saved["stages"][TASKS[index - 1]];
        if body.input_revision == 0
            || parent["revision"] != body.input_revision
            || parent["checkedThrough"] != body.checked_through
        {
            return Err("Upstream result changed or is missing. Read it before saving.".into());
        }
    } else {
        if body.input_revision != 0 {
            return Err("Activity stage has no upstream revision.".into());
        }
        let mut ranges = Vec::new();
        for range in &body.coverage {
            if range["complete"] != true {
                return Err("Finish reading all pages before advancing coverage.".into());
            }
            let start = range["start"]
                .as_str()
                .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                .ok_or("Invalid coverage start.")?;
            let end = range["end"]
                .as_str()
                .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                .ok_or("Invalid coverage end.")?;
            if start >= end || end > through {
                return Err("Invalid coverage interval.".into());
            }
            ranges.push((start, end));
        }
        ranges.sort();
        let mut cursor = saved["stages"][TASKS[0]]["checkedThrough"]
            .as_str()
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .or(ranges.first().map(|r| r.0))
            .ok_or("Coverage is required.")?;
        for (start, end) in ranges {
            if start > cursor {
                return Err("Coverage contains an unread gap.".into());
            }
            cursor = cursor.max(end);
        }
        if cursor < through {
            return Err("Coverage does not reach the checkpoint.".into());
        }
        for item in &body.items {
            if !matches!(
                item["classification"].as_str(),
                Some("professional" | "personal" | "mixed" | "uncertain")
            ) || item["id"].as_str().is_none()
                || !item["sources"].is_array()
            {
                return Err("Episodes need an ID, classification and source references.".into());
            }
        }
    }
    let old = saved["stages"][&body.task]["checkedThrough"]
        .as_str()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok());
    if old.is_some_and(|v| v > through) {
        return Err("Checkpoint cannot move backwards.".into());
    }
    Ok(())
}

#[oasgen]
pub(crate) async fn commit(
    State(state): State<Arc<AppState>>,
    Extension(source): Extension<WorkflowCatalogSource>,
    perms: OptionalPipePerms,
    headers: HeaderMap,
    Json(body): Json<StageCommit>,
) -> Result<Json<Value>, ApiError> {
    super::workflow_catalog::allowed(&state, &perms)?;
    if perms.0.as_ref().is_some_and(|p| p.pipe_name != body.task) {
        return Err(error(
            StatusCode::FORBIDDEN,
            "A task can only save its own enrichment stage.",
        ));
    }
    let _guard = super::workflow_catalog::WRITER.lock().await;
    let previous = read(&source).await?;
    validate(&previous, &body).map_err(|e| error(StatusCode::CONFLICT, &e))?;
    if let Some(token) = headers
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer sp_pipe_"))
    {
        if !state
            .pipe_permissions
            .contains_key(&format!("sp_pipe_{token}"))
        {
            return Err(error(StatusCode::CONFLICT, "Task stopped before saving."));
        }
    }
    let mut next = previous.clone();
    let revision = previous["revision"].as_u64().unwrap_or(0) + 1;
    next["revision"] = json!(revision);
    let unchanged =
        body.items.is_empty() || previous["stages"][&body.task]["items"] == json!(body.items);
    next["stages"][&body.task] = json!({"unchanged":unchanged,"revision":revision,"inputRevision":body.input_revision,
        "checkedThrough":body.checked_through,"items":body.items,"coverage":body.coverage});
    let dir = source.0.clone().ok_or_else(|| {
        error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Workflow storage unavailable.",
        )
    })?;
    tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        let _lock = crate::atomic_file::lock(&dir.join("pipeline.lock"))?;
        crate::atomic_file::replace(
            &dir.join("pipeline.backup.json"),
            &serde_json::to_vec(&previous)?,
        )?;
        crate::atomic_file::replace(&dir.join("pipeline.json"), &serde_json::to_vec(&next)?)
    })
    .await
    .map_err(|_| {
        error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Could not save workflow progress.",
        )
    })?
    .map_err(|_| {
        error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Could not save workflow progress.",
        )
    })?;
    Ok(Json(
        json!({"revision":revision,"checkedThrough":body.checked_through}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_gaps_failed_pages_and_stale_dependencies() {
        let end = Utc::now() - Duration::minutes(1);
        let start = end - Duration::hours(2);
        let saved = json!({"revision":1,"stages":{"workflow-activity":{"revision":1,"checkedThrough":start.to_rfc3339()}}});
        let mut body = StageCommit {
            task: TASKS[0].into(),
            expected_revision: 1,
            input_revision: 0,
            checked_through: end.to_rfc3339(),
            items: vec![],
            coverage: vec![
                json!({"start":start.to_rfc3339(),"end":end.to_rfc3339(),"complete":true}),
            ],
        };
        assert!(validate(&saved, &body).is_ok());
        body.coverage[0]["complete"] = json!(false);
        assert!(validate(&saved, &body).is_err());
        body.coverage[0]["complete"] = json!(true);
        body.coverage[0]["start"] = json!((start + Duration::minutes(1)).to_rfc3339());
        assert!(validate(&saved, &body).is_err());
        body.task = TASKS[1].into();
        body.input_revision = 7;
        assert!(validate(&saved, &body).is_err());
    }
    #[tokio::test]
    async fn corrupt_progress_recovers_from_backup_without_resetting() {
        let dir = tempfile::tempdir().unwrap();
        let source = WorkflowCatalogSource(Some(dir.path().to_path_buf()));
        tokio::fs::write(dir.path().join("pipeline.json"), b"broken")
            .await
            .unwrap();
        assert!(read(&source).await.is_err());
        tokio::fs::write(
            dir.path().join("pipeline.backup.json"),
            br#"{"schemaVersion":1,"revision":9,"stages":{}}"#,
        )
        .await
        .unwrap();
        assert_eq!(read(&source).await.unwrap()["revision"], 9);
    }
    #[test]
    fn stages_cannot_advance_an_upstream_checkpoint_or_overwrite_a_newer_revision() {
        let now = (Utc::now() - Duration::minutes(1)).to_rfc3339();
        let saved = json!({"revision":3,"stages":{"workflow-patterns":{"revision":3,"checkedThrough":now}}});
        let mut body = StageCommit {
            task: "workflow-procedures".into(),
            expected_revision: 3,
            input_revision: 3,
            checked_through: now,
            items: vec![],
            coverage: vec![],
        };
        assert!(validate(&saved, &body).is_ok());
        body.checked_through = Utc::now().to_rfc3339();
        assert!(validate(&saved, &body).is_err());
        body.expected_revision = 2;
        assert!(validate(&saved, &body).is_err());
    }
}
