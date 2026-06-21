# Timeline Video-Based Frame Loading — Architecture Spec

> **Status**: Draft  
> **Issue**: #2165  
> **Author**: screenpipe team  
> **Date**: 2026-02-06

## 1. Problem Statement

### 1.1 Current Architecture

Every frame displayed in the timeline follows this path:

```
User scrolls → frame_id changes → 150ms debounce
→ HTTP GET /frames/{frame_id}
→ Server: DB lookup (file_path, offset_index)
→ ffprobe for video metadata (~200-500ms, cached after first call)
→ ffmpeg spawns, seeks, extracts single JPEG (~500ms-3s)
→ writes JPEG to /tmp/screenpipe_frames/
→ serves file back over HTTP
→ Browser renders <img>

Total: 1.5–4 seconds per frame
```

On a typical 8-hour workday at 0.5 fps with 2 monitors, the system produces **28,800 frames** across **1,920 video chunks**. Every single frame view spawns a new ffmpeg process.

### 1.2 User Feedback

From user Creon Levit (screenshot context):

> "3. Faster retrieval & display of screenshots when scrolling."
> "4. (Optional) slightly higher quality compression. Less blurry."

From user Menelaus (Discord):

> "I put it to 0.5 now. But since it seems to act so strangely, in terms of the timeline... it's hard to tell if things are working or just being buggy and glitchy"

### 1.3 Root Cause

The bottleneck is **ffmpeg process spawn per frame**. This is fundamentally wrong because:

