# Event-Driven Capture — Architecture Spec

> **Status**: Draft
> **Date**: 2026-02-20

## 1. Problem

Three independent capture systems run on their own clocks with zero synchronization:

- **Vision**: polls at 0.5–10 FPS, compares frames, runs OCR, encodes H.265 video
- **Accessibility tree walker**: walks every 3s or on app switch, stores text separately
- **UI event recorder**: real-time input capture, stored in its own table

When a user searches a keyword that exists in accessibility data, the nearest screenshot is from a different moment. The thumbnail is wrong. The user doesn't trust the results.

Meanwhile the vision pipeline burns CPU comparing and skipping identical frames on a static screen. The `ActivityFeed` already detects every click, keystroke, and app switch — but instead of triggering a capture, it nudges a polling rate. That's backwards.

## 2. Design

### 2.1 One Capture System

Kill the three-system split. One system: **event happens → screenshot + text extraction → store together**.

```
Event (click / app switch / typing pause / scroll stop / idle timer)
  → Screenshot (reuse capture_monitor_image)
  → Accessibility tree walk (reuse walk_focused_window)
  → If accessibility empty → OCR fallback (reuse process_ocr_task)
  → Write JPEG to disk
  → Insert frame + text into DB (single row, single timestamp)
```

Screenshot and text share the same timestamp because they come from the same capture. No desync possible.

### 2.2 Event Triggers

| Trigger | Debounce | Why |
|---------|----------|-----|
| App switch | 300ms settle | Highest-value event — user changed context |
| Window focus change | 300ms settle | New tab, new document, new conversation |
| Mouse click | 200ms | User interacted — screen likely changed |
| Typing pause | 500ms after last key | Capture the result of typing, not every character |
| Scroll stop | 400ms after last scroll | New content scrolled into view |
| Clipboard copy | 200ms | User grabbed something — capture context |
| **Idle fallback** | **Every 5s** | Catch passive changes: notifications, incoming messages, auto-play |

**Hard constraints**:
- **Minimum interval**: 200ms between captures per monitor. Non-negotiable — prevents storms.
- **Maximum gap**: 10s. If nothing triggers a capture for 10s, take one anyway. Identical consecutive idle frames are deduplicated via frame hash comparison (already exists in `FrameComparer`).

### 2.3 Text Extraction

Accessibility first. OCR as fallback. No "both" mode at capture time — keep it simple.

```
walk_focused_window() → result
  if result.text_content is non-empty → done (text_source = "accessibility")
  if result is empty/error → run OCR → done (text_source = "ocr")
```

Accessibility tree walk has a **200ms hard timeout**. If the app has a massive AX tree (Electron apps with 10k+ nodes), we take whatever text we got in 200ms and move on. This keeps capture latency predictable.

OCR is the safety net for:
- Image-heavy apps (Figma, Photoshop)
- PDF viewers rendering as canvas
- Video players showing text
- Apps with broken/missing accessibility support

The user doesn't choose. The system picks the right method per-capture.

### 2.4 Snapshot Storage

No more H.265 video encoding. No more FFmpeg for frame extraction.

Each capture writes a JPEG directly to disk:

```
~/.screenpipe/data/
  2026-02-20/
    1708423935123_m0.jpg     # monitor 0 screenshot
    1708423937456_m0.jpg
    1708423939100_m1.jpg     # monitor 1 screenshot
    ...
```

Metadata (text, app name, trigger, etc.) lives in the DB, not sidecar files. The JPEG is just pixels.

**Why kill video?**
1. Event-driven capture has irregular timing. H.265 assumes consistent FPS.
2. FFmpeg extraction is the #1 timeline bottleneck (100-500ms per frame, 3-permit semaphore).
3. FFmpeg is a 100MB+ dependency we can stop depending on for the hot path.
4. JPEG files are directly servable. Zero processing to display.

**Storage math** (8 hours active use, 1080p, JPEG quality 80 ≈ 80KB/frame):
- Today (0.5-1 FPS continuous): 14,400–28,800 frames → 1.1–2.3 GB (H.265 compressed ≈ 100-200 MB/hr × 8hr)
- Event-driven (~10 captures/min active, 6/min idle, 50/50 split): ~3,840 frames → ~300 MB total

Fewer frames, each slightly larger, far less total storage.

**Reading old data**: Legacy video-chunk frames stay on disk forever. The frame retrieval endpoint checks `snapshot_path` on the frame row — if set, serve JPEG directly; if NULL, use the existing FFmpeg extraction path. Old data keeps working with zero migration effort.

### 2.5 Database Changes

One migration, additive only:

