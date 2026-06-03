# Honcho Synthesizer Improvement Specs

## Context

The current synthesizer (`src/synthesizer.rs`) queries raw DB rows via `db.search()`,
converts them to `RawEvent` structs, groups into focus spans by app name, and renders
flat text like:

```
13:06–13:07 — Firefox: feat: add optional Honcho memory backend by ajspig · Pull Request #2673...
  app.honcho.dev/explore?workspace=agents&view=sessions&session=screenpipe-2026-05-01
```

Problems: raw window titles with browser suffixes, full PR titles as noise, URLs dumped
without context, OCR content thrown away (only window title survives), no deduplication,
no duration info, no key text extraction.

Screenpipe's `/activity-summary` endpoint already computes rich aggregated data (app usage
with durations, window/tab activity, key texts from accessibility, audio with speakers).
Built-in pipes (day-recap, meeting-summary) use this endpoint. The honcho synthesizer
should too.

---

## Spec A: Replace raw search with activity-summary SQL queries

### Goal
Replace `poll_recent_events` (raw `/search` → `RawEvent[]` → focus spans) with the same
SQL queries that power `/activity-summary`, called directly via `db.execute_raw_sql()`.

### What changes

#### `src/service.rs`
- **Delete** `poll_recent_events()` — the method that calls `db.search()` and maps
  `SearchResult` → `RawEvent`
- **Add** `poll_activity_summary(&self, since, until) -> Result<ActivitySummary>` that:
  - Builds the 5 SQL query strings (apps, windows, texts, audio speakers, audio transcripts)
    copied from `screenpipe-engine/src/routes/activity_summary.rs` lines 124-215
  - Calls `self.db.execute_raw_sql()` for each (parallel via `tokio::join!`)
  - Parses JSON results into local `ActivitySummary` struct
- **Update** `sync_once()` to call `poll_activity_summary` instead of `poll_recent_events`,
  then pass the result to the rewritten synthesizer

#### `src/synthesizer.rs`
- **Delete** `RawEvent`, `EventType`, `FocusSpan`, and focus-span grouping logic
- **Add** local types mirroring the activity-summary response:
  ```rust
  pub struct ActivitySummary {
      pub apps: Vec<AppUsage>,
      pub windows: Vec<WindowActivity>,
      pub key_texts: Vec<KeyText>,
      pub audio: AudioSummary,
  }
  pub struct AppUsage { pub name: String, pub minutes: f64 }
  pub struct WindowActivity {
      pub app_name: String,
      pub window_name: String,
      pub browser_url: String,
      pub minutes: f64,
  }
  pub struct KeyText {
      pub text: String,
      pub app_name: String,
      pub window_name: String,
  }
  pub struct AudioSummary {
      pub speakers: Vec<SpeakerSummary>,
      pub top_transcriptions: Vec<AudioSegment>,
  }
  pub struct SpeakerSummary { pub name: String, pub segment_count: i64 }
  pub struct AudioSegment {
      pub transcription: String,
      pub speaker: String,
      pub device: String,
      pub timestamp: String,
  }
  ```
- **Rewrite** `synthesize()` to accept `&ActivitySummary` instead of `&[RawEvent]`
- **Rewrite** `format_observations()` to iterate `windows` (already grouped by
  app+window with durations) and `key_texts` instead of building focus spans
- **Keep** privacy filter, adapted to operate on `key_texts` text + `windows` window_name
- **Keep** `MAX_MESSAGE_LEN`, truncation

#### Helper functions to copy
From `activity_summary.rs` lines 355-369:
```rust
fn str_field(row: &serde_json::Value, key: &str) -> String
fn num_field(row: &serde_json::Value, key: &str) -> f64
```

### Example output (target format)
```
Firefox (12m): reviewed PR #2673 (honcho backend), Honcho session explorer
  github.com, app.honcho.dev
VS Code (25m): synthesizer.rs, service.rs
Slack (8m): #screenpipe channel

Key texts:
  [VS Code] "refactored focus span grouping to use activity summary"
  [Firefox] "add optional Honcho memory backend"

Audio:
  13:40 [user, mic] "let's keep the privacy filter on the client side..."
  13:42 [speaker-2, speaker] "sounds good, what about the sync interval?"
```

