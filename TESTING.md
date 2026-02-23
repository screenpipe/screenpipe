# screenpipe regression testing checklist

> **purpose**: prevent regressions. every PR touching window management, activation policy, tray, dock, monitors, or audio MUST be tested against the relevant sections below before merge.

## critical edge cases (sorted by regression frequency)

### 1. window overlay & fullscreen spaces (macOS)

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

### 4. audio device handling

- [ ] **default audio device** — with "follow system default", recording uses whatever macOS says is default.
- [ ] **plug in USB headset** — if set to follow defaults and macOS switches to headset, recording follows.
- [ ] **unplug USB headset** — recording falls back to built-in mic/speakers. no crash. no 30s timeout errors.
- [ ] **bluetooth device connect/disconnect** — AirPods connect mid-recording. audio continues without gap.
- [ ] **no audio device available** — unplug all audio. app continues (vision still works). log shows warning, not crash.
- [ ] **audio stream timeout recovery** — if audio stream times out (30s no data), it should reconnect automatically.
- [ ] **multiple audio devices simultaneously** — input (mic) + output (speakers) both recording. both show in device list.
- [ ] **disable audio setting** — toggling "disable audio" stops all audio recording. re-enabling restarts it.
- [ ] **Metal GPU for whisper** — transcription uses GPU acceleration on macOS (`f882caef`). verify with Activity Monitor GPU tab.

### 5. frame comparison & OCR pipeline

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

### 6. permissions (macOS)

commits: `d9d43d31`, `620c89a5`

- [ ] **fresh install — all prompts appear** — screen recording, microphone, accessibility prompts all show on first launch.
- [ ] **denied permission → opens System Settings** — if user previously denied mic permission, clicking "grant" opens System Settings > Privacy directly (`620c89a5`).
- [ ] **permission revoked while running** — go to System Settings, revoke screen recording. app shows red permission banner within 10 seconds.
- [ ] **permission banner is visible** — solid red `bg-destructive` banner at top of main window when any permission missing. not subtle (`9c0ba5d1`).
- [ ] **permission recovery page** — navigating to /permission-recovery shows clear instructions.
- [ ] **startup permission gate** — on first launch, permissions are requested before recording starts (`d9d43d31`).
- [ ] **faster permission polling** — permission status checked every 5-10 seconds, not 30 (`d9d43d31`).

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

commits: `94531265`, `d794176a`, `9070639c`, `0378cab1`, `4a3313d3`

- [ ] **clean quit via tray** — right-click tray → Quit. all processes terminate. no orphaned ffmpeg/bun processes.
- [ ] **clean quit via dock** — right-click dock → Quit. same as above.
- [ ] **clean quit via Cmd+Q** — same verification.
- [ ] **force quit recovery** — force quit app. relaunch. database is intact. recording resumes.
- [ ] **sleep/wake** — close laptop lid, wait 10s, open. recording resumes within 5s. no crash (`9070639c`).
- [ ] **restart app** — quit and relaunch. all settings preserved. recording starts automatically.
- [ ] **auto-update** — when update available, UpdateBanner shows in main window. clicking it downloads and installs.
- [ ] **update without tray** — user can update via dock menu "Check for updates" or Apple menu "Check for Updates..." (`d794176a`, `94531265`).
- [ ] **update banner in main window** — when update available, banner appears at top of main window.
- [ ] **source build update dialog** — source builds show "source build detected" dialog with link to pre-built version.
- [ ] **port conflict on restart** — if old process is holding port 3030, new process kills it and starts cleanly (`0378cab1`, `4a3313d3`, `8c435a10`).
- [ ] **no orphaned processes** — after quit, `ps aux | grep screenpipe` shows nothing. `lsof -i :3030` shows nothing.
- [ ] **rollback** — user can rollback to previous version via tray menu (`c7fbc3ea`).

### 9. database & storage

commits: `eea0c865`, `cc09de61`

- [ ] **slow DB insert warning** — check logs. "Slow DB batch insert" warnings should be <1s in normal operation. >3s indicates contention.
- [ ] **concurrent DB access** — UI queries + recording inserts happening simultaneously. no "database is locked" errors.
- [ ] **store race condition** — rapidly toggle settings while recording is active. no crash (`eea0c865`).
- [ ] **event listener race condition** — Tauri event listener setup during rapid window creation. no crash (`cc09de61`).
- [ ] **UTF-8 boundary panic** — search with special characters, non-ASCII text in OCR results. no panic on string slicing (`eea0c865`).
- [ ] **low disk space** — with <1GB free, app should warn user. no crash from failed writes.
- [ ] **large database (>10GB)** — search still returns results within 2 seconds. app doesn't freeze on startup.

