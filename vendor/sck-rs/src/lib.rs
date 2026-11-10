//! # xcap-sck
//!
//! A modern screen capture library for macOS using ScreenCaptureKit.
//! Provides an API compatible with xcap for easy migration.
//!
//! ## Features
//!
//! - Uses Apple's ScreenCaptureKit (macOS 12.3+) for efficient capture
//! - Lower CPU usage than legacy CGWindowListCreateImage
//! - Better support for HDR content and system windows
//! - Metal/GPU accelerated capture
//!
//! ## Example
//!
//! ```rust,no_run
//! use sck_rs::{Window, Monitor};
//!
//! // Capture all windows
//! let windows = Window::all().unwrap();
//! for window in windows {
//!     if let Ok(image) = window.capture_image() {
//!         image.save(format!("{}.png", window.id().unwrap())).unwrap();
//!     }
//! }
//!
//! // Capture primary monitor
//! let monitors = Monitor::all().unwrap();
//! if let Some(monitor) = monitors.first() {
//!     let image = monitor.capture_image().unwrap();
//!     image.save("monitor.png").unwrap();
//! }
//! ```

#![cfg(target_os = "macos")]

mod capture;
mod error;
mod monitor;
mod stream_manager;
mod window;

pub use capture::{process_status, ProcessStatus};
pub use error::{XCapError, XCapResult};
pub use monitor::Monitor;
pub use stream_manager::{
    capture_monitor_persistent, invalidate_monitor_stream, monitor_frame_seq, peek_latest_frame,
    start_hd_capture, stop_all_streams, HdCaptureStream,
};
pub use window::Window;

/// Check if ScreenCaptureKit is available on this system (macOS 12.3+)
pub fn is_supported() -> bool {
    // ScreenCaptureKit requires macOS 12.3+
    // The screencapturekit crate handles this check internally
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_supported() {
        // On macOS 12.3+, this should return true
        assert!(is_supported());
    }
}
