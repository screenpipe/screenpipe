## New Features

- **macOS 14.4+:** Exclude apps from system-audio capture via `~/.screenpipe/audio-exclusions.json` (hot-reloadable JSON file; resolves bundle IDs via NSRunningApp + macOS 14.4+ `NSAudioCaptureUsageDescription` TCC prompt)
- **macOS 14.4+:** Settings panel for managing audio process exclusions — Settings → Recording → "Exclude apps from system audio" with Finder `.app` picker, chip list with app icons, Apply & Restart integration
- Bring your own MCP servers — register custom MCP servers from your config and route them through the AI agent alongside the built-in ones
- Microphone capture can now use macOS VoiceProcessingIO (opt-in) for cleaner echo/noise cancellation on Apple silicon

## Bug Fixes

- Electron apps (VS Code, Discord, Slack) now get the full accessibility walk budget — depth counter resets at AXWebArea boundaries instead of cutting off the tree halfway through
- USB audio devices with mismatched sample rates no longer drop into silence on macOS

#### **Full Changelog:** [bdf01bdb..2b06b643](https://github.com/screenpipe/screenpipe/compare/bdf01bdb..2b06b643)