```sql
ALTER TABLE frames ADD COLUMN snapshot_path TEXT;
ALTER TABLE frames ADD COLUMN accessibility_text TEXT;
ALTER TABLE frames ADD COLUMN capture_trigger TEXT;  -- 'app_switch', 'click', 'typing_pause', 'scroll_stop', 'clipboard', 'idle', etc.
ALTER TABLE frames ADD COLUMN text_source TEXT DEFAULT 'ocr';  -- 'ocr' or 'accessibility'

CREATE INDEX idx_frames_ts_device ON frames(timestamp, device_name);
```

New frames: `snapshot_path` set, `video_chunk_id` may be NULL, `accessibility_text` populated.
Old frames: `snapshot_path` NULL, existing `video_chunk_id` + `offset_index` used.

Both coexist in the same table. Timeline and search show both. No data loss.

### 2.6 Search

Keyword search queries both `ocr_text` (via existing `ocr_text_fts`) and the new `accessibility_text` on frames. Since `accessibility_text` is on the frame row, the matched thumbnail is always correct.

For the keyword search handler (`/search/keyword`):
```sql
-- Existing OCR path (unchanged)
SELECT ... FROM ocr_text_fts WHERE ocr_text_fts MATCH ?

-- New accessibility path
UNION

SELECT ... FROM frames
WHERE accessibility_text LIKE '%' || ? || '%'
  OR frame_id IN (SELECT rowid FROM accessibility_text_fts WHERE accessibility_text_fts MATCH ?)
```

Results are merged, deduplicated by frame ID, sorted by timestamp. Thumbnails are always correct regardless of which text source matched.

### 2.7 Multi-Monitor

Events are monitor-specific where possible:
- Click/scroll → capture the monitor where the cursor is
- App switch → capture the monitor with the newly focused window
- Typing pause → capture the monitor with the focused window

Other monitors get idle fallback captures only (every 5s, deduplicated).

This avoids capturing all monitors on every click — important for 3+ monitor setups.

### 2.8 Concurrency Model

```
                    ┌─────────────────────┐
                    │  Event Listener      │  (reuse existing CGEventTap / UI Automation)
                    │  (real-time thread)  │
                    └─────────┬───────────┘
                              │ EventTrigger (type + monitor + timestamp)
                              ▼
                    ┌─────────────────────┐
                    │  Debounce + Dedup    │  (per-monitor, 200ms min interval)
                    │  (async task)        │
                    └─────────┬───────────┘
                              │ qualified trigger
                              ▼
              ┌───────────────────────────────┐
              │  Capture Worker (per monitor)  │
              │  1. capture_monitor_image()    │  ~5ms
              │  2. capture_windows()          │  ~10ms
              │  3. walk_focused_window()      │  ~10-200ms (200ms timeout)
              │  4. if empty → process_ocr()   │  ~100-500ms (rare)
              │  5. encode JPEG, write to disk  │  ~5-10ms
              │  6. insert frame + text to DB   │  ~5ms (batched)
              └───────────────────────────────┘
```

Total latency per capture: ~30-50ms typical (accessibility path), ~200-600ms worst case (OCR fallback). Well within the 200ms minimum interval.

One capture worker per monitor. Workers are independent — a slow OCR on monitor 1 doesn't block capture on monitor 2.

### 2.9 Settings

Remove:
- FPS slider (meaningless in event-driven)
- Adaptive FPS toggle (replaced entirely)
- Video quality presets (no video encoding)

Add:
- **Capture sensitivity** — Low / Medium / High
  - Low: 500ms debounce, 10s idle gap (laptop battery mode)
  - Medium: 200ms debounce, 5s idle gap (default)
  - High: 100ms debounce, 3s idle gap (maximum recall)
- **JPEG quality** — slider, 60-95%, default 80%

Keep:
- Monitor selection (which monitors to capture)
- Ignored windows list (skip sensitive apps)

## 3. What Gets Deleted

This is not additive. Old code gets removed.

| Removed | Reason |
|---------|--------|
| `continuous_capture()` loop in `core.rs` | Replaced by event-driven capture |
| `save_frames_as_video()` in `video.rs` | No more video encoding |
| `FrameWriteTracker` in `video.rs` | No video chunks to track offsets in |
| `FrameComparer` as capture gatekeeper | Events decide when to capture, not frame diffs. Keep only for idle dedup. |
| `ActivityFeed::get_capture_params()` | No FPS to adjust. Feed becomes event source. |
| Adaptive FPS feature flag | Gone entirely |
| `ocr_work_queue` / OCR worker thread | OCR runs inline on accessibility fallback only |
| `video_frame_queue` / video encoding thread | No video to encode |
| FFmpeg encoding dependency (write path) | Still needed for legacy frame extraction (read path only) |
| `WindowOcrCache` (300s TTL, 100 entries) | Accessibility is fast enough to not need caching. OCR fallback is rare. |

