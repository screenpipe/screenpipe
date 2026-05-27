# Pipe Execution Reliability Spec

## Current Architecture

All pipe state lives in-memory (`Arc<Mutex<HashMap>>`). Logs written as JSON files to `~/.screenpipe/pipes/{name}/logs/`. A global `Semaphore::new(1)` serializes all pipe execution. The Pi agent subprocess uses `wait_with_output()` with **no timeout**. PID is captured from `child.id()` at spawn (line 198 of pi.rs) but stored as `ExecutionHandle { pid: 0 }` in the running map (lines 371, 756 of mod.rs) — the real PID from spawn is never written back.

### State Dependencies (what a single pipe run touches)

```
pipe.md (config + prompt)
    ├── store.bin (AI preset → model + provider)
    │     └── may be written by Tauri app concurrently
    ├── ~/.pi/agent/models.json (provider config, merged on every run)
    ├── ~/.pi/agent/auth.json (API keys, merged on every run)
    ├── pi binary (found via PATH/known locations)
    ├── screenpipe API at localhost:3030 (queried by pipe during execution)
    │     └── SQLite DB (OCR, audio, UI data the pipe reads)
    ├── LLM provider API (external network call)
    │     └── API key (from auth.json or SCREENPIPE_API_KEY env)
    ├── ./output/ directory (pipe writes results here)
    └── ./logs/ directory (execution logs written after completion)
```

Every one of these can fail independently, mid-execution.

---

## Complete Edge Case Inventory

### A. Model & Provider Resolution

#### A1. Model switched in UI while pipe is running
**Current:** Preset resolved at queue time (line 378-395). Running execution unaffected.
**But:** `resolve_preset()` reads `store.bin` with no locking. If Tauri writes store.bin at the exact moment the scheduler reads it, you get a partial read → JSON parse failure → `None` → silent fallback to pipe.md defaults.
**Required:** Read store.bin atomically (read into buffer, then parse). Or use SQLite for presets too.

#### A2. Model switched between queue and execution
**Current:** There IS no queue — preset resolved right before `executor.run()`. But with the proposed DB queue, a pipe could sit queued for minutes while user changes preset.
**Required:** Snapshot the resolved model/provider into the execution row at queue time. Execution uses the snapshot, not a live re-resolve.

#### A3. Preset deleted while pipe references it
**Current:** `resolve_preset()` returns `None` → falls back to pipe.md `model:` field. Silent. User thinks they're using Claude Opus but pipe runs with Haiku (the pipe.md default).
**Required:** If preset not found, fail the execution with clear error: "Preset 'xyz' no longer exists. Update pipe config or set a new default."

#### A4. Model name typo or model not available on provider
**Current:** Pi subprocess gets an error from the LLM API. stderr captured but truncated to 5KB. Logged as generic failure.
**Required:** Parse common LLM API errors (model_not_found, invalid_api_key, rate_limited) from stderr. Surface structured `error_type` in API response so UI can show actionable message.

#### A5. Provider requires API key but key is missing/expired
**Current:** `ensure_pi_config()` writes `SCREENPIPE_API_KEY` env var and merges auth.json. But if screenpipe cloud token expires, pi gets a 401. Stderr says "unauthorized" but user sees generic failure.
**Required:** Detect auth errors. Surface "API key expired" or "API key missing for provider X" in execution error.

#### A6. Custom provider URL changed/unreachable
**Current:** Provider URL comes from preset → models.json merge. If URL becomes unreachable, pi hangs on HTTP timeout (could be 30s-2min depending on the HTTP client pi uses internally).
**Required:** This is a sub-case of the general timeout problem. The execution timeout (proposed 5min) covers this.

#### A7. Ollama model not pulled / not running
**Current:** If provider=ollama and Ollama isn't running or model isn't pulled, pi fails immediately with connection refused. But the error is buried in stderr.
**Required:** Pre-flight check: if provider=ollama, verify `curl http://localhost:11434/api/tags` is reachable before spawning pi. Surface "Ollama not running" or "Model X not found in Ollama" as structured error.

