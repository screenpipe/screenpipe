# sck-rs

A modern screen capture library for macOS using Apple's ScreenCaptureKit framework via [cidre](https://crates.io/crates/cidre) Rust bindings.

## Features

- **ScreenCaptureKit-based** - Uses Apple's modern screen capture framework
- **Pure Rust** - No Swift runtime dependency (uses cidre for Apple framework bindings)
- **Lower CPU usage** - Metal/GPU accelerated capture
- **Better compatibility** - Handles HDR content and system windows better
- **macOS Tahoe ready** - First-class support for macOS 26+

## Requirements

- macOS 14.0 or later (Sonoma+)
- Screen Recording permission granted

## Installation

Add to your `Cargo.toml`:

```toml
[dependencies]
sck-rs = { git = "https://github.com/louis030195/sck-rs" }
```

## Usage

### Monitor Capture

```rust
use sck_rs::Monitor;

// List all monitors
let monitors = Monitor::all().unwrap();
for monitor in &monitors {
    println!("{} - {}x{}", monitor.name(), monitor.raw_width(), monitor.raw_height());
}

// Capture primary monitor
let monitor = Monitor::primary().unwrap();
let image = monitor.capture_image().unwrap();
image.save("monitor.png").unwrap();
```

### Window Capture

```rust
use sck_rs::Window;

// List all windows
let windows = Window::all().unwrap();
for window in &windows {
    println!("{} - {}",
        window.app_name().unwrap_or_default(),
        window.title().unwrap_or_default()
    );
}

// Capture a window
if let Some(window) = windows.first() {
    let image = window.capture_image().unwrap();
    image.save("window.png").unwrap();
}
```

## API

### Window

```rust
impl Window {
    pub fn all() -> Result<Vec<Window>>;
    pub fn id(&self) -> Result<u32>;
    pub fn pid(&self) -> Result<u32>;
    pub fn app_name(&self) -> Result<String>;
    pub fn title(&self) -> Result<String>;
    pub fn x(&self) -> Result<i32>;
    pub fn y(&self) -> Result<i32>;
    pub fn width(&self) -> Result<u32>;
    pub fn height(&self) -> Result<u32>;
    pub fn is_minimized(&self) -> Result<bool>;
    pub fn is_on_screen(&self) -> bool;
    pub fn capture_image(&self) -> Result<RgbaImage>;
}
```

### Monitor

```rust
impl Monitor {
    pub fn all() -> Result<Vec<Monitor>>;
    pub fn primary() -> Result<Monitor>;
    pub fn id(&self) -> u32;
    pub fn name(&self) -> &str;
    pub fn x(&self) -> i32;
    pub fn y(&self) -> i32;
    pub fn width(&self) -> Result<u32>;
    pub fn height(&self) -> Result<u32>;
    pub fn raw_width(&self) -> u32;
    pub fn raw_height(&self) -> u32;
    pub fn is_primary(&self) -> bool;
    pub fn capture_image(&self) -> Result<RgbaImage>;
}
```

## Why ScreenCaptureKit?

| Feature | CGWindowListCreateImage | ScreenCaptureKit |
|---------|------------------------|------------------|
| CPU Usage | High (main thread blocking) | Low (async, Metal) |
| HDR Support | Limited | Full |
| System Windows | Often fails | Full support |
| macOS Tahoe (26) | Breaking | First-class support |
| Future | Legacy/deprecated | Active development |

## Implementation Notes

- **Window capture**: Captures the display containing the window and crops to the window bounds. Works reliably for all window types.
- **macOS 14.0+ required**: Uses `SCScreenshotManager` which requires macOS 14.0 (Sonoma) or later.

## Permissions

Screen capture requires user permission. Add to your `Info.plist`:

```xml
<key>NSScreenCaptureUsageDescription</key>
<string>This app needs screen recording permission.</string>
```

Or grant permission in System Settings > Privacy & Security > Screen Recording.

## Examples

```bash
# List all windows
cargo run --example list_windows

# Capture primary monitor
cargo run --example capture_monitor

# Capture windows
cargo run --example capture_window

# Capture specific app windows
cargo run --example capture_window -- Safari
```

## License

MIT

### Standalone macOS host lifecycle

A long-lived capture host must initialize AppKit on its process main thread and
service that thread's run loop. GUI applications already provide this lifecycle.
A Tokio runtime alone does not deliver display-environment updates: after hotplug,
CoreGraphics mode queries can remain unavailable even while ScreenCaptureKit lists
the display. Keep initialization and the main loop in the host, not in a capture
callback. Monitor discovery skips unavailable display modes while preserving other
healthy displays; it never assumes a 1x backing scale for an unknown mode.

Monitor capture dimensions are backing pixels. Use `logical_width()` and
`logical_height()` with `x()`/`y()` for desktop geometry and cursor attribution.
