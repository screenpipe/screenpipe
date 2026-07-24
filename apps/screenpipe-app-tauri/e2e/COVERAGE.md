# E2E Coverage Map

This is a behavioral coverage dashboard for the Tauri/WebDriver E2E suite.
It is not line or branch coverage. A spec contributes coverage to each platform
and layer declared in the manifest, weighted by confidence and criticality.

- Manifest: `e2e/coverage-map.json`
- Specs directory: `e2e/specs`
- Mapped specs: 71
- Declared test blocks: 218
- Weighted coverage points: 168.0

Confidence weights: strong=1.0, partial=0.7, conditional=0.4, smoke=0.3.
Criticality weights: high=1.0, medium=0.7, low=0.4.
Declared test blocks are counted statically from source, so parameterized specs
can execute more runtime cases than this number shows.

## Platform Summary

| Platform | Specs | Declared tests | Weighted points | Layers | Features | Critical score |
| --- | --- | --- | --- | --- | --- | --- |
| windows | 60 | 203 | 162.3 | 15 | 65 | 93% |
| macos | 67 | 182 | 139.3 | 17 | 66 | 89% |
| linux | 51 | 165 | 132.9 | 13 | 61 | 87% |

## Runtime Results

No runtime result directory was supplied. Run with
`--results-dir e2e/results` after WDIO emits runtime JSON to include actual
pass/fail/skip counts.

## Layer Matrix

| Layer | windows | macos | linux |
| --- | --- | --- | --- |
| audio-device | 2 specs / 27 tests / 19.8 pts | 2 specs / 2 tests / 1.3 pts | - |
| auth | - | 1 specs / 1 tests / 1.0 pts | - |
| billing | 4 specs / 6 tests / 5.7 pts | 4 specs / 6 tests / 5.7 pts | 4 specs / 6 tests / 5.7 pts |
| capture-ocr | 2 specs / 15 tests / 6.0 pts | 4 specs / 6 tests / 2.4 pts | 1 specs / 3 tests / 1.2 pts |
| chat-ai | 17 specs / 28 tests / 19.4 pts | 20 specs / 32 tests / 20.7 pts | 16 specs / 27 tests / 18.9 pts |
| entitlement | - | 1 specs / 1 tests / 1.0 pts | - |
| local-api | 14 specs / 94 tests / 78.0 pts | 14 specs / 69 tests / 59.0 pts | 11 specs / 67 tests / 58.2 pts |
| notifications | 2 specs / 11 tests / 10.1 pts | 2 specs / 4 tests / 2.4 pts | 1 specs / 3 tests / 2.1 pts |
| onboarding | 1 specs / 4 tests / 1.6 pts | 1 specs / 4 tests / 1.6 pts | 1 specs / 4 tests / 1.6 pts |
| os-integration | 5 specs / 17 tests / 16.1 pts | 5 specs / 4 tests / 1.3 pts | - |
| performance | 2 specs / 44 tests / 44.0 pts | 4 specs / 34 tests / 30.5 pts | 1 specs / 29 tests / 29.0 pts |
| pipes | 3 specs / 12 tests / 12.0 pts | 3 specs / 12 tests / 12.0 pts | 3 specs / 12 tests / 12.0 pts |
| real-ui-e2e | 38 specs / 121 tests / 96.1 pts | 40 specs / 108 tests / 85.6 pts | 35 specs / 101 tests / 83.3 pts |
| settings | 13 specs / 33 tests / 30.6 pts | 15 specs / 28 tests / 24.3 pts | 12 specs / 25 tests / 22.6 pts |
| storage-privacy | 6 specs / 21 tests / 20.1 pts | 5 specs / 13 tests / 12.1 pts | 4 specs / 13 tests / 12.1 pts |
| tauri-command | 10 specs / 19 tests / 12.3 pts | 10 specs / 20 tests / 11.8 pts | 9 specs / 18 tests / 11.3 pts |
| window-lifecycle | 17 specs / 61 tests / 51.6 pts | 17 specs / 42 tests / 30.0 pts | 12 specs / 37 tests / 28.5 pts |

## Critical Feature Matrix