#### A8. `store.bin` corrupted / partially written
**Current:** `serde_json::from_str()` returns `Err` → `resolve_preset()` returns `None` → silent fallback.
**Required:** Log warning: "store.bin is corrupted, using pipe defaults". Consider atomic write (write to tmp, rename) when creating bootstrap store.bin.

#### A9. Provider mapping incomplete
**Current:** Only maps `pi`, `native-ollama`, `openai`, `custom`. Any other provider string → `None` → no provider passed to pi → pi uses its own default.
**Required:** Either fail explicitly for unknown providers, or pass through raw string and let pi handle it.

---

### B. Computer Restart / Sleep / Power

#### B1. Computer restarts while pipe is running
**Current:** Process killed by OS. In-memory state lost entirely. No record the execution ever happened. Pipe might have been mid-write to output file → partial/corrupt output.
**Required:**
- DB row with `status='running'` survives restart
- On startup: detect orphaned rows, mark as `failed` with error "interrupted by system restart"
- Check for partial output files and either clean up or mark as incomplete

#### B2. macOS sleep during execution
**Current:** Process suspended by OS. When wake: process resumes but wall-clock has jumped. LLM API connection likely timed out/closed. Pi subprocess may get broken pipe or connection reset.
**Required:**
- After wake: check if running executions are still alive (PID check)
- If process died during sleep: mark as failed
- If process resumed but hung (no output for >60s after wake): timeout and kill
- Consider: detect sleep/wake events (already done in `sleep_monitor.rs`) and proactively kill running pipes before sleep

#### B3. macOS App Nap throttles screenpipe
**Current:** App Nap can suspend the server process → scheduler stops ticking → pipes don't run on schedule. When un-napped, scheduler resumes but missed windows are gone.
**Required:**
- Already mitigated by `NSProcessInfo` activity assertion in Tauri app
- But CLI (`screenpipe` binary) doesn't have this protection
- For CLI: document that App Nap can affect scheduling reliability

