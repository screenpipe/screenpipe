# SOP blocks and captions

Captured at 1440 × 1000 from the maintained web preview using the shared desktop components. The workflow, screenshots, speech and short video are fictional fixtures.

- `editor.png`: added heading, hover drag handle and insertion menu.
- `captions.png`: playback at 0.5 seconds with the default caption track visibly rendered and the video block's drag handle available.

The maintained `eval-video-chat.cjs` checks insertion, editing, keyboard movement, video dragging, default active captions, chat generation, repeat/stop and a 900px layout. Persistence and export ordering are covered separately by `document-blocks.test.tsx`. The native renderer test inspects a real encoded MP4's default subtitle disposition.

These screenshots do not establish installed-app interaction or model-output quality. Page block order is document layout, separate from scene ordering in the video script.
