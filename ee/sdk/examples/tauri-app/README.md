# Screenpipe Tauri Example

![Tauri example app](../../docs/screenshots/tauri-example.png)

Back to the [examples index](../README.md).

This is a minimal Tauri v2 app using the SDK's Tauri frontend client and Rust
plugin.

```bash
cd examples/tauri-app
npm install
npm run dev
```

The Rust plugin is **native** — `ee/sdk/tauri/rust` depends on
`screenpipe-recorder` directly and drives the recorder in-process inside
the Tauri tokio runtime. No Node binary, no bridge script, no child
process at runtime. The frontend uses `@screenpipe/sdk/tauri` and talks
to the plugin over standard Tauri IPC.