| Feature | Required layers | windows | macos | linux |
| --- | --- | --- | --- | --- |
| App launch and Home shell | real-ui-e2e | covered (strong; app-lifecycle, onboarding-redirect) | covered (strong; app-lifecycle, onboarding-redirect) | covered (strong; app-lifecycle, onboarding-redirect) |
| Home to floating Search | real-ui-e2e | covered (strong; windows-user-journey, tray-search) | covered (partial; tray-search, search-request-priority) | covered (partial; tray-search, search-request-priority) |
| Timeline navigation and frames | real-ui-e2e | covered (strong; windows-user-journey, windows-core-recording) | covered (strong; timeline, home-window) | covered (strong; timeline, home-window) |
| Real capture, OCR, and indexing | capture-ocr | weak (conditional; windows-core-recording, timeline) | weak (conditional; timeline, capture-frequency-floor) | weak (conditional; timeline) |
| Local API auth enforcement | local-api | covered (strong; api-search-stress, windows-system-integration) | covered (strong; api-search-stress, api) | covered (strong; api-search-stress, api) |
| Local API search stability | local-api | covered (strong; api-search-stress, windows-core-recording) | covered (strong; api-search-stress, search-request-priority) | covered (strong; api-search-stress, search-request-priority) |
| Recording settings UX | settings | covered (strong; settings-sections, windows-user-journey) | covered (strong; settings-sections, meeting-apps-picker) | covered (strong; settings-sections, meeting-apps-picker) |
| AI presets and preferences UX | settings | covered (strong; settings-sections) | covered (strong; settings-sections) | covered (strong; settings-sections) |
| Privacy API auth settings UX | settings | covered (strong; settings-sections, windows-user-journey) | covered (strong; settings-sections, privacy-api-auth) | covered (strong; settings-sections, privacy-api-auth) |
| Notification history and viewer paths | notifications | covered (strong; windows-user-journey, notification-viewer-link) | covered (partial; notification-viewer-link, audio-fallback) | covered (partial; notification-viewer-link) |
| Audio device health | audio-device | covered (strong; windows-system-integration, windows-core-recording) | weak (conditional; audio-fallback) | gap |
| Window lifecycle, focus, and dedupe | window-lifecycle | covered (strong; windows-system-integration, window-lifecycle) | covered (strong; window-lifecycle, viewer-deeplink) | covered (strong; window-lifecycle, viewer-deeplink) |
| Meeting note creation and editing | real-ui-e2e | covered (strong; windows-user-journey, meeting-note-bottom-click) | covered (strong; meeting-note-bottom-click) | covered (strong; meeting-note-bottom-click) |
| Pipes discover, install, and play | pipes | covered (strong; pipes, pipes-mcp-connections) | covered (strong; pipes, pipes-mcp-connections) | covered (strong; pipes, pipes-mcp-connections) |
| Chat window, composer, and streaming state | chat-ai | covered (strong; chat-sidebar-groups, chat-tool-activity) | covered (strong; chat-sidebar-groups, chat-tool-activity) | covered (strong; chat-sidebar-groups, chat-tool-activity) |
| Tray/search window behavior | window-lifecycle | covered (strong; window-lifecycle, tray-search) | covered (strong; window-lifecycle, tray-search) | covered (strong; window-lifecycle, tray-search) |
| Native tray recording status refresh | os-integration | covered (strong; tray-recording-status) | - | - |
| Storage retention safety UX | storage-privacy | covered (strong; settings-sections, windows-user-journey) | covered (strong; settings-sections) | covered (strong; settings-sections) |
| Updater install and rollback safety | os-integration | gap | gap | gap |
| Update-available banner surfacing | real-ui-e2e | covered (partial; updater-banner) | covered (partial; updater-banner) | covered (partial; updater-banner) |

## Critical Gaps

- windows: Real capture, OCR, and indexing (weak); Updater install and rollback safety (gap).
- macos: Real capture, OCR, and indexing (weak); Audio device health (weak); Updater install and rollback safety (gap).
- linux: Real capture, OCR, and indexing (weak); Audio device health (gap); Updater install and rollback safety (gap).