1. The data already exists in browser-playable format (HEVC/H.265 in fragmented MP4)
2. Screenpipe uses `-movflags frag_keyframe+empty_moov+default_base_moof`, meaning the moov atom is at the start — **even actively-recording files are seekable**
3. At 0.5 fps, the GOP structure means most frames are keyframes, so browser seeking is frame-accurate
4. WebKit on macOS (Tauri's webview) natively supports HEVC
5. The `file_path` is already sent to the client in WebSocket metadata — it's just not used for display

We're spawning 28,800 ffmpeg processes per day for something the browser can do in hardware with a `video.currentTime` assignment.

## 2. Goals & Non-Goals

### Goals

- **P0**: Frame display latency < 100ms for same-chunk seeks (scrolling within a 30-second window)
- **P0**: Frame display latency < 500ms for cross-chunk seeks (jumping to adjacent chunks)
- **P0**: Frame display latency < 1s for day jumps (clicking a date 15 days ago)
- **P0**: Zero ffmpeg process spawns during normal timeline scrolling
- **P1**: Seamless chunk boundary transitions (no flicker)
- **P1**: Works with actively-recording chunks (live edge)
- **P1**: OCR text overlay still functions correctly
- **P2**: Reduce server CPU usage from frame extraction

### Non-Goals

- Changing the recording format (HEVC stays)
- Changing the database schema beyond additive fields
- Supporting browsers without HEVC support in this iteration (Linux/some Windows — they keep ffmpeg fallback)
- Video playback (play/pause) — this is about still-frame seeking
- Changing the WebSocket streaming protocol substantially

## 3. Data Model (Current)

### 3.1 Database Schema

```sql
-- video_chunks: one row per MP4 file
CREATE TABLE video_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT NOT NULL  -- e.g., ~/.screenpipe/data/monitor_1_2026-02-06_10-30-00.mp4
);

-- frames: one row per captured frame
CREATE TABLE frames (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_chunk_id INTEGER NOT NULL,
    offset_index INTEGER NOT NULL,  -- frame number within chunk (0, 1, 2, ...)
    timestamp TIMESTAMP NOT NULL,
    FOREIGN KEY (video_chunk_id) REFERENCES video_chunks(id)
);
```

### 3.2 Video Files

| Property | Value |
|----------|-------|
| Codec | HEVC (hvc1) via libx265 |
| Container | Fragmented MP4 (`frag_keyframe+empty_moov+default_base_moof`) |
| FPS | Configurable: 0.2–1.0 (default 0.5) |
| Chunk duration | 30s (Tauri app) / 60s (CLI) |
| Frames per chunk | ~15 (at 0.5fps, 30s) |
| Resolution | Native monitor resolution (e.g., 1920×1080, 3024×1964) |
| Typical file size | 300KB–1MB per chunk |
| Naming | `monitor_{id}_{YYYY-MM-DD_HH-MM-SS}.mp4` |

### 3.3 Seeking Math

```
currentTime = offset_index / fps

Example at 0.5 fps, 30s chunk (15 frames):
  offset_index=0  → currentTime = 0s
  offset_index=1  → currentTime = 2s
  offset_index=7  → currentTime = 14s
  offset_index=14 → currentTime = 28s
```

### 3.4 What the Client Currently Receives (WebSocket)

```typescript
interface StreamTimeSeriesResponse {
    timestamp: string;           // ISO 8601
    devices: DeviceFrameResponse[];
}

interface DeviceFrameResponse {
    device_id: string;          // "monitor_1"
    frame_id: string;           // DB id — used for GET /frames/{id}
    metadata: {
        file_path: string;      // ✅ ALREADY SENT — the MP4 path
        app_name: string;
        window_name: string;
        ocr_text: string;
        browser_url?: string;
    };
    audio: AudioData[];
}
```

**Missing from client**: `offset_index` and `fps` — needed for `video.currentTime` calculation.

### 3.5 Asset Protocol Scope

```json
// tauri.conf.json
"security": {
    "assetProtocol": {
        "enable": true,
        "scope": ["$APPDATA/**"]  // ⚠️ Does NOT include ~/.screenpipe/data/
    }
}
```

**Problem**: Video files are at `~/.screenpipe/data/`, which is outside `$APPDATA` (`~/Library/Application Support/`). The asset protocol scope must be expanded, or we serve videos through the HTTP server.

## 4. Proposed Architecture

### 4.1 Overview

```
CURRENT:
  scroll → frame_id → HTTP GET → ffprobe → ffmpeg → JPEG → <img>
  Latency: 1.5–4s

PROPOSED:
  scroll → (file_path, offset_index, fps) already in memory
         → video.currentTime = offset_index / fps
         → browser hardware-seeks HEVC
  Latency: 10–50ms (same chunk), 100–300ms (chunk swap)
```

### 4.2 Component Diagram

```
┌─────────────────────────────────────────────────────────┐
│                    Timeline UI                           │
│                                                          │
│  ┌──────────────┐  ┌──────────────────────────────────┐ │
│  │ Timeline Bar  │  │ VideoFrameDisplay                │ │
│  │ (unchanged)   │  │                                  │ │
│  │               │  │  ┌────────────────────────────┐  │ │
│  │ Scrolls →     │  │  │ <video> current chunk      │  │ │
│  │ frame index   │  │  │  .currentTime = offset/fps │  │ │
│  │               │  │  └────────────────────────────┘  │ │
│  │               │  │  ┌────────────────────────────┐  │ │
│  │               │  │  │ <video> preloaded next     │  │ │
│  │               │  │  │  (hidden, ready to swap)   │  │ │
│  │               │  │  └────────────────────────────┘  │ │
│  │               │  │  ┌────────────────────────────┐  │ │
│  │               │  │  │ <canvas> for OCR overlay   │  │ │
│  │               │  │  │  (captures video frame)    │  │ │
│  │               │  │  └────────────────────────────┘  │ │
│  └──────────────┘  └──────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
         │                       │
         │ WebSocket             │ file:// or http://
         ▼                       ▼
┌─────────────────┐    ┌──────────────────────┐
│ Backend Server   │    │ Local filesystem     │
│ (localhost:3030) │    │ ~/.screenpipe/data/  │
│                  │    │  monitor_*.mp4       │
│ Sends metadata:  │    └──────────────────────┘
│  + file_path     │
│  + offset_index  │  ← NEW
│  + fps           │  ← NEW
│  + chunk_id      │  ← NEW
│  + frame_id      │
└──────────────────┘
```

### 4.3 Video Access Strategy

**Option A: Expand Tauri asset protocol scope**

```json
"scope": ["$APPDATA/**", "$HOME/.screenpipe/**"]
```

Then use `convertFileSrc(file_path)` → `asset://localhost/...` URL.

- ✅ Zero HTTP overhead
- ✅ Uses native file streaming with range requests
- ⚠️ Need to handle custom `dataDir` setting (user can change data location)
- ⚠️ Must dynamically add paths via `scope.allow_file()` for custom dirs

**Option B: New HTTP endpoint `/video/chunk/{chunk_id}`**

Serve the raw MP4 file via the existing HTTP server with Range request support.

- ✅ No scope config changes needed
- ✅ Works for any data dir location
- ⚠️ HTTP overhead (minimal for local connections)
- ⚠️ Must support Range headers for seeking

**Recommendation**: Option A (asset protocol) as primary, Option B as fallback for custom data dirs. Both should be implemented since the `<video>` element just needs a URL.

## 5. Detailed Design

### 5.1 Backend Changes (Minimal)

#### 5.1.1 Add `offset_index` and `fps` to WebSocket Response

```rust
// server.rs — DeviceFrameResponse
pub struct DeviceFrameResponse {
    pub device_id: String,
    pub frame_id: i64,
    pub offset_index: i64,    // NEW: frame index within chunk
    pub fps: f64,             // NEW: fps of the video chunk
    pub metadata: DeviceMetadata,
    pub audio: Vec<AudioData>,
}
```

The `offset_index` already exists in `FrameData` from the DB query. The `fps` can be:
- Read from the video file via the existing metadata cache (`get_video_fps_and_duration`)
- Or stored in a new `video_chunks.fps` column (better — avoids ffprobe entirely)

**Preferred**: Add `fps REAL` column to `video_chunks` table, populate at chunk creation time (we know the fps when starting ffmpeg). Then the WebSocket response includes it from the DB query with zero extra cost.

#### 5.1.2 Add `fps` Column to video_chunks

```sql
-- Migration
ALTER TABLE video_chunks ADD COLUMN fps REAL DEFAULT 0.5;
```

Populate for existing data:
```sql
-- Backfill: use global default. Users who changed fps mid-session may have
-- some chunks with wrong fps, but seeking will be close enough (±1 frame).
UPDATE video_chunks SET fps = 0.5 WHERE fps IS NULL OR fps = 0;
```

At chunk creation time, the fps is already known (it's a parameter to `start_ffmpeg_process`). Store it:

```rust
// In save_frames_as_video, when creating a new chunk:
new_chunk_callback(&output_file, fps);  // pass fps to callback

// In the DB insert:
INSERT INTO video_chunks (file_path, fps) VALUES (?, ?);
```

#### 5.1.3 New Endpoint: `/video/stream/{chunk_path}`

For serving video files with proper Range request support:

```rust
async fn stream_video_file(
    Path(path): Path<String>,
) -> impl IntoResponse {
    // Validate path is under screenpipe data dir (security)
    // Serve file with Accept-Ranges, Content-Range headers
    // This enables the <video> element to seek efficiently
}
```

This is the fallback for when asset protocol scope doesn't cover the file path.

#### 5.1.4 Keep `/frames/{frame_id}` Endpoint (ffmpeg fallback)

Don't remove the existing endpoint. It serves as:
- Fallback for platforms without HEVC browser support (Linux)
- Fallback for corrupt video files where `<video>` fails
- Export functionality that needs JPEG frames

Note: frame images are redacted at rest by the image-PII worker (rfdetr →
black boxes); there is no per-request `?redact_pii` query param.

### 5.2 Frontend Changes

#### 5.2.1 New Component: `VideoFrameDisplay`

Replaces `CurrentFrameTimeline`'s `<img>` with a `<video>` element pool.

```typescript
interface VideoFrameDisplayProps {
    filePath: string;       // from WebSocket metadata
    offsetIndex: number;    // NEW from WebSocket
    fps: number;            // NEW from WebSocket  
    frameId: string;        // for OCR data fetch
    onFrameReady: () => void;
    onError: () => void;    // triggers ffmpeg fallback
}
```

**Core seeking logic:**
```typescript
const seekToFrame = useCallback((video: HTMLVideoElement, offsetIndex: number, fps: number) => {
    const targetTime = offsetIndex / fps;
    
    // Only seek if we're not already at this time (avoid redundant seeks)
    if (Math.abs(video.currentTime - targetTime) < 0.001) return;
    
    video.currentTime = targetTime;
    // 'seeked' event fires when frame is ready to display
}, []);
```

#### 5.2.2 Video Element Pool (Double Buffering)

Keep 2 `<video>` elements per monitor:
- **Active**: Currently displaying a frame
- **Preloaded**: Has the next/previous chunk loaded and ready

```typescript
interface VideoPool {
    active: {
        element: HTMLVideoElement;
        chunkPath: string;
        fps: number;
    };
    preloaded: {
        element: HTMLVideoElement;
        chunkPath: string;
        fps: number;
    } | null;
}
```

When crossing a chunk boundary:
1. Swap active ↔ preloaded (instant — element already has data)
2. Start loading the NEW adjacent chunk into the now-freed preloaded slot
3. Previous chunk's `<video>` gets its `src` cleared to free memory

#### 5.2.3 Chunk Preloading Strategy

When displaying a frame, preload chunks in this priority order:
1. **Next chronological chunk** (if scrolling forward / at live edge)
2. **Previous chronological chunk** (if scrolling backward)
3. Only preload if the adjacent chunk is ≤ 2 chunks away (don't preload 50 chunks)

The preloading is passive — just set `<video src="...">` with `preload="auto"`. The browser handles buffering.

#### 5.2.4 Chunk-to-URL Mapping

Build a map from `file_path` to playable URL:

```typescript
function getVideoUrl(filePath: string): string {
    // Try asset protocol first
    try {
        return convertFileSrc(filePath);
    } catch {
        // Fallback to HTTP endpoint
        return `http://localhost:3030/video/stream?path=${encodeURIComponent(filePath)}`;
    }
}
```

#### 5.2.5 Fallback to ffmpeg (`<img>`) Path

If the `<video>` element fires an `error` event (unsupported codec, corrupt file, etc.):

```typescript
const handleVideoError = useCallback(() => {
    console.warn('Video element failed, falling back to ffmpeg frame extraction');
    setUseFfmpegFallback(true);
    // Render <img src={`http://localhost:3030/frames/${frameId}`}> instead
}, [frameId]);
```

Per-chunk error tracking — if a chunk fails, mark it so we don't keep retrying:
```typescript
const failedChunks = useRef(new Set<string>());
```

#### 5.2.6 OCR Overlay Interaction

Currently, OCR text positions are fetched by `frame_id` and overlaid on the `<img>`. With `<video>`:

- OCR data fetch is unchanged (keyed by `frame_id`, fetched from `/frames/{frame_id}/ocr`)
- The overlay `<div>` positions are unchanged (percentage-based, relative to container)
- `naturalDimensions` come from `video.videoWidth` / `video.videoHeight` instead of `img.naturalWidth`
- Text selection works the same way (overlay divs positioned over the video)

**No change needed for OCR overlay** — it's already independent of the image source.

#### 5.2.7 Timeline Store Changes

The `useTimelineStore` needs to:
1. Build a chunk index from incoming frames (group frames by `file_path`)
2. Track which chunk is currently loaded in each `<video>` element
3. Provide `getChunkForFrame(frameIndex)` → `{ filePath, fps, offsetIndex }`

```typescript
// Derived from frames array — computed on each flush
interface ChunkIndex {
    // Ordered list of unique chunks with their time ranges
    chunks: Array<{
        filePath: string;
        fps: number;
        startTimestamp: string;
        endTimestamp: string;
        frameIds: number[];      // frames in this chunk
        offsetIndices: number[];  // corresponding offsets
    }>;
    // Quick lookup: frameId → chunk index
    frameToChunk: Map<string, number>;
}
```

### 5.3 Migration & Backwards Compatibility

| Component | Change | Backwards Compatible? |
|-----------|--------|-----------------------|
| `DeviceFrameResponse` | Add `offset_index`, `fps` fields | ✅ Additive JSON fields |
| `video_chunks` table | Add `fps` column with DEFAULT | ✅ Existing rows get default |
| `CurrentFrameTimeline` | Replace internals, keep props | ✅ Same component API |
| `/frames/{frame_id}` endpoint | Keep as-is | ✅ No change |
| Asset protocol scope | Expand | ✅ Only grants more access |
| `use-timeline-store` | Add chunk index | ✅ Internal refactor |

## 6. Edge Cases — Complete Catalog

### 6.1 Same-Chunk Navigation (Most Common — 80% of scrolling)

**Scenario**: User scrolls through frames that all belong to the same 30-second video chunk.

| Edge Case | What Happens | Handling |
|-----------|-------------|----------|
| Seek within loaded chunk | `video.currentTime = offset/fps` | 10-50ms, hardware accelerated |
| Rapid scrolling (30+ frames/sec) | Many `currentTime` assignments | Debounce 80ms. Browser coalesces seeks. Only last seek matters. |
| Seek to exact same frame | `currentTime` unchanged | Skip seek (delta < 0.001) |
| Frame at offset_index=0 | `currentTime = 0` | Works — video is at start |
| Frame at last offset in chunk | `currentTime = 28s` (for 30s chunk at 0.5fps) | Works — within duration |
| `seeked` event fires before paint | Frame not visually updated yet | Use `requestAnimationFrame` after `seeked` to confirm paint |
| Video element not yet loaded | `loadeddata` hasn't fired | Queue seek, execute after `loadeddata` |

### 6.2 Chunk Boundary Crossing

**Scenario**: User scrolls from the last frame of chunk A to the first frame of chunk B.

| Edge Case | What Happens | Handling |
|-----------|-------------|----------|
| Next chunk is preloaded | Swap active ↔ preloaded, seek | <100ms — swap is instant, seek is instant |
| Next chunk NOT preloaded | Must load new video file | Show last frame of old chunk (hold), start loading new chunk. Display new frame on `seeked`. Worst case: 200-500ms for local file. |
| Preloaded chunk is WRONG (user changed direction) | Preloaded is next but user went prev | Evict preloaded, load correct chunk. Latency: 200-500ms. Update preload heuristic. |
| Two chunks with different fps | Old chunk 0.5fps, new chunk 0.2fps | Each `<video>` uses its own fps. No issue — fps travels with chunk metadata. |
| Chunk file was deleted (user cleared old data) | `<video>` fires `error` event | Fall back to ffmpeg path for this frame. Mark chunk as failed. |
| Gap between chunks (recording stopped briefly) | No frames for 5 minutes, then next chunk | Timeline already handles gaps (no frame to display). Next scrollable frame jumps to new chunk. |
| Two monitors' chunks cross boundaries at different times | Monitor 1 chunk changes at :30, monitor 2 at :45 | Each monitor has its own video pool. Independent chunk tracking. |

### 6.3 Day Navigation (Calendar Jumps)

**Scenario**: User clicks a date in the calendar picker, jumping to a completely different day.

| Edge Case | What Happens | Handling |
|-----------|-------------|----------|
| Jump to yesterday | WebSocket fetches yesterday's frames, new file_paths arrive | Clear video pool. Load first chunk of target day. Show skeleton during load (<1s). |
| Jump to 15 days ago | Same as above but more frames to stream | WebSocket already handles this (progressive frame streaming). Video loads from first arriving frame. |
| Jump to date with no data | `hasFramesForDate` returns false | Walk backward up to 7 days (existing behavior). No video change until frames arrive. |
| Jump to date, then immediately jump again | First day's data still streaming when second jump happens | Abort/ignore first day's video loads. `AbortController` on video source changes. Clear video pool on navigation. |
| Jump forward then back to today | Return to live edge | Resume live polling. Load latest chunk. |
| Jump to first-ever recording date | Very old data, potentially thousands of chunks skipped | Only load the specific chunk for the selected frame. Don't preload thousands of chunks. |

### 6.4 Live Edge (Active Recording)

**Scenario**: User is viewing the most recent frame, and new frames are being captured in real-time.

| Edge Case | What Happens | Handling |
|-----------|-------------|----------|
| New frame in same chunk | Poll detects new frame, same file_path, higher offset_index | Seek to new offset. Fragmented MP4 = browser can read new fragments. May need to trigger video reload (`video.load()`) to pick up new data. |
| Chunk rotation while viewing | Encoder finishes chunk A, starts chunk B. New frames have new file_path. | Swap to chunk B's video element. Chunk A remains valid (finalized). |
| Chunk A finalized AFTER we loaded it as "active" | Video was loaded when A was incomplete. Now it's complete with moov finalized. | No issue — fragmented MP4 has moov at start. Browser already has all the data it needs. |
| Very recent frame not yet on disk | Frame captured but ffmpeg hasn't written it yet | offset_index points to a frame that doesn't exist in the file yet. Browser seek silently goes to nearest frame. WebSocket only sends frames AFTER they're written to video (via `FrameWriteTracker`). |
| Live edge with 2-second frame interval (0.5fps) | User sees 2-second-old data | This is inherent to the capture rate. Not a video-loading issue. |
| Screenpipe process restarts while viewing | Video connection lost, new chunks start | WebSocket reconnection already handles this. Video pool resets on reconnect. |

### 6.5 Multi-Monitor

**Scenario**: User has 2+ monitors, each producing separate video chunks.

| Edge Case | What Happens | Handling |
|-----------|-------------|----------|
| 2 monitors, viewing monitor 1 | Only monitor 1's video loaded | One video pool per visible monitor. Inactive monitors don't load video. |
| Switch from monitor 1 to monitor 2 view | Need different file_path | Load monitor 2's chunk. Keep monitor 1's video in pool (may switch back). |
| Monitor disconnected mid-day | Frames stop for that monitor_id | Timeline shows gap. No video to load. Existing behavior. |
| 3 monitors, all visible (side by side) | 3 active video elements + 3 preloaded = 6 total | 6 video elements is fine for browser. ~6MB memory. |
| Monitors have different resolutions | Monitor 1: 3024×1964, Monitor 2: 1920×1080 | Each `<video>` element has its own natural dimensions. OCR overlay scales independently. |
| Monitors have different fps (adaptive fps) | Monitor 1: 0.5fps, Monitor 2: 0.2fps | fps is per-chunk, stored in metadata. Each video pool uses its own fps for seeking. |

### 6.6 Error Handling & Corruption

| Edge Case | What Happens | Handling |
|-----------|-------------|----------|
| Corrupt video file (truncated) | `<video>` fires `error` event | Mark chunk as failed. Fall back to ffmpeg extraction (may also fail). Auto-skip to next valid frame. |
| Video file exists but has 0 bytes | `<video>` fires `error` event | Same as corrupt. Already handled server-side (`VIDEO_CORRUPTED: empty file`). |
| Permission denied on video file | `<video>` fires `error` event | Same as corrupt. Log the specific error for debugging. |
| HEVC not supported (Linux, some Windows) | `<video>` fires `error` event immediately or shows green frames | Detect on first video load. If error within 500ms of first load, set `useVideoElement = false` globally. Fall back to ffmpeg `<img>` path for all frames on this session. |
| Browser out of memory (too many videos) | Memory pressure, tab crash | Limit total video elements to 6 (3 monitors × 2). Eagerly revoke old blob URLs. Use `video.src = ""` to unload unused videos. |
| Network error on HTTP video endpoint | `<video>` fires `error` with network type | Retry once after 500ms. Then fall back to ffmpeg path. |

### 6.7 User Settings & Configurations

| Edge Case | What Happens | Handling |
|-----------|-------------|----------|
| Custom data directory | Video files at non-standard path | Asset protocol scope must include custom path. Use dynamic `scope.allow_directory()` or fall back to HTTP serving. |
| FPS changed mid-day | Chunks before change: 0.5fps, after: 0.2fps | Each chunk carries its own fps in metadata. Seeking uses per-chunk fps. |
| Video quality changed | Different CRF values in different chunks | Transparent to `<video>` element. No impact on seeking. |
| frame_cache enabled (server-side) | Server has precomputed JPEGs in cache | The WebSocket path (metadata only) doesn't use frame_cache. The `/frames/{id}` fallback benefits from cache. No conflict. |
| Adaptive FPS enabled | FPS varies per chunk | Same as "FPS changed mid-day" — per-chunk fps handles this. |

### 6.8 UI/UX Details

| Edge Case | What Happens | Handling |
|-----------|-------------|----------|
| Skeleton shown while chunk loads | User sees shimmer animation | Same SkeletonLoader as current. Show immediately on chunk change, hide on `seeked` event. |
| Double-click to zoom/fullscreen | Video element has native controls | Set `controls={false}`, `muted`, `playsInline`. Prevent default double-click. |
| Right-click context menu on video | Browser shows "Save Video As..." | Prevent default context menu on `<video>`. Show app-specific menu if needed. |
| Video frame vs image frame visual difference | Video rendering may differ slightly from ffmpeg JPEG | Accept this. Video is the source of truth. JPEG was a lossy derivative anyway. |
| User drags on timeline during video load | Rapid source changes while previous load in-flight | Track a "generation ID" per load request. Discard stale `seeked` events that don't match current generation. |
| Transition animation between frames | Currently 150ms opacity transition | Apply same CSS transition to `<canvas>` or use visibility swap with the double-buffer. |

### 6.9 Text Selection & URL Detection

| Edge Case | What Happens | Handling |
|-----------|-------------|----------|
| OCR overlay on `<video>` instead of `<img>` | Overlay divs positioned over video | No change — overlay uses percentage-based positioning relative to container. `videoWidth`/`videoHeight` replace `naturalWidth`/`naturalHeight`. |
| Text selection across video frame change | User selecting text, then frame changes | Selection clears on frame change (existing behavior). |
| URL detection timing | OCR data arrives after video frame is displayed | This already happens today — OCR loads async. No change needed. |

## 7. Testing Plan

### 7.1 Automated Tests

| Test | What to Verify |
|------|----------------|
| Seek accuracy | `video.currentTime = offset/fps` → `seeked` event → `video.currentTime` matches expected ±0.1s |
| Chunk transition | Load video A, seek to end; load video B, seek to start. Verify <300ms total transition. |
| Error fallback | Serve corrupt video → verify fallback to ffmpeg `<img>` path within 1s |
| Memory management | Load/unload 50 chunks sequentially → verify memory doesn't grow unbounded |
| Multi-monitor | 3 video elements seeking simultaneously → no race conditions |

### 7.2 Manual Test Scenarios

| # | Test | Expected Result |
|---|------|-----------------|
| 1 | Open overlay, scroll 10 frames forward | Each frame appears in <100ms. No skeleton flash. |
| 2 | Scroll rapidly for 5 seconds, then stop | Only final frame loads. Intermediate frames skipped. <200ms after stopping. |
| 3 | Click "previous day" button | New day's frame appears in <1s. Skeleton shown briefly. |
| 4 | Jump to date 2 weeks ago via calendar | Frame appears in <1.5s. |
| 5 | Scroll across a chunk boundary | No visible gap or flicker. |
| 6 | Leave overlay open at live edge for 5 minutes | New frames appear every ~2s. No memory growth. |
| 7 | Disconnect a monitor, scroll past that point in timeline | Graceful gap. No crash. |
| 8 | Change data directory in settings, reopen overlay | Video loads from new directory. |
| 9 | Test on Linux (no HEVC support) | Automatic fallback to ffmpeg path. Frames still load (slower). |

### 7.3 Performance Benchmarks

| Metric | Current | Target | How to Measure |
|--------|---------|--------|----------------|
| Same-chunk seek latency | 1.5–4s | <100ms | `performance.now()` between `currentTime` set and `seeked` event |
| Cross-chunk seek latency | 1.5–4s | <500ms | Same, but includes `loadeddata` event for new source |
| Day-jump latency | 3–8s | <1s | Time from date click to first frame painted |
| ffmpeg processes spawned per scroll session | ~50 | 0 | Count process spawns in server logs |
| Memory per video element | N/A | <5MB | Browser DevTools memory snapshot |
| PostHog `timeline_frame_load_time` P95 | ~3000ms | <200ms | PostHog dashboard |

## 8. Implementation Milestones

### Phase 1: Backend Data (1 day)

- [ ] Add `fps` column to `video_chunks` table (migration)
- [ ] Store fps at chunk creation time in `save_frames_as_video`
- [ ] Add `offset_index` and `fps` to `DeviceFrameResponse` in WebSocket
- [ ] Backfill existing `video_chunks` rows with default fps
- [ ] Add `/video/stream` endpoint with Range request support

### Phase 2: Frontend Video Element (2 days)

- [ ] Create `VideoFrameDisplay` component with `<video>` seeking
- [ ] Implement double-buffer pool (active + preloaded)
- [ ] Expand asset protocol scope for `~/.screenpipe/data/`
- [ ] Handle `seeked` event for frame-ready signaling
- [ ] Add ffmpeg `<img>` fallback on `<video>` error
- [ ] Wire up to existing `CurrentFrameTimeline` props

### Phase 3: Chunk Management (1 day)

- [ ] Build chunk index from WebSocket frame stream
- [ ] Implement preloading logic (adjacent chunks)
- [ ] Handle chunk transitions (swap active ↔ preloaded)
- [ ] Memory management (evict old video elements)
- [ ] Live edge chunk rotation handling

### Phase 4: Polish & Edge Cases (1 day)

- [ ] OCR overlay with `<video>` dimensions
- [ ] Platform detection → HEVC fallback for Linux
- [ ] Custom data directory support
- [ ] PostHog metrics (seek latency, chunk load time, fallback rate)
- [ ] Cleanup: remove ffmpeg frame extraction from hot path (keep as fallback)
- [ ] Update regression tests in TESTING.md

## 9. Open Questions

1. **Should we also precompute thumbnail strips?** A single JPEG montage of all frames in a chunk (~15 frames) could enable instant scrubbing previews. Out of scope for v1 but worth considering.

2. **Should the `<video>` element use `poster` attribute?** We could set `poster` to the ffmpeg-extracted JPEG as a loading placeholder, then swap to video seeking once loaded. This gives instant "something" while the video loads.

3. **Canvas-based frame capture for pixel-level operations?** If we need to do client-side text detection, PII redaction, or image export, we'd need to capture the `<video>` frame to a `<canvas>`. This is a simple `ctx.drawImage(video, 0, 0)` call but adds complexity.

4. **What about the `/frames/{id}` endpoint consumers?** The search results, AI chat, and export features use `/frames/{id}` to get JPEGs. These should continue using the ffmpeg path since they're not latency-sensitive and need actual image data. Only the timeline live-scrolling switches to `<video>`.

5. **HTTP Range request support in the Rust server**: Does the existing axum setup support Range headers for static file serving? If not, we need `tower-http`'s `ServeFile` with range support.
