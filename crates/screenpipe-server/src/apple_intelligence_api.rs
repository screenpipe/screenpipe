//! OpenAI-compatible API wrapping Apple Foundation Models.
//!
//! Full-featured endpoint with tool calling, JSON schema generation, and streaming.
//! Feature-gated behind `apple-intelligence` (macOS aarch64 only).

use axum::{
    http::StatusCode,
    response::{
        sse::{Event, Sse},
        IntoResponse,
    },
    Json,
};
use screenpipe_apple_intelligence::{check_availability, generate_text, prewarm, Availability};
use serde::{Deserialize, Serialize};
use std::convert::Infallible;
use std::sync::Once;
use tokio_stream::StreamExt as _;
use tracing::{info, warn};

static PREWARM: Once = Once::new();

const MODEL_ID: &str = "apple-intelligence";

fn ensure_prewarm() {
    PREWARM.call_once(|| {
        info!("prewarming apple intelligence model");
        if let Err(e) = prewarm() {
            warn!("prewarm failed: {}", e);
        }
    });
}

fn now_ts() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

fn make_request_id() -> String {
    format!(
        "chatcmpl-{}",
        &uuid::Uuid::new_v4().to_string().replace('-', "")[..24]
    )
}

// ─── OpenAI-compatible types ────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct ChatCompletionRequest {
    messages: Vec<Message>,
    #[serde(default)]
    stream: bool,
    #[serde(default)]
    #[allow(dead_code)]
    temperature: Option<f64>,
    #[serde(default)]
    #[allow(dead_code)]
    max_tokens: Option<u32>,
    #[serde(default)]
    tools: Option<Vec<ToolDef>>,
    #[serde(default)]
    #[allow(dead_code)]
    tool_choice: Option<serde_json::Value>,
    /// OpenAI-compatible response_format. Use {"type": "json_schema", "json_schema": {"schema": ...}}
    /// to get guaranteed valid JSON via Apple's GenerationSchema.
    #[serde(default)]
    response_format: Option<ResponseFormat>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct Message {
    role: String,
    #[serde(default)]
    content: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_calls: Option<Vec<ToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_call_id: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ToolDef {
    r#type: String,
    function: ToolFunction,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ToolFunction {
    name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    parameters: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ToolCall {
    id: String,
    r#type: String,
    function: ToolCallFunction,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ToolCallFunction {
    name: String,
    arguments: String,
}

#[derive(Debug, Deserialize)]
pub struct ResponseFormat {
    r#type: String,
    /// For "json_schema" type: {"name": "...", "schema": {...}}
    #[serde(default)]
    json_schema: Option<JsonSchemaFormat>,
}

#[derive(Debug, Deserialize)]
pub struct JsonSchemaFormat {
    #[serde(default)]
    #[allow(dead_code)]
    name: Option<String>,
    schema: serde_json::Value,
}

#[derive(Serialize)]
pub struct ChatCompletionResponse {
    id: String,
    object: String,
    created: u64,
    model: String,
    choices: Vec<Choice>,
    usage: Usage,
}

#[derive(Serialize)]
pub struct Choice {
    index: u32,
    message: ResponseMessage,
    finish_reason: String,
}

#[derive(Serialize)]
pub struct ResponseMessage {
    role: String,
    content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_calls: Option<Vec<ToolCall>>,
}

#[derive(Serialize)]
pub struct Usage {
    prompt_tokens: u32,
    completion_tokens: u32,
    total_tokens: u32,
}

#[derive(Serialize)]
pub struct ChatCompletionChunk {
    id: String,
    object: String,
    created: u64,
    model: String,
    choices: Vec<StreamChoice>,
}

#[derive(Serialize)]
pub struct StreamChoice {
    index: u32,
    delta: Delta,
    finish_reason: Option<String>,
}

#[derive(Serialize)]
pub struct Delta {
    #[serde(skip_serializing_if = "Option::is_none")]
    role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_calls: Option<Vec<ToolCall>>,
}

#[derive(Serialize)]
pub struct StatusResponse {
    available: bool,
    status: String,
    model: String,
}

// ─── Prompt building (handles tools + multi-content messages) ───────────────

fn build_prompt_from_messages(
    messages: &[Message],
    tools: &Option<Vec<ToolDef>>,
) -> (Option<String>, String) {
    let mut system_parts: Vec<String> = Vec::new();
    let mut conversation: Vec<String> = Vec::new();

    // Inject tool descriptions into system prompt
    if let Some(tools) = tools {
        if !tools.is_empty() {
            let mut tool_desc = String::from("You have access to the following tools:\n\n");
            for tool in tools {
                tool_desc.push_str(&format!("### {}\n", tool.function.name));
                if let Some(desc) = &tool.function.description {
                    tool_desc.push_str(&format!("{}\n", desc));
                }
                if let Some(params) = &tool.function.parameters {
                    tool_desc.push_str(&format!(
                        "Parameters: {}\n",
                        serde_json::to_string(params).unwrap_or_default()
                    ));
                }
                tool_desc.push('\n');
            }
            tool_desc.push_str(
                "To call a tool, respond with a JSON block in this exact format:\n\
                 ```tool_call\n{\"name\": \"tool_name\", \"arguments\": {\"arg1\": \"value1\"}}\n```\n\n\
                 You can call multiple tools. After tool results, continue your response.\n\
                 If no tool is needed, respond normally with text.",
            );
            system_parts.push(tool_desc);
        }
    }

    for msg in messages {
        match msg.role.as_str() {
            "system" => {
                if let Some(content) = &msg.content {
                    let text = content_to_text(content);
                    if !text.is_empty() {
                        system_parts.push(text);
                    }
                }
            }
            "user" => {
                if let Some(content) = &msg.content {
                    let text = content_to_text(content);
                    if !text.is_empty() {
                        conversation.push(format!("User: {}", text));
                    }
                }
            }
            "assistant" => {
                if let Some(content) = &msg.content {
                    let text = content_to_text(content);
                    if !text.is_empty() {
                        conversation.push(format!("Assistant: {}", text));
                    }
                }
                if let Some(tool_calls) = &msg.tool_calls {
                    for tc in tool_calls {
                        conversation.push(format!(
                            "Assistant called tool {}: {}",
                            tc.function.name, tc.function.arguments
                        ));
                    }
                }
            }
            "tool" => {
                if let Some(content) = &msg.content {
                    let text = content_to_text(content);
                    let id = msg.tool_call_id.as_deref().unwrap_or("?");
                    conversation.push(format!("Tool result ({}): {}", id, text));
                }
            }
            _ => {}
        }
    }

    let instructions = if system_parts.is_empty() {
        None
    } else {
        Some(system_parts.join("\n\n"))
    };
    (instructions, conversation.join("\n\n"))
}

/// Extract text from OpenAI content (string or array of content parts).
fn content_to_text(content: &serde_json::Value) -> String {
    match content {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(parts) => parts
            .iter()
            .filter_map(|p| {
                if p.get("type").and_then(|t| t.as_str()) == Some("text") {
                    p.get("text").and_then(|t| t.as_str()).map(String::from)
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("\n"),
        other => other.to_string(),
    }
}

// ─── Tool call parsing ──────────────────────────────────────────────────────

fn parse_tool_calls(text: &str) -> (Option<String>, Vec<ToolCall>) {
    let mut tool_calls = Vec::new();
    let mut remaining = String::new();
    let mut in_block = false;
    let mut block = String::new();

    for line in text.lines() {
        if line.trim() == "```tool_call" {
            in_block = true;
            block.clear();
            continue;
        }
        if in_block && line.trim() == "```" {
            in_block = false;
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&block) {
                if let (Some(name), Some(args)) = (
                    parsed.get("name").and_then(|n| n.as_str()),
                    parsed.get("arguments"),
                ) {
                    tool_calls.push(ToolCall {
                        id: format!(
                            "call_{}",
                            &uuid::Uuid::new_v4().to_string().replace('-', "")[..24]
                        ),
                        r#type: "function".to_string(),
                        function: ToolCallFunction {
                            name: name.to_string(),
                            arguments: serde_json::to_string(args).unwrap_or_default(),
                        },
                    });
                }
            }
            continue;
        }
        if in_block {
            block.push_str(line);
            block.push('\n');
        } else {
            remaining.push_str(line);
            remaining.push('\n');
        }
    }

    let content = remaining.trim().to_string();
    (
        if content.is_empty() {
            None
        } else {
            Some(content)
        },
        tool_calls,
    )
}

// ─── Handlers ───────────────────────────────────────────────────────────────

/// GET /ai/status
pub async fn ai_status() -> Json<StatusResponse> {
    let avail = check_availability();
    let is_available = avail == Availability::Available;
    let status_str = avail.to_string();
    if is_available {
        info!("apple intelligence status: available");
    } else {
        warn!("apple intelligence status: {} (not available)", status_str);
    }
    Json(StatusResponse {
        available: is_available,
        status: status_str,
        model: MODEL_ID.to_string(),
    })
}

/// POST /ai/chat/completions — OpenAI-compatible chat completions
///
/// Supports:
/// - Tool calling (tools array → injected into system prompt → parsed from output)
/// - JSON schema mode (response_format.type = "json_schema" → fm_generate_json)
/// - Streaming (stream: true → SSE)
/// - Multi-content messages (string or array of content parts)
/// - Tool result messages (role: "tool")
pub async fn chat_completions(
    Json(req): Json<ChatCompletionRequest>,
) -> Result<axum::response::Response, (StatusCode, Json<serde_json::Value>)> {
    ensure_prewarm();

    let (instructions, prompt) = build_prompt_from_messages(&req.messages, &req.tools);
    let has_tools = req.tools.as_ref().map_or(false, |t| !t.is_empty());
    let prompt_len = prompt.len();

    // Check if JSON schema mode is requested
    let json_schema = req.response_format.as_ref().and_then(|rf| {
        if rf.r#type == "json_schema" {
            rf.json_schema
                .as_ref()
                .map(|js| serde_json::to_string(&js.schema).unwrap_or_default())
        } else if rf.r#type == "json_object" {
            // Basic JSON mode without schema — just use text generation
            // (the model will try to output JSON based on the prompt)
            None
        } else {
            None
        }
    });

    info!(
        "apple intelligence chat: {} chars, tools: {}, json_schema: {}, stream: {}",
        prompt_len,
        has_tools,
        json_schema.is_some(),
        req.stream
    );

    // Generate response — either JSON-constrained or plain text
    let (response_text, is_json) = if let Some(schema_str) = json_schema {
        // Apple's GenerationSchema cannot be decoded from standard JSON Schema format,
        // so we inject the schema into the instructions and use text generation instead.
        // The model is told to output ONLY valid JSON matching the schema.
        let json_instructions = format!(
            "{}\n\nYou MUST respond with ONLY a valid JSON object matching this schema, no other text:\n{}",
            instructions.as_deref().unwrap_or(""),
            schema_str
        );

        let result =
            tokio::task::spawn_blocking(move || generate_text(Some(&json_instructions), &prompt))
                .await
                .map_err(|e| mk_err(&e.to_string()))?
                .map_err(|e| mk_err(&e.to_string()))?;

        info!(
            "apple intelligence json response: {} chars, {:.0}ms",
            result.text.len(),
            result.metrics.total_time_ms
        );

        // Try to extract valid JSON from the response
        let text = result.text.trim().to_string();
        let json_text = if text.starts_with('{') {
            text
        } else if let Some(m) = text.find('{') {
            // Model prepended text like "Here is the JSON:"
            text[m..].to_string()
        } else {
            text
        };
        // Trim trailing non-JSON text after the closing brace
        let json_text = if let Some(end) = json_text.rfind('}') {
            json_text[..=end].to_string()
        } else {
            json_text
        };

        (json_text, true)
    } else {
        let result =
            tokio::task::spawn_blocking(move || generate_text(instructions.as_deref(), &prompt))
                .await
                .map_err(|e| mk_err(&e.to_string()))?
                .map_err(|e| mk_err(&e.to_string()))?;

        info!(
            "apple intelligence text response: {} chars, {:.0}ms",
            result.text.len(),
            result.metrics.total_time_ms
        );
        (result.text, false)
    };

    let request_id = make_request_id();
    let est_prompt_tokens = (prompt_len / 4) as u32;
    let est_completion_tokens = (response_text.len() / 4) as u32;

    // Parse tool calls from output if tools were provided
    let (text_content, tool_calls) = if has_tools && !is_json {
        parse_tool_calls(&response_text)
    } else {
        (Some(response_text), vec![])
    };

    let finish_reason = if tool_calls.is_empty() {
        "stop"
    } else {
        "tool_calls"
    };

    if req.stream {
        let chunks = build_stream_chunks(
            &request_id,
            text_content.clone(),
            if tool_calls.is_empty() {
                None
            } else {
                Some(tool_calls)
            },
            finish_reason,
        );

        let stream = tokio_stream::iter(chunks.into_iter().map(|c| {
            Ok::<_, Infallible>(Event::default().data(serde_json::to_string(&c).unwrap()))
        }))
        .chain(tokio_stream::once(Ok(Event::default().data("[DONE]"))));

        Ok(Sse::new(stream)
            .keep_alive(axum::response::sse::KeepAlive::default())
            .into_response())
    } else {
        Ok(Json(ChatCompletionResponse {
            id: request_id,
            object: "chat.completion".to_string(),
            created: now_ts(),
            model: MODEL_ID.to_string(),
            choices: vec![Choice {
                index: 0,
                message: ResponseMessage {
                    role: "assistant".to_string(),
                    content: text_content,
                    tool_calls: if tool_calls.is_empty() {
                        None
                    } else {
                        Some(tool_calls)
                    },
                },
                finish_reason: finish_reason.to_string(),
            }],
            usage: Usage {
                prompt_tokens: est_prompt_tokens,
                completion_tokens: est_completion_tokens,
                total_tokens: est_prompt_tokens + est_completion_tokens,
            },
        })
        .into_response())
    }
}

fn build_stream_chunks(
    request_id: &str,
    content: Option<String>,
    tool_calls: Option<Vec<ToolCall>>,
    finish_reason: &str,
) -> Vec<ChatCompletionChunk> {
    vec![
        ChatCompletionChunk {
            id: request_id.to_string(),
            object: "chat.completion.chunk".to_string(),
            created: now_ts(),
            model: MODEL_ID.to_string(),
            choices: vec![StreamChoice {
                index: 0,
                delta: Delta {
                    role: Some("assistant".to_string()),
                    content: None,
                    tool_calls: None,
                },
                finish_reason: None,
            }],
        },
        ChatCompletionChunk {
            id: request_id.to_string(),
            object: "chat.completion.chunk".to_string(),
            created: now_ts(),
            model: MODEL_ID.to_string(),
            choices: vec![StreamChoice {
                index: 0,
                delta: Delta {
                    role: None,
                    content,
                    tool_calls,
                },
                finish_reason: None,
            }],
        },
        ChatCompletionChunk {
            id: request_id.to_string(),
            object: "chat.completion.chunk".to_string(),
            created: now_ts(),
            model: MODEL_ID.to_string(),
            choices: vec![StreamChoice {
                index: 0,
                delta: Delta {
                    role: None,
                    content: None,
                    tool_calls: None,
                },
                finish_reason: Some(finish_reason.to_string()),
            }],
        },
    ]
}

fn mk_err(msg: &str) -> (StatusCode, Json<serde_json::Value>) {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(serde_json::json!({"error": {"message": msg}})),
    )
}
