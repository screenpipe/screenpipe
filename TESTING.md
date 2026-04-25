# screenpipe regression testing checklist

> **purpose**: prevent regressions. test core features rigorously every time

## critical edge cases (sorted by regression frequency)

### 1. window overlay & fullscreen spaces (macOS)

### 1.1. Live Text Interaction (macOS)

commits: `e9c76934`, `9acdf850`

- [ ] **Native Live Text selection** — On macOS, verify that native Live Text selection works within the app's text overlay.
- [ ] **Native Data Detectors** — On macOS, verify that native data detectors (e.g., phone numbers, addresses, dates) are active and clickable within the app's text overlay.
- [ ] **Cross-architecture Live Text compilation** — On both x86_64 (Intel) and arm64 (Apple Silicon) macOS machines, verify that Live Text functionality is available and works without compilation errors or runtime issues.


- [ ] **window mode CSS restore** — In window mode (not fullscreen), verify that CSS styling is correct and as expected (e.g., no unexpected transparent panels).
- [ ] **keyboard input in main window from tray** — Open the main window from the tray icon and immediately try typing. Verify that keyboard input works without requiring a click.
- [ ] **WKWebView keyboard focus recovery** — Interact with embedded web views (e.g., billing, help sections), then navigate back to other UI elements. Verify keyboard focus is correctly recovered by the WKWebView.



these break CONSTANTLY. any change to `window_api.rs`, `main.rs` shortcuts, activation policy, or NSPanel code must test ALL of these.

commits that broke this area: `0752ea59`, `d89c5f14`, `4a64fd1a`, `fa591d6e`, `8706ae73`, `6d44af13`, `b6ff1bf7`, `09a18070`

- [ ] **overlay shortcut on fullscreen space** — press shortcut while a fullscreen app (e.g., Chrome fullscreen) is active. overlay MUST appear on top.
- [ ] **chat shortcut on fullscreen space** — press chat shortcut while on a fullscreen space. chat panel MUST appear on top. Fixed: panel pre-created at startup, show uses order_front→activate order.
- [ ] **chat shortcut on normal desktop** — chat appears, receives keyboard focus, can type immediately.
- [ ] **overlay toggle on/off** — press shortcut twice. first shows, second hides. no "ghost" window left behind.
- [ ] **chat toggle on/off** — press chat shortcut twice. first shows, second closes.
- [ ] **overlay does NOT follow space swipe** — show overlay, then three-finger swipe to another space. overlay should NOT follow you (no blink-and-disappear). was broken by `MoveToActiveSpace` staying set.
- [ ] **no blink on show** — overlay appears instantly, no flash of white/transparent then reappear. was broken multiple times (`3097872b`, `8706ae73`, `09a18070`).
- [ ] **no blink on hide** — overlay disappears instantly. no momentary reappear after hiding.
- [ ] **overlay on second monitor** — with 2 monitors, show overlay. it appears on the monitor where the mouse cursor is.
- [ ] **window mode vs fullscreen mode** — switch overlay mode in settings. shortcut still works in both modes. no crash.
- [ ] **switch modes while overlay is visible** — change from fullscreen to window mode in settings while overlay is showing. should not crash (`b4eb2ab4`).
- [ ] **keyboard focus in overlay** — show overlay, start typing. text input works immediately without clicking (`d74d0665`, `5a50aaad`).
- [ ] **keyboard focus in chat** — show chat, start typing. text input works immediately.
- [ ] **escape closes overlay** — press Escape while overlay is visible. it hides.
- [ ] **no space jump on show** — showing the overlay should NOT cause a space transition animation (`6d44af13`, `d74d0665`).
- [ ] **no space jump on hide** — hiding the overlay should NOT switch you to a different space.
- [ ] **screen recording visibility setting** — toggle "show in screen recording" in settings. overlay should appear/disappear from screen recordings accordingly (`206107ba`).
- [ ] **search panel focus** — open search, keyboard focus is in search input immediately (`2315a39c`, `1f2681e3`).
- [ ] **ghost clicks after hide** — hide overlay via `order_out`. clicking where overlay was should NOT trigger overlay buttons (`32e1a962`).
- [ ] **pinch-to-zoom works** — pinch gesture on trackpad zooms timeline without needing to click first (`d99444a7`, `523a629e`).
- [ ] **shortcut reminder on all Spaces** — switch between 3+ Spaces (including fullscreen apps). reminder pill stays visible on every Space simultaneously.
- [ ] **shortcut reminder on fullscreen app** — fullscreen Chrome/Safari, reminder shows at top center. not just leftmost Space.
- [ ] **shortcut reminder doesn't steal focus** — showing reminder never takes keyboard focus from active app.
- [ ] **chat on non-primary Space** — switch to Space 3 (normal desktop), press chat shortcut. chat appears on Space 3, not Space 1. no Space transition animation.
- [ ] **chat re-show on fullscreen Space** — show chat on fullscreen Space, hide it, show again. must reappear on same fullscreen Space.
- [ ] **space monitor only hides main overlay** — swipe Spaces. main overlay hides. chat window and shortcut reminder are unaffected.
- [ ] **space monitor doesn't race with show** — show overlay via shortcut. the `activateIgnoringOtherApps` call must not trigger space monitor's hide callback.
- [ ] **Chat streaming UX** — Verify that chat streaming uses a state-aware grid dissolve loader for a smooth user experience.
- [ ] **chat always-on-top toggle** — Toggle the "chat always-on-top" setting and verify that the chat window behaves as expected (e.g., stays on top of other applications when enabled). (`b6c363e5`)
- [ ] **overlay hidden in OBS when screen recording toggle is off** — Verify that the overlay is NOT visible in OBS (or other screen capture tools) when the "show in screen recording" toggle is off. (`87d107a29`)
- [ ] **resizable shortcut overlay** — Change shortcut overlay size (small/medium/large) in settings and verify it updates correctly on all spaces. (`1e1e17171`)
- [ ] **overlay resize support for webview fallback** — Verify that the overlay can be resized even when using the webview fallback. (`d095f5994`)
- [ ] **text selection not blocked by URL overlays** — On URL-heavy pages, verify that text selection is not blocked by clickable URL overlays. (`eb9e65b4`)
- [ ] **macOS focused-app capture with AX observers** — On macOS, verify that focused-app capture works correctly when switching between applications, utilizing AX observers. (`22830119`)
- [ ] **macOS native Live Text interaction** — On macOS, verify that native Live Text interaction, including text selection and data detectors, is re-enabled and functions correctly. (`e9c76934`)
- [ ] **Livetext single worker thread** — verify no GCD thread exhaustion freeze during heavy livetext analysis. (`a3e29d42a`)
- [ ] **VisionKit semaphore timeouts** — verify no deadlocks in vision pipeline if VisionKit hangs (10s timeout). (`397f46133`)
- [ ] **Notification panel order_out** — verify no ghost clicks after hiding notification/shortcut panels. (`32fed7c8c`)
- [ ] **Excluded windows from screenshots** — Verify that windows specified in the ignore list are correctly excluded from full-monitor screenshots taken via ScreenCaptureKit (SCK). (`61212c429`)
- [ ] **Swift overlay meeting toggle** — Verify that the meeting toggle in the Swift-based overlay works correctly and reflects the recording state. (`e5e955aa6`)


### 2. dock icon & tray icon (macOS)

commits that broke this area: `0752ea59`, `7562ec62`, `2a2bd9b5`, `f2f7f770`, `5cb100ea`

- [ ] **dock icon visible on launch** — app icon appears in dock immediately on startup.
- [ ] **tray icon visible on launch** — tray icon appears in menu bar on startup.
- [ ] **dock icon persists after overlay show/hide** — show and hide overlay 5 times. dock icon must remain visible every time. was broken by Accessory mode switches.
- [ ] **tray icon persists after overlay show/hide** — same test. tray icon must remain visible.
- [ ] **dock right-click menu works** — right-click dock icon. "Show screenpipe", "Settings", "Check for updates" all work (`d794176a`).
- [ ] **tray menu items don't fire twice** — click any tray menu item. action happens once, not twice (`9e151265`).
- [ ] **tray health indicator** — tray icon shows green (healthy) or yellow/red (issues) based on recording status.
- [ ] **tray on notched MacBook** — on 14"/16" MacBook Pro, tray icon is visible (not hidden behind notch). if hidden, user can Cmd+drag to reposition.
- [ ] **activation policy never changes** — after ANY user interaction, dock icon should remain visible. no Accessory mode switches. verify with: `ps aux | grep screenpipe`.
- [ ] **no autosave_name crash** — removed in `2a2bd9b5`. objc2→objc pointer cast was causing `panic_cannot_unwind`.
- [ ] **no recreate_tray** — recreating tray pushes icon LEFT (behind notch). must only create once (`f2f7f770`).
- [ ] **tray upgrade button opens in-app checkout** — Verify that clicking the tray's upgrade button correctly opens the in-app checkout experience. (`078fcfb2`)
- [ ] **modernized tray menu** — Verify the tray menu's updated layout and functionality match the modernized design. (`b6c363e5`)
- [ ] **Recording toggle in tray** — Verify that the tray menu has a single toggle to start/stop recording (replacing separate items). (`cdc1d0fd9`)

### 3. monitor plug/unplug

commits: `28e5c247`

- [ ] **unplug external monitor while recording** — recording continues on remaining monitor(s). no crash. log shows "Monitor X disconnected".
- [ ] **plug in external monitor while recording** — new monitor is detected within 5 seconds. recording starts on it. log shows "Monitor X reconnected".
- [ ] **unplug and replug same monitor** — recording resumes. same monitor ID reused. no duplicate recording tasks.
- [ ] **unplug all external monitors (laptop only)** — built-in display continues recording. no crash.
- [ ] **plug monitor with different resolution** — recording starts at correct resolution. OCR works on new monitor.
- [ ] **"use all monitors" setting** — with this ON, all monitors auto-detected. no manual configuration needed.
- [ ] **specific monitor IDs setting** — with specific IDs configured, only those monitors are recorded. unplugging a non-configured monitor has no effect.
- [ ] **resolution change (e.g., clamshell mode)** — closing MacBook lid with external monitor. recording continues on external.
- [ ] **queue stats after unplug** — check logs. no queue stats for disconnected monitor after disconnect.
- [ ] **--use-all-monitors flag override** — Verify that the `--use-all-monitors` CLI flag correctly overrides tier-based defaults (e.g., if a tier defaults to a single monitor, the flag should still enable all monitors). (`bd5b94328`)

### 4. audio device handling

- [ ] **CoreAudio Process Tap** — On macOS 14.4+, verify that system audio defaults to CoreAudio Process Tap and rebuilds if silence is detected. (`75a52603b`, `5634664da`)


