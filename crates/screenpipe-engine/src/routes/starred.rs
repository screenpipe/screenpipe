// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use super::search::OptionalPipePerms;
use crate::server::AppState;
use axum::{
    extract::{Query, State},
    http::StatusCode,
    Json,
};
use chrono::{DateTime, SecondsFormat, Utc};
use oasgen::{oasgen, OaSchema};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    sync::{atomic::Ordering, Arc},
    time::Duration,
};

type Error = (StatusCode, Json<Value>);
fn error(status: StatusCode, message: &str) -> Error {
    (status, Json(json!({"error": message})))
}
fn database_error(e: sqlx::Error) -> Error {
    tracing::error!(error = %e, "starred session storage failed");
    error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "could not access starred sessions",
    )
}
pub(crate) fn stamp(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[derive(OaSchema, Serialize)]
pub(crate) struct StarredSession {
    pub id: String,
    pub start: String,
    pub end: String,
    pub hd_requested: bool,
    pub revision: i64,
    pub has_audio: bool,
}
impl From<screenpipe_db::StarredSession> for StarredSession {
    fn from(s: screenpipe_db::StarredSession) -> Self {
        Self {
            id: s.id,
            start: s.start,
            end: s.end,
            hd_requested: s.hd_requested,
            revision: s.revision,
            has_audio: s.has_audio,
        }
    }
}
#[derive(OaSchema, Deserialize)]
pub(crate) struct ListQuery {
    pub start_time: Option<DateTime<Utc>>,
    pub end_time: Option<DateTime<Utc>>,
    pub id: Option<String>,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}
#[derive(OaSchema, Serialize)]
pub(crate) struct SessionList {
    pub data: Vec<StarredSession>,
}

#[oasgen]
pub(crate) async fn list(
    Query(query): Query<ListQuery>,
    State(state): State<Arc<AppState>>,
    OptionalPipePerms(perms): OptionalPipePerms,
) -> Result<Json<SessionList>, Error> {
    // Session boundaries/audio presence are global metadata. Don't disclose
    // them to agents restricted to particular apps, content or time windows.
    if perms.as_ref().is_some_and(|p| p.has_data_restrictions()) {
        return Err(error(
            StatusCode::FORBIDDEN,
            "starred metadata requires unrestricted history access",
        ));
    }
    let cutoff = state.history_access.cutoff(Utc::now());
    let lower = query.start_time.unwrap_or(DateTime::<Utc>::UNIX_EPOCH);
    let start = cutoff.map_or(lower, |c| lower.max(c));
    let end = query
        .end_time
        .unwrap_or(Utc::now() + chrono::Duration::days(1));
    if start >= end {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "start_time must precede end_time",
        ));
    }
    let rows = if let Some(id) = query.id {
        state
            .db
            .get_starred_session(&id)
            .await
            .map_err(database_error)?
            .into_iter()
            .collect()
    } else {
        state
            .db
            .list_starred_sessions(
                &stamp(start),
                &stamp(end),
                query.limit.unwrap_or(20).clamp(1, 100),
                query.offset.unwrap_or(0),
            )
            .await
            .map_err(database_error)?
    };
    // Do not expose a session spanning inaccessible history (including audio
    // metadata computed over its full range).
    Ok(Json(SessionList {
        data: rows
            .into_iter()
            .filter(|s| cutoff.is_none_or(|c| s.start >= stamp(c)))
            .map(Into::into)
            .collect(),
    }))
}

#[derive(OaSchema, Deserialize)]
pub(crate) struct SaveSession {
    pub id: String,
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
    #[serde(default)]
    pub hd_requested: bool,
    /// 0 creates; updates must pass the last returned revision.
    #[serde(default)]
    pub revision: i64,
}
fn validate(s: &SaveSession, now: DateTime<Utc>) -> Result<(), Error> {
    if uuid::Uuid::parse_str(&s.id).is_err() || s.revision < 0 || s.revision == i64::MAX {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "valid UUID and nonnegative revision required",
        ));
    }
    if s.start > now
        || stamp(s.end) <= stamp(s.start)
        || s.end - s.start > chrono::Duration::hours(24)
        || s.end > now + chrono::Duration::hours(2)
    {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "range must start in the past, be under 24 hours, and end within 2 hours from now",
        ));
    }
    Ok(())
}

#[oasgen]
pub(crate) async fn save(
    State(state): State<Arc<AppState>>,
    OptionalPipePerms(perms): OptionalPipePerms,
    Json(request): Json<SaveSession>,
) -> Result<Json<StarredSession>, Error> {
    if perms.is_some() {
        return Err(error(
            StatusCode::FORBIDDEN,
            "agents may read starred sessions; marking requires a user action",
        ));
    }
    let now = Utc::now();
    validate(&request, now)?;
    if state
        .history_access
        .cutoff(now)
        .is_some_and(|c| request.start < c)
    {
        return Err(error(
            StatusCode::FORBIDDEN,
            "session starts outside accessible history",
        ));
    }
    if request.hd_requested && request.end > now && state.high_fps_controller.is_none() {
        return Err(error(StatusCode::CONFLICT, "HD capture is unavailable"));
    }
    let _write = state.starred_session_writes.lock().await;
    let previous = state
        .db
        .get_starred_session(&request.id)
        .await
        .map_err(database_error)?;
    let changed = previous.as_ref().is_none_or(|s| {
        s.start != stamp(request.start)
            || s.end != stamp(request.end)
            || s.hd_requested != request.hd_requested
    });
    if !state
        .db
        .save_starred_session(
            &request.id,
            &stamp(request.start),
            &stamp(request.end),
            request.hd_requested,
            request.revision,
            &stamp(now),
        )
        .await
        .map_err(database_error)?
    {
        return Err(error(
            StatusCode::CONFLICT,
            "sessions changed in another window; reload before saving",
        ));
    }
    if changed {
        state.starred_revision.fetch_add(1, Ordering::SeqCst);
        if let Some(controller) = &state.high_fps_controller {
            let remaining = (request.end - now).to_std().unwrap_or(Duration::ZERO);
            controller.set_starred_session(
                &request.id,
                if request.hd_requested {
                    remaining
                } else {
                    Duration::ZERO
                },
            );
        }
    }
    let row = state
        .db
        .get_starred_session(&request.id)
        .await
        .map_err(database_error)?
        .ok_or_else(|| error(StatusCode::NOT_FOUND, "session no longer exists"))?;
    Ok(Json(row.into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_invalid_and_unbounded_sessions() {
        let now = Utc::now();
        let mut s = SaveSession {
            id: uuid::Uuid::new_v4().to_string(),
            start: now,
            end: now + chrono::Duration::minutes(15),
            hd_requested: false,
            revision: 0,
        };
        assert!(validate(&s, now).is_ok());
        s.end = now;
        assert!(validate(&s, now).is_err());
        s.end = now + chrono::Duration::hours(3);
        assert!(validate(&s, now).is_err());
    }
}
