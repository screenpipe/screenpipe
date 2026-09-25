# Split chat composer evidence

Captured September 25, 2026 on the real `/home` browser-mock surface with synthetic conversations, files, audio, and IPC. No native process, device recording, or live AI/transcription request was used.

`before-light.png` was captured before editing at base `2972f4fa966be94965ed7762bba3dbc01157ebe4`. The remaining images show the source changes in this commit, using `scripts/eval-split-chat-composers.mjs` from the desktop app.

The before/after pair uses the same route, light theme, 1440 × 1000 viewport and two chat titles. The baseline has default mock settings; after captures configure synthetic models, use ordinary local chat fixtures, and add drafts to exercise input. Source icons/model labels therefore differ. A development-only indicator appears in the baseline and is hidden in after captures. This is a behavior comparison, not a pixel-identical fixture comparison.

All desktop images are 1440 × 1000. `compact.png` is 1000 × 780. The 24-image gallery covers independent drafts, light/dark and compact layouts, preparing, direct send, concurrent streaming, queueing, targeted stop, close/reopen draft restoration, error/retry, empty chat, focused shortcut, add menu, attachment extraction/completion, filters, model menu, different selected models, dictation recording/transcript, and microphone denial.

Both panes use the shared input, attachment tray, utility menu, model/effort controls, usage indicator, dictation control, and queue display. The eval also verifies late file extraction after switching panes and dictation/shortcut isolation.

Native WebKit, physical microphone permissions/capture, native file picking, and live provider/transcription execution remain unverified. Their existing adapters are mocked in browser evidence.