- [ ] **default audio device** — with "follow system default", recording uses whatever macOS says is default.
- [ ] **plug in USB headset** — if set to follow defaults and macOS switches to headset, recording follows.
- [ ] **unplug USB headset** — recording falls back to built-in mic/speakers. no crash. no 30s timeout errors.
- [ ] **bluetooth device connect/disconnect** — AirPods connect mid-recording. audio continues without gap.
- [ ] **no audio device available** — unplug all audio. app continues (vision still works). log shows warning, not crash.
- [ ] **audio stream timeout recovery** — if audio stream times out (30s no data), it should reconnect automatically.
- [ ] **multiple audio devices simultaneously** — input (mic) + output (speakers) both recording. both show in device list.
- [ ] **disable audio setting** — toggling "disable audio" stops all audio recording. re-enabling restarts it.
- [ ] **Metal GPU for whisper** — transcription uses GPU acceleration on macOS (`f882caef`). verify with Activity Monitor GPU tab.
- [ ] **Qwen3-asr OpenBLAS** — On Linux/Windows, verify that qwen3-asr uses OpenBLAS for improved transcription performance. (`e64ee25f4`)
- [ ] **Batch transcription mode** — Verify that batch transcription mode works correctly with both cloud and Deepgram engines.
- [ ] **Cloud transcription batch capping** — Send large audio chunks (>200s) to cloud transcription. Verify they are correctly capped/split and do not trigger Cloudflare 413 errors. (`792145ac6`)
- [ ] **Lower RMS threshold for batch mode output devices** — In batch transcription mode, verify that output devices correctly use a lower RMS threshold.
- [ ] **OpenAI-compatible STT connection test** — Configure OpenAI-compatible STT, then use the connection test feature. Verify it accurately reports connection status.
- [ ] **OpenAI-compatible STT editable model input** — When using OpenAI-compatible STT, verify that the model input fields are editable.
- [ ] **OpenAI-compatible STT with custom vocabulary** — Configure OpenAI-compatible STT with a custom vocabulary. Verify that transcription accuracy improves when this vocabulary is present in the audio. Verify that vocabulary is sent as both prompt and context. (`d3a4b6bcc`)
- [ ] **OpenAI-compatible transcription engine support** — Enable and configure the OpenAI-compatible transcription engine. Verify that audio is correctly captured and transcribed using this engine.
- [ ] **"transcribing..." only for recent chunks** — Verify that the "transcribing..." caption/indicator only appears for audio chunks that are less than 2 minutes old. (`b70116b`)
- [ ] **no transcribing caption on old silent chunks** — Verify that old silent audio chunks do not trigger or display a "transcribing..." caption. (`54a550f4`)
- [ ] **silent chunks deleted, not stored** — After periods of silence, verify that no empty transcription rows are stored in the database for silent audio chunks, and they are instead correctly deleted. (`cb2cc205`)
- [ ] **silent chunk zombie loop prevention** — Verify that silent audio chunks do not lead to a "zombie loop" resulting in excessive CPU usage or large log files. (`6b3a71eb`)
- [ ] **write-ahead transcription cache performance** — Verify that the write-ahead transcription cache improves the performance and responsiveness of audio transcription. (`46350671`)
- [ ] **enhanced audio pipeline diagnostics** — Check logs and verify that enhanced audio pipeline diagnostics provide useful and accurate information. (`2e68400c`)
- [ ] **audio start/stop shortcuts toggle capture** — Verify that the audio start/stop shortcuts correctly toggle audio capture on and off. (`3701cce2`)
- [ ] **bulk import transcription dictionary** — Verify that the bulk import functionality for the transcription dictionary works correctly, including smart delimiter detection. (`73adc9d4`)
- [ ] **Audio start/stop shortcuts** — Verify that designated audio start/stop shortcuts reliably toggle audio capture on and off. Check logs for corresponding start/stop events.
- [ ] **Filter music toggle UI** — Verify that a "filter music" toggle exists in recording settings and correctly enables/disables music filtering.
- [ ] **Music detection thresholds** — With "filter music" enabled, play various types of music. Verify that music is correctly detected and filtered, and that non-music speech is still captured.
- [ ] **Audio reconciliation FK constraint loop** — Verify that audio reconciliation does not enter an infinite retry loop on foreign key constraints. (`e9e2dc252`)
- [ ] **Skip reconciliation when transcription disabled** — Disable audio transcription in settings. Verify that audio reconciliation is skipped. (`ceb77559d`)
- [ ] **dead System Audio auto-reconnect** — Simulate a dead system audio stream. Verify it auto-reconnects and resumes capture. (`0f287761d`)
- [ ] **per-device audio toggle** — In the tray menu, verify you can toggle recording for individual audio devices. (`3ee3defcb`)
- [ ] **stable audio device order** — Verify that audio devices listed in the tray menu maintain a stable order across refreshes. (`4577ac8a6`)
- [ ] **Mic disconnect false-positives on sleep/wake** — Put the computer to sleep and wake it up. Verify that no false-positive mic disconnect notifications or logs are generated. (`796baa619`)


#### Audio device recovery (monitor unplug / device switch)

commits: device_monitor.rs atomic swap, tiered backoff, empty device list guard

- [ ] **unplug monitor during active Zoom call** — output audio recovers within 15 seconds. Verify: `grep "DEVICE_RECOVERY.*output.*restored" ~/.screenpipe/screenpipe-app.*.log`. Verify: `curl localhost:3030/search?content_type=audio&limit=5` shows output device transcriptions resume.
- [ ] **unplug and replug monitor within 5 seconds** — no audio gap. both input and output continue. Verify: no "stopping" log for input device.
- [ ] **unplug monitor, wait 2 minutes, replug** — output recovers both times. Verify: two `DEVICE_RECOVERY` log entries.
- [ ] **switch audio output (AirPods → speakers) during call** — output audio continues with <5s gap. Old device kept running until new one starts (atomic swap).
- [ ] **health endpoint during output recovery** — `curl localhost:3030/health` shows `device_status_details` with output device present within 15 seconds of recovery.
- [ ] **SCK transient failure doesn't cascade** — if ScreenCaptureKit returns empty device list, running devices are NOT disconnected. Verify: `grep "device list returned empty" ~/.screenpipe/screenpipe-app.*.log` shows warning but no disconnections.
- [ ] **DB gap query after device switch** — run: `sqlite3 ~/.screenpipe/db.sqlite "SELECT t1.timestamp as gap_start, t2.timestamp as gap_end, (julianday(t2.timestamp) - julianday(t1.timestamp)) * 86400 as gap_seconds FROM audio_transcriptions t1 JOIN audio_transcriptions t2 ON t2.id = (SELECT MIN(id) FROM audio_transcriptions WHERE id > t1.id AND is_input_device = 0) WHERE t1.is_input_device = 0 AND (julianday(t2.timestamp) - julianday(t1.timestamp)) * 86400 > 60 ORDER BY t1.timestamp;"` — should return no rows if output was continuously captured.

#### meeting detection & speaker identification

commits: calendar_speaker_id.rs, meetings.rs, meeting_persister.rs

- [ ] **restart during active meeting** — start a 1:1 calendar meeting (2 attendees), quit app mid-meeting, relaunch. meeting re-detected via calendar event still in progress. speaker names assigned. verify: `grep "meeting detected via calendar" ~/.screenpipe/screenpipe-app.*.log` shows detection after restart. verify: `sqlite3 ~/.screenpipe/db.sqlite "SELECT id, name FROM speakers WHERE name != ''"` shows both user and attendee names.
- [ ] **calendar-only meeting detection** — schedule a 1:1 meeting with 2 attendees, no meeting app (Zoom/Meet) open. meeting detected purely via calendar. verify: `grep "meeting_started" ~/.screenpipe/screenpipe-app.*.log`.
- [ ] **calendar meeting auto-end** — calendar meeting detected, wait past the calendar event end time. meeting_ended fires. verify: `grep "meeting ended via calendar" ~/.screenpipe/screenpipe-app.*.log`.
- [ ] **speaker naming in 1:1** — during 1:1 call with userName set in settings, input speaker named as user, output speaker named as other attendee. verify: `curl 'localhost:3030/search?content_type=audio&speaker_name=<attendee>&limit=5'` returns results.
- [ ] **auto-name input speaker** — with userName set, after ~2 minutes of speaking into mic, dominant input speaker named. verify: `grep "auto speaker identification: named" ~/.screenpipe/screenpipe-app.*.log`.
- [ ] **speaker names survive restart** — speaker named pre-restart stays named post-restart. verify: `sqlite3 ~/.screenpipe/db.sqlite "SELECT id, name FROM speakers WHERE name != ''"` shows same speakers before and after restart.
- [ ] **no duplicate speaker naming on restart** — restart during meeting, speakers already named aren't overwritten or duplicated. verify: no duplicate names in speakers table.
- [ ] **meeting detection stability** — Verify that meeting detection does not drop when alt-tabbing during long calls. (`7684f1d47`)
- [ ] **speaker search deduplication** — Search for speakers in the UI. Verify that results are deduplicated and reassignment targets are stable. (`34a62c053`)
- [ ] **meeting detection regardless of transcription mode** — Verify that meeting detection works even when transcription is disabled. (`ef39e728d`)
- [ ] **Windows UI Automation meeting detection** — On Windows, join a meeting in a supported app (Zoom, Teams, etc.). Verify detection works via UI element scanning rather than just process focus. (`fe905d6af`, `01eb9cf33`)
- [ ] **macOS Zoom menu bar detection** — On macOS, join a Zoom meeting. Verify detection works even if Zoom window is not focused, by scanning menu bar items. (`849372fa9`)
- [ ] **Stop auto-detected meeting from overlay** — During an auto-detected meeting, verify that the stop button in the overlay correctly terminates the meeting session. (`403d5b732`)
- [ ] **MLX transcription model reuse** — Verify that the MLX transcription model is reused across requests to prevent GPU memory spikes or crashes. (`59deeba19`)
- [ ] **Meeting detection app coverage** — Verify detection works for 35+ supported apps and various browser URL patterns. (`e6740eb38`)
- [ ] **Meeting detection UI labels** — Verify meeting status shows "starts in Xm" and filters all-day events correctly. (`ef470d9e1`)
- [ ] **Meeting detection support for Signal, WhatsApp, Telegram, and Teams 2** — Verify that meetings from these apps are correctly detected and recorded. (`8d2f1a542`, `a74e393e1`)
- [ ] **Browser meetings splitting fix** — Verify that meetings in the browser are correctly split into separate events. (`d8ba1dad3`)
- [ ] **OpenAI-compatible transcription endpoint** — Verify that the `/v1/audio/transcriptions` endpoint works as expected, following the OpenAI specification. (`5a14e9a92`)

### 5. frame comparison & OCR pipeline

commits: `6dd5d98e`, `831ad258`

commits: `6dd5d98e`, `831ad258`

