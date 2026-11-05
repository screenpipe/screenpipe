// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use crate::server::AppState;
use axum::{
    extract::{Query, State},
    http::StatusCode,
    Json,
};
use chrono::{DateTime, Utc};
use oasgen::{oasgen, OaSchema};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

#[derive(Deserialize, OaSchema)]
pub struct DayStartQuery {
    pub start_time: DateTime<Utc>,
    pub end_time: DateTime<Utc>,
}

#[oasgen]
pub(crate) async fn get_day_start(
    State(state): State<Arc<AppState>>,
    Query(query): Query<DayStartQuery>,
    super::search::OptionalPipePerms(perms): super::search::OptionalPipePerms,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    screenpipe_db::day_start::validate_day_window(query.start_time, query.end_time)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(json!({"error":e}))))?;
    if perms
        .as_ref()
        .is_some_and(|perms| perms.has_data_restrictions())
    {
        return Ok(Json(
            json!({"status":"permission_restricted", "first_observed_input":null}),
        ));
    }
    // Refuse to label a truncated history window as the first input of a day.
    if state
        .history_access
        .cutoff(Utc::now())
        .is_some_and(|cutoff| query.start_time < cutoff)
    {
        return Ok(Json(
            json!({"status":"history_restricted", "first_observed_input":null}),
        ));
    }
    let evidence = state
        .db
        .first_input_for_day(query.start_time, query.end_time, None)
        .await
        .map_err(|error| {
            tracing::error!(%error, "day start query failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error":"day start query failed"})),
            )
        })?;
    Ok(Json(json!({
        "status": if evidence.is_some() {"observed"} else {"no_observation"},
        "heuristic":"first_recorded_human_input",
        "start_time":query.start_time, "end_time":query.end_time,
        "first_observed_input":evidence,
        "is_confirmed_work_start":false
    })))
}