### 10. AI presets & settings

commits: `8a5f51dd`, `0b0d8090`

- [ ] **Ollama not running** — creating an Ollama preset shows free-text input fields (not stuck loading). user can type model name manually (`8a5f51dd`).
- [ ] **custom provider preset** — user can add a custom API endpoint. model name is free-text input with optional autocomplete.
- [ ] **settings survive restart** — change any setting, quit, relaunch. setting is preserved.
- [ ] **overlay mode switch** — change from fullscreen to window mode. setting saves. next shortcut press uses new mode.
- [ ] **FPS setting** — change capture FPS. recording interval changes accordingly.
- [ ] **language/OCR engine setting** — change OCR language. new language used on next capture cycle.
- [ ] **video quality setting** — low/balanced/high/max. affects FFmpeg encoding params (`21bddd0f`).

### 11. onboarding

commits: `87abb00d`, `9464fdc9`, `0f9e43aa`, `7ea15f32`

- [ ] **fresh install flow** — onboarding appears, permissions requested, user completes setup.
- [ ] **auto-advance after engine starts** — status screen advances automatically after 15-20 seconds once engine is running (`87abb00d`, `9464fdc9`).
- [ ] **skip onboarding** — user can skip and get to main app. settings use defaults.
- [ ] **shortcut gate** — onboarding teaches the shortcut. user must press it to proceed (`0f9e43aa`).
- [ ] **onboarding window size** — window is correctly sized, no overflow (`7ea15f32`).
- [ ] **onboarding doesn't re-show** — after completing onboarding, restart app. main window shows, not onboarding.

### 12. timeline & search

commits: `f1255eac`, `25cbdc6b`, `2529367d`, `d9821624`

- [ ] **arrow key navigation** — left/right arrow keys navigate timeline frames (`f1255eac`).
- [ ] **search results sorted by time** — search results appear in chronological order (`25cbdc6b`).
- [ ] **no frame clearing during navigation** — navigating timeline doesn't cause frames to disappear and reload (`2529367d`).
- [ ] **URL detection in frames** — URLs visible in screenshots are extracted and shown as clickable pills (`50ef52d1`, `aa992146`).
- [ ] **app context popover** — clicking app icon in timeline shows context (time, windows, urls, audio) (`be3ecffb`).
- [ ] **daily summary in timeline** — Apple Intelligence summary shows in timeline, compact when no summary (`d9821624`).
- [ ] **window-focused refresh** — opening app via shortcut/tray refreshes timeline data immediately (`0b057046`).
- [ ] **frame deep link navigation** — `screenpipe://frame/N` or `screenpipe://frames/N` opens main window and jumps to frame N. works from cold start; invalid IDs show clear error.

### 13. sync & cloud

commits: `2f6b2af5`, `ea7f1f61`, `5cb100ea`

- [ ] **auto-remember sync password** — user doesn't have to re-enter password each time (`5cb100ea`).
- [ ] **auto-download from other devices** — after upload cycle, download new data from paired devices (`2f6b2af5`).
- [ ] **auto-init doesn't loop** — sync initialization happens once, doesn't repeat endlessly (`ea7f1f61`).

### 14. Windows-specific

commits: `eea0c865`

- [ ] **COM thread conflict** — audio and vision threads don't conflict on COM initialization (`eea0c865`).
- [ ] **high-DPI display (150%, 200%)** — OCR captures at correct resolution.
- [ ] **multiple monitors** — all detected and recorded.
- [ ] **Windows Defender** — app not blocked by default security.

### 15. CI / release

commits: `8f334c0a`, `fda40d2c`

- [ ] **macOS 26 runner** — release builds on self-hosted macOS 26 runner with Apple Intelligence (`fda40d2c`).
- [ ] **updater artifacts** — release includes `.tar.gz` + `.sig` for macOS, `.nsis.zip` + `.sig` for Windows.
- [ ] **prod config used** — CI copies `tauri.prod.conf.json` to `tauri.conf.json` before building. identifier is `screenpi.pe` not `screenpi.pe.dev`.
- [ ] **draft then publish** — `workflow_dispatch` creates draft. manual publish or `release-app-publish` commit publishes.

### 16. MCP / Claude integration

commits: `8c8c445c`