- [ ] **static screen = low CPU** — leave a static image on screen for 60s. CPU should drop below 5% (release build). hash early exit should kick in.
- [ ] **active screen = OCR runs** — actively browse/type. OCR results appear in search within 5 seconds of screen change.
- [ ] **identical frames skipped** — check logs for hash match frequency on idle monitors. should be >80% skip rate.
- [ ] **ultrawide monitor (3440x1440+)** — OCR works correctly. no distortion in change detection. text at edges is captured.
- [ ] **4K monitor** — OCR works. frame comparison doesn't timeout or spike CPU.
- [ ] **high refresh rate (120Hz+)** — app respects its own FPS setting (0.5 default), not the display refresh rate.
- [ ] **very fast content changes** — scroll quickly through a document. OCR captures content, no crashes from buffer overflows.
- [ ] **corrupt pixel buffer** — sck-rs handles corrupt ScreenCaptureKit buffers gracefully (no SIGABRT). fixed in `831ad258`.
- [ ] **window capture only on changed frames** — window enumeration (CGWindowList) should NOT run on skipped frames. verify by checking CPU on idle multi-monitor setup.
- [ ] **Meeting app OCR force** — Open a meeting app (Zoom, Teams, Meet). Verify OCR is forced for these apps even if accessibility is available. (`b18ae2253`)
- [ ] **Accessibility automation properties** — Verify automation properties (labels, roles, automation IDs) are correctly captured in the accessibility tree across Windows, macOS, and Linux. (`1b7d0db5b`)
- [ ] **DB write coalesce queue** — Under heavy load (e.g. many pipes + high FPS), verify no "database is locked" errors and no vision stalls due to write contention. (`39c016cb3`, `d119d060d`, `231521192`)
- [ ] **Windows idle CPU reduction** — Verify low CPU usage on Windows when screen is idle, using event-driven hooks and caching. (`d2c9d1fb8`)
- [ ] **reduced CPU spikes in vision/capture pipeline** — Actively browse and use applications, verifying that CPU spikes in the vision/capture pipeline are significantly reduced. (`8f7294e6`)
- [ ] **OCR bounding boxes normalized on Windows/Linux** — On Windows and Linux, verify that OCR bounding boxes are correctly normalized to the 0-1 range, ensuring consistent text overlay and interaction. (`aba74513`)
- [ ] **Debounced monitor capture errors** — Simulate transient monitor capture errors. Verify that these errors are debounced and do not lead to excessive error logging or app crashes.
- [ ] **Focus-aware capture** — Enable "Only record focused monitor" in settings. Verify that Screenpipe only captures frames and runs OCR for the monitor that currently has the focused window. (`886b5c05d`)

### 6. Battery Saver Mode

commits: `d5a9d052`, `0b32cc9a`, `ca29a67b`

- [ ] **Battery Saver mode functionality** — Enable Battery Saver mode. Verify that capture adjustments (e.g., reduced FPS, paused capture) occur as expected when the device's power state changes (e.g., unplugging/plugging power, low battery).
- [ ] **Faster power state UI updates** — Change the device's power state (e.g., unplug/plug power). Verify that the UI updates quickly and accurately reflects the current power state and capture mode.
- [ ] **Correct default power mode** — On a fresh install or after a reset, verify that the default power mode is set to "performance" until Battery Saver mode is explicitly enabled or configured.

### 7. permissions (macOS)

commits: `d9d43d31`, `620c89a5`, `14acf6f0`

- [ ] **fresh install — all prompts appear** — screen recording, microphone, accessibility prompts all show on first launch.
- [ ] **denied permission → opens System Settings** — if user previously denied mic permission, clicking "grant" opens System Settings > Privacy directly (`620c89a5`).
- [ ] **permission revoked while running** — go to System Settings, revoke screen recording. app shows red permission banner within 10 seconds.
- [ ] **permission banner is visible** — solid red `bg-destructive` banner at top of main window when any permission missing. not subtle (`9c0ba5d1`).
- [ ] **permission recovery page** — navigating to /permission-recovery shows clear instructions.
- [ ] **startup permission gate** — on first launch, permissions are requested before recording starts (`d9d43d31`).
- [ ] **faster permission polling** — permission status checked every 5-10 seconds, not 30 (`d9d43d31`).
- [ ] **No recurring permission modal after close** — Grant macOS permissions, quit the app, and relaunch it multiple times. Verify that the macOS permission modal does NOT reappear every time the app is closed.

- [ ] **fresh install — all prompts appear** — screen recording, microphone, accessibility prompts all show on first launch.
- [ ] **denied permission → opens System Settings** — if user previously denied mic permission, clicking "grant" opens System Settings > Privacy directly (`620c89a5`).
- [ ] **permission revoked while running** — go to System Settings, revoke screen recording. app shows red permission banner within 10 seconds.
- [ ] **permission banner is visible** — solid red `bg-destructive` banner at top of main window when any permission missing. not subtle (`9c0ba5d1`).
- [ ] **permission recovery page** — navigating to /permission-recovery shows clear instructions.
- [ ] **startup permission gate** — on first launch, permissions are requested before recording starts (`d9d43d31`).
- [ ] **faster permission polling** — permission status checked every 5-10 seconds, not 30 (`d9d43d31`).
- [ ] **improved permission recovery UX** — Verify that the user experience for recovering from denied permissions is clear and intuitive. (`57cca740`)

### 7. Apple Intelligence (macOS 26+)

commits: `d4abc619`, `4f4a8282`, `31f37407`, `2223af9a`, `b34a4abd`, `303958f9`

- [ ] **macOS 26: API works** — `POST /ai/chat/completions` returns valid response using on-device Foundation Model.
- [ ] **macOS < 26: no crash** — app launches normally. FoundationModels.framework is weak-linked (`31f37407`). feature gracefully disabled.
- [ ] **Intel Mac: no crash** — Apple Intelligence not available, but app doesn't crash at DYLD load time.
- [ ] **JSON mode** — request with `response_format: { type: "json_object" }` returns valid JSON, no prose preamble (`2223af9a`).
- [ ] **JSON fallback extraction** — if model prepends prose before JSON, the `{...}` is extracted correctly (`b34a4abd`).
- [ ] **streaming (SSE)** — request with `stream: true` returns Server-Sent Events with incremental tokens (`4f4a8282`).
- [ ] **tool calling** — request with `tools` array gets tool definitions injected into prompt, model responds with tool calls (`4f4a8282`).
- [ ] **daily summary** — generates valid JSON summary from audio transcripts. no "JSON Parse error: Unexpected identifier 'Here'" (`303958f9`, `2223af9a`).
- [ ] **daily summary audio-only** — summary uses only audio data (no vision), single AI call (`303958f9`).

### 8. app lifecycle & updates

commits: `94531265`, `d794176a`, `9070639c`, `0378cab1`, `4a3313d3`, `7ffdd4f1`, `1b36f62d`

- [ ] **clean quit via tray** — right-click tray → Quit. all processes terminate. no orphaned ffmpeg/bun processes.
- [ ] **clean quit via dock** — right-click dock → Quit. same as above.
- [ ] **clean quit via Cmd+Q** — same verification.
- [ ] **force quit recovery** — force quit app. relaunch. database is intact. recording resumes.
- [ ] **sleep/wake** — close laptop lid, wait 10s, open. recording resumes within 5s. no crash (`9070639c`).
- [ ] **restart app** — quit and relaunch. all settings preserved. recording starts automatically.
- [ ] **Cross-platform autorelease pool** — Verify that Windows and Linux builds compile and run without issues related to macOS-specific autorelease pool calls. (`851b3037c`)
- [ ] **Main thread safety (macOS)** — Verify that tray icon operations, space monitoring, and frontmost app restoration are dispatched to the main thread to prevent crashes. (`ac46aa437`, `418826dfa`, `274826dfa`)
- [ ] **ObjC memory management (macOS)** — Verify that all ObjC operations are wrapped in scoped autorelease pools and objects are retained in async callbacks to prevent use-after-free or SIGSEGV crashes. (`4cb9850f7`, `c49350df0`, `139500d52`)
- [ ] **auto-update** — when update available, UpdateBanner shows in main window. clicking it downloads and installs.
- [ ] **update without tray** — user can update via dock menu "Check for updates" or Apple menu "Check for Updates..." (`d794176a`, `94531265`).
- [ ] **update banner in main window** — when update available, banner appears at top of main window.
- [ ] **source build update dialog** — source builds show "source build detected" dialog with link to pre-built version.
- [ ] **port conflict on restart** — if old process is holding port 3030, new process kills it and starts cleanly (`0378cab1`, `4a3313d3`, `8c435a10`).
- [ ] **no orphaned processes** — after quit, `ps aux | grep screenpipe` shows nothing. `lsof -i :3030` shows nothing.
- [ ] **rollback** — user can rollback to previous version via tray menu (`c7fbc3ea`).
- [ ] **Zombie CPU drain prevention** — Verify that `lsof` calls have a 5-second timeout, preventing zombie CPU drain, especially on quit. Check logs for `lsof` timeouts if applicable.
- [ ] **Tokio shutdown stability** — Verify that the `tokio` shutdown process is stable and doesn't panic in the tree walker, especially during application exit or process restarts.
- [ ] **No ggml Metal destructor crash on quit** — Perform multiple quick quits (Cmd+Q, tray quit) and restarts. Verify that the app exits cleanly without a `ggml Metal destructor crash`.
- [ ] **Properly wait for UI recorder tasks before exit** — During a clean quit, verify that all UI recorder tasks complete properly and no orphaned processes or partial recordings remain.
- [ ] **recording watchdog diagnostics** — Verify that the recording watchdog correctly diagnoses and handles recording issues, and provides useful diagnostic information. (`af2b4f3d`)
- [ ] **capture stall detection** — Simulate or observe a capture stall. Verify that a notification appears with a "Restart" button to recover. (`d3ead88eb`)
- [ ] **DB write stall detection** — if DB writes stall, verify a notification appears with a "Restart" button. (`1b4bf7918`)
- [ ] **clean startup after unclean shutdown on Windows** — On Windows, verify that the app starts cleanly after an unclean shutdown (e.g., force quit), without port 3030 binding failures. (`a8413fe2`)
- [ ] **sleep/wake detection on Windows and Linux** — Verify that recording resumes correctly after sleep/wake on Windows and Linux. (`f519281b5`)

### 9. database & storage

commits: `eea0c865`, `cc09de61`, `e61501da`, `d25191d7`, `60096fb9`

