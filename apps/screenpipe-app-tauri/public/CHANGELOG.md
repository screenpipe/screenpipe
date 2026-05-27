## New Features

- Bring your own MCP servers — register custom MCP servers from your config and route them through the AI agent alongside the built-in ones
- Microphone capture can now use macOS VoiceProcessingIO (opt-in) for cleaner echo/noise cancellation on Apple silicon

## Bug Fixes

- Electron apps (VS Code, Discord, Slack) now get the full accessibility walk budget — depth counter resets at AXWebArea boundaries instead of cutting off the tree halfway through
- USB audio devices with mismatched sample rates no longer drop into silence on macOS

#### **Full Changelog:** [bdf01bdb..2b06b643](https://github.com/screenpipe/screenpipe/compare/bdf01bdb..2b06b643)
