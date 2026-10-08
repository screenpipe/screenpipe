// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Allowlisted MCP diagnostics, never prompts, arguments, results or error text.
use crate::qualified_value::AgentClient;
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct McpCall {
    schema_version: u8,
    request_id: String,
    mcp_version: String,
    client: AgentClient,
    transport: Transport,
    tool: String,
    status: Status,
    error_kind: ErrorKind,
    duration_ms: u64,
    response_bytes: u64,
    result_count: Option<u64>,
    truncated: Option<bool>,
    dropped_reports: u64,
}

macro_rules! fixed_values {
    ($name:ident { $($variant:ident),+ }) => {
        #[derive(Debug, Deserialize, serde::Serialize)]
        #[serde(rename_all = "snake_case")]
        enum $name { $($variant),+ }
    };
}
fixed_values!(Transport { Stdio, Http });
fixed_values!(Status { Ok, Empty, Error });
fixed_values!(ErrorKind {
    None,
    Auth,
    InvalidRequest,
    NotFound,
    RateLimited,
    Backend,
    Unavailable,
    Cancelled,
    Unknown
});

const TOOLS: &[&str] = &[
    "unknown",
    "search-content",
    "search_content",
    "synced-devices",
    "search-synced-content",
    "list-meetings",
    "activity-summary",
    "search-elements",
    "frame-context",
    "export-video",
    "update-memory",
    "get-feedback",
    "send-notification",
    "health-check",
    "list-audio-devices",
    "list-monitors",
    "add-tags",
    "search-speakers",
    "list-unnamed-speakers",
    "update-speaker",
    "merge-speakers",
    "start-meeting",
    "stop-meeting",
    "get-meeting",
    "update-meeting",
    "keyword-search",
    "get-frame-elements",
    "control-recording",
    "list-pipes",
    "create-pipe",
    "run-pipe",
    "pipe-logs",
    "team-search",
    "team-devices",
    "team-records",
    "team-frame",
    "list-workflows",
    "get-workflow",
    "screenpipe-skills",
];

impl McpCall {
    pub(crate) fn into_properties(self) -> Option<Value> {
        let version: Vec<_> = self.mcp_version.split('.').collect();
        if self.schema_version != 1
            || self.mcp_version.len() > 32
            || version.len() != 3
            || !version
                .iter()
                .all(|v| !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()))
            || !TOOLS.contains(&self.tool.as_str())
            || uuid::Uuid::parse_str(&self.request_id)
                .map(|id| id.get_version_num() != 4)
                .unwrap_or(true)
        {
            return None;
        }
        Some(json!({
            "schema_version": 1, "request_id": self.request_id,
            "mcp_version": self.mcp_version, "agent_client": self.client.as_str(),
            "transport": self.transport, "tool": self.tool, "status": self.status,
            "error_kind": self.error_kind, "duration_ms": self.duration_ms,
            "response_bytes": self.response_bytes, "result_count": self.result_count,
            "truncated": self.truncated, "dropped_reports": self.dropped_reports,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn valid() -> Value {
        json!({"schema_version":1,"request_id":"12345678-1234-4234-8234-123456789abc",
            "mcp_version":"0.20.2","client":"claude","transport":"stdio",
            "tool":"search-content","status":"empty","error_kind":"none",
            "duration_ms":42,"response_bytes":30,"result_count":0,"truncated":false,"dropped_reports":0})
    }
    #[test]
    fn keeps_empty_and_unknown_outcomes_distinct() {
        let properties = serde_json::from_value::<McpCall>(valid())
            .unwrap()
            .into_properties()
            .unwrap();
        assert_eq!(properties["status"], "empty");
        assert_eq!(properties["result_count"], 0);
        assert!(properties.get("success").is_none());
        let mut v = valid();
        v.as_object_mut().unwrap().remove("result_count");
        assert!(serde_json::from_value::<McpCall>(v)
            .unwrap()
            .into_properties()
            .unwrap()["result_count"]
            .is_null());
    }
    #[test]
    fn rejects_free_text_and_unknown_schema_values() {
        for key in ["query", "result", "error", "arguments"] {
            let mut v = valid();
            v[key] = json!("private content");
            assert!(serde_json::from_value::<McpCall>(v).is_err());
        }
        for key in ["client", "transport", "status", "error_kind"] {
            let mut v = valid();
            v[key] = json!("private content");
            assert!(serde_json::from_value::<McpCall>(v).is_err());
        }
        for key in ["tool", "mcp_version", "request_id"] {
            let mut v = valid();
            v[key] = json!("private content");
            assert!(serde_json::from_value::<McpCall>(v)
                .unwrap()
                .into_properties()
                .is_none());
        }
    }
}