- [ ] **slow DB insert warning** — check logs. "Slow DB batch insert" warnings should be <1s in normal operation. >3s indicates contention.
- [ ] **concurrent DB access** — UI queries + recording inserts happening simultaneously. no "database is locked" errors.
- [ ] **store race condition** — rapidly toggle settings while recording is active. no crash (`eea0c865`).
- [ ] **event listener race condition** — Tauri event listener setup during rapid window creation. no crash (`cc09de61`).
- [ ] **UTF-8 boundary panic** — search with special characters, non-ASCII text in OCR results. no panic on string slicing (`eea0c865`).
- [ ] **low disk space** — with <1GB free, app should warn user. no crash from failed writes.
- [ ] **large database (>10GB)** — search still returns results within 2 seconds. app doesn't freeze on startup.
- [ ] **Snapshot compaction integrity** — Verify compaction doesn't result in NULL offset_index or pool exhaustion. (`09245af5f`)
- [ ] **Audio chunk timestamps** — `start_time` and `end_time` are correctly set for reconciled and retranscribed audio chunks in the database.
- [ ] **SCREENPIPE_DATA_DIR usage** — Set the `SCREENPIPE_DATA_DIR` environment variable. Verify the app uses this directory for all its data storage. (`d5f30db71`)
- [ ] **DB pool starvation prevention** — Simulate high database load (e.g., rapid screen activity, many pipes running) and monitor logs. Verify no "database is locked" errors or signs of DB pool starvation.
- [ ] **DB write coalescing queue** — verify high-frequency captures (e.g. 10 FPS) don't lock the UI or cause write errors. (`c23768f41`)
- [ ] **Multi-byte window titles in suggestions** — Interact with suggestions for windows that have multi-byte (e.g., Unicode, emoji) characters in their titles. Verify no char boundary panics.
- [ ] **no concurrent reconciliation issues** — Verify that concurrent reconciliation processes do not cause issues during heavy load or sync operations. (`1d436bc3`)
- [ ] **pipe_config blobs skipped in sync** — Verify that `pipe_config` blobs are correctly skipped during synchronization, preventing unnecessary data transfer and potential issues. (`08d5c53a`)
- [ ] **Pi's native auto-compaction for pipe session history** — Verify that Pi's native auto-compaction feature for pipe session history works as expected, preventing indefinite growth of history and maintaining performance. (`8f49e2cf`)
- [ ] **UTF-8 panic with long multi-byte strings** — Introduce long strings with multi-byte UTF-8 characters (e.g., in window titles, chat input, search queries). Verify no panics occur when these strings are truncated, stored, or processed.
- [ ] **fsync snapshots before DB commit** — verify data integrity by force-quitting during heavy capture; snapshots should match DB entries. (`2e63282b8`)
- [ ] **Data directory setting location** — Verify that the data directory setting is now located in the "Storage" tab of the settings menu. (`0d3ffe30a`)
- [ ] **store.bin encryption** — Enable "Encrypt store.bin" in settings (Privacy > Security). Verify that `store.bin` is encrypted and correctly decrypted on startup using the OS keychain. (`143875207`, `aee1cd2b5`, `85ecd7935`)
- [ ] **graceful keychain denial** — On macOS, deny keychain access for store encryption. Verify the app handles it gracefully and falls back to unencrypted store if necessary or warns the user. (`b9c01b916`)

- [ ] **slow DB insert warning** — check logs. "Slow DB batch insert" warnings should be <1s in normal operation. >3s indicates contention.
- [ ] **concurrent DB access** — UI queries + recording inserts happening simultaneously. no "database is locked" errors.
- [ ] **store race condition** — rapidly toggle settings while recording is active. no crash (`eea0c865`).
- [ ] **event listener race condition** — Tauri event listener setup during rapid window creation. no crash (`cc09de61`).
- [ ] **UTF-8 boundary panic** — search with special characters, non-ASCII text in OCR results. no panic on string slicing (`eea0c865`).
- [ ] **low disk space** — with <1GB free, app should warn user. no crash from failed writes.
- [ ] **large database (>10GB)** — search still returns results within 2 seconds. app doesn't freeze on startup.
- [ ] **Audio chunk timestamps** — `start_time` and `end_time` are correctly set for reconciled and retranscribed audio chunks in the database.

### 10. AI presets & settings

commits: `8a5f51dd`, `0b0d8090`, `7e58564e`, `2522a7e2`, `f3e55dbc`, `79f2913f`

- [ ] **Ollama not running** — creating an Ollama preset shows free-text input fields (not stuck loading). user can type model name manually (`8a5f51dd`).
- [ ] **custom provider preset** — user can add a custom API endpoint. model name is free-text input with optional autocomplete.
- [ ] **settings survive restart** — change any setting, quit, relaunch. setting is preserved.
- [ ] **overlay mode switch** — change from fullscreen to window mode. setting saves. next shortcut press uses new mode.
- [ ] **FPS setting** — change capture FPS. recording interval changes accordingly.
- [ ] **language/OCR engine setting** — change OCR language. new language used on next capture cycle.
- [ ] **video quality setting** — low/balanced/high/max. affects FFmpeg encoding params (`21bddd0f`).
- [ ] **Settings UI sentence case** — All settings UI elements (billing, pipes, team) should use consistent sentence case.
- [ ] **Sidebar text visibility in Auto theme** — On macOS, switch between Light, Dark, and Auto system theme modes. Verify that sidebar text remains visible and legible in all modes. (`16d38570d`)
- [ ] **Billing page links to website** — Verify that the in-app billing page correctly links to the *new* website billing page.
- [ ] **Non-pro subscriber Whisper fallback** — As a non-pro subscriber, verify that audio transcription defaults to `whisper-large-v3-turbo-quantized` and functions correctly.
- [ ] **Pi restart on preset switch** — Switch between different AI presets. Verify that the Pi agent restarts if required by the new preset.
- [ ] **Web search disabled for non-cloud providers** — When using a non-cloud AI provider, verify that web search functionality is correctly disabled.
- [ ] **Credit balance in billing UI and errors** — Verify that the billing UI accurately displays the credit balance and clearly differentiates between `credits_exhausted` and other LLM-related errors.
- [ ] **Unknown AI provider type sanitization** — Configure a malformed or unknown AI provider type (e.g., by manual config edit). Verify the app doesn't crash on startup or when navigating to settings, and gracefully handles the unknown type.
- [ ] **standalone settings page** — Verify that clicking settings in the tray menu opens a standalone `/settings` page instead of a modal overlay. (`ec2a5789e`)
- [ ] **optional API auth** — Enable API auth in settings (or via `--api-auth`). Verify that remote access to the API requires the configured token. (`09f18141a`, `cfc1a74e1`)
- [ ] **privacy settings reordering** — Verify that the Security section appears first in the Privacy settings tab. (`4718785b6`)
- [ ] **password field filtering** — Verify that password fields are skipped in the accessibility tree and not stored as OCR/text. (`8159641f5`, `d39e42e5b`)
- [ ] **browser extension popup filtering** — Verify that browser extension popups (like Bitwarden) are filtered and not captured in the accessibility tree or as black frames. (`52d20987a`, `449ae7a68`, `931db40b6`)

commits: `8a5f51dd`, `0b0d8090`

- [ ] **Ollama not running** — creating an Ollama preset shows free-text input fields (not stuck loading). user can type model name manually (`8a5f51dd`).
- [ ] **custom provider preset** — user can add a custom API endpoint. model name is free-text input with optional autocomplete.
- [ ] **settings survive restart** — change any setting, quit, relaunch. setting is preserved.
- [ ] **overlay mode switch** — change from fullscreen to window mode. setting saves. next shortcut press uses new mode.
- [ ] **FPS setting** — change capture FPS. recording interval changes accordingly.
- [ ] **language/OCR engine setting** — change OCR language. new language used on next capture cycle.
- [ ] **video quality setting** — low/balanced/high/max. affects FFmpeg encoding params (`21bddd0f`).
- [ ] **Settings UI sentence case** — All settings UI elements (billing, pipes, team) should use consistent sentence case.

### 11. onboarding

commits: `87abb00d`, `9464fdc9`, `0f9e43aa`, `7ea15f32`, `bf1f1004`

- [ ] **fresh install flow** — onboarding appears, permissions requested, user completes setup.
- [ ] **auto-advance after engine starts** — status screen advances automatically after 15-20 seconds once engine is running (`87abb00d`, `9464fdc9`).
- [ ] **skip onboarding** — user can skip and get to main app. settings use defaults.
- [ ] **Onboarding completion destination** — After completing onboarding, verify that the home window opens instead of the timeline overlay. (`6ddc33a94`, `3cf668c76`)
- [ ] **shortcut gate** — onboarding teaches the shortcut. user must press it to proceed (`0f9e43aa`).
- [ ] **onboarding window size** — window is correctly sized, no overflow (`7ea15f32`).
- [ ] **onboarding doesn't re-show** — after completing onboarding, restart app. main window shows, not onboarding.
- [ ] **First-run 2-hour reminder notification** — On a fresh install, verify that a custom notification panel appears after approximately 2 hours as a first-run reminder.

commits: `87abb00d`, `9464fdc9`, `0f9e43aa`, `7ea15f32`

- [ ] **fresh install flow** — onboarding appears, permissions requested, user completes setup.
- [ ] **auto-advance after engine starts** — status screen advances automatically after 15-20 seconds once engine is running (`87abb00d`, `9464fdc9`).
- [ ] **skip onboarding** — user can skip and get to main app. settings use defaults.
- [ ] **shortcut gate** — onboarding teaches the shortcut. user must press it to proceed (`0f9e43aa`).
- [ ] **onboarding window size** — window is correctly sized, no overflow (`7ea15f32`).
- [ ] **onboarding doesn't re-show** — after completing onboarding, restart app. main window shows, not onboarding.

### 12. timeline & search

commits: `f1255eac`, `25cbdc6b`, `2529367d`, `d9821624`, `e61501da`, `039d5fea`, `50ff4f4c`, `91cc4371`, `bcce42796`, `a98fa2991`, `0ff93b167`, `adbbb8f84`

