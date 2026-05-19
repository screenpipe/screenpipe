# Electron example — `@screenpipe/sdk`

![Electron example app](../../docs/screenshots/electron-example.png)

Back to the [examples index](../README.md).

Minimal Electron app that embeds the SDK with the packaged
`@screenpipe/sdk/electron` helpers:

1. Request OS permissions
2. Start recording to an MP4 in your Videos folder
3. Stop recording and reveal the file
4. Poll live preview, frame count, file size, mic level, and focused app

## Run locally

First, build the SDK prebuild (from repo root):

```bash
cd /path/to/screenpipe/ee/sdk
bun install
bun run build          # release build — recommended for real perf
```

Then install + launch the example:

```bash
cd examples/electron-app
npm install            # pulls Electron; SDK comes via file:../..
npm start
```

On first launch, click **1. Request permissions** — macOS will prompt for Screen Recording. Grant it, then click **2. Start recording** → **3. Stop**.

## What this demonstrates

- **Native module loads cleanly in Electron's main process.** The `.node` prebuild from `bun run build` is referenced via `"@screenpipe/sdk": "file:../.."` in `package.json`.
- **First-class IPC helper**: `registerScreenpipeIpc()` owns the `Recorder` instance and registers permission/start/stop/status/snapshot/reveal channels.
- **Preload bridge**: `exposeScreenpipeApi({ name: "api" })` exposes a context-isolated renderer API without enabling Node integration.
- **File placement**: MP4 is written to `app.getPath('videos')` which resolves to `~/Movies` on macOS and `~/Videos` on Windows — a reliable, user-accessible location.
- **Embed payloads**: `snapshot()` returns a JPEG preview plus `frames`, `bytes`, `audioLevel`, `focusedApp`, and per-sensor errors so one denied permission does not break the whole UI.

## What this does NOT cover (yet)

- **Code signing**: a production Electron app bundling the SDK must include the `.node` file in its signing script. For `electron-builder`, add `dist/**/*.node` to `extraResources` and ensure `afterSign` notarizes it on macOS. This example is unsigned — fine for `npm start`, not fine for a production ship.
- **Packaging**: this example only runs via `npm start`. To ship a `.dmg` or `.exe`, add `electron-builder` config and wire in signing/notarization — out of scope here.
- **Audio**: v0.1.0 of the SDK records silent video. Audio lands in v0.2.x.

## Troubleshooting

**`Error: Cannot find module '@screenpipe/sdk'` at launch**
You didn't build the SDK first. Run `bun run build` in the repo root.

**Recording starts but MP4 is 0 bytes or very short**
You're in a debug build (`bun run build:debug`) where the PNG encoder runs ~500× slower. Use `bun run build` (release).

**Permissions prompt never appears**
macOS caches the grant decision per bundle identifier. If you've run this example before and denied, open System Settings → Privacy & Security → Screen Recording, remove Electron from the list, relaunch.
