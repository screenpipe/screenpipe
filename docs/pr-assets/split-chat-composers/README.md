# Split chat composer evidence

Captured September 25, 2026 on the real `/home` browser-mock surface with synthetic conversations and IPC. No native process or live AI provider was used.

`before-light.png` was captured before editing at base `2972f4fa966be94965ed7762bba3dbc01157ebe4`. The remaining images show the source changes in this commit, using `scripts/eval-split-chat-composers.mjs` from the desktop app.

The before/after pair uses the same route, light theme, 1440 × 1000 viewport and two chat titles. The baseline has default mock settings; after captures configure a synthetic model, use ordinary local chat fixtures, and add drafts to exercise input. Source icons/model labels therefore differ. A development-only indicator appears in the baseline and is hidden in after captures. This is a behavior comparison, not a pixel-identical fixture comparison.

All desktop images are 1440 × 1000. `compact.png` is 1000 × 780. The gallery covers independent drafts, light/dark and compact layouts, preparing, direct send, concurrent streaming, queueing, targeted stop, close/reopen with draft restoration, error/retry, empty chat, and a shortcut targeting the focused pane.

Native WebKit and live provider execution remain unverified. Model and attachment controls remain available through the secondary pane's full-controls button.