- [ ] **arrow key navigation** — left/right arrow keys navigate timeline frames (`f1255eac`).
- [ ] **search results sorted by time** — search results appear in chronological order (`25cbdc6b`).
- [ ] **no frame clearing during navigation** — navigating timeline doesn't cause frames to disappear and reload (`2529367d`).
- [ ] **URL detection in frames** — URLs visible in screenshots are extracted and shown as clickable pills (`50ef52d1`, `aa992146`).
- [ ] **app context popover** — clicking app icon in timeline shows context (time, windows, urls, audio) (`be3ecffb`).
- [ ] **Timeline single "current" bar** — Verify that the timeline only shows one "current time" bar, even during rapid updates. (`bcce42796`)
- [ ] **Timeline "Calls" filter** — Verify the "Calls" filter on the timeline correctly filters for call-related events. (`0ff93b167`)
- [ ] **Collapsible timeline filters** — Verify that timeline filters can be collapsed and expanded correctly. (`0ff93b167`)
- [ ] **daily summary in timeline** — Apple Intelligence summary shows in timeline, compact when no summary (`d9821624`).
- [ ] **window-focused refresh** — opening app via shortcut/tray refreshes timeline data immediately (`0b057046`).
- [ ] **code block colors in memories** — Verify that code block colors in the memories page match the current app theme. (`1c8d785fc`)
- [ ] **memories page pagination** — Verify that memories page pagination works correctly and tags are loaded from the API. (`3e00b70b4`)
- [ ] **frame deep link navigation** — `screenpipe://frame/N` or `screenpipe://frames/N` opens main window and jumps to frame N. works from cold start; invalid IDs show clear error.
- [ ] **missing frames return 404** — Attempt to access a non-existent frame via the API. Verify that it returns a 404 error. (`2e63282b8`)
- [ ] **Search result exact navigation** — Click a search result. Verify it navigates exactly to the associated `frame_id`. (`a98fa2991`)
- [ ] **Search navigation persistence** — Navigate to a frame from search results. Shift focus away from the app and back. Verify the navigation is not reset. (`71dee4ca3`)
- [ ] **Search navigation race condition** — Verify that search navigation works reliably even if the webview is still mounting (retries should handle it). (`2015137a1`)
- [ ] **Consolidated text search** — Perform keyword searches. Verify results are correctly pulled from the consolidated `frames.full_text` and `frames_fts`. (`adbbb8f84`)
- [ ] **Keyword search accessibility** — Keyword search should find content within accessibility-only frames and utilize `frames_fts` for comprehensive accessibility text searching.
- [ ] **Keyword search logic** — Verify that keyword search SQL correctly uses `OR` instead of `UNION` within `IN()`.
- [ ] **Search prompt accuracy** — Verify that search prompts are improved to prevent false negatives from over-filtering.
- [ ] **Past-day timeline navigation** — Navigate the timeline to past days (e.g., using date picker or arrow keys). Verify that data loads correctly and the timeline behaves as expected.
- [ ] **`content_type=all` search and pagination** — Perform search queries with `content_type=all`. Verify that the result count is accurate and pagination works correctly without missing or duplicating results.
- [ ] **Search pagination with offset** — Perform paginated searches, particularly beyond the first page. Verify that results are not empty or incorrect due to double-applied offsets.
- [ ] **`search_ocr()` returns results for event-driven capture** — Verify that `search_ocr()` correctly returns OCR results for event-driven captures and does not return empty when visible text is present on screen.
- [ ] **timeline displays consistent timestamps** — Verify that the timeline displays consistent timestamps, regardless of locale settings, and that there are no timestamp localization issues via websocket. (`2cf0c14e`)
- [ ] **timeline retry backoff mechanism** — Verify that the timeline's retry backoff mechanism functions as expected for data loading, ensuring resilience during temporary data unavailability. (`57cca740`)
- [ ] **arrow key navigation between search results in timeline** — Verify that left/right arrow keys correctly navigate between search results within the timeline view. (`3e8f37fc`)
- [ ] **URL chips always shown when detected** — Verify that URL chips are always displayed in the UI when URLs are detected in the content. (`cba69e56`)
- [ ] **refresh button inline with suggestion chips (icon-only)** — Verify that the refresh button for suggestion chips is displayed inline with the chips and is icon-only. (`a80e9ce6`)
- [ ] **bottom suggestion chips hidden on empty chat** — Verify that bottom suggestion chips are hidden when the chat is empty to avoid duplication. (`d6c4b821`)
- [ ] **Refresh button for suggestion chips** — A refresh button appears on bottom suggestion chips. Clicking it updates suggestions.
- [ ] **Timeline refresh button hover** — verify cursor-pointer and hover state on timeline refresh button. (`0cee47b62`)
- [ ] **Smarter idle suggestions** — Verify that "idle suggestions" appear and are contextually relevant when the user is inactive.
- [ ] **Hide suggestion chips on empty chat** — Verify that suggestion chips are hidden when the chat is empty to prevent duplication.
- [ ] **Text selection not blocked by URL overlays** — On URL-heavy pages, verify that text selection is not blocked by clickable URL overlays.
- [ ] **AI suggestion chip refresh and animations** — Verify a refresh button exists on AI suggestion chips, and appropriate animations (e.g., loading spinner) are shown when refreshing.
- [ ] **Activity summary time measurement and relative parsing** — Verify activity summaries display accurate time measurements and relative time parsing (e.g., "5 minutes ago", "yesterday") works correctly in the UI.
- [ ] **Hybrid OCR for canvas apps** — Verify that text from Google Docs and Figma (canvas-rendered) is captured using hybrid OCR. (`4d2b05990`, `f09f1e9aa`)
- [ ] **Search modal scroll** — Verify that the search modal is scrollable on Windows/Linux embedded timeline and trackpad/wheel scrolling works. (`f108f1f0d`, `2a2bd9b5`, `5762c60bf`)
- [ ] **Modal scrolling (general)** — Verify that all modals (e.g., settings, pipes, search) are scrollable and handle overflow correctly, especially on Windows and Linux. (`19789657d`)
- [ ] **Search modal UX** — Verify that click interference from Live Text and wheel handlers is resolved, and app/date filter timezone bugs are fixed. (`0c883819e`, `b7123231`, `f09f1e9aa`)
- [ ] **Timeline filter viewport scoping** — verify timeline filters apply to current viewport, not a fixed 800-frame window. (`9277431e4`)
- [ ] **Chat UI code blocks** — verify light text on dark bg in chat code blocks. (`c029f7779`)
- [ ] **Chat image viewer** — verify images can be viewed in chat. (`2bcdf8d8b`)
- [ ] **Chat preset dropdown** — verify AI preset switching within chat. (`2bcdf8d8b`)
- [ ] **Memories Settings UI** — verify frame_id relationship and Memories settings work as expected. (`67f4c4304`)

commits: `f1255eac`, `25cbdc6b`, `2529367d`, `d9821624`

- [ ] **arrow key navigation** — left/right arrow keys navigate timeline frames (`f1255eac`).
- [ ] **search results sorted by time** — search results appear in chronological order (`25cbdc6b`).
- [ ] **no frame clearing during navigation** — navigating timeline doesn't cause frames to disappear and reload (`2529367d`).
- [ ] **URL detection in frames** — URLs visible in screenshots are extracted and shown as clickable pills (`50ef52d1`, `aa992146`).
- [ ] **app context popover** — clicking app icon in timeline shows context (time, windows, urls, audio) (`be3ecffb`).
- [ ] **daily summary in timeline** — Apple Intelligence summary shows in timeline, compact when no summary (`d9821624`).
- [ ] **window-focused refresh** — opening app via shortcut/tray refreshes timeline data immediately (`0b057046`).
- [ ] **frame deep link navigation** — `screenpipe://frame/N` or `screenpipe://frames/N` opens main window and jumps to frame N. works from cold start; invalid IDs show clear error.
- [ ] **Keyword search accessibility** — Keyword search should find content within accessibility-only frames and utilize `frames_fts` for comprehensive accessibility text searching.
- [ ] **Keyword search logic** — Verify that keyword search SQL correctly uses `OR` instead of `UNION` within `IN()`.
- [ ] **Search prompt accuracy** — Verify that search prompts are improved to prevent false negatives from over-filtering.

### 13. sync & cloud

- [ ] **CLI remote sync** — Run `screenpipe sync remote`. Verify it correctly syncs data to a remote SSH/SFTP server. (`f46e85cb1`)


commits: `2f6b2af5`, `ea7f1f61`, `5cb100ea`

- [ ] **auto-remember sync password** — user doesn't have to re-enter password each time (`5cb100ea`).
- [ ] **auto-download from other devices** — after upload cycle, download new data from paired devices (`2f6b2af5`).
- [ ] **auto-init doesn't loop** — sync initialization happens once, doesn't repeat endlessly (`ea7f1f61`).
- [ ] **Cloud archive docs** — Verify that the cloud archive documentation page exists and is accessible via a link from settings.
- [ ] **simplified Arc URL extraction** — Verify that simplified Arc URL extraction works correctly, capturing URLs from Arc browser content. (`08d5c53a`)
- [ ] **Randomly generated cloud sync password** — On new sync setup, verify that a randomly generated cloud sync password is used.
- [ ] **Trialing subscriptions for pipe sync** — With a trialing subscription, verify that pipe sync functions as if the subscription is active, and pipes sync correctly.
- [ ] **Encrypted pipe sync (Pro) and locked toggle (non-Pro)** — As a Pro user, enable encrypted pipe sync and verify pipes sync encrypted. As a non-Pro user, verify the encrypted pipe sync toggle is locked and inaccessible.
- [ ] **Arc URL extraction and pipe_config blobs** — If Arc Browser is supported, verify accurate URL extraction. Verify that `pipe_config` blobs are correctly skipped during sync (requires inspection of sync data or logs).
- [ ] **Per-device record counts in sync** — In sync settings, verify that record counts are displayed for each synchronized device and that sync configuration persists across restarts. (`0e7baaedb`)
- [ ] **transcription daily cost cap** — Verify that the daily cost cap for transcription is correctly enforced and prevents further transcription once reached. (`2f67a1041`)
- [ ] **local Google Calendar OAuth** — Connect Google Calendar. Verify it uses the local OAuth flow instead of a cloud-based one. (`0177fdf2b`)

### 14. Region OCR (Shift+Drag)

commits: `b3628788`, `738178da`

- [ ] **Shift+Drag region OCR functionality** — Perform a `Shift+Drag` region OCR selection on the screen. Verify that the RegionOcrOverlay appears correctly and local OCR processes the selected region.
- [ ] **Local OCR without login for Shift+Drag** — Verify that the `Shift+Drag` region OCR uses local OCR and functions correctly without requiring the user to be logged in or have a cloud subscription.

### 15. Windows-specific

commits: `eea0c865`, `fe9060db`, `c99c3967`, `aeaa446b`, `5a219688`, `caae1ebc`, `67caf1d1`, `ff4af7b5`

- [ ] **COM thread conflict** — audio and vision threads don't conflict on COM initialization (`eea0c865`).
- [ ] **high-DPI display (150%, 200%)** — OCR captures at correct resolution.
- [ ] **multiple monitors** — all detected and recorded.
- [ ] **Windows Defender** — app not blocked by default security.
- [ ] **Windows default mode** — On Windows, the app should default to window mode on first launch.
- [ ] **Windows taskbar icon** — The app should display a taskbar icon on Windows.
- [ ] **Windows audio transcription accuracy** — On Windows, verify improved audio transcription accuracy due to native Silero VAD frame size and lower speech threshold.
- [ ] **Windows multi-line pipe prompts** — Multi-line pipe prompts should be preserved on Windows.
- [ ] **Windows ARM64 support** — On a Windows ARM64 device, verify the app installs and runs correctly. (`d62360bc4`)
- [ ] **Windows app matching for meetings** — On Windows, verify that meeting detection correctly matches active applications. (`ef39e728d`)
- [ ] **Alt+S shortcut activates overlay with keyboard focus** — On Windows, press `Alt+S`. Verify that the overlay window appears and immediately receives keyboard focus, allowing immediate typing.
- [ ] **OcrTextBlock deserialization handles Windows OCR format** — On Windows, verify that `OcrTextBlock` deserialization correctly handles the specific Windows OCR format. (`c49ccb55`)
- [ ] **populate accessibility tree bounds for text overlay on Windows** — On Windows, verify that accessibility tree bounds are correctly populated for text overlay, ensuring accurate positioning and interaction. (`4d20803a`)
- [ ] **capture full accessibility tree for Chromium/Electron apps on Windows** — On Windows, verify that the full accessibility tree is captured for Chromium/Electron applications. (`2e50c772`)
- [ ] **Accessibility tree bounds for text overlay** — On Windows, verify that text overlays accurately reflect the accessibility tree bounds, making selection and interaction precise.
- [ ] **No console flash during GPU detection** — On Windows startup, verify that no temporary console window flashes during the GPU detection process. (`a0aba1643`)
- [ ] **Filter noisy system apps** — On Windows, verify that noisy system apps are filtered out from screen capture and do not appear in the timeline or search results.
- [ ] **Settings window instead of overlay** — On Windows, verify that the Settings window is used instead of the overlay for settings, and the shortcut toggle works correctly. (`c13e21b55`)

