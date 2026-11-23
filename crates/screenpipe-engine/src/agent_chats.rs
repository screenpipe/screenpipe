// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Read-only adapter over the same bounded chat search used by internal agents,
//! plus read-only SQLite discovery for local OpenCode sessions.
use crate::{
    history_access::HistoryAccessPolicy, routes::search::OptionalPipePerms, server::AppState,
};
use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use rusqlite::{Connection, OpenFlags};
use screenpipe_core::agents::chat_control::{
    self, ChatSearchRequest, ChatSearchResponse, ChatSearchResult, ChatSource,
};
use screenpipe_core::pipes::permissions::PipePermissions;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

const MAX_OPENCODE_SESSIONS: usize = 250;
const MAX_OPENCODE_PREVIEW_CHARS: usize = 220;

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
        if self.sources.len() > 6 {
            return Err("at most six sources are allowed");
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

fn compact_preview(value: &str, limit: usize) -> String {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.chars().count() <= limit {
        return normalized;
    }
    let prefix = normalized
        .chars()
        .take(limit.saturating_sub(1))
        .collect::<String>();
    format!("{prefix}…")
}

fn opencode_db_path() -> Option<PathBuf> {
    if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
        let trimmed = xdg.trim();
        if !trimmed.is_empty() {
            let candidate = PathBuf::from(trimmed).join("opencode").join("opencode.db");
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }
    let home = dirs::home_dir()?;
    let default_path = home
        .join(".local")
        .join("share")
        .join("opencode")
        .join("opencode.db");
    if default_path.exists() {
        return Some(default_path);
    }
    None
}

fn search_opencode_db(path: &Path, query: &str, limit: usize) -> Result<(Vec<ChatSearchResult>, bool), String> {
    if !path.exists() {
        return Ok((Vec::new(), false));
    }
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| error.to_string())?;
    let _ = conn.busy_timeout(Duration::from_millis(500));

    let query_trimmed = query.trim();
    let query_lower = query_trimmed.to_lowercase();

    let mut session_stmt = conn
        .prepare(
            "SELECT id, COALESCE(title, ''), COALESCE(directory, ''), COALESCE(time_updated, 0)
             FROM session
             ORDER BY time_updated DESC
             LIMIT ?1",
        )
        .map_err(|error| error.to_string())?;

    let sessions: Vec<(String, String, String, i64)> = session_stmt
        .query_map([(MAX_OPENCODE_SESSIONS + 1) as i64], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .collect();

    let truncated = sessions.len() > MAX_OPENCODE_SESSIONS;

    let mut part_stmt = conn
        .prepare(
            "SELECT json_extract(data, '$.text')
             FROM part
             WHERE session_id = ?1
               AND json_extract(data, '$.type') = 'text'
             ORDER BY id DESC
             LIMIT 24",
        )
        .ok();

    let mut results = Vec::new();
    for (id, raw_title, directory, updated_at) in sessions.into_iter().take(MAX_OPENCODE_SESSIONS) {
        let mut preview = String::new();
        let mut matched_part = false;

        let metadata_matches = query_lower.is_empty()
            || "opencode".contains(&query_lower)
            || raw_title.to_lowercase().contains(&query_lower)
            || id.to_lowercase().contains(&query_lower)
            || directory.to_lowercase().contains(&query_lower);

        if let Some(stmt) = part_stmt.as_mut() {
            if let Ok(rows) = stmt.query_map([&id], |row| row.get::<_, Option<String>>(0)) {
                for text in rows.flatten().flatten() {
                    let trimmed = text.trim();
                    if trimmed.is_empty()
                        || trimmed.starts_with("<system-reminder>")
                        || trimmed.starts_with("<conversation-checkpoint>")
                    {
                        continue;
                    }
                    if preview.is_empty() {
                        preview = compact_preview(trimmed, MAX_OPENCODE_PREVIEW_CHARS);
                    }
                    if !query_lower.is_empty() && trimmed.to_lowercase().contains(&query_lower) {
                        preview = compact_preview(trimmed, MAX_OPENCODE_PREVIEW_CHARS);
                        matched_part = true;
                        break;
                    }
                }
            }
        }

        if !metadata_matches && !matched_part {
            continue;
        }

        let title = if raw_title.trim().is_empty() {
            if preview.is_empty() {
                "untitled OpenCode chat".to_string()
            } else {
                compact_preview(&preview, 80)
            }
        } else {
            compact_preview(&raw_title, 100)
        };

        results.push(ChatSearchResult {
            source: ChatSource::Opencode,
            id,
            title,
            preview,
            updated_at,
            workspace: if directory.trim().is_empty() {
                None
            } else {
                Some(directory)
            },
            state: "read-only".to_string(),
            can_send: ChatSource::Opencode.supports_send(),
        });
        if query_lower.is_empty() && results.len() >= limit {
            break;
        }
    }

    Ok((results, truncated))
}

fn match_tier(result: &ChatSearchResult, query_lower: &str) -> u8 {
    if query_lower.is_empty() {
        return 0;
    }
    let title_lower = result.title.trim().to_lowercase();
    if title_lower == query_lower {
        0
    } else if title_lower.starts_with(query_lower) {
        1
    } else if title_lower.contains(query_lower) {
        2
    } else if result.source.label().contains(query_lower) {
        3
    } else {
        4
    }
}

fn rank_and_trim(results: &mut Vec<ChatSearchResult>, query: &str, limit: usize) {
    let query_lower = query.trim().to_lowercase();
    results.sort_by(|left, right| {
        match_tier(left, &query_lower)
            .cmp(&match_tier(right, &query_lower))
            .then_with(|| right.updated_at.cmp(&left.updated_at))
    });
    results.truncate(limit);
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

    let limit = request.limit.unwrap_or(10);
    let query = request.query.clone();
    let wants_opencode =
        request.sources.is_empty() || request.sources.contains(&ChatSource::Opencode);
    let core_sources: Vec<ChatSource> = if request.sources.is_empty() {
        Vec::new()
    } else {
        request
            .sources
            .iter()
            .copied()
            .filter(|source| *source != ChatSource::Opencode)
            .collect()
    };
    let run_core = request.sources.is_empty() || !core_sources.is_empty();
    let core_request = ChatSearchRequest {
        query: request.query.clone(),
        sources: core_sources,
        limit: Some(limit),
    };

    let opencode_query = query.clone();
    let search_fut = async move {
        let core_fut = async {
            if run_core {
                chat_control::search(core_request, &HashSet::new()).await
            } else {
                ChatSearchResponse {
                    results: Vec::new(),
                    warnings: Vec::new(),
                }
            }
        };
        let opencode_fut = async {
            if !wants_opencode {
                return Ok((Vec::new(), false));
            }
            tokio::task::spawn_blocking(move || match opencode_db_path() {
                Some(path) => search_opencode_db(&path, &opencode_query, limit),
                None => Ok((Vec::new(), false)),
            })
            .await
            .map_err(|error| error.to_string())?
        };
        let (mut found, opencode_result) = tokio::join!(core_fut, opencode_fut);
        match opencode_result {
            Ok((mut oc_results, truncated)) => {
                if truncated {
                    found.warnings.push(format!(
                        "opencode: read the {MAX_OPENCODE_SESSIONS} most recent sessions; older chats were not searched"
                    ));
                }
                found.results.append(&mut oc_results);
            }
            Err(error) => found.warnings.push(format!("opencode: {error}")),
        }
        rank_and_trim(&mut found.results, &query, limit);
        found
    };

    match tokio::time::timeout(Duration::from_secs(25), search_fut).await {
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
            json!({"query":"decision","sources":["claude","codex","opencode"],"limit":5}),
        )
        .unwrap();
        let request = input.into_request().unwrap();
        assert_eq!(request.query, "decision");
        assert_eq!(
            request.sources,
            vec![ChatSource::Claude, ChatSource::Codex, ChatSource::Opencode]
        );
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
            json!({"sources":vec!["codex"; 7]}),
        ] {
            assert!(serde_json::from_value::<SearchInput>(value)
                .unwrap()
                .into_request()
                .is_err());
        }
    }

    #[test]
    fn searches_opencode_sqlite_read_only_and_ranks_title_matches_first() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("opencode.db");
        let conn = Connection::open(&db_path).unwrap();
        conn.execute_batch(
            "CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_updated INTEGER);
             CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
             INSERT INTO session VALUES ('ses_1', 'pricing audit', '/Users/dev/monorepo', 1000);
             INSERT INTO session VALUES ('ses_2', 'weekly review', '/Users/dev/screenpipe', 2000);
             INSERT INTO part VALUES ('p1', 'ses_1', '{\"type\":\"text\",\"text\":\"compare Basic vs Business pricing\"}');
             INSERT INTO part VALUES ('p2', 'ses_2', '{\"type\":\"text\",\"text\":\"pricing came up in the weekly review\"}');",
        )
        .unwrap();
        drop(conn);

        let (mut results, truncated) = search_opencode_db(&db_path, "pricing", 10).unwrap();
        assert!(!truncated);
        assert_eq!(results.len(), 2);
        rank_and_trim(&mut results, "pricing", 10);
        // Prefix title match ('pricing audit') ranks ahead of body-only match ('weekly review') even if older.
        assert_eq!(results[0].id, "ses_1");
        assert_eq!(results[0].source, ChatSource::Opencode);
        assert_eq!(results[0].workspace.as_deref(), Some("/Users/dev/monorepo"));
        assert_eq!(results[1].id, "ses_2");

        let (recent, _) = search_opencode_db(&db_path, "", 10).unwrap();
        assert_eq!(recent[0].id, "ses_2");
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