**What stays for backward compat (read path only)**:
- `extract_frame_from_video()` — for displaying old video-chunk frames
- `video_chunks` table — for old data
- `offset_index` / `fps` columns on frames — for old data

These remain but receive no new writes. They're read-only legacy support.

## 4. Implementation Order

Not phased. One PR per step, each shippable independently, but all ship in the same release.

### Step 1: DB migration + snapshot write path
- Add new columns to `frames`
- `SnapshotWriter`: JPEG write to `~/.screenpipe/data/YYYY-MM-DD/`
- `insert_snapshot_frame()` in DB
- Update `get_frame_data()` to serve snapshots directly

### Step 2: Paired capture function
- `paired_capture()`: screenshot + accessibility walk + OCR fallback
- Returns `PairedCaptureResult` with image bytes + text + metadata
- Unit-testable in isolation

### Step 3: Event trigger system
- Extend `ActivityFeed` with `tokio::sync::Notify` + event type
- `EventDrivenCapture::wait_for_trigger()` — debounce + dedup logic
- Idle fallback timer
- Wire into existing `CGEventTap` / UI Automation hooks

### Step 4: New capture loop
- Replace `VisionManager`'s capture task with event-driven loop
- One worker per monitor: `wait_for_trigger → paired_capture → snapshot_write → db_insert`
- Delete `continuous_capture()`, `save_frames_as_video()`, `FrameWriteTracker`
- Delete adaptive FPS, `get_capture_params()`

### Step 5: Search + timeline integration
- Add `accessibility_text` to keyword search FTS
- Update timeline data fetching to handle snapshot frames
- Update settings UI (remove FPS, add sensitivity)

### Step 6: Cleanup
- Remove dead code: video encoding pipeline, OCR queues, frame comparison gatekeeper
- Update TESTING.md with new test cases
- Remove `adaptive-fps` feature flag from Cargo.toml

## 5. Testing Checklist

### Capture correctness
- [ ] App switch → capture within 500ms, correct app/window in metadata
- [ ] Click → capture within 400ms, screenshot reflects post-click state
- [ ] Typing 3 words, stop → capture within 1s of last keystroke
- [ ] Scroll through long page, stop → capture shows final scroll position
- [ ] Copy text → capture within 400ms
- [ ] Sit idle 10s → idle capture fires, identical consecutive frames deduplicated
- [ ] Rapid clicking (10 clicks in 1s) → at most 5 captures (200ms min interval)
- [ ] 3 monitors → events only capture affected monitor, others get idle captures

### Text extraction
- [ ] Chrome: accessibility returns page text, window title, URL
- [ ] VS Code: accessibility returns visible code
- [ ] Finder: accessibility returns file names
- [ ] Figma/Photoshop: accessibility empty → OCR fallback activates
- [ ] Electron app with huge DOM: tree walk returns partial text within 200ms timeout

### Storage
- [ ] Snapshots written as valid JPEG, correct resolution, readable by Preview/Photos
- [ ] Directory `~/.screenpipe/data/YYYY-MM-DD/` created automatically
- [ ] Frame retrieval: snapshot frames served in <5ms (no FFmpeg)
- [ ] Frame retrieval: old video-chunk frames still served correctly via FFmpeg
- [ ] Disk cleanup deletes oldest snapshots when retention limit hit

### Search
- [ ] Keyword in accessibility text → correct thumbnail (no desync)
- [ ] Keyword in OCR text (fallback frames) → correct thumbnail
- [ ] Keyword in old OCR data (pre-migration) → still works
- [ ] Mixed results (old video frames + new snapshots) display correctly

### Regression (from TESTING.md)
- [ ] Section 3: Monitor plug/unplug — capture resumes on new/remaining monitors
- [ ] Section 5: Static screen < 0.5% CPU. Active use < 5% CPU.
- [ ] Section 6: Permissions — accessibility prompt on first launch
- [ ] Section 8: Sleep/wake — capture resumes within 5s
- [ ] Section 9: DB concurrent access — no "database is locked" errors
- [ ] Section 12: Timeline navigation, search results, frame deep links all work

## 6. E2E Robot Testing

### Principle: Use Accessibility to Test Accessibility

The same APIs we use for capture can drive automated E2E tests. On macOS, `osascript` opens apps, clicks buttons, types text, switches windows. On Windows, PowerShell + UI Automation does the same. Tests perform real user actions, wait for captures to appear in the DB, and assert correctness.

### Test Layers

