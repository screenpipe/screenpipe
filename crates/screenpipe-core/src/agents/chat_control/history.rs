// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Read-only native conversation history, shared by chat and scheduled agents.
//! Reuses chat_control's transcript parsing and never starts an external agent.
use super::*;
use rusqlite::{params, Connection, OpenFlags};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Claude,
    Codex,
    Hermes,
}
impl Source {
    pub fn label(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Hermes => "hermes",
        }
    }
    pub fn app(self) -> &'static str {
        match self {
            Self::Claude => "Claude Code",
            Self::Codex => "Codex",
            Self::Hermes => "Hermes",
        }
    }
}
#[derive(Debug, Deserialize)]
pub struct HistoryRequest {
    pub source: Source,
    #[serde(default)]
    pub query: String,
    pub id: Option<String>,
    #[serde(default)]
    pub offset: usize,
    pub limit: Option<usize>,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct Message {
    pub source: String,
    pub timestamp: String,
    pub app: String,
    pub role: String,
    pub text: String,
    pub truncated: bool,
}
fn message(
    source: Source,
    id: &str,
    offset: usize,
    timestamp: i64,
    role: &str,
    text: String,
) -> Option<Message> {
    if !matches!(role, "user" | "assistant")
        || text.trim().is_empty()
        || is_codex_harness_context(&text)
        || is_wrapped_directive(&text)
    {
        return None;
    }
    Some(Message {
        source: format!("chat:{}:{}:{}", source.label(), id, offset),
        timestamp: DateTime::from_timestamp_millis(timestamp)?.to_rfc3339(),
        app: source.app().into(),
        role: role.into(),
        truncated: text.chars().count() > MAX_SEARCH_BODY_CHARS,
        text: text.chars().take(MAX_SEARCH_BODY_CHARS).collect(),
    })
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 200
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        && id != "."
        && id != ".."
}
pub fn citation(value: &str) -> Result<(Source, String, usize), String> {
    let parts: Vec<_> = value.split(':').collect();
    if parts.len() != 4 || parts[0] != "chat" || !valid_id(parts[2]) {
        return Err("Invalid chat source address".into());
    }
    let source = match parts[1] {
        "claude" => Source::Claude,
        "codex" => Source::Codex,
        "hermes" => Source::Hermes,
        _ => return Err("Unsupported chat source".into()),
    };
    Ok((
        source,
        parts[2].into(),
        parts[3].parse().map_err(|_| "Invalid message offset")?,
    ))
}
fn files(source: Source) -> Result<Vec<PathBuf>, String> {
    let root = match source {
        Source::Claude => home_dir()?.join(".claude/projects"),
        Source::Codex => home_dir()?.join(".codex/sessions"),
        Source::Hermes => return Ok(vec![]),
    };
    fs::read_dir(&root)
        .map_err(|_| format!("{} history directory is unavailable", source.label()))?;
    Ok(if source == Source::Codex {
        codex_session_files()
    } else {
        collect_jsonl_files(&root)
    })
}
fn summary(source: Source, path: &Path) -> Result<(ChatSearchResult, String), String> {
    match source {
        Source::Claude => parse_claude_chat(path),
        Source::Codex => parse_codex_chat(path),
        Source::Hermes => Err("Not a JSONL source".into()),
    }
}
fn hermes() -> Result<Connection, String> {
    let root = std::env::var_os("HERMES_HOME")
        .map(PathBuf::from)
        .unwrap_or(home_dir()?.join(".hermes"));
    let connection = Connection::open_with_flags(
        root.join("state.db"),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| "Hermes history unavailable")?;
    connection
        .busy_timeout(Duration::from_secs(2))
        .map_err(|e| e.to_string())?;
    Ok(connection)
}
pub fn search(request: HistoryRequest) -> Result<Value, String> {
    let limit = request.limit.unwrap_or(20).clamp(1, 50);
    if request.query.chars().count() > 200 {
        return Err("Query is too long".into());
    }
    if request.source == Source::Hermes {
        return search_hermes(&hermes()?, &request, limit);
    }
    search_files(&request, &files(request.source)?, limit)
}
fn search_files(
    request: &HistoryRequest,
    paths: &[PathBuf],
    limit: usize,
) -> Result<Value, String> {
    let mut results = vec![];
    let end = request.offset.saturating_add(limit).min(paths.len());
    let mut warnings = vec![];
    for path in paths.iter().skip(request.offset).take(limit) {
        match summary(request.source, path) {
            Ok((item, body)) if query_matches(&item, &request.query, &body) => results.push(json!({"source":request.source,"id":item.id,"title":item.title,"preview":item.preview,"updated_at":item.updated_at})),
            Ok(_) => (),
            Err(_) => warnings.push("A transcript could not be read or contains no user conversation"),
        }
    }
    if paths.len() >= MAX_EXTERNAL_FILES {
        warnings.push("Only the 1000 most recent discoverable transcript files are indexed; older history is outside coverage");
    }
    Ok(
        json!({"results":results,"next_offset": if end < paths.len() {Some(end)} else {None},"warnings":warnings,"coverage":"Each page searches up to 50 files; text search covers the first 5000 lines / 60000 characters per file. Read messages for original evidence."}),
    )
}
pub fn read(request: HistoryRequest) -> Result<Value, String> {
    let id = request
        .id
        .as_deref()
        .filter(|id| valid_id(id))
        .ok_or("Invalid chat id")?;
    let limit = request.limit.unwrap_or(20).clamp(1, 50);
    if request.source == Source::Hermes {
        return read_hermes(&hermes()?, id, request.offset, limit);
    }
    let mut paths = files(request.source)?;
    // Resolve the usual filename identity first, then support older files whose
    // session id appears only in metadata without penalizing every source read.
    paths.sort_by_key(|path| {
        !path
            .file_stem()
            .and_then(|s| s.to_str())
            .is_some_and(|stem| stem == id || stem.ends_with(&format!("-{id}")))
    });
    let path = paths
        .into_iter()
        .find(|path| summary(request.source, path).is_ok_and(|(item, _)| item.id == id))
        .ok_or("Chat not found in the bounded local index")?;
    read_file(request.source, id, &path, request.offset, limit)
}
fn read_file(
    source: Source,
    id: &str,
    path: &Path,
    offset: usize,
    limit: usize,
) -> Result<Value, String> {
    let file = File::open(path).map_err(|_| "Chat transcript unavailable")?;
    let mut lines = BufReader::new(file)
        .lines()
        .enumerate()
        .skip(offset)
        .peekable();
    let mut messages = vec![];
    let mut next = offset;
    // Page physical records, including non-message records. Never silently skip
    // the rest of a long transcript because an early page has no user prose.
    for _ in 0..limit {
        let Some((index, line)) = lines.next() else {
            break;
        };
        next = index + 1;
        let value: Value = serde_json::from_str(&line.map_err(|_| "Could not read transcript")?)
            .map_err(|_| "Malformed transcript record; retry after the writer finishes")?;
        let Some(at) = parse_timestamp_ms(value.get("timestamp")) else {
            continue;
        };
        let (role, text) = match source {
            Source::Claude => {
                if is_claude_bookkeeping(&value) || value["isSidechain"] == true {
                    continue;
                }
                (
                    value["type"].as_str().unwrap_or(""),
                    value_message_text(&value),
                )
            }
            Source::Codex => {
                let payload = &value["payload"];
                if value["type"] != "response_item" || payload["type"] != "message" {
                    continue;
                }
                (
                    payload["role"].as_str().unwrap_or(""),
                    codex_payload_text(payload),
                )
            }
            Source::Hermes => unreachable!(),
        };
        if let Some(msg) = message(source, id, index, at, role, text) {
            messages.push(msg);
        }
    }
    Ok(
        json!({"messages":messages,"next_offset": if lines.peek().is_some() {Some(next)} else {None}}),
    )
}
fn search_hermes(db: &Connection, request: &HistoryRequest, limit: usize) -> Result<Value, String> {
    let mut stmt = db.prepare("SELECT s.id, COALESCE(s.title,''), s.started_at FROM sessions s WHERE ?1 = '' OR EXISTS (SELECT 1 FROM messages m WHERE m.session_id=s.id AND m.role IN ('user','assistant') AND instr(lower(m.content),lower(?1))>0) ORDER BY s.started_at DESC, s.id LIMIT ?2 OFFSET ?3").map_err(|_| "Unsupported Hermes history schema")?;
    let mut rows = stmt
        .query(params![
            request.query,
            (limit + 1) as i64,
            i64::try_from(request.offset).map_err(|_| "Offset too large")?
        ])
        .map_err(|e| e.to_string())?;
    let mut results = vec![];
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        results.push(json!({"source":"hermes","id":row.get::<_,String>(0).map_err(|e| e.to_string())?,"title":row.get::<_,String>(1).map_err(|e| e.to_string())?,"updated_at":(row.get::<_,f64>(2).map_err(|e| e.to_string())?*1000.) as i64}));
    }
    let more = results.len() > limit;
    results.truncate(limit);
    Ok(json!({"results":results,"next_offset":more.then_some(request.offset+limit),"warnings":[]}))
}
fn read_hermes(db: &Connection, id: &str, offset: usize, limit: usize) -> Result<Value, String> {
    let mut stmt = db.prepare("SELECT id,role,content,timestamp FROM messages WHERE session_id=?1 AND id>=?2 AND role IN ('user','assistant') ORDER BY id LIMIT ?3").map_err(|_| "Unsupported Hermes history schema")?;
    let mut rows = stmt
        .query(params![
            id,
            i64::try_from(offset).map_err(|_| "Offset too large")?,
            (limit + 1) as i64
        ])
        .map_err(|e| e.to_string())?;
    let mut messages = vec![];
    let mut count = 0;
    let mut next = None;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let index = row.get::<_, i64>(0).map_err(|e| e.to_string())? as usize;
        if count == limit {
            next = Some(index);
            break;
        }
        count += 1;
        let role: String = row.get(1).map_err(|e| e.to_string())?;
        let text: String = row
            .get::<_, Option<String>>(2)
            .map_err(|e| e.to_string())?
            .unwrap_or_default();
        let at: f64 = row.get(3).map_err(|e| e.to_string())?;
        if let Some(msg) = message(Source::Hermes, id, index, (at * 1000.) as i64, &role, text) {
            messages.push(msg);
        }
    }
    Ok(json!({"messages":messages,"next_offset":next}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn paginates_past_the_first_search_page() {
        let dir = tempfile::tempdir().unwrap();
        let mut paths = vec![];
        for n in 0..55 {
            let path = dir.path().join(format!("session-{n}.jsonl"));
            fs::write(&path, json!({"sessionId":format!("session-{n}"),"type":"user","timestamp":"2026-10-01T10:00:00Z","message":{"content": if n == 54 {"needle workflow"} else {"ordinary task"}}}).to_string()).unwrap();
            paths.push(path);
        }
        let mut request = HistoryRequest {
            source: Source::Claude,
            query: "needle".into(),
            id: None,
            offset: 0,
            limit: Some(50),
        };
        let first = search_files(&request, &paths, 50).unwrap();
        assert_eq!(first["results"], json!([]));
        request.offset = first["next_offset"].as_u64().unwrap() as usize;
        let next = search_files(&request, &paths, 50).unwrap();
        assert_eq!(next["results"][0]["id"], "session-54");
        assert!(next["next_offset"].is_null());
    }
    #[test]
    fn reads_original_claude_messages_with_roles_and_provenance() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("claude-session.jsonl");
        let lines = [
            json!({"type":"user","sessionId":"claude-session","timestamp":"2026-10-01T10:00:00Z","message":{"role":"user","content":"Compare the source documents."}}),
            json!({"type":"assistant","timestamp":"2026-10-01T10:00:01Z","message":{"role":"assistant","content":[{"type":"text","text":"Here is a draft comparison."},{"type":"tool_use","id":"tool","name":"bash","input":{"command":"private command"}}]}}),
        ];
        fs::write(
            &path,
            lines
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .unwrap();
        let first = read_file(Source::Claude, "claude-session", &path, 0, 1).unwrap();
        assert_eq!(
            first["messages"][0]["text"],
            "Compare the source documents."
        );
        assert_eq!(first["messages"][0]["role"], "user");
        assert_eq!(
            first["messages"][0]["source"],
            "chat:claude:claude-session:0"
        );
        assert_eq!(first["next_offset"], 1);
        let next = read_file(Source::Claude, "claude-session", &path, 1, 1).unwrap();
        assert_eq!(next["messages"][0]["role"], "assistant");
        assert_eq!(next["messages"][0]["text"], "Here is a draft comparison.");
        assert!(!next.to_string().contains("private command"));
        assert!(next["next_offset"].is_null());
    }

    #[test]
    fn reads_original_codex_messages_after_metadata_and_filters_injected_context() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("chat.jsonl");
        let lines = [
            json!({"type":"session_meta","payload":{"id":"chat"}}),
            json!({"type":"response_item","timestamp":"2026-10-01T10:00:00Z","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>injected</environment_context>"}]}}),
            json!({"type":"response_item","timestamp":"2026-10-01T10:00:01Z","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Compare the source documents."}]}}),
        ];
        fs::write(
            &path,
            lines
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .unwrap();
        let first = read_file(Source::Codex, "chat", &path, 0, 2).unwrap();
        assert_eq!(first["messages"], json!([]));
        assert_eq!(first["next_offset"], 2);
        let next = read_file(Source::Codex, "chat", &path, 2, 2).unwrap();
        assert_eq!(next["messages"][0]["source"], "chat:codex:chat:2");
        assert_eq!(next["messages"][0]["text"], "Compare the source documents.");
        assert_eq!(next["messages"][0]["role"], "user");
        assert!(next["next_offset"].is_null());
    }
    #[test]
    fn hermes_reads_messages_by_stable_id_and_does_not_expose_tool_content() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE sessions(id TEXT,title TEXT,started_at REAL); CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,content TEXT,timestamp REAL); INSERT INTO sessions VALUES('session-1','Research',1790848800); INSERT INTO messages VALUES(1,'session-1','user','Compare sources',1790848800),(2,'session-1','tool','secret tool output',1790848801),(3,'session-1','assistant','Draft comparison',1790848802);").unwrap();
        let request = HistoryRequest {
            source: Source::Hermes,
            query: "Compare".into(),
            id: None,
            offset: 0,
            limit: Some(1),
        };
        assert_eq!(
            search_hermes(&db, &request, 1).unwrap()["results"][0]["id"],
            "session-1"
        );
        let page = read_hermes(&db, "session-1", 0, 1).unwrap();
        assert_eq!(page["messages"][0]["source"], "chat:hermes:session-1:1");
        assert_eq!(page["next_offset"], 3);
        let next = read_hermes(&db, "session-1", 3, 1).unwrap();
        assert_eq!(next["messages"][0]["text"], "Draft comparison");
        assert!(next["next_offset"].is_null());
    }
    #[test]
    fn rejects_path_and_source_injection() {
        for value in [
            "chat:codex:../../secret:0",
            "chat:claude:/tmp/file:0",
            "chat:shell:id:0",
            "chat:codex:id:-1",
        ] {
            assert!(citation(value).is_err());
        }
        assert_eq!(
            citation("chat:claude:session-1:51").unwrap(),
            (Source::Claude, "session-1".into(), 51)
        );
    }
}