- [ ] **Claude connect button works** — Settings → Connections → "Connect Claude" downloads `.mcpb` file and opens it in Claude Desktop. was broken because GitHub releases API pagination didn't reach `mcp-v*` releases buried behind 30+ app releases (`8c8c445c`).
- [ ] **MCP release discovery with many app releases** — `getLatestMcpRelease()` paginates up to 5 pages (250 releases) to find `mcp-v*` tagged releases. verify it works even when >30 app releases exist since last MCP release.
- [ ] **Claude Desktop not installed** — clicking connect shows a useful error, not a silent failure.
- [ ] **MCP version display** — Settings shows the available MCP version and whether it's already installed.
- [ ] **macOS Claude install flow** — downloads `.mcpb`, opens Claude Desktop, waits 1.5s, then opens the `.mcpb` file to trigger Claude's install modal.
- [ ] **Windows Claude install flow** — same flow using `cmd /c start` instead of `open -a`.
- [ ] **download error logging** — if download fails, console shows actual error message (not `{}`).

### 17. OCR & audio transcription accuracy

> **purpose**: ensure OCR and audio transcription quality doesn't regress. compare against reference models to catch accuracy drops.

#### OCR accuracy benchmarks

- [ ] **baseline accuracy test** — run OCR on `test_data/ocr_reference/` images. compare output against `.expected.txt` files. accuracy must be ≥95% character-level match.
- [ ] **high contrast text** — black text on white background. accuracy must be ≥98%.
- [ ] **low contrast text** — gray text on light gray background. accuracy must be ≥90%.
- [ ] **small font (8-10px)** — OCR captures small UI text correctly. accuracy must be ≥85%.
- [ ] **mixed fonts in single frame** — screenshot with multiple font sizes/styles. all text regions detected.
- [ ] **non-Latin scripts** — Chinese, Japanese, Korean, Cyrillic, Arabic text. must not crash; accuracy ≥80% for configured languages.
- [ ] **code/monospace text** — terminal output, IDE code. special characters (`{}[]<>|`) captured correctly.
- [ ] **rotated/skewed text** — slight rotation (≤5°) still recognized. accuracy ≥85%.
- [ ] **text over images** — UI overlays, watermarks. text detected despite complex background.
- [ ] **OCR engine comparison** — run same images through Apple native, Tesseract, Windows native. log accuracy differences.
- [ ] **regression vs previous release** — compare current OCR output against last release on identical test images. no >2% accuracy drop.

#### audio transcription accuracy benchmarks

- [ ] **baseline accuracy test** — transcribe `test_data/audio_reference/` files. compare against `.expected.txt`. Word Error Rate (WER) must be ≤10%.
- [ ] **clear speech** — single speaker, low noise, standard accent. WER must be ≤5%.
- [ ] **background noise** — office ambient noise, keyboard typing. WER must be ≤15%.
- [ ] **multiple speakers** — 2-3 speakers in conversation. all speakers transcribed, WER ≤12%.
- [ ] **fast speech** — 180+ words per minute. WER must be ≤15%.
- [ ] **accented English** — non-native speakers. WER must be ≤20%.
- [ ] **technical vocabulary** — programming terms, product names. domain-specific words captured.
- [ ] **whisper model comparison** — run same audio through tiny, base, small models. log accuracy vs speed tradeoffs.
- [ ] **silence handling** — long pauses (>5s) don't cause hallucinations or repeated words.
- [ ] **audio quality degradation** — low bitrate (64kbps), compression artifacts. transcription still usable.
- [ ] **timestamp accuracy** — word timestamps within ±500ms of actual speech.
- [ ] **regression vs previous release** — compare current transcription against last release. no >2% WER increase.

#### reference model comparison

- [ ] **OCR: Apple Vision vs Tesseract** — run identical screenshots through both. document accuracy difference per image category.
- [ ] **OCR: tesseract-ocr-server baseline** — if using external OCR server, verify responses match expected format and accuracy.
- [ ] **audio: Whisper tiny vs base vs small** — benchmark speed (RTF) and accuracy (WER) for each model on test set.
- [ ] **audio: local vs API transcription** — if cloud API available, compare accuracy and latency against local Whisper.

#### automated accuracy CI

- [ ] **CI accuracy gate** — PR fails if OCR accuracy drops >2% or audio WER increases >2% vs main branch.
- [ ] **accuracy metrics in logs** — each transcription/OCR run logs confidence scores. `grep "confidence" ~/.screenpipe/*.log`.
- [ ] **weekly accuracy report** — scheduled job runs full benchmark suite, posts results to tracking dashboard.

## how to run

### before every release
1. run sections 1-4 completely (90% of regressions)
2. spot-check sections 5-10
3. if Apple Intelligence code changed, run section 7

### before merging window/tray/dock changes
run section 1 and 2 completely. these are the most fragile.

### before merging vision/OCR changes
run section 3 and 5 completely.

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