commits: `eea0c865`, `fe9060db`, `c99c3967`, `aeaa446b`, `5a219688`, `caae1ebc`, `67caf1d1`

- [ ] **COM thread conflict** — audio and vision threads don't conflict on COM initialization (`eea0c865`).
- [ ] **high-DPI display (150%, 200%)** — OCR captures at correct resolution.
- [ ] **multiple monitors** — all detected and recorded.
- [ ] **Windows Defender** — app not blocked by default security.
- [ ] **Windows default mode** — On Windows, the app should default to window mode on first launch.
- [ ] **Windows taskbar icon** — The app should display a taskbar icon on Windows.
- [ ] **Windows audio transcription accuracy** — On Windows, verify improved audio transcription accuracy due to native Silero VAD frame size and lower speech threshold.
- [ ] **Windows multi-line pipe prompts** — Multi-line pipe prompts should be preserved on Windows.

#### Windows text extraction matrix (accessibility vs OCR)

The event-driven pipeline (`paired_capture.rs`) decides per-frame whether to use accessibility tree text or OCR. Terminal apps force OCR because their accessibility tree only returns window chrome.

commits: `5a219688` (wire up Windows OCR), `caae1ebc` (prefer OCR for terminals), `67caf1d1` (no chrome fallback)

**App categories and expected behavior:**

| App category | Examples | `app_prefers_ocr` | Text source | Expected text |
|---|---|---|---|---|
| Browser | Chrome, Edge, Firefox | false | Accessibility | Full page content + chrome |
| Code editor | VS Code, Fleet | false | Accessibility | Editor content, tabs, sidebar |
| Terminal (listed) | WezTerm, Windows Terminal, Alacritty | true | Windows OCR | Terminal buffer content via screenshot |
| Terminal (unlisted) | cmd.exe, powershell.exe | false | Accessibility | Whatever UIA exposes (may be limited) |
| System UI | Explorer, taskbar, Settings | false | Accessibility | UI labels, text fields |
| Games / low-a11y apps | Games, Electron w/o a11y | false | Windows OCR (fallback) | OCR from screenshot |
| Lock screen | LockApp.exe | false | Accessibility | Time, date, battery |

**Terminal detection list** (`app_prefers_ocr` matches, case-insensitive):
`wezterm`, `iterm`, `terminal`, `alacritty`, `kitty`, `hyper`, `warp`, `ghostty`

Note: `"terminal"` matches `WindowsTerminal.exe` but NOT `cmd.exe` or `powershell.exe`.

**Test checklist:**

- [ ] **WezTerm OCR capture** — open WezTerm, type commands. search for terminal content within 30s. should return OCR text, NOT "System Minimize Restore Close" chrome.
- [ ] **Windows Terminal OCR** — same test with Windows Terminal.
- [ ] **Chrome/Edge full accessibility** — open Chrome or Edge, browse a page. search returns full page content from accessibility tree, not just limited UI elements.
- [ ] **VS Code full accessibility** — open VS Code with a file. search returns full code content and UI elements from accessibility tree.
- [ ] **Game/no-a11y OCR fallback** — open an app with poor accessibility. OCR should run and extract text from screenshot.
- [ ] **OCR engine name** — query DB: OCR entries should have engine `WindowsNative` (not `AppleNative`).
- [ ] **Failed OCR = no noise** — if OCR fails for a terminal, the frame should have NULL text, not chrome like "System Minimize Restore Close".
- [ ] **Non-terminal chrome-only** — rare case where a normal app returns only chrome from accessibility. stored as-is (acceptable, no OCR fallback triggered).
- [ ] **Empty accessibility + empty OCR** — app with no tree text and OCR failure. frame stored with NULL text. no crash.
- [ ] **ocr_text table populated** — `SELECT COUNT(*) FROM ocr_text` should be non-zero after a few minutes of use on Windows.

#### Windows text extraction — untested / unknown apps

These apps are common on Windows but have **never been tested** with the event-driven pipeline. We don't know if their accessibility tree returns useful text or just chrome. Each needs manual verification: open the app, use it for a few minutes, then `curl "http://localhost:3030/search?app_name=<name>&limit=3"` and check if the text is meaningful.

**Status legend:** `?` = untested, `OK` = verified good, `CHROME` = only returns chrome, `EMPTY` = no text, `OCR-NEEDED` = should be added to `app_prefers_ocr`

| App | Status | a11y text quality | Notes |
|---|---|---|---|
| **Browsers** | | | |
| Chrome | OK | good (full page content) | 2778ch avg, rich a11y tree |
| Edge | ? | probably good | same Chromium UIA as Chrome |
| Firefox | ? | unknown | different a11y engine than Chromium |
| Brave / Vivaldi / Arc | ? | probably good | Chromium-based, needs verification |
| **Code editors** | | | |
| VS Code | ? | unknown | Electron, should have good UIA |
| JetBrains (IntelliJ, etc) | ? | unknown | Java Swing/AWT, UIA quality varies |
| Sublime Text | ? | unknown | custom UI, may need OCR fallback |
| Cursor | ? | unknown | Electron fork of VS Code |
| Zed | ? | unknown | custom GPU renderer, a11y unknown |
| **Terminals** | | | |
| WezTerm | CHROME | chrome only ("System Minimize...") | `app_prefers_ocr` = true, OCR works |
| Windows Terminal | ? | unknown | matches `"terminal"` in `app_prefers_ocr` |
| cmd.exe | ? | unknown | NOT matched by `app_prefers_ocr` |
| powershell.exe | ? | unknown | NOT matched by `app_prefers_ocr` |
| Git Bash (mintty) | ? | unknown | NOT matched by `app_prefers_ocr` |
| **Communication** | | | |
| Discord | ? | unknown | Electron, old OCR data exists |
| Slack | ? | unknown | Electron |
| Teams | ? | unknown | Electron/WebView2 |
| Zoom | ? | unknown | custom UI |
| Telegram | ? | unknown | Qt-based |
| WhatsApp | ? | unknown | Electron |
| **Productivity** | | | |
| Notion | ? | unknown | Electron |
| Obsidian | ? | unknown | Electron |
| Word / Excel / PowerPoint | ? | unknown | native Win32, historically good UIA |
| Outlook | ? | unknown | mixed native/web |
| OneNote | ? | unknown | UWP, should have good UIA |
| **Media / Creative** | | | |
| Figma | ? | unknown | Electron + canvas, likely poor a11y on canvas |
| Spotify | ? | unknown | Electron/CEF |
| VLC | ? | unknown | Qt-based |
| Adobe apps (Photoshop, etc) | ? | unknown | custom UI, historically poor a11y |
| **System / Utilities** | | | |
| Explorer | OK | good | file names, paths, status bar |
| Settings | ? | unknown | UWP, should be good |
| Task Manager | ? | unknown | UWP on Win11 |
| Notepad | ? | unknown | should have excellent UIA |
| **Games / GPU-rendered** | | | |
| Any game | ? | likely empty | GPU-rendered, no UIA tree. should fall to OCR |
| Electron w/ disabled a11y | ? | likely empty | some Electron apps disable a11y |

**Priority to test (most common user apps):**
1. VS Code — most developers will have this open
2. Discord / Slack — always running in background
3. Windows Terminal / cmd.exe / powershell.exe — verify terminal detection
4. Edge / Firefox — browser is primary use
5. Notion / Obsidian — knowledge workers
6. Office apps — enterprise users

**How to verify an app:**
```bash
# 1. Open the app, use it for 2 minutes
# 2. Check what was captured:
curl "http://localhost:3030/search?app_name=<exe_name>&limit=3&content_type=all"
# 3. If text is only chrome (System/Minimize/Close), it may need adding to app_prefers_ocr
# 4. If text is empty and screenshots exist, OCR fallback should kick in
# 5. Update this table with findings
```

**Apps that may need adding to `app_prefers_ocr` list:**
- If cmd.exe / powershell.exe return chrome-only text, add `"cmd"` and `"powershell"` to the list
- If mintty (Git Bash) returns chrome-only, add `"mintty"`
- Any app where the accessibility tree consistently returns only window chrome but screenshots contain readable text

### 15. Help and Support

commits: `deac5ea9`

- [ ] **Intercom integration in help section** — Navigate to the desktop app's help section. Verify that Crisp is replaced by Intercom and that the Intercom chat widget and knowledge base search function as expected.

### 16. CI / release

commits: `8f334c0a`, `fda40d2c`

- [ ] **macOS 26 runner** — release builds on self-hosted macOS 26 runner with Apple Intelligence (`fda40d2c`).
- [ ] **updater artifacts** — release includes `.tar.gz` + `.sig` for macOS, `.nsis.zip` + `.sig` for Windows.
- [ ] **prod config used** — CI copies `tauri.prod.conf.json` to `tauri.conf.json` before building. identifier is `screenpi.pe` not `screenpi.pe.dev`.
- [ ] **draft then publish** — `workflow_dispatch` creates draft. manual publish or `release-app-publish` commit publishes.
- [ ] **macOS E2E workflow** — Verify the macOS E2E workflow in CI ensures stability across releases. (`18ca34d55`)

### 16. MCP / Claude integration

commits: `8c8c445c`

- [ ] **Claude connect button works** — Settings → Connections → "Connect Claude" downloads `.mcpb` file and opens it in Claude Desktop. was broken because GitHub releases API pagination didn't reach `mcp-v*` releases buried behind 30+ app releases (`8c8c445c`).
- [ ] **MCP release discovery with many app releases** — `getLatestMcpRelease()` paginates up to 5 pages (250 releases) to find `mcp-v*` tagged releases. verify it works even when >30 app releases exist since last MCP release.
- [ ] **Claude Desktop not installed** — clicking connect shows a useful error, not a silent failure.
- [ ] **MCP version display** — Settings shows the available MCP version and whether it's already installed.
- [ ] **macOS Claude install flow** — downloads `.mcpb`, opens Claude Desktop, waits 1.5s, then opens the `.mcpb` file to trigger Claude's install modal.
- [ ] **Windows Claude install flow** — same flow using `cmd /c start` instead of `open -a`.
- [ ] **download error logging** — if download fails, console shows actual error message (not `{}`).

### 17. AI Agents / Pipes

commits: `fa887407`, `815f52e6`, `60840155`, `e66c3ff8`, `c905ffbf`, `01147096`, `5908d7f4`, `46422869`, `4f43da70`, `71a1a537`, `6abaaa36`, `f3e55dbc`, `8e426dec`, `1289f51e`, `4bc9ff1a`, `c336f73d`, `2f7416ae`

