// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use super::search::OptionalPipePerms;
use crate::server::AppState;
use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use screenpipe_db::{FocusedAction, FocusedPhase, FocusedRecording};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

type Error = (StatusCode, Json<Value>);
fn error(status: StatusCode, message: &str) -> Error {
    (status, Json(json!({"error":message})))
}
fn storage(e: sqlx::Error) -> Error {
    tracing::error!(error=%e, "focused recording storage failed");
    error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Could not save this recording. Your captured work is kept. Try again.",
    )
}
fn authorize(perms: OptionalPipePerms) -> Result<(), Error> {
    if perms.0.is_some() {
        return Err(error(
            StatusCode::FORBIDDEN,
            "Focused recording requires a user action.",
        ));
    }
    Ok(())
}
fn accessible(state: &AppState, session: &FocusedRecording) -> Result<(), Error> {
    if state
        .history_access
        .cutoff(chrono::Utc::now())
        .is_some_and(|cutoff| session.created_at < cutoff.timestamp_millis())
    {
        return Err(error(
            StatusCode::FORBIDDEN,
            "This recording is outside accessible history.",
        ));
    }
    Ok(())
}
fn uuid(value: &str) -> Result<(), Error> {
    uuid::Uuid::parse_str(value).map_err(|_| {
        error(
            StatusCode::BAD_REQUEST,
            "A valid recording identifier is required.",
        )
    })?;
    Ok(())
}
const LEASE: std::time::Duration = std::time::Duration::from_secs(15);
async fn capture_available(state: &AppState) -> Result<(), Error> {
    let manager = state.vision_manager.load().as_ref().clone();
    if state.vision_disabled
        || state.high_fps_controller.is_none()
        || manager.is_none()
        || manager.unwrap().active_monitors().await.is_empty()
    {
        return Err(error(StatusCode::CONFLICT,"Screen capture is unavailable. Check recording settings and permissions, then try again."));
    }
    Ok(())
}
fn recovery_boundary(
    session: &FocusedRecording,
    controller: Option<&crate::high_fps_controller::HighFpsController>,
) -> i64 {
    controller
        .filter(|c| session.capture_owner.as_deref() == Some(c.focused_owner()))
        .and_then(|c| c.focused_capture_end(&session.id))
        .unwrap_or(session.last_capture_at)
        .min(session.capture_until)
}
async fn recover(state: &AppState, session: &mut FocusedRecording) -> Result<(), Error> {
    if session.phase == FocusedPhase::Recording
        && !state
            .high_fps_controller
            .as_ref()
            .is_some_and(|c| c.focused_session_active(&session.id))
    {
        let until = recovery_boundary(session, state.high_fps_controller.as_deref()).max(
            state
                .db
                .focused_audio_end(&session.id)
                .await
                .map_err(storage)?
                .unwrap_or(session.last_capture_at),
        );
        let revision = session.revision;
        session
            .pause_interrupted(until)
            .map_err(|m| error(StatusCode::CONFLICT, m))?;
        if !state
            .db
            .save_focused_recording(session, revision)
            .await
            .map_err(storage)?
        {
            return Err(error(
                StatusCode::CONFLICT,
                "Recording changed. Reload before continuing.",
            ));
        }
    }
    Ok(())
}
async fn retire_inaccessible(
    state: &AppState,
    session: &mut FocusedRecording,
) -> Result<bool, Error> {
    if !state
        .history_access
        .cutoff(chrono::Utc::now())
        .is_some_and(|cutoff| session.created_at < cutoff.timestamp_millis())
    {
        return Ok(false);
    }
    if session.phase == FocusedPhase::Recording {
        if let Some(controller) = &state.high_fps_controller {
            controller.set_focused_session(&session.id, std::time::Duration::ZERO);
        }
        let until = recovery_boundary(session, state.high_fps_controller.as_deref()).max(
            state
                .db
                .focused_audio_end(&session.id)
                .await
                .map_err(storage)?
                .unwrap_or(session.last_capture_at),
        );
        session
            .pause_interrupted(until)
            .map_err(|m| error(StatusCode::CONFLICT, m))?;
    }
    let revision = session.revision;
    if !state
        .db
        .retire_focused_recording(session, revision)
        .await
        .map_err(storage)?
    {
        return Err(error(
            StatusCode::CONFLICT,
            "Recording changed. Reload before continuing.",
        ));
    }
    Ok(true)
}
pub(crate) async fn current(
    State(state): State<Arc<AppState>>,
    perms: OptionalPipePerms,
) -> Result<Json<Option<FocusedRecording>>, Error> {
    authorize(perms)?;
    let _write = state.starred_session_writes.lock().await;
    let mut session = state
        .db
        .current_focused_recording()
        .await
        .map_err(storage)?;
    if let Some(value) = &mut session {
        if retire_inaccessible(&state, value).await? {
            return Ok(Json(None));
        }
        recover(&state, value).await?;
    }
    Ok(Json(session))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Start {
    id: String,
    voice_enabled: Option<bool>,
}
pub(crate) async fn start(
    State(state): State<Arc<AppState>>,
    perms: OptionalPipePerms,
    Json(input): Json<Start>,
) -> Result<Json<FocusedRecording>, Error> {
    authorize(perms)?;
    uuid(&input.id)?;
    let _write = state.starred_session_writes.lock().await;
    if let Some(mut session) = state
        .db
        .current_focused_recording()
        .await
        .map_err(storage)?
    {
        if matches!(
            session.phase,
            FocusedPhase::Recording | FocusedPhase::Paused | FocusedPhase::Summary
        ) {
            if !retire_inaccessible(&state, &mut session).await? {
                recover(&state, &mut session).await?;
                return Ok(Json(session));
            }
        }
    }
    capture_available(&state).await?;
    let voice_default = state
        .db
        .focused_voice_preference()
        .await
        .map_err(storage)?
        .unwrap_or(!state.audio_disabled);
    let mut session = FocusedRecording::new(
        input.id,
        chrono::Utc::now().timestamp_millis(),
        input.voice_enabled.unwrap_or(voice_default),
    );
    session.capture_owner = Some(
        state
            .high_fps_controller
            .as_ref()
            .unwrap()
            .focused_owner()
            .to_owned(),
    );
    if !state
        .db
        .save_focused_recording(&mut session, 0)
        .await
        .map_err(storage)?
    {
        return Err(error(
            StatusCode::CONFLICT,
            "Recording changed. Reopen its controls.",
        ));
    }
    state
        .high_fps_controller
        .as_ref()
        .unwrap()
        .set_focused_session(&session.id, LEASE);
    Ok(Json(session))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Action {
    revision: i64,
    request_id: String,
    at: Option<i64>,
    #[serde(flatten)]
    action: FocusedAction,
}
pub(crate) async fn act(
    State(state): State<Arc<AppState>>,
    perms: OptionalPipePerms,
    Path(id): Path<String>,
    Json(input): Json<Action>,
) -> Result<Json<FocusedRecording>, Error> {
    authorize(perms)?;
    uuid(&id)?;
    uuid(&input.request_id)?;
    let stopping = matches!(input.action, FocusedAction::Pause | FocusedAction::Finish);
    if stopping {
        if let Some(controller) = &state.high_fps_controller {
            controller.set_focused_session(&id, std::time::Duration::ZERO);
        }
    }
    let _write = state.starred_session_writes.lock().await;
    // An earlier heartbeat may have renewed while this stop waited for storage.
    if stopping {
        if let Some(controller) = &state.high_fps_controller {
            controller.set_focused_session(&id, std::time::Duration::ZERO);
        }
    }
    let mut session = state
        .db
        .get_focused_recording(&id)
        .await
        .map_err(storage)?
        .ok_or_else(|| error(StatusCode::NOT_FOUND, "Recording not found."))?;
    accessible(&state, &session)?;
    if !matches!(
        input.action,
        FocusedAction::Delete { .. } | FocusedAction::Submit
    ) {
        if state
            .db
            .current_focused_recording()
            .await
            .map_err(storage)?
            .is_some_and(|active| {
                active.id != id
                    && matches!(
                        active.phase,
                        FocusedPhase::Recording | FocusedPhase::Paused | FocusedPhase::Summary
                    )
            })
        {
            return Err(error(
                StatusCode::CONFLICT,
                "Another workflow is active. Finish it before reopening this recording.",
            ));
        }
    }
    if matches!(input.action, FocusedAction::Heartbeat) && capture_available(&state).await.is_err()
    {
        if let Some(controller) = &state.high_fps_controller {
            controller.interrupt_focused_capture();
        }
    }
    if !stopping {
        recover(&state, &mut session).await?;
    }
    if matches!(input.action, FocusedAction::Heartbeat) && session.phase != FocusedPhase::Recording
    {
        return Ok(Json(session));
    }
    if session.last_request_id.as_ref() == Some(&input.request_id) {
        return Ok(Json(session));
    }
    if session.revision != input.revision {
        return Err(error(
            StatusCode::CONFLICT,
            "Recording changed in another window. Reload before continuing.",
        ));
    }
    // Submission must be backed by a durable receipt from the selected host.
    // No local UI action can manufacture successful remote submission.
    if matches!(input.action, FocusedAction::Submit) {
        return Err(error(
            StatusCode::CONFLICT,
            "Workflow submission is not configured.",
        ));
    }
    if matches!(input.action, FocusedAction::Resume) {
        capture_available(&state).await?;
    }
    let now = chrono::Utc::now().timestamp_millis();
    let at = input.at.unwrap_or(now);
    if at > now
        || at
            < session
                .intervals
                .last()
                .map_or(session.created_at, |i| i.start)
    {
        return Err(error(StatusCode::BAD_REQUEST, "Invalid capture boundary."));
    }
    if stopping {
        if let Some(controller) = &state.high_fps_controller {
            controller.set_focused_session(&session.id, std::time::Duration::ZERO);
        }
    }
    let was_summary = session.phase == FocusedPhase::Summary;
    session
        .apply(input.action, at)
        .map_err(|message| error(StatusCode::BAD_REQUEST, message))?;
    if session.phase == FocusedPhase::Summary && !was_summary {
        session.media = Some(
            state
                .db
                .focused_recording_media(&session)
                .await
                .map_err(storage)?,
        );
    }
    if session.phase == FocusedPhase::Recording {
        session.capture_owner = Some(
            state
                .high_fps_controller
                .as_ref()
                .unwrap()
                .focused_owner()
                .to_owned(),
        );
    }
    session.last_request_id = Some(input.request_id);
    if !state
        .db
        .save_focused_recording(&mut session, input.revision)
        .await
        .map_err(storage)?
    {
        return Err(error(
            StatusCode::CONFLICT,
            "Recording changed. Reload before continuing.",
        ));
    }
    if session.phase == FocusedPhase::Recording {
        state
            .high_fps_controller
            .as_ref()
            .unwrap()
            .set_focused_session(&session.id, LEASE);
    }
    Ok(Json(session))
}
#[derive(Deserialize)]
pub(crate) struct Audio {
    stream_id: String,
    sequence: i64,
    start: i64,
    end: i64,
}
pub(crate) async fn audio(
    State(state): State<Arc<AppState>>,
    perms: OptionalPipePerms,
    Path((id, chunk)): Path<(String, String)>,
    Query(input): Query<Audio>,
    headers: HeaderMap,
    bytes: Bytes,
) -> Result<Json<Value>, Error> {
    authorize(perms)?;
    uuid(&id)?;
    uuid(&chunk)?;
    uuid(&input.stream_id)?;
    let now = chrono::Utc::now().timestamp_millis();
    let mime = headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !matches!(
        mime.split(';').next().unwrap_or(""),
        "audio/webm" | "audio/mp4" | "audio/ogg"
    ) || bytes.len() > 8 * 1024 * 1024
        || input.start > now
        || input.end > now
        || input.end < input.start
    {
        return Err(error(StatusCode::BAD_REQUEST, "Invalid captured audio."));
    }
    let session = state
        .db
        .get_focused_recording(&id)
        .await
        .map_err(storage)?
        .ok_or_else(|| error(StatusCode::NOT_FOUND, "Recording not found."))?;
    // Metadata reads remain restricted; this write-only retry returns no historical content.
    let _ = session;
    if !state
        .db
        .save_focused_audio(
            &id,
            &chunk,
            &input.stream_id,
            input.sequence,
            input.start,
            input.end,
            mime,
            &bytes,
        )
        .await
        .map_err(storage)?
    {
        return Err(error(
            StatusCode::CONFLICT,
            "Could not save this audio chunk. Keep this recording open and retry.",
        ));
    }
    Ok(Json(json!({"saved":true})))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::high_fps_controller::{DefaultMode, HighFpsController};
    #[test]
    fn process_restart_never_counts_the_unused_lease_tail_as_capture() {
        let original = HighFpsController::new(None, DefaultMode::Ask, 100);
        let restarted = HighFpsController::new(None, DefaultMode::Ask, 100);
        let mut session = FocusedRecording::new("fixture".into(), 1000, false);
        session.capture_owner = Some(original.focused_owner().to_owned());
        session.last_capture_at = 6000;
        session.capture_until = 21000;
        assert_eq!(recovery_boundary(&session, Some(&restarted)), 6000);
        assert_eq!(recovery_boundary(&session, None), 6000);
    }
}
