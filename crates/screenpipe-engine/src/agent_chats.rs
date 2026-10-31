// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Read-only adapter over the same bounded chat search used by internal agents.
use crate::{
    history_access::HistoryAccessPolicy, routes::search::OptionalPipePerms, server::AppState,
};
use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use screenpipe_core::agents::chat_control::{
    self, ChatSearchRequest, ChatSearchResponse, ChatSource,
};
use screenpipe_core::pipes::permissions::PipePermissions;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::HashSet, sync::Arc, time::Duration};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SearchInput {
    #[serde(default)]
    query: String,
    #[serde(default)]
    sources: Vec<ChatSource>,
    limit: Option<usize>,
}

impl SearchInput {
    fn into_request(self) -> Result<ChatSearchRequest, &'static str> {
        if self.query.chars().count() > 1000 {
            return Err("query exceeds 1000 characters");
        }
        if self.sources.len() > 5 {
            return Err("at most five sources are allowed");
        }
        let limit = self.limit.unwrap_or(10);
        if !(1..=50).contains(&limit) {
            return Err("limit must be from 1 to 50");
        }
        Ok(ChatSearchRequest {
            query: self.query,
            sources: self.sources,
            limit: Some(limit),
        })
    }
}

fn search_result(found: ChatSearchResponse) -> Value {
    let results: Vec<Value> = found
        .results
        .into_iter()
        .map(|item| {
            json!({
                "source": item.source, "id": item.id, "title": item.title,
                "preview": item.preview, "workspace": item.workspace, "updated_at": item.updated_at,
            })
        })
        .collect();
    // Running state and delivery permissions belong to the internal broker.
    json!({ "results": results, "warnings": found.warnings,
        "coverage": "bounded_recent_chats", "read_only": true })
}

fn access_error(
    policy: &HistoryAccessPolicy,
    permissions: Option<&PipePermissions>,
) -> Option<&'static str> {
    if policy.is_restricted() {
        return Some("history_restricted");
    }
    if permissions.is_some_and(|p| {
        p.has_data_restrictions() || p.has_content_type_restrictions() || p.privacy_filter
    }) {
        return Some("chat_search_requires_unfiltered_history_permission");
    }
    None
}

pub(crate) async fn search_handler(
    State(state): State<Arc<AppState>>,
    OptionalPipePerms(permissions): OptionalPipePerms,
    Json(input): Json<SearchInput>,
) -> Response {
    // A recently updated chat can contain arbitrarily old messages. The core
    // preview contract cannot enforce per-message history or app/window scopes.
    if let Some(code) = access_error(&state.history_access, permissions.as_deref()) {
        return (StatusCode::FORBIDDEN, Json(json!({"error": "chat search cannot enforce the active history filters", "code": code}))).into_response();
    }

    let request = match input.into_request() {
        Ok(request) => request,
        Err(error) => {
            return (StatusCode::BAD_REQUEST, Json(json!({"error": error}))).into_response()
        }
    };
    match tokio::time::timeout(
        Duration::from_secs(25),
        chat_control::search(request, &HashSet::new()),
    )
    .await
    {
        Ok(found) => Json(search_result(found)).into_response(),
        Err(_) => (
            StatusCode::GATEWAY_TIMEOUT,
            Json(json!({"error": "chat search timed out; coverage is unknown"})),
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use screenpipe_core::agents::chat_control::ChatSearchResult;

    #[test]
    fn chat_previews_cannot_bypass_history_or_pipe_filters() {
        let policy = HistoryAccessPolicy::unrestricted();
        assert_eq!(access_error(&policy, None), None);
        assert_eq!(
            access_error(&HistoryAccessPolicy::last_24_hours(), None),
            Some("history_restricted")
        );
        let permissions: PipePermissions = serde_json::from_value(json!({
            "pipe_name":"scoped", "allow_rules":[], "deny_rules":[],
            "use_default_allowlist":true, "time_range":null, "days":null,
            "privacy_filter":true
        }))
        .unwrap();
        assert_eq!(
            access_error(&policy, Some(&permissions)),
            Some("chat_search_requires_unfiltered_history_permission")
        );
    }

    #[test]
    fn validates_search_before_discovery() {
        let input: SearchInput = serde_json::from_value(
            json!({"query":"decision","sources":["claude","codex"],"limit":5}),
        )
        .unwrap();
        let request = input.into_request().unwrap();
        assert_eq!(request.query, "decision");
        assert_eq!(request.sources, vec![ChatSource::Claude, ChatSource::Codex]);
        assert_eq!(request.limit, Some(5));
        for value in [
            json!({"sources":["unknown"]}),
            json!({"limit":-1}),
            json!({"confirmed":true}),
        ] {
            assert!(serde_json::from_value::<SearchInput>(value).is_err());
        }
        for value in [
            json!({"limit":0}),
            json!({"limit":51}),
            json!({"query":"x".repeat(1001)}),
            json!({"sources":vec!["codex"; 6]}),
        ] {
            assert!(serde_json::from_value::<SearchInput>(value)
                .unwrap()
                .into_request()
                .is_err());
        }
    }

    #[test]
    fn preserves_attribution_and_coverage_without_dispatch_capability() {
        let output = search_result(ChatSearchResponse {
            results: vec![ChatSearchResult {
                source: ChatSource::Codex,
                id: "thread-1".into(),
                title: "Project".into(),
                preview: "An earlier decision".into(),
                workspace: Some("/project".into()),
                updated_at: 42,
                state: "idle".into(),
                can_send: true,
            }],
            warnings: vec!["Older chats were not scanned".into()],
        });
        assert_eq!(output["results"][0]["source"], "codex");
        assert_eq!(output["results"][0]["preview"], "An earlier decision");
        assert!(output["results"][0].get("can_send").is_none());
        assert!(output["results"][0].get("state").is_none());
        assert_eq!(output["warnings"][0], "Older chats were not scanned");
        assert_eq!(output["coverage"], "bounded_recent_chats");
    }
}