#### B4. Computer clock jumps (NTP sync, timezone change, DST)
**Current:** Scheduler uses `Utc::now()` and `Local::now()`. `last_run` is in-memory HashMap. Clock jump forward → multiple pipes suddenly "due". Clock jump backward → pipe that just ran appears to not have run yet (re-runs).
**Required:**
- Use monotonic time for interval scheduling (not wall clock)
- Store `last_run` in DB (survives restart, single source of truth)
- Cap catch-up: if >3 runs are due after a clock jump, only run once
- Cron schedules should still use wall clock (that's what cron means)

#### B5. Laptop lid close → WiFi drops → LLM API mid-response
**Current:** Pi process blocks on HTTP read. Eventually the OS TCP timeout fires (could be minutes). Pi returns error. Pipe fails.
**Required:** This is a sub-case of the timeout. With 5min execution timeout, the pipe gets killed before the TCP timeout. But: partial response from LLM is lost. Consider: pi should checkpoint partial work (future, complex).

---

### C. Logs & Output

#### C1. Log directory doesn't exist
**Current:** `std::fs::create_dir_all(&log_dir)` (line 826). Silently handles this.
**Status:** OK.

#### C2. Disk full while writing log
**Current:** `std::fs::write()` returns Err, ignored with `let _ =` (line 829). Log lost.
**Required:** At minimum, log to stderr (tracing). For DB: SQLite will return SQLITE_FULL — handle gracefully, don't crash.

#### C3. Logs accumulate indefinitely
**Current:** No rotation. Every run creates a new JSON file in `~/.screenpipe/pipes/{name}/logs/`. Over months, thousands of small files.
**Required:**
- DB: prune executions older than 30 days (configurable)
- File cleanup: delete JSON logs older than 7 days on startup
- In-memory: already capped at 50 (good)

#### C4. Sensitive data in logs
**Current:** stdout/stderr may contain OCR text, transcriptions, personal data. Stored as plaintext JSON files.
**Required:**
- JSON log files should have restrictive permissions (0600)
- DB: same file permissions as main screenpipe DB
- Consider: option to redact logs (strip API keys, PII) — but complex, phase 3+

#### C5. Log truncation loses critical debug info
**Current:** stdout truncated to 10KB, stderr to 5KB (line 807-808). Pi agent can produce verbose output.
**Required:**
- DB: store full output (SQLite TEXT has no practical limit)
- API: paginate output retrieval (`GET /pipes/:id/executions/:exec_id/output?offset=0&limit=10000`)
- Keep truncation only for in-memory cache and list endpoints

#### C6. Output files from crashed/timed-out run
**Current:** Pipe may have written partial files to `./output/` before crash. No cleanup. Next run may append to or overwrite partial files.
**Required:**
- Each execution should write to a timestamped subdirectory: `./output/{execution_id}/`
- On timeout/crash: directory exists but is marked incomplete
- Don't auto-delete — user may want partial results

#### C7. Concurrent log writes
**Current:** Manual run and scheduled run can't overlap (semaphore=1). But if semaphore increases, two runs of same pipe could write to same log directory.
**Required:** Execution-scoped output dirs (see C6). Log writes go to DB row (no file conflicts).

#### C8. Cannot correlate pipe output with screenpipe data
**Current:** Pipe queries screenpipe API with a time range. Output written to files. No link between "which frames/audio the pipe saw" and "what it produced".
**Required (future):** Store the time range and query parameters in the execution row. Enables: "show me what data this pipe run was based on."

---

### D. Process Management

#### D1. PID tracking is wrong
**Current:** `child.id()` is captured at line 198 of pi.rs and returned in `AgentOutput.pid`. But `ExecutionHandle { pid: 0 }` is inserted into the running map at lines 371 and 756 of mod.rs BEFORE `executor.run()` is called. The real PID is never written back to the running map — it's only available after `run()` returns (too late for cancellation).
**Required:**
- Change `AgentExecutor::run()` to take a callback/channel for PID reporting
- Or: return `(PID, Future<AgentOutput>)` instead of just `Future<AgentOutput>`
- Or: split into `spawn() → ExecutionHandle` and `wait(handle) → AgentOutput`
- The DB row should be updated with PID immediately after spawn

#### D2. Pi spawns child processes
**Current:** Pi may spawn bash commands, npm processes, etc. `kill_process()` only kills the pi PID itself. Children become orphans.
**Required:**
- Use process groups: `cmd.process_group(0)` (unstable Rust) or `setsid` on Unix
- Kill the entire process group: `kill(-pgid, SIGTERM)`
- Windows: use Job Objects to group child processes

#### D3. Kill sends SIGTERM but process ignores it
**Current:** `kill -TERM` sent once. No follow-up. If pi ignores SIGTERM (e.g., stuck in syscall), process runs forever.
**Required:**
- SIGTERM → wait 5s → SIGKILL
- Update execution status to `cancelled` or `timed_out` regardless of whether kill succeeds
- Release semaphore regardless

#### D4. Pi binary not found after it was found
**Current:** `is_available()` checks `find_pi_executable()` before run. But between the check and `run()`, pi could be removed (bun uninstall, PATH change). `cmd.spawn()` returns Err.
**Required:** Already handled — `spawn()` error propagates to `PipeRunLog { success: false }`. But error message should be clear: "pi binary not found at {path}".

#### D5. Pi binary version mismatch
**Current:** No version check. Pi is installed via `bun add -g @earendil-works/pi-coding-agent` with no pinned version. Auto-update could break compatibility.
**Required:** Pin pi version in `ensure_installed()`. Or at minimum, check `pi --version` output and warn if unexpected.

#### D6. Multiple screenpipe instances running pipes
**Current:** Each instance has its own PipeManager with its own in-memory state. Both could try to run the same pipe, spawn duplicate pi processes.
**Required:** DB-based locking. Before starting execution, `INSERT INTO pipe_executions` with a unique constraint or advisory lock. Second instance gets conflict.

---

### E. Scheduling

#### E1. Schedule changed while execution is queued
**Current:** No queue exists (scheduler fires inline). With proposed queue: execution was queued with old schedule, user changes to "manual" or different interval.
**Required:** Queue entries store the trigger reason. If pipe disabled or schedule changed to "manual", dequeue pending runs.

#### E2. Pipe enabled with schedule that was "due" hours ago
**Current:** `last_run` defaults to `DateTime::UNIX_EPOCH` (line 721). So enabling a pipe with "every 30m" triggers immediate run.
**Required:** This is actually correct behavior. But document it. Option: `pipe.md` frontmatter `run_on_enable: false` to suppress immediate run.

#### E3. Two scheduled triggers in rapid succession
**Current:** Scheduler sets `last_run` immediately (line 751), then spawns async task. If scheduler loop runs again before pipe starts (30s granularity), the `is_running` check (line 729) prevents duplicate.
**But:** There's a race — `last_run.insert()` at line 751 happens before `running.insert()` at line 756. A narrow window exists where the running check passes for both.
**Required:** Atomic operation: insert into running map AND update last_run in same lock scope.

#### E4. Scheduler task panics
**Current:** `tokio::spawn()` — if the closure panics, the task dies silently. Pipes stop being scheduled. No error visible to user.
**Required:** Wrap scheduler loop in `catch_unwind`. Log panic. Restart scheduler. Surface in health endpoint.

#### E5. Very frequent schedule ("every 1m") with slow pipe
**Current:** Pipe takes 3 minutes. Semaphore blocks. Scheduler keeps trying every 30s, hits "already running" check, skips. After completion, next tick runs it again. Effectively runs back-to-back.
**Required:** This is mostly OK but wasteful. Consider: if a pipe is consistently slower than its schedule, log a warning: "pipe 'X' takes avg 3min but is scheduled every 1min."

#### E6. Cron expression evaluates to the past
**Current:** `should_run()` compares `now >= next_occurrence(last_run)`. If clock jumps backward, `now` might be before the next occurrence → pipe doesn't run.
**Required:** Acceptable for cron (wall-clock based). Document: cron schedules depend on accurate system clock.

---

### F. Config & File System

#### F1. pipe.md modified while pipe is running
**Current:** Config loaded at schedule/run time. Execution already has its copy. Pipe body (prompt) already rendered. No conflict.
**But:** If user edits pipe.md, `load_pipes()` isn't called automatically — config is stale until next scheduler tick re-reads? Actually no — pipes are loaded once at startup (line 227-275) and only modified by explicit API calls (enable/disable/update). Scheduler uses the in-memory snapshot.
**Required:** File watcher or re-read on each scheduler tick. Or: accept that config changes only take effect via API (current behavior, document it).

#### F2. pipe.md has invalid YAML frontmatter
**Current:** YAML parse failure → pipe skipped during `load_pipes()`. No error surfaced.
**Required:** Log warning with pipe name and parse error. API `GET /pipes` should include pipes with `config_error` field.

#### F3. Pipe directory deleted while pipe is running
**Current:** Pi subprocess has working_dir set to the pipe directory. If deleted mid-execution, file operations fail. Pi may crash.
**Required:** Delete operation should cancel running execution first, wait for completion, then delete.

#### F4. Output directory permissions
**Current:** `./output/` created by pi during execution. If parent dir has wrong permissions, pi fails.
**Required:** `ensure_dir_exists(pipe_dir.join("output"))` before spawning pi.

#### F5. Pipe installs from untrusted URL
**Current:** `install_pipe()` fetches from URL, writes pipe.md. No validation, no sandboxing.
**Required (future):** Content validation — pipe.md must have valid frontmatter. Warn about unknown agents. Don't auto-enable installed pipes.

---

### G. Network & API Dependencies

#### G1. Screenpipe API not ready when pipe runs
**Current:** Pipe prompt says "Screenpipe API: http://localhost:3030". Pi queries this. If server still booting, pi gets connection refused. Fails.
**Required:** Pipe scheduler should only start after server is listening. Currently scheduler starts at line 912 of screenpipe-server.rs, server starts at line ~950. There's a potential race.

#### G2. Screenpipe API port is not 3030
**Current:** Hardcoded in `render_prompt()` (line 992): `Screenpipe API: http://localhost:3030`. If user runs on port 3031, pipe queries wrong port.
**Required:** Pass actual server port to PipeManager. Inject into prompt template.

#### G3. LLM provider rate limited
**Current:** Pi gets 429 from API. Returns as stderr. Logged as failure.
**Required:** Parse rate-limit errors. Set structured `error_type = "rate_limited"`. Consider: built-in backoff before retry.

#### G4. LLM response too large / malformed
**Current:** Pi captures all stdout. If LLM produces garbage (encoding issues, binary output), stdout may be huge or unparseable.
**Required:** Cap stdout capture at reasonable limit (1MB?). Detect binary/non-UTF8 content early.

---

### H. Pi Chat Sessions (Interactive)

#### H1. Chat session process tracking
**Current:** Chat spawns pi via Tauri command. Process managed in `standalone-chat.tsx` frontend. No server-side tracking.
**Required:**
- Chat sessions are different from pipes (interactive vs batch) — keep separate
- But share the same process management concerns (PID, timeout, kill)
- Consider: `chat_sessions` table or extend `pipe_executions` with `execution_type = 'chat' | 'pipe'`

#### H2. Chat stuck / unresponsive
**Current:** User has no way to know if pi is thinking or hung. No timeout.
**Required:**
- Heartbeat: if no stdout from pi for 60s, show "response may be delayed" in UI
- Manual cancel button that actually kills the process (needs reliable PID)
- Server-side: track chat PIDs in a separate map, expose via API

#### H3. Multiple chat sessions
**Current:** Can user open multiple chat windows? If so, multiple pi processes. No coordination.
**Required:** Document: one chat session at a time. Or: track all active chat PIDs, show in system status.

#### H4. Chat and pipe compete for resources
**Current:** Chat doesn't use the pipe semaphore. Both can spawn pi simultaneously.
**Required:** Decide: should chat respect the pipe semaphore? Probably not (user expects immediate response). But resource usage should be monitored.

---

### I. Tauri App / Embedded Server

#### I1. App quit while pipe running
**Current:** Tauri app shutdown kills the embedded server. In-memory state lost. Pi process may or may not be killed (depends on process group inheritance).
**Required:** Graceful shutdown: cancel running pipes, wait up to 5s, force kill. Write final status to DB before exit.

#### I2. App update while pipe running
**Current:** Updater replaces binary. On restart, same as B1 (computer restart).
**Required:** Pre-update hook: cancel running pipes. Or: updater waits for pipes to finish (with timeout).

#### I3. store.bin locked by Tauri
**Current:** `resolve_preset()` reads store.bin with `std::fs::read_to_string()`. Tauri plugin-store writes to same file. No coordination.
**Required:**
- Tauri plugin-store uses atomic writes internally (write-to-tmp then rename)
- But read can still see partial content during rename on some filesystems
- Fix: retry read on JSON parse failure (simple, covers the race)

#### I4. Permissions dialog blocks during execution
**Current:** macOS may show permission dialog (screen recording, mic access). Dialog blocks the thread.
**Required:** Not directly related to pipes (pipes query API, not hardware). But if screenpipe server is blocked on a permission dialog, API requests from pi hang → pi hangs → timeout kills it. Acceptable with timeout in place.

---

## Proposed Schema (updated)

```sql
CREATE TABLE pipe_executions (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    pipe_name         TEXT NOT NULL,

    -- lifecycle
    status            TEXT NOT NULL DEFAULT 'queued',
        -- queued → running → completed | failed | cancelled | timed_out
    queued_at         TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    started_at        TIMESTAMP,
    finished_at       TIMESTAMP,

    -- process tracking
    pid               INTEGER,       -- OS process ID, set immediately after spawn

    -- execution context (snapshot at queue time — immutable after creation)
    agent             TEXT NOT NULL DEFAULT 'pi',
    model             TEXT NOT NULL,
    provider          TEXT,
    preset_id         TEXT,
    preset_snapshot   TEXT,          -- JSON: full preset config at queue time
    trigger           TEXT NOT NULL,  -- 'manual' | 'scheduled' | 'retry'
    rendered_prompt   TEXT,          -- full prompt sent to agent (for debugging)
    api_port          INTEGER,       -- screenpipe port used in prompt

    -- output (updated during/after execution)
    stdout            TEXT DEFAULT '',
    stderr            TEXT DEFAULT '',
    exit_code         INTEGER,
    error_type        TEXT,          -- structured: 'timeout' | 'crash' | 'rate_limited' |
                                     --   'model_not_found' | 'auth_failed' | 'network' |
                                     --   'cancelled' | 'agent_not_found' | NULL (success)
    error_message     TEXT,          -- human-readable error for UI

    -- metadata
    duration_ms       INTEGER,
    retry_of          INTEGER REFERENCES pipe_executions(id),
    retry_count       INTEGER DEFAULT 0,

    -- data context (what screenpipe data window this execution covered)
    context_start     TIMESTAMP,     -- start of time range in rendered prompt
    context_end       TIMESTAMP      -- end of time range in rendered prompt
);

CREATE INDEX idx_pe_name_status ON pipe_executions(pipe_name, status);
CREATE INDEX idx_pe_running ON pipe_executions(status) WHERE status = 'running';
CREATE INDEX idx_pe_name_time ON pipe_executions(pipe_name, queued_at DESC);

-- Scheduler state (persisted across restarts)
CREATE TABLE pipe_scheduler_state (
    pipe_name         TEXT PRIMARY KEY,
    last_run_at       TIMESTAMP,
    last_success_at   TIMESTAMP,
    consecutive_failures INTEGER DEFAULT 0
);
```

### Why two tables

`pipe_executions` is append-only (one row per run). `pipe_scheduler_state` is one row per pipe (updated in place). Separating them means:
- Scheduler reads one small table to decide what to run
- Execution history queries scan a separate table
- No need to `SELECT MAX(queued_at) FROM pipe_executions GROUP BY pipe_name` on every scheduler tick

---

## State Machine

```
                    ┌─────────┐
          queue     │ queued  │
          ────────► │         │
                    └────┬────┘
                         │ semaphore acquired, spawn process
                         ▼
                    ┌─────────┐
                    │ running │──── PID set in DB
                    │         │──── stdout/stderr streaming to DB
                    └────┬────┘
                    ╱    │    ╲
                   ╱     │     ╲
                  ▼      ▼      ▼
           ┌──────┐ ┌──────┐ ┌──────────┐
           │compl.│ │failed│ │timed_out │
           └──────┘ └──┬───┘ └──────────┘
                       │
                  retry_count < max?
                  yes → new row (trigger='retry', retry_of=id)
                  no  → stay failed

    At any point from queued or running:
        user cancel → cancelled
        server shutdown → failed (error_type='shutdown')
        sleep/crash → failed (error_type='interrupted', detected on startup)
```

---

## Implementation Priority (updated)

| Phase | What | Blocks |
|-------|------|--------|
| **P0** | Execution timeout (5min default) + process group kill | Everything — without this, one hung pipe = system dead |
| **P0** | Fix PID tracking: split executor into spawn+wait, write PID to running map immediately | Cancellation |
| **P0** | `pipe_executions` + `pipe_scheduler_state` tables | Restart recovery, observability, everything |
| **P0** | Startup orphan recovery | Clean state guarantee |
| **P1** | Snapshot preset/model at queue time | Correct execution after user changes settings |
| **P1** | Inject actual API port into prompt (not hardcoded 3030) | Correctness for non-default port |
| **P1** | Structured error types (parse stderr for common failures) | Actionable UI errors |
| **P1** | Scheduler state in DB (last_run, consecutive_failures) | Survives restart, prevents re-runs |
| **P1** | Graceful shutdown: cancel pipes on app quit | Clean exit |
| **P2** | Streaming stdout/stderr to DB during execution | Real-time visibility |
| **P2** | WebSocket live output tail | User watches pipe run |
| **P2** | Retry with backoff | Handles transient LLM failures |
| **P2** | Queue position in API | User knows where they are |
| **P3** | Execution-scoped output directories | Clean partial output handling |
| **P3** | Log pruning (30 day retention) | Disk management |
| **P3** | Concurrent execution (semaphore > 1) | Performance |
| **P3** | Pre-flight checks (Ollama reachable, model exists) | Better UX |
