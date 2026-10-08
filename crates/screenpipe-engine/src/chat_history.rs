// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
//! Shared read-only local history API. The recorder's normal authentication and
//! pipe API allowlist apply; no chat-delivery capability is exposed here.
use axum::{extract::Query, http::StatusCode, Extension, Json};
use screenpipe_core::agents::chat_control::history::{self, HistoryRequest};
use screenpipe_core::pipes::permissions::PipePermissions;
use serde_json::{json, Value};
use std::sync::Arc;
async fn run(
    input: HistoryRequest,
    read: bool,
    permissions: Option<Extension<Arc<PipePermissions>>>,
) -> (StatusCode, Json<Value>) {
    // Native transcripts have no recorder window/category identity. Do not
    // bypass an existing app, window, content or time restriction.
    if permissions.is_some_and(|p| p.0.has_data_restrictions() || p.0.privacy_filter) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"error":"Native history is unavailable under recorder data filters"})),
        );
    }
    match tokio::task::spawn_blocking(move || {
        if read {
            history::read(input)
        } else {
            history::search(input)
        }
    })
    .await
    {
        Ok(Ok(value)) => (StatusCode::OK, Json(value)),
        Ok(Err(error)) => (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({"error":error})),
        ),
        Err(_) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error":"Local chat history unavailable"})),
        ),
    }
}
pub(crate) async fn search(
    permissions: Option<Extension<Arc<PipePermissions>>>,
    Query(input): Query<HistoryRequest>,
) -> (StatusCode, Json<Value>) {
    run(input, false, permissions).await
}
pub(crate) async fn read(
    permissions: Option<Extension<Arc<PipePermissions>>>,
    Query(input): Query<HistoryRequest>,
) -> (StatusCode, Json<Value>) {
    run(input, true, permissions).await
}