- [ ] **Pi process stability** — After app launch, `ps aux | grep pi` should show a single, stable `pi` process that doesn't restart or get killed.
- [ ] **Pi readiness handshake** — First chat interaction with Pi should be fast (<2s for readiness).
- [ ] **Pi auto-recovery** — If the `pi` process is manually killed, it should restart automatically within a few seconds and be ready for chat.
- [ ] **Pipe output accuracy** — When executing a pipe, the user's prompt should be accurately reflected in the output.
- [ ] **Silent LLM errors** — LLM errors during pipe execution should be displayed to the user, not silently suppressed.
- [ ] **Fast first chat with Pi** — The first interaction with Pi after app launch should be responsive, with no noticeable delay (aim for <2s).
- [ ] **Activity Summary tool** — MCP can access activity summaries via the `activity-summary` tool, and the `activity-summary` endpoint works correctly.
- [ ] **Search Elements tool** — MCP can search elements using the `search-elements` tool.
- [ ] **Frame Context tool** — MCP can access frame context via the `frame-context` tool.
- [ ] **Progressive disclosure for AI data** — AI data querying should progressively disclose information.
- [ ] **Screenpipe Analytics skill** — The `screenpipe-analytics` skill can be used by the Pi agent to perform raw SQL usage analytics.
- [ ] **Screenpipe Retranscribe skill** — The `screenpipe-retranscribe` skill can be used by the Pi agent for retranscription.
- [ ] **AI preset save stability** — Saving AI presets should not cause crashes, especially when dealing with pipe session conflicts.
- [ ] **Pipe token handling** — Ensure that Pi configuration for pipes uses the actual token value, not the environment variable name.
- [ ] **Pipe user_token passthrough** — Verify that the `user_token` is correctly passed to Pi pre-configuration so pipes use the screenpipe provider.
- [ ] **Pipe preset override** — Install a pipe from the store. Verify its preset can be overridden by user's default. (`bee49f1e7`)
- [ ] **Pipe configurable timeout** — Add `timeout` to pipe.md frontmatter. Verify pipe respects this timeout. (`cc0ecef53`)
- [ ] **Pipe store caching** — Navigate pipe store and connections pages. Verify fast loading due to client-side caching. (`f501c19fb`)
- [ ] **Primary + fallback AI preset UI** — Verify the UI for primary and fallback AI presets for pipes works as expected. (`da206471a`)
- [ ] **Default AI model ID** — Verify that the default AI model ID does not contain outdated date suffixes.
- [ ] **Move provider/model flags** — `--provider` and `--model` flags should be correctly moved before `-p prompt` in `pi spawn` commands.
- [ ] **Pi restart on preset switch** — Switch between different AI presets. Verify that the Pi agent restarts if required by the new preset.
- [ ] **Faster Pipes page loading** — Verify that the "Pipes" page loads significantly faster, especially when there are a large number of pipes configured.
- [ ] **Instant pipe enable toggle UI update** — Toggle a pipe's enable status. Verify that the UI updates instantly due to optimistic updates, even if the backend operation takes a moment.
- [ ] **Pipe execution shows parsed text** — Execute a pipe that outputs JSON. Verify that the output displayed to the user is correctly parsed text, not raw JSON.
- [ ] **Surface LLM errors in chat UI** — Interact with the chat UI using an AI provider under conditions that would cause LLM errors (e.g., exhausted credits, rate limits). Verify these errors are clearly surfaced to the user.
- [ ] **Pipe preset bug fixes and credit drain prevention** — Thoroughly test creating, editing, and switching pipe presets to ensure no bugs, especially those that might lead to unexpected cloud credit usage or misconfiguration.
- [ ] **pipe UI improvements** — Verify the overall improvements to the Pipes UI, ensuring a better user experience. (`2e68400c`)
- [ ] **proper spinner icon for pipe refresh button** — Verify that the pipe refresh button displays the correct spinner icon during loading states. (`b709af2f`)
- [ ] **ChatGPT OAuth provider in pipes** — Configure ChatGPT OAuth provider. Verify that pipes using ChatGPT work correctly.
- [ ] **Reduced excessive Pi restarts** — When changing AI preset values or other settings, verify that excessive Pi restarts are reduced. Monitor logs for unnecessary restart messages.
- [ ] **Invalid UTF-8 in Pi streaming** — Execute a pipe that outputs invalid UTF-8 characters to stdout/stderr. Verify that Pi streaming correctly handles these without crashing or displaying garbled output.
- [ ] **Auto-abort stuck Pi agent** — Verify that the Pi agent is auto-aborted if stuck before sending a new message. (`602419151`)
- [ ] **Pi crash loop fix (Windows)** — Verify that the Pi agent doesn't enter a crash loop on Windows due to lru-cache interop issues. (`de56176e5`)
- [ ] **Token counter** — Verify that the chat UI displays a token counter. (`2f75e90bf`)
- [ ] **Optimize button** — Verify that the "optimize" button appears in the pipe dropdown menu. (`5dff9d21a`)
- [ ] **Pipes as App Store** — Verify the redesigned Pipes tab, which provides a unified app store experience. (`89d2e0129`)
- [ ] **Tool call UI with progress rail** — Execute a pipe that uses tool calls. Verify the redesigned UI featuring a progress rail timeline and auto-collapse for friendly interaction. (`6c23e1399`, `d81ea65c1`)
- [ ] **In-app Notification Panel** — Use the `/notify` API (e.g., via a pipe). Verify an in-app notification panel appears instead of a system notification. (`34937b2dc`)
- [ ] **Pipe Suggestions Scheduler** — Verify that pipe suggestions are displayed according to the scheduled intervals. (`41c8b8085`)
- [ ] **Pipe store stability** — verify null guards, sharp corners, unpublish functionality, and data unwrap fixes. (`603c84f7b`)
- [ ] **Pi agent & search timeouts** — Run a long-running search or Pi agent task. Verify it doesn't timeout prematurely at 60s (should allow up to 120s for search). (`f01213cf5`)
- [ ] **allow schedule + triggers together in pipe config UI** — Verify that both schedule and triggers can be configured together in the pipe config UI without conflicts. (`f32bf9230`)
- [ ] **local event triggers for pipes** — Verify that pipes can be triggered by local events such as meeting start/end and pipe chaining. (`508b68ff7`, `776587aa7`)
- [ ] **tool call indicators in pipe run output** — Verify that tool call indicators are displayed in the pipe run output. (`dda33a6a7`)
- [ ] **align copy and chat icons in pipe run history** — Verify that copy and chat icons are properly aligned in the pipe run history. (`f8fe5cff4`)
- [ ] **Live pipe output streaming** — Open the "Runs" tab for a running pipe. Verify that the output streams live as the pipe executes. (`4c1fab276`)
- [ ] **Rich activity-summary** — Verify that activity summaries include details about windows, URLs, and audio transcriptions. (`f2d8ba1dad3`)
- [ ] **OpenAI-compatible transcription endpoint** — Verify that the `/v1/audio/transcriptions` endpoint works correctly with standard OpenAI clients. (`59deeba19`)
- [ ] **Mermaid diagram XSS sanitization** — Verify that mermaid diagrams in the UI are correctly sanitized to prevent XSS attacks. (`3405e9793`)
- [ ] **Per-machine pipe favorites (stars)** — Toggle the star icon for a pipe. Verify that favorites are persisted per-machine and that the filter chip correctly shows starred pipes first. (`e1a18adb9`, `0a2c1abb7`)
- [ ] **Connected integrations @mentions in chat** — Open the filter popover in chat. Verify that connected integrations (like Notion, Slack, Google Docs) appear as @mentions for easy filtering. (`1c0c95b20`)

commits: `fa887407`, `815f52e6`, `60840155`, `e66c3ff8`, `c905ffbf`, `01147096`, `5908d7f4`, `46422869`, `4f43da70`, `71a1a537`, `6abaaa36`

- [ ] **Pi process stability** — After app launch, `ps aux | grep pi` should show a single, stable `pi` process that doesn't restart or get killed.
- [ ] **Pi readiness handshake** — First chat interaction with Pi should be fast (<2s for readiness).
- [ ] **Pi auto-recovery** — If the `pi` process is manually killed, it should restart automatically within a few seconds and be ready for chat.
- [ ] **Pipe output accuracy** — When executing a pipe, the user's prompt should be accurately reflected in the output.
- [ ] **Silent LLM errors** — LLM errors during pipe execution should be displayed to the user, not silently suppressed.
- [ ] **Fast first chat with Pi** — The first interaction with Pi after app launch should be responsive, with no noticeable delay (aim for <2s).
- [ ] **Activity Summary tool** — MCP can access activity summaries via the `activity-summary` tool, and the `activity-summary` endpoint works correctly.
- [ ] **Search Elements tool** — MCP can search elements using the `search-elements` tool.
- [ ] **Frame Context tool** — MCP can access frame context via the `frame-context` tool.
- [ ] **Progressive disclosure for AI data** — AI data querying should progressively disclose information.
- [ ] **Screenpipe Analytics skill** — The `screenpipe-analytics` skill can be used by the Pi agent to perform raw SQL usage analytics.
- [ ] **Screenpipe Retranscribe skill** — The `screenpipe-retranscribe` skill can be used by the Pi agent for retranscription.
- [ ] **AI preset save stability** — Saving AI presets should not cause crashes, especially when dealing with pipe session conflicts.
- [ ] **Pipe token handling** — Ensure that Pi configuration for pipes uses the actual token value, not the environment variable name.
- [ ] **Pipe user_token passthrough** — Verify that the `user_token` is correctly passed to Pi pre-configuration so pipes use the screenpipe provider.
- [ ] **Default AI model ID** — Verify that the default AI model ID does not contain outdated date suffixes.
- [ ] **Move provider/model flags** — `--provider` and `--model` flags should be correctly moved before `-p prompt` in `pi spawn` commands.

### 18. Admin / Team features

commits: `58460e02`, `853e0975`

- [ ] **Admin team-shared filters** — Admins should be able to remove individual team-shared filters.
- [ ] **Simplified team invite** — Verify the simplified team invite flow using a single web URL without requiring a passphrase. (`44a19b73f`, `b53b08b6e`)
- [ ] **Per-request AI cost tracking and admin spend endpoint** — Verify that per-request AI costs are tracked correctly and that the admin spend endpoint provides accurate usage data.

commits: `58460e02`

- [ ] **Admin team-shared filters** — Admins should be able to remove individual team-shared filters.

### 19. Logging

commits: `fc830b43`, `f54d3e0d`

- [ ] **Reduced log noise** — Verify a significant reduction in log noise (~54%).
- [ ] **PII scrubbing** — Ensure that PII (Personally Identifiable Information) is scrubbed from logs.
- [ ] **Phone regex PII scrubbing preservation** — Verify phone numbers are scrubbed but accessibility bounds (which look like numbers) are NOT mangled. (`08feb4df5`)
- [ ] **Phone regex PII scrubbing** — After generating some PII-containing data (e.g., typing phone numbers), review logs to ensure that the phone regex correctly scrubs PII and does not over-match bare digit sequences.

### 20. Vault Lock (Encryption at rest)

commits: `274a968af`, `dc575e48e`, `81aabbf18`, `d5e071854`, `db08f8c06`, `f4225b580`