### What gets deleted from honcho
- `RawEvent` struct and `EventType` enum
- `FocusSpan` struct
- `poll_recent_events()` method
- The `SearchResult` → `RawEvent` mapping loop
- Focus-span grouping logic in `format_observations()`

### Dependencies
- No new crate dependencies (already has `screenpipe-db` with `DatabaseManager`)
- Uses `db.execute_raw_sql()` which is already public
- `serde_json` already in deps for the JSON parsing

### SQL queries to copy
All 5 queries from `screenpipe-engine/src/routes/activity_summary.rs`:
1. **Apps query** (lines 124-139): App usage with frame counts, minutes, first/last seen
2. **Windows query** (lines 143-161): Window/tab activity grouped by app+window with URLs
3. **Texts query** (lines 167-189): Key text per app+window, prefers input fields, 30-300 chars
4. **Audio speakers query** (lines 192-198): Speaker names with segment counts
5. **Audio transcripts query** (lines 204-215): Top 20 transcriptions by length

---

## Spec B: Spec A + workflow classifier annotations

### Goal
Layer workflow event labels onto the activity summary output, so Honcho messages include
semantic context like `[code_review]` or `[deep_work]`.

### Prerequisites
- Spec A implemented first
- Workflow classifier running (graceful degradation if not)

### Architecture
Workflow classifier events are **ephemeral** — they exist only in an in-memory
`tokio::sync::broadcast` channel (capacity 10k) in the `screenpipe-events` crate.
They are NOT persisted to any database table. Currently consumed only by the pipe
scheduler to trigger matching pipes.

Access: `screenpipe_events::subscribe_to_event::<WorkflowEvent>("workflow_event")`

### What changes

#### `screenpipe-honcho/Cargo.toml`
- Add dependency: `screenpipe-events`

#### `src/service.rs`
- **Add** a background task on startup that subscribes to `"workflow_event"` broadcast
- **Buffer** received `WorkflowEvent`s in `Arc<Mutex<Vec<WorkflowEvent>>>` (or bounded channel)
- **In `sync_once()`**: drain the buffer, pass events alongside `ActivitySummary` to synthesizer
- **Pass** `HonchoService::new()` needs access to the event subscription (or spawn internally)

#### `src/synthesizer.rs`
- **Update** `synthesize()` signature: `(&self, summary: &ActivitySummary, events: &[WorkflowEvent])`
- **Add** time-overlap matching: for each app in the summary, check if any `WorkflowEvent`
  overlaps its time range
- **Annotate** output lines with matched labels: `[code_review] Firefox (12m): ...`
- **Graceful degradation**: empty events slice = no labels, output identical to Spec A

#### WorkflowEvent fields (from screenpipe-events)
```rust
pub struct WorkflowEvent {
    pub event_type: String,      // e.g., "code_review", "deep_work_session"
    pub confidence: f64,         // ≥0.75 threshold (already filtered by classifier)
    pub description: String,
    pub activities: Vec<...>,    // source activities that triggered classification
    pub timestamp: DateTime<Utc>,
}
```

### Example output (target format)
```
[code_review] Firefox (12m): reviewed PR #2673 (honcho backend)
  github.com
[deep_work] VS Code (25m): synthesizer.rs, service.rs
Slack (8m): #screenpipe channel

Audio:
  13:40 [user, mic] "let's keep the privacy filter on the client side..."
```

### Graceful degradation
- Classifier not running → no events arrive → Spec A output unchanged
- Classifier running but no match for a span → span rendered without label
- Multiple events match one span → pick highest confidence

---

## Implementation order
1. Implement Spec A (standalone value, no new deps)
2. Layer Spec B on top (adds `screenpipe-events` dep, broadcast subscription)

## Key reference files
- Activity summary SQL: `crates/screenpipe-engine/src/routes/activity_summary.rs`
- Current honcho service: `crates/screenpipe-honcho/src/service.rs`
- Current synthesizer: `crates/screenpipe-honcho/src/synthesizer.rs`
- Honcho client: `crates/screenpipe-honcho/src/client.rs`
- Event bus: `crates/screenpipe-events/src/events_manager.rs`
- Workflow classifier: `crates/screenpipe-engine/src/workflow_classifier.rs`
- Workflow event type: `crates/screenpipe-events/src/custom_events/workflow.rs`