**Layer 1: Unit tests** (fast, CI, no UI)
- Debounce: rapid events → correct trigger count
- Frame dedup: identical images → skip, different → capture
- SnapshotWriter: valid JPEG, correct path format
- DB: insert_snapshot_frame → query returns correct data
- Search: accessibility_text FTS matches

**Layer 2: Integration tests** (CI, headless)
- Paired capture: screenshot + accessibility return together
- OCR fallback: accessibility empty → OCR runs
- Legacy compat: video-chunk frames still serve via FFmpeg

**Layer 3: E2E robot tests** (real machines, real UI, nightly CI)

```bash
# macOS: osascript drives real apps
# Windows: PowerShell + [System.Windows.Automation] drives real apps

test_app_switch_capture:
  1. open TextEdit, type "test document alpha"
  2. open Safari, navigate to example.com
  3. sleep 1s
  4. query DB: frames WHERE capture_trigger = 'app_switch' AND timestamp > test_start
  5. assert: >= 2 frames
  6. assert: frame 1 accessibility_text contains "test document alpha"
  7. assert: frame 2 app_name = "Safari"
  8. assert: both snapshot_path files are valid JPEGs

test_typing_pause_capture:
  1. focus TextEdit, type "meeting notes for project X"
  2. sleep 1s
  3. assert: frame with capture_trigger = 'typing_pause'
  4. assert: accessibility_text contains "meeting notes for project X"

test_scroll_capture:
  1. open Safari, navigate to long page
  2. scroll down 5 times
  3. sleep 1s
  4. assert: frame with capture_trigger = 'scroll_stop'
  5. assert: content differs from pre-scroll frame

test_click_capture:
  1. open System Settings, click "General"
  2. sleep 500ms
  3. assert: frame with capture_trigger = 'click'

test_idle_fallback:
  1. do nothing for 12s
  2. assert: >= 1 frame with capture_trigger = 'idle'

test_rapid_events_debounce:
  1. click 20 times in 1s
  2. sleep 1s
  3. assert: <= 5 frames (200ms min interval)

test_search_thumbnail_correctness:
  1. open TextEdit, type "unique_term_xyz"
  2. switch to Safari
  3. sleep 2s
  4. GET /search?q=unique_term_xyz
  5. assert: result thumbnail shows TextEdit, not Safari
```

**Layer 4: Soak test** (8 hours real use, before every release)
- Run event-driven capture during a full workday
- End-of-day assertions:
  - No crashes, no DB corruption, no orphaned files
  - Frame count: 3,000–5,000 (reasonable for 8hr active day)
  - Disk: ~300 MB total
  - Search responds in <2s on full-day DB
  - CPU never exceeded 10% sustained

### CI Integration

- Unit + integration tests: every PR (fast, headless)
- E2E robot tests: nightly on macOS + Windows runners (too slow for PRs)
- Soak test: manual before each release, automated weekly on dev machines

## 7. Windows Compatibility

~90% of new code is platform-agnostic (debounce, paired capture, snapshot writer, DB, search). Platform-specific code already exists and is abstracted:

| Component | macOS | Windows | New code needed? |
|-----------|-------|---------|-----------------|
| Event detection | CGEventTap | SetWindowsHookEx | No — already exists in `platform/` |
| Screenshot | ScreenCaptureKit | DXGI/GDI | No — already abstracted |
| Accessibility tree | AX API | UI Automation | No — already in `tree/` |
| Debounce/dedup | Pure Rust | Same | No |
| Snapshot writer | File I/O | Same | No |
| JPEG encoding | `image` crate | Same | No |
| DB | SQLite | Same | No |

**One platform-specific tuning**: UIA tree walk is slower on Windows (200-500ms vs 10-50ms on macOS). The accessibility timeout constant needs `#[cfg(target_os)]`:
```rust
#[cfg(target_os = "macos")]
const AX_WALK_TIMEOUT_MS: u64 = 200;
#[cfg(target_os = "windows")]
const AX_WALK_TIMEOUT_MS: u64 = 350;
```

E2E robot tests use platform-native automation:
- macOS: `osascript` (AppleScript)
- Windows: PowerShell + `System.Windows.Automation`

## 8. Success Criteria

| Metric | Today | Target |
|--------|-------|--------|
| CPU idle (static screen, release) | 3-5% | < 0.5% |
| CPU active (browsing, release) | 8-15% | < 5% |
| App switch → frame in DB | 1-5s | < 500ms |
| Search thumbnail correctness | ~60% for accessibility matches | 100% |
| Frame serve latency (new frames) | 100-500ms (FFmpeg) | < 5ms |
| Storage (8hr active day) | 800 MB – 1.6 GB | ~300 MB |
| Lines of code in capture pipeline | ~2500 (core.rs + video.rs + frame_comparison.rs) | ~800 |