## Execution Integrity

- Specs that claim coverage but contain zero executable test blocks: zzz-browser-state-chat-switch.spec.ts, zz-owned-browser-background-nav.spec.ts, zzz-owned-browser-headless.spec.ts. They assert nothing and no longer count toward any critical feature.
- Declared coverage below is NOT reconciled against execution: no runtime results
  were supplied. Specs can self-skip on hosted runners (no display, vision off,
  recording disabled) and still read as covered. Run `e2e:coverage:runtime` (or pass
  `--results-dir`) in CI to flag declared coverage that did not actually run.

## Spec Inventory

| Spec | Platforms | Layers | Features | Criticality | Confidence | UX | Tests | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| api-key-cold-spawn.spec.ts | windows, macos, linux | local-api, tauri-command | local-api-auth, app-launch | medium | partial | command | 3 | Cold-spawn local API config regression coverage. |
| api-search-stress.spec.ts | windows, macos, linux | local-api, performance | local-api-auth, local-api-search, health, audio-device-health, local-api-load | high | strong | api | 29 | Broad readonly API, auth, search, and load coverage. |
| api.spec.ts | windows, macos, linux | local-api | health, audio-device-health, connections, local-api-auth | high | partial | api | 7 | Smoke coverage for local HTTP API shape and auth behavior. |
| app-lifecycle.spec.ts | windows, macos, linux | real-ui-e2e, window-lifecycle | app-launch, home-navigation, webview-stability, route-churn, browser-storage | high | strong | mixed | 14 | Home webview, routing, reload, focus, resize, and storage stability. |
| artifacts-api.spec.ts | windows, macos, linux | local-api | local-api-auth, artifacts | medium | strong | api | 7 | CRUD coverage for artifact registration, validation, unified listing, upsert, and delete. |
| audio-fallback.spec.ts | macos | audio-device, settings, notifications | audio-device-health, settings-recording, notifications | medium | conditional | real-user-flow | 1 | Opt-in macOS cloud audio fallback seed. |
| brain-section.spec.ts | windows, macos, linux | real-ui-e2e | brain, artifacts, memories, viewer-deeplink | medium | strong | real-user-flow | 10 | Brain coverage for filters, search, delete flows, selection pruning, add memory, and inline artifact markdown preview. |
| capture-frequency-floor.spec.ts | macos | capture-ocr, settings, real-ui-e2e | capture-ocr, settings-recording, restart-flow | high | conditional | real-user-flow | 1 | macOS fixed screenshot cadence regression: persists the 1s setting before immediate Apply & Restart, then verifies real capture attempts and frame writes. |
| chat-ask-user-tool-card.spec.ts | windows, macos, linux | chat-ai, real-ui-e2e | chat, chat-tools, pi-ask-user | medium | partial | mixed | 1 | Synthetic assistant tool block renders the Pi ask_user dropdown and sends the selected answer through the normal chat reply path. |
| chat-automation-card-duplicate.spec.ts | windows, macos, linux | chat-ai, real-ui-e2e | chat, chat-sidebar-dedupe | medium | partial | real-user-flow | 1 | Home automation card clicks must create exactly one persisted conversation per card, guarding the #4719 duplicate-row path. |
| chat-composer-isolation.spec.ts | windows, macos, linux | chat-ai, real-ui-e2e | chat, chat-drafts | medium | partial | mixed | 1 | Composer draft isolation across conversations. |
| chat-connections-context-duplicate.spec.ts | windows, macos | chat-ai | chat, chat-sidebar-dedupe | medium | partial | synthetic | 1 | QUARANTINED (#4689): connections-context wrapper stripping regression. The synthetic background-router event path never persists deterministically on Linux/macOS CI; re-enable once it drives a deterministic persisted session. |
| chat-newchat-duplicate.spec.ts | windows, macos, linux | chat-ai | chat, chat-sidebar-dedupe | medium | partial | synthetic | 1 | Synthetic chat event regression for duplicate sidebar rows. |
| chat-newchat-fresh.spec.ts | windows, macos, linux | chat-ai, real-ui-e2e | chat, chat-drafts | medium | partial | real-user-flow | 2 | The real new-chat shortcut opens a fresh chat from non-empty conversations and reuses one blank chat when pressed repeatedly. |
| chat-parallel-jobs-duplicate.spec.ts | windows, macos, linux | chat-ai | chat, chat-sidebar-dedupe | medium | partial | synthetic | 1 | Parallel auto-send prefill dedupe regression. |
| chat-prefill-context-leak.spec.ts | windows, macos, linux | chat-ai | chat, chat-prefill | medium | partial | synthetic | 1 | Pending auto-send prefill must render only the clean prompt, not the internal model context, as the user message. |
| chat-prefill-duplicate.spec.ts | macos | chat-ai | chat, chat-prefill | medium | partial | synthetic | 1 | QUARANTINED (#4610): cross-window prefill duplicate regression. The autoSend persist precondition is racy in CI — times out with 0 conversations (not the duplicate=2 it guards) ~100% Linux + ~33% macOS. Re-enable once it seeds the persisted conversation deterministically. |
| chat-settings-background-stream.spec.ts | windows, macos, linux | chat-ai, settings, real-ui-e2e | chat, chat-streaming, settings | high | strong | real-user-flow | 1 | Opening the standalone Settings route mid-stream must not abort the chat: a long synthetic stream keeps running while the user round-trips to Settings, remains live in Recents, and restores the full response (early + final tokens) after the row is clicked. |
| chat-sidebar-groups.spec.ts | windows, macos, linux | chat-ai, real-ui-e2e | chat, chat-sidebar-groups | medium | strong | real-user-flow | 9 | Pipe auto-grouping (collapse, badge, expand/collapse, localStorage persistence) and manual sidebar groups (move-to-group, section headers, remove-from-group cleanup). 8 tests. |
| chat-sidebar-pipe-inventory.spec.ts | windows, macos, linux | chat-ai, pipes, real-ui-e2e | chat, pipes, chat-sidebar-groups | high | strong | mixed | 1 | A collapsed Pipes section loads nothing; expanding it lists a compact execution-backed activity page, expanding a pipe lazily loads its newest 10 executions, and older runs paginate on demand. |
| chat-sidebar-stub-dedup.spec.ts | windows, macos, linux | chat-ai | chat, chat-sidebar-dedupe | medium | partial | synthetic | 1 | Listener-order regression for metadata-only sidebar stubs gaining dedup keys. |
| chat-source-file-preview.spec.ts | windows, macos, linux | chat-ai, real-ui-e2e | chat | medium | strong | real-user-flow | 1 | Clicking a chat file source opens it in the preview sidebar with rendered markdown + syntax-highlighted code. |
| chat-streaming-performance.spec.ts | macos | chat-ai, performance | chat, chat-streaming | medium | conditional | performance | 2 | macOS-only chat streaming responsiveness. |
| chat-subagent-async-completion.spec.ts | windows, macos, linux | chat-ai, real-ui-e2e, tauri-command | chat | high | strong | real-user-flow | 1 | Verifies an asynchronous subagent completion appears as a second assistant turn after the original answer settles. |
| chat-switch-context-loss.spec.ts | windows, macos, linux | chat-ai | chat, chat-context | medium | partial | synthetic | 1 | Switching conversations during streaming must not corrupt state. |
| chat-tool-activity.spec.ts | windows, macos, linux | chat-ai, real-ui-e2e | chat, chat-tools, pi-tool-activity, progressive-disclosure | high | strong | mixed | 3 | Mixed Python, JavaScript, Screenpipe API, file, test, recovered-error, and optional live Pi tool flows stay collapsed by default, expose only friendly activity on first expansion, and capture screenshots. |
| chat-window.spec.ts | windows, macos, linux | chat-ai, window-lifecycle, real-ui-e2e | chat, window-lifecycle | high | strong | real-user-flow | 1 | Opens Chat and focuses the composer for typing. |
| chat-within-session-context-loss.spec.ts | macos | chat-ai | chat, chat-context | medium | conditional | synthetic | 1 | macOS-only within-chat context retention regression. |
| focus-server.spec.ts | windows, macos, linux | local-api, window-lifecycle, tauri-command | window-lifecycle, focus-server, deeplink | medium | partial | api | 2 | Focus server opens windows and forwards deeplink args. |
| hd-recording-pipeline.spec.ts | macos | capture-ocr, local-api, performance | capture-ocr, hd-recording, timeline | high | conditional | api | 1 | Opt-in macOS HD capture and OCR indexing. |
| help-discord-link.spec.ts | windows, macos, linux | real-ui-e2e | help | low | smoke | real-user-flow | 2 | Help section Discord invite link. |
| home-window.spec.ts | windows, macos, linux | real-ui-e2e, window-lifecycle | app-launch, home-navigation, timeline, settings-recording, pipes | high | strong | real-user-flow | 1 | Clicks through Home, Pipes, Timeline, Help, and Settings. |
| html-artifact-render.spec.ts | windows, macos, linux | real-ui-e2e | brain, artifacts, html-sandbox | high | strong | real-user-flow | 1 | Registers an HTML artifact, opens it in Brain, and asserts it renders inside a sandboxed allow-scripts iframe (CSP default-src 'none') whose global <style> never leaks into the host app DOM (regression: rehype-raw repainting the whole window). |
| macos-ui-performance.spec.ts | macos | performance, real-ui-e2e | timeline, audio-device-health | medium | conditional | performance | 2 | macOS-only timeline/audio UI performance guards. |
| main-overlay-visibility.spec.ts | windows, macos, linux | window-lifecycle, tauri-command | window-lifecycle, main-overlay | medium | partial | command | 1 | Main overlay show/hide without duplicate handles. |
| main-window-close-reopen.spec.ts | windows, macos, linux | window-lifecycle, tauri-command | window-lifecycle, main-window | medium | partial | command | 1 | Main close/reopen without handle leaks. |
| main-window.spec.ts | windows, macos, linux | window-lifecycle, tauri-command | window-lifecycle, main-window | medium | partial | command | 2 | Main window show/hide dedupe. |
| meeting-apps-picker.spec.ts | windows, macos, linux | settings, real-ui-e2e | settings-recording, meeting-detector-ignored-apps | medium | strong | real-user-flow | 3 | Per-app meeting-detection ignore picker: open, toggle, count badge, persistence across reopen (#3882 / #3847). |
| meeting-note-bottom-click.spec.ts | windows, macos, linux | real-ui-e2e, local-api | meeting-notes | high | strong | real-user-flow | 3 | Seeds and opens a long meeting note, checks editor shell click focus behavior, then clicks the bottom editor line. |
| notification-viewer-link.spec.ts | windows, macos, linux | notifications, local-api, window-lifecycle | notifications, viewer-deeplink | high | partial | mixed | 3 | Notification local file links rewrite into in-app viewer links. |
| onboarding-redirect.spec.ts | windows, macos, linux | onboarding, real-ui-e2e, window-lifecycle | onboarding, app-launch | high | conditional | real-user-flow | 4 | Opt-in no-onboarding seed verifies onboarding redirect. |
| owned-browser.spec.ts | windows, macos | os-integration, window-lifecycle | owned-browser, window-lifecycle | low | smoke | command | 1 | Embedded agent browser hides safely without an attached child. |
| permission-recovery.spec.ts | macos | os-integration, real-ui-e2e, window-lifecycle | permission-recovery, window-lifecycle | high | conditional | real-user-flow | 2 | macOS-only recovery window for missing TCC permissions. |
| pi-extensions.spec.ts | windows, macos, linux | real-ui-e2e, settings | connections, pi-extensions, agent-extensions | medium | strong | real-user-flow | 1 | Opens Home -> Connections, opens Pi extensions, verifies catalog and warning copy, filters package search, and captures a screenshot. Read-only smoke: does not install packages. |
| pipes-mcp-connections.spec.ts | windows, macos, linux | pipes, real-ui-e2e, local-api | pipes, connections | high | strong | real-user-flow | 3 | Seeds a custom MCP server, installs a local pipe, selects the MCP server from the pipe connection picker, and verifies the mcp:<id> allowlist persists. |
| pipes.spec.ts | windows, macos, linux | pipes, real-ui-e2e, local-api | pipes | high | strong | real-user-flow | 8 | Pipes discover, install failure, connection modal, install, list, play, and stop. |
| privacy-api-auth-enforcement.spec.ts | windows, macos, linux | settings, local-api, storage-privacy | settings-privacy-api-auth, local-api-auth, restart-flow | high | conditional | mixed | 1 | Opt-in restart smoke toggles API auth and verifies backend behavior. |
| privacy-api-auth.spec.ts | windows, macos, linux | settings, storage-privacy, real-ui-e2e | settings-privacy-api-auth, local-api-auth | high | strong | real-user-flow | 1 | Privacy settings reveal/copy local API key flow. |
| privacy-installed-apps.spec.ts | windows, macos, linux | settings, storage-privacy, real-ui-e2e | settings-privacy-filters, installed-apps | medium | strong | real-user-flow | 1 | Privacy content filters surface installed-but-not-captured apps as typeable options with the not-captured hint (fetch-intercepted /installed-apps for determinism). |
| sck-startup-recovery.spec.ts | macos | capture-ocr, local-api, os-integration | app-launch, capture-ocr, health, local-api-search | high | conditional | api | 1 | Opt-in macOS fault injection verifies bounded SCK enumeration recovery, same-process capture, and OCR persistence. |
| search-request-priority.spec.ts | windows, macos, linux | real-ui-e2e, local-api | home-search, local-api-search | medium | partial | synthetic | 1 | Verifies keyword search request fires before secondary search, facet, and speaker requests. |
| settings-sections.spec.ts | windows, macos, linux | settings, real-ui-e2e, storage-privacy | settings-recording, settings-ai, settings-privacy-api-auth, storage-retention, audio-device-health | high | strong | real-user-flow | 10 | Settings sections, AI preset/preferences split and toggle flows, storage, privacy, and rapid switching crash guard. |
| timeline.spec.ts | windows, macos, linux | real-ui-e2e, capture-ocr | timeline, capture-ocr | high | conditional | real-user-flow | 3 | Timeline shell always runs; seeded frame assertion skips under no-recording. |
| tray-recording-status.spec.ts | windows | os-integration, tauri-command | tray-recording-status | high | strong | command | 1 | Drives Starting to Recording and reads back the status item from the successfully installed native tray menu. |
| tray-search.spec.ts | windows, macos, linux | window-lifecycle, tauri-command, real-ui-e2e | tray-search, home-search, window-lifecycle | high | partial | command | 2 | Invokes open_search_window and verifies focused floating Search. |
| updater-banner.spec.ts | windows, macos, linux | real-ui-e2e | update-surfacing | high | partial | synthetic | 1 | Synthetic update-available event surfaces the restart-to-update banner (no relaunch). Real check/download/install + rollback stay manual via e2e/mock-updates; the debug e2e build disables the updater check under cfg!(debug_assertions). |
| viewer-deeplink.spec.ts | windows, macos, linux | window-lifecycle, tauri-command | viewer-deeplink, window-lifecycle | medium | partial | command | 3 | Viewer window creation and per-path dedupe. |
| window-activation.spec.ts | macos | window-lifecycle, tauri-command, real-ui-e2e | window-lifecycle, chat | medium | conditional | real-user-flow | 2 | macOS-only show_window_activated focus coverage. |
| window-lifecycle.spec.ts | windows, macos, linux | window-lifecycle, tauri-command, real-ui-e2e | window-lifecycle, onboarding, tray-search | high | strong | mixed | 3 | Home, Search, and onboarding window routing. |
| windows-core-recording.spec.ts | windows | capture-ocr, local-api, audio-device, real-ui-e2e | capture-ocr, local-api-auth, local-api-search, audio-device-health, timeline | high | conditional | mixed | 12 | Windows recording-enabled lane; hosted runners can skip frame-dependent OCR assertions. |
| windows-system-integration.spec.ts | windows | os-integration, local-api, audio-device, window-lifecycle, performance | app-launch, local-api-auth, audio-device-health, window-lifecycle, os-process-health, webview-stability | high | strong | mixed | 15 | Windows display, WebView2, loopback, process, Defender, audio, focus, and crash-report checks. |
| windows-user-journey.spec.ts | windows | real-ui-e2e, settings, notifications, storage-privacy, window-lifecycle | home-search, timeline, settings-recording, meeting-notes, shortcut-reminder, notifications, storage-retention, settings-privacy-api-auth | high | strong | real-user-flow | 8 | Windows-first real UX journey across search, timeline, settings, meetings, notifications, storage, and privacy. |
| zz-account-basic-upgrade-billing.spec.ts | windows, macos, linux | real-ui-e2e, settings, billing | account-upgrade, billing-proration, checkout-duplication | high | strong | real-user-flow | 1 | Basic paid user clicking Account upgrade opens account billing for subscription changes/proration and does not call the fresh subscription checkout endpoint. |
| zz-account-stale-subscription.spec.ts | windows, macos, linux | real-ui-e2e, settings, billing | account-card, billing-gate | medium | strong | real-user-flow | 1 | Account 'active' plan card is gated on the session token (token AND cloud_subscribed) like the header, so a tokenless-but-subscribed stale shell (post-#3943 secret-store token desync) renders 'not logged in' with the active card gone. Mocks /api/user across all windows and clears set_cloud_token to reproduce the desync deterministically. |
| zz-app-entitlement-gate.spec.ts | windows, macos, linux | settings, billing, real-ui-e2e | app-entitlement-gate, billing-gate | high | strong | real-user-flow | 2 | Production billing gate blocks an unentitled session behind the paywall and restores access when the forced-gate flag is cleared. |
| zz-audio-fallback-reverify.spec.ts | macos | auth, entitlement, audio-device, settings | cloud-entitlement-reverify, audio-engine-fallback, settings-recording | high | strong | real-user-flow | 1 | AuthGuard re-verifies cloud entitlement on window focus so a freshly-subscribed user gets cloud transcription without restart (#4339). |
| zz-enterprise-license-prompt.spec.ts | windows, macos, linux | settings, billing, real-ui-e2e | app-entitlement-gate, billing-gate | high | strong | real-user-flow | 2 | Enterprise license prompt handles invalid keys, full-seat errors, and retry success after seats are added without staying stuck in validating state. |
| zz-logout-resurrect.spec.ts | windows, macos, linux | real-ui-e2e, settings | account-logout, auth-session | high | strong | synthetic | 1 | Logout must not be resurrected by an in-flight loadUser. Logs in via a synthetic deep-link (?api_key=) with a mocked /api/user fetch, makes the fetch slow, fires it, then clicks logout while it is pending and asserts the slow response cannot re-write the user (the 'logout needs two clicks' bug). Covers the auth-generation guard in use-settings.tsx. |
| zz-owned-browser-background-nav.spec.ts | windows, macos | os-integration, window-lifecycle | owned-browser, window-lifecycle | low | smoke | command | 0 | Owned browser background navigation visibility. |
| zzz-browser-state-chat-switch.spec.ts | windows, macos | real-ui-e2e, storage-privacy | chat, owned-browser | high | strong | synthetic | 0 | Synthetic E2E (zzz- prefix, search-driven): starts from a fresh chat with no conversation file, seeds browser state before the first durable save, then verifies auto-save persists that state and it survives a switch away and back. Keeps native visibility assertions out of this spec because post-zz window state is too brittle; deeper save/merge coverage lives in focused tests. |
| zzz-owned-browser-headless.spec.ts | windows, macos | os-integration, window-lifecycle, local-api | owned-browser, window-lifecycle | high | strong | mixed | 0 | Headless owned browser for background pipes (#4248): with the sidebar never opened, a background eval and navigate-and-scrape over the local API lazily create a hidden offscreen child webview, return a real JS result (6*7 -> 42; document.readyState), and stay invisible; is_ready reflects real serviceability; the same singleton is then adopted into the sidebar panel (page state survives, no second webview). Search-driven and runs last because attaching the child to home tears down home's WebDriver handle. |