- [ ] **Vault lock initialization** — Verify that the vault can be initialized and a password set.
- [ ] **Encryption of database and data files** — Verify that screenpipe data is encrypted at rest when the vault is locked.
- [ ] **Recording stop on lock** — Verify that recording stops immediately when the vault is locked.
- [ ] **Recording resume on unlock** — Verify that recording restarts automatically when the vault is unlocked.
- [ ] **Fast vault unlock** — Verify that the DB is decrypted quickly and data files are decrypted in the background. (`dc575e48e`)
- [ ] **Vault lock shortcut** — Verify that the configurable vault lock shortcut works as expected. (`81aabbf18`)
- [ ] **CLI vault commands** — Verify that `screenpipe vault` commands work without the server running. (`f4225b580`)
- [ ] **Skip server start on locked vault** — Verify that the server does not start if the vault is locked. (`d5e071854`)

### 21. Privacy & Incognito Detection

- [ ] **PII Filter** — Toggle the PII filter in chat or search. Verify that sensitive information is filtered using Tinfoil. (`fec0f1023`)


commits: `ad431b513`, `d9722bccc`, `4df21e83d`

- [ ] **Incognito window detection** — Verify that private browsing/incognito windows are correctly detected for major browsers (Chrome, Safari, Firefox, etc.). (`ad431b513`)
- [ ] **Ignore incognito toggle** — Verify that the "Ignore Incognito Windows" toggle in settings correctly prevents recording of private windows. (`d9722bccc`)
- [ ] **Incognito detection UI feedback** — Verify that the UI correctly reflects when an incognito window is being ignored.
- [ ] **DRM pause behavior** — Play DRM-protected content (e.g., Netflix in Safari). Verify that Screenpipe pauses recording gracefully and resumes automatically once the DRM content is closed, without crashing the server. (`3d9f0e8bb`)
- [ ] **LAN-access toggle** — Toggle "Enable LAN access" in API settings. Verify that the API binds to `0.0.0.0` and that `api_auth` is forcibly enabled for security. (`c8d9c83f0`)

commits: `fc830b43`

- [ ] **Reduced log noise** — Verify a significant reduction in log noise (~54%).
- [ ] **PII scrubbing** — Ensure that PII (Personally Identifiable Information) is scrubbed from logs.

### 23. GPU & Performance Telemetry

- [ ] **GPU error handling & telemetry** — Verify that GPU errors are handled gracefully and CPU/GPU telemetry is correctly reported in logs. (`0d42ea221`)
- [ ] **Clipboard thread leak** — Verify that long-running sessions do not exhibit gradual input lag or memory growth due to clipboard thread leaks. (`0718c2e03`, `f0adcddd0`)

### 24. Data Management

- [ ] **Delete local data confirmation** — Use the "Delete device local data" feature. Verify an `AlertDialog` appears instead of a standard `window.confirm`. (`b5db080d6`)

### 25. Feedback & Support

- [ ] **Compressed feedback screenshots** — Send feedback with a screenshot. Verify that the screenshot is compressed to JPEG before sending. (`591710246`)

## how to run

### before every release
1. run sections 1-4 completely (90% of regressions)
2. spot-check sections 5-10
3. if Apple Intelligence code changed, run section 7

### before merging window/tray/dock changes
run section 1 and 2 completely. these are the most fragile.

### before merging vision/OCR changes
run section 3, 5, and 14 (Windows text extraction matrix) completely.

### before merging audio changes
run section 4 completely.

### before merging AI/Apple Intelligence changes
run section 7 and 10.

## known limitations (not bugs)

- tray icon on notched MacBooks can end up behind the notch if menu bar is crowded. Cmd+drag to reposition. dock menu is the fallback.
- macOS only shows permission prompts once (NotDetermined → Denied is permanent). must use System Settings to re-grant.
- debug builds use ~3-5x more CPU than release builds for vision pipeline.
- first frame after app launch always triggers OCR (intentional — no previous frame to compare against).
- chat panel is pre-created hidden at startup so it exists before user presses the shortcut. Creation no longer activates/shows — only the show_existing path does (matching main overlay pattern).
- shortcut reminder should use `CanJoinAllSpaces` (visible on all Spaces simultaneously). chat and main overlay should use `MoveToActiveSpace` (moved to current Space on show, then flag removed to pin).

## log locations

```
macOS:   ~/.screenpipe/screenpipe-app.YYYY-MM-DD.log
Windows: %USERPROFILE%\.screenpipe\screenpipe-app.YYYY-MM-DD.log
Linux:   ~/.screenpipe/screenpipe-app.YYYY-MM-DD.log
```

### what to grep for

```bash
# crashes/errors
grep -E "panic|SIGABRT|ERROR|error" ~/.screenpipe/screenpipe-app.*.log

# monitor events
grep -E "Monitor.*disconnect|Monitor.*reconnect|Starting vision" ~/.screenpipe/screenpipe-app.*.log

# frame skip rate (debug level only)
grep "Hash match" ~/.screenpipe/screenpipe-app.*.log

# queue health
grep "Queue stats" ~/.screenpipe/screenpipe-app.*.log

# DB contention
grep "Slow DB" ~/.screenpipe/screenpipe-app.*.log

# audio issues
grep -E "audio.*timeout|audio.*error|device.*disconnect" ~/.screenpipe/screenpipe-app.*.log

# window/overlay issues
grep -E "show_existing|panel.*level|Accessory|activation_policy" ~/.screenpipe/screenpipe-app.*.log

# Apple Intelligence
grep -E "FoundationModels|apple.intelligence|fm_generate" ~/.screenpipe/screenpipe-app.*.log
```

### 12. mainland china / great firewall

- [ ] **full app functionality behind GFW** — download, onboarding, AI chat, cloud features, and update checks must all work (or degrade gracefully) on networks subject to the Great Firewall.
- [ ] **HF_ENDPOINT Chinese mirror** — verify model downloads work in China via the HF mirror. (`7ea1eb94e`)

### 22. WhatsApp Gateway

commits: `cf2dcd5f8`, `ad1d00d8f`, `6f623b30a`, `aaf031169`

- [ ] **WhatsApp gateway auto-restart** — Manually terminate the WhatsApp gateway process. Verify the watchdog restarts it automatically. (`cf2dcd5f8`)
- [ ] **WhatsApp gateway self-termination** — Kill the main screenpipe process. Verify the WhatsApp gateway process also terminates. (`ad1d00d8f`)
- [ ] **WhatsApp history & contacts sync** — Verify that WhatsApp chat history and contacts are correctly synchronized. (`aaf031169`)
- [ ] **WhatsApp auto-reconnect** — Verify the WhatsApp gateway automatically reconnects on server start. (`6f623b30a`)

### 23. Notifications

- [ ] **Restart notifications toggle** — Toggle "restart notifications" in settings. Verify notifications only appear when enabled. (`f82b4f350`)
- [ ] **Notification text selection** — Verify that text can be selected in notification inbox messages. (`3449197c3`)
- [ ] **macOS notification "Open" click** — Click "Open" on a macOS system notification. Verify it correctly brings the Screenpipe window to the front. (`3e86cebb0`)

### 26. Onboarding & Fleet UX

commits: `f6c21a022`, `31e67ae1c`, `8d0a5348d`, `b1c30e99b`

- [ ] **Redesigned Onboarding** — Complete the redesigned onboarding. Verify live feed appears and opinionated pipe setup works. (`f6c21a022`)
- [ ] **Pipes & Fleet merged UI** — Open Pipes tab. Verify fleet devices appear in the dropdown. Verify local machine is filtered/distinct. (`31e67ae1c`, `8d0a5348d`)
- [ ] **Scheduled vs Manual pipes** — In My Pipes, verify sub-tabs for scheduled and manual pipes. (`b1c30e99b`)

### 27. Connections (Multi-instance & New Services)

- [ ] **Microsoft 365 / Teams** — Verify that Microsoft Graph OAuth works for Microsoft 365 and Teams (excluding personal accounts). (`635c32347`, `f35e999b0`)
- [ ] **New Integrations** — Verify Loops, Resend, and Supabase integrations. (`ea454f324`)
- [ ] **Google Docs Read/Write** — Verify Google Docs integration supports both read and write scopes. (`8f3ca5283`)


commits: `c8769545b`, `4f522325b`, `54000c295`

- [ ] **Multi-instance connections** — Add two different accounts for the same service (e.g., two Slack workspaces). Verify both work independently. (`c8769545b`)
- [ ] **Post-install connection modal** — After installing a pipe, verify the connection modal appears if the pipe requires a service connection. (`c8769545b`)
- [ ] **New service connections** — Verify Brex, Stripe, Sentry, Vercel, Pipedrive, Intercom, and Limitless connections can be authorized and sync data. (`4f522325b`, `54000c295`)
- [ ] **Multi-instance OAuth for GitHub and Notion** — Verify that multi-instance OAuth works for GitHub and Notion, including fetching identity after token exchange. (`5d6ee5da3`)
- [ ] **Glean icon in connections grid** — Verify that the Glean icon is displayed in the connections grid. (`ec6374e1d`)
- [ ] **Google Docs connection & Pro gate** — Verify that Google Docs connection works and that the "Pro required" gate correctly appears for non-pro users on the connect button. (`9835b09d8`, `dbf451f34`, `dda16447c`, `e3a2be5cb`)
- [ ] **Bitrix24 CRM integration** — Verify that Bitrix24 CRM connection can be authorized and syncs data correctly. (`55026df56`)
- [ ] **OAuth auto-refresh** — Verify that expired OAuth tokens for generic proxy connections (like Google, Bitrix24) are automatically refreshed. (`d7835eabb`)

### 28. Deployment & Remote Management

commits: `c6a73b17e`, `945b687ec`

- [ ] **Deploy to offline devices** — Use chat prompt to deploy screenpipe to an offline device. Verify it handles the "Screen Sharing" permission dialog by opening it on the target machine. (`c6a73b17e`, `945b687ec`)

### 29. Browser Extension

- [ ] **Extension popup** — Open the browser extension popup. Verify connection status is displayed correctly. (`be7c9e8b5`)


- [ ] **Browser extension token auth** — Open the browser extension options page. Verify that token-based authentication works and that it can successfully connect to the Screenpipe API. (`be14de544`)

### 30. CLI

- [ ] **CLI logout** — Run `screenpipe logout`. Verify it clears local auth tokens. (`793c3d6e9`)
- [ ] **CLI sync remote** — Verify `screenpipe sync remote` command and its configuration. (`f46e85cb1`)

### 31. Chat (Pi)

- [ ] **Parallel chats** — Verify that multiple chat sessions can run in parallel and their background streams remain visible when switching. (`c9d64ce23`)
- [ ] **Chat sidebar navigation** — Verify that the chat sidebar (pinned, recents, live status) works correctly and replaces the Home view for "New chat". (`ec5e80992`, `28c4b1ac5`)
- [ ] **Persistent background chats** — Verify that chats continue to stream in the background even when navigating away from the chat view. (`0060ae9e5`, `ec5e80992`)
- [ ] **Inline history in overlay** — Verify that inline history is restored in the overlay window. (`15b419ec7`)
- [ ] **Notification URL actions** — Open a URL action from a native macOS notification when the overlay is not mounted. (`7fdcd2054`)
