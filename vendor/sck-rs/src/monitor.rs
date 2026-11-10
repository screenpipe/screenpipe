// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Monitor/Display capture using ScreenCaptureKit via cidre

use cidre::cg;
use image::RgbaImage;
use tracing::{debug, warn};

use crate::capture;
use crate::error::{XCapError, XCapResult};

/// Represents a capturable monitor/display
///
/// This type provides an API compatible with xcap::Monitor
#[derive(Debug, Clone)]
pub struct Monitor {
    /// The display ID
    display_id: u32,
    /// Display name (if available)
    name: String,
    /// Display X position
    x: i32,
    /// Display Y position
    y: i32,
    /// Display width in backing pixels used for capture
    width: u32,
    /// Display height in backing pixels used for capture
    height: u32,
    /// Logical width (what macOS reports for UI layout)
    logical_width: u32,
    /// Logical height (what macOS reports for UI layout)
    logical_height: u32,
    /// Scale factor (for Retina displays) - ratio of physical to logical pixels
    scale_factor: f64,
    /// Whether this is the primary display
    is_primary: bool,
}

impl Monitor {
    /// Get all available monitors
    ///
    /// Returns a list of all displays that can be captured.
    /// Requires screen recording permission.
    pub fn all() -> XCapResult<Vec<Monitor>> {
        let content = capture::get_shareable_content()?;

        Self::from_shareable_content(&content)
    }

    /// Get all available monitors without spawning a synchronous bridge worker.
    pub async fn all_async() -> XCapResult<Vec<Monitor>> {
        let content = capture::get_shareable_content_async().await?;

        let mut result = None;
        cidre::objc::ar_pool(|| {
            result = Some(Self::from_shareable_content(&content));
        });
        result.expect("autorelease pool closure must run")
    }

    fn from_shareable_content(content: &cidre::sc::ShareableContent) -> XCapResult<Vec<Monitor>> {
        let displays = content.displays();

        if displays.is_empty() {
            return Err(XCapError::no_monitors());
        }

        // Find the primary display (usually the first one, or has origin at 0,0)
        let primary_id = displays
            .iter()
            .find(|d| {
                let frame = d.frame();
                frame.origin.x == 0.0 && frame.origin.y == 0.0
            })
            .map(|d| d.display_id().0)
            .unwrap_or_else(|| displays.first().map(|d| d.display_id().0).unwrap_or(0));

        let monitors = displays.iter().map(|d| {
            let frame = d.frame();
            let display_id = d.display_id().0;

            // SCDisplay dimensions are points, not backing pixels. The mode's
            // pixel/point ratio also works for rotated displays: apply it to
            // the current global bounds, whose axes already reflect rotation.
            let bounds = cg::DirectDisplayId(display_id).bounds();
            let logical_width = bounds.size.width as u32;
            let logical_height = bounds.size.height as u32;
            let (capture_width, capture_height, scale_factor) =
                native_capture_size(display_id, (logical_width, logical_height))?;
            debug!(
                "Display {display_id}: {logical_width}x{logical_height} points, \
                     {capture_width}x{capture_height} backing pixels, scale={scale_factor}"
            );

            Ok(Monitor {
                display_id,
                name: format!("Display {}", display_id),
                x: frame.origin.x as i32,
                y: frame.origin.y as i32,
                width: capture_width,
                height: capture_height,
                logical_width,
                logical_height,
                scale_factor,
                is_primary: display_id == primary_id,
            })
        });
        collect_available_monitors(monitors)
    }

    /// Get the primary monitor
    pub fn primary() -> XCapResult<Monitor> {
        let monitors = Self::all()?;
        monitors
            .into_iter()
            .find(|m| m.is_primary)
            .ok_or_else(|| XCapError::new("No primary monitor found"))
    }

    /// Get the monitor ID
    pub fn id(&self) -> u32 {
        self.display_id
    }

    /// Get the monitor name
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Get the monitor X position
    pub fn x(&self) -> i32 {
        self.x
    }

    /// Get the monitor Y position
    pub fn y(&self) -> i32 {
        self.y
    }

    /// Get the monitor width in pixels
    pub fn width(&self) -> XCapResult<u32> {
        Ok(self.width)
    }

    /// Get the monitor height in pixels
    pub fn height(&self) -> XCapResult<u32> {
        Ok(self.height)
    }

    /// Get the raw width (non-Result version) - returns physical pixels
    pub fn raw_width(&self) -> u32 {
        self.width
    }

    /// Get the raw height (non-Result version) - returns physical pixels
    pub fn raw_height(&self) -> u32 {
        self.height
    }

    /// Get the logical width (what macOS reports for UI layout)
    pub fn logical_width(&self) -> u32 {
        self.logical_width
    }

    /// Get the logical height (what macOS reports for UI layout)
    pub fn logical_height(&self) -> u32 {
        self.logical_height
    }

    /// Get the scale factor (for Retina displays)
    pub fn scale_factor(&self) -> f64 {
        self.scale_factor
    }

    /// Check if this is the primary monitor
    pub fn is_primary(&self) -> bool {
        self.is_primary
    }

    /// Capture an image of the monitor
    ///
    /// Returns an RGBA image of the entire monitor.
    /// Uses a persistent SCStream internally (reuses across calls).
    pub fn capture_image(&self) -> XCapResult<RgbaImage> {
        capture::capture_monitor_sync(self.display_id, self.width, self.height, &[])
    }

    /// Capture an image of the monitor, excluding the given SCK window IDs.
    ///
    /// The OS will not render excluded windows into the capture buffer
    /// (zero overhead, pixel-perfect). Use this to hide sensitive apps
    /// (password managers, banking apps, etc.) from stored frames.
    pub fn capture_image_excluding(&self, excluded_window_ids: &[u32]) -> XCapResult<RgbaImage> {
        capture::capture_monitor_sync(
            self.display_id,
            self.width,
            self.height,
            excluded_window_ids,
        )
    }

    /// Capture an image of the monitor, downscaled at the source.
    ///
    /// `max_width` is the upper bound on captured width; height is derived
    /// from the source aspect ratio. If `max_width >= native_width` this is
    /// equivalent to `capture_image()` (no downscale).
    ///
    /// Cheaper than capturing native and resizing in user space: the GPU
    /// resizes the framebuffer before `replayd` hands it back, so WindowServer
    /// composites + reads back a smaller surface. Use for OCR-quality
    /// consumers that don't need pixel-perfect captures.
    ///
    /// Internally reuses the persistent SCStream cache. Different `max_width`
    /// values for the same monitor will recreate the stream (same caching
    /// rules as resolution changes).
    pub fn capture_image_scaled(&self, max_width: u32) -> XCapResult<RgbaImage> {
        let (target_w, target_h) = scaled_dims(self.width, self.height, max_width);
        capture::capture_monitor_sync(self.display_id, target_w, target_h, &[])
    }

    /// Same as `capture_image_scaled` but with window exclusion.
    pub fn capture_image_scaled_excluding(
        &self,
        max_width: u32,
        excluded_window_ids: &[u32],
    ) -> XCapResult<RgbaImage> {
        let (target_w, target_h) = scaled_dims(self.width, self.height, max_width);
        capture::capture_monitor_sync(self.display_id, target_w, target_h, excluded_window_ids)
    }

    /// Capture a fresh image, downscaled at the source, with window exclusions.
    ///
    /// Unlike the persistent latest-frame methods, this cannot return pixels
    /// latched before the request. Use it for input/focus transitions whose
    /// metadata describes a new surface. It does not raise the persistent
    /// stream's frame rate. `max_width == 0` keeps the native dimensions.
    ///
    /// macOS 14+ uses ScreenshotManager; older versions recreate the filtered
    /// stream. Errors are returned rather than serving an older cached frame.
    pub fn capture_image_fresh_scaled_excluding(
        &self,
        max_width: u32,
        excluded_window_ids: &[u32],
    ) -> XCapResult<RgbaImage> {
        let (width, height) = scaled_dims(self.width, self.height, max_width);
        capture::capture_monitor_fresh_sync(self.display_id, width, height, excluded_window_ids)
    }

    /// Stop the persistent capture stream for this monitor.
    ///
    /// The stream will be recreated automatically on the next `capture_image()` call.
    /// Use this when pausing capture (e.g., for DRM content) to fully release
    /// ScreenCaptureKit handles.
    pub fn stop_stream(&self) {
        crate::stream_manager::invalidate_monitor_stream(self.display_id);
    }
}

/// Compute target (width, height) capped at `max_width` while preserving
/// the source aspect ratio. Always returns at least 1×1 to avoid degenerate
/// SCK configs.
fn scaled_dims(src_w: u32, src_h: u32, max_width: u32) -> (u32, u32) {
    if src_w == 0 || src_h == 0 || max_width == 0 || max_width >= src_w {
        return (src_w.max(1), src_h.max(1));
    }
    let target_w = max_width;
    // Preserve aspect ratio with rounding.
    let target_h = ((max_width as u64 * src_h as u64) + (src_w as u64 / 2)) / src_w as u64;
    (target_w, (target_h as u32).max(1))
}

// These CoreGraphics mode APIs predate ScreenCaptureKit's macOS 12.3 minimum.
// A display can disappear after the SCK snapshot but before its mode query.
// Preserve the other captures instead of failing discovery for every display.
fn collect_available_monitors(
    monitors: impl Iterator<Item = XCapResult<Monitor>>,
) -> XCapResult<Vec<Monitor>> {
    let available: Vec<_> = monitors
        .filter_map(|monitor| match monitor {
            Ok(monitor) => Some(monitor),
            Err(error) => {
                warn!("Skipping unavailable display: {error}");
                None
            }
        })
        .collect();
    if available.is_empty() {
        Err(XCapError::no_monitors())
    } else {
        Ok(available)
    }
}

// CGDisplayPixelsWide can return point-sized dimensions on HiDPI virtual
// displays, so read the display mode's explicit backing-pixel dimensions.
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGDisplayCopyDisplayMode(display: u32) -> *const std::ffi::c_void;
    fn CGDisplayModeGetWidth(mode: *const std::ffi::c_void) -> usize;
    fn CGDisplayModeGetHeight(mode: *const std::ffi::c_void) -> usize;
    fn CGDisplayModeGetPixelWidth(mode: *const std::ffi::c_void) -> usize;
    fn CGDisplayModeGetPixelHeight(mode: *const std::ffi::c_void) -> usize;
    fn CGDisplayModeRelease(mode: *const std::ffi::c_void);
}

fn native_capture_size(display: u32, logical: (u32, u32)) -> XCapResult<(u32, u32, f64)> {
    // SAFETY: Copy returns an owned mode or null. All getters use that live
    // object, and it is released exactly once before validation can fail.
    let mode = unsafe {
        let mode = CGDisplayCopyDisplayMode(display);
        if mode.is_null() {
            return Err(XCapError::new(format!(
                "Display {display} has no current mode"
            )));
        }
        let dimensions = (
            CGDisplayModeGetWidth(mode),
            CGDisplayModeGetHeight(mode),
            CGDisplayModeGetPixelWidth(mode),
            CGDisplayModeGetPixelHeight(mode),
        );
        CGDisplayModeRelease(mode);
        dimensions
    };
    capture_size(logical, mode)
}

fn capture_size(
    logical: (u32, u32),
    mode: (usize, usize, usize, usize),
) -> XCapResult<(u32, u32, f64)> {
    let (mw, mh, pw, ph) = mode;
    if logical.0 == 0 || logical.1 == 0 || mw == 0 || mh == 0 || pw == 0 || ph == 0 {
        return Err(XCapError::new(
            "Display has empty logical or backing dimensions",
        ));
    }
    let scale = pw as f64 / mw as f64;
    let vertical_scale = ph as f64 / mh as f64;
    if (scale - vertical_scale).abs() > 0.001 {
        return Err(XCapError::new(
            "Display mode has inconsistent backing scales",
        ));
    }
    let width = (logical.0 as f64 * scale).round();
    let height = (logical.1 as f64 * scale).round();
    if width < 1.0 || height < 1.0 || width > u32::MAX as f64 || height > u32::MAX as f64 {
        return Err(XCapError::new(
            "Display backing dimensions are out of range",
        ));
    }
    Ok((width as u32, height as u32, scale))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backing_size_preserves_points_and_rotation() {
        for (logical, mode, expected) in [
            ((1280, 720), (1280, 720, 1280, 720), (1280, 720, 1.0)),
            ((1280, 720), (1280, 720, 2560, 1440), (2560, 1440, 2.0)),
            ((720, 1280), (1280, 720, 2560, 1440), (1440, 2560, 2.0)),
            ((1920, 1080), (1920, 1080, 2880, 1620), (2880, 1620, 1.5)),
            ((3008, 1692), (3008, 1692, 6016, 3384), (6016, 3384, 2.0)),
        ] {
            assert_eq!(capture_size(logical, mode).unwrap(), expected);
        }
    }

    #[test]
    fn invalid_backing_size_is_not_silently_truncated() {
        for (logical, mode) in [
            ((0, 720), (1280, 720, 2560, 1440)),
            ((1280, 720), (0, 720, 2560, 1440)),
            ((1280, 720), (1280, 720, 0, 1440)),
            ((1280, 720), (1280, 720, 2560, 720)),
            ((u32::MAX, 720), (1280, 720, 2560, 1440)),
        ] {
            assert!(capture_size(logical, mode).is_err());
        }
    }

    fn sample_monitor() -> Monitor {
        Monitor {
            display_id: 1,
            name: "Test Display".to_string(),
            x: 0,
            y: 0,
            width: 3840,
            height: 2160,
            logical_width: 1920,
            logical_height: 1080,
            scale_factor: 2.0,
            is_primary: true,
        }
    }

    #[test]
    fn unavailable_display_does_not_remove_healthy_captures() {
        let monitors = collect_available_monitors(
            [
                Err(XCapError::new("display disappeared during enumeration")),
                Ok(sample_monitor()),
            ]
            .into_iter(),
        )
        .unwrap();
        assert_eq!(monitors.len(), 1);
        assert_eq!(monitors[0].id(), 1);
        assert!(collect_available_monitors([Err(XCapError::no_monitors())].into_iter()).is_err());
    }

    #[test]
    fn test_monitor_getters() {
        let monitor = sample_monitor();
        assert_eq!(monitor.id(), 1);
        assert_eq!(monitor.name(), "Test Display");
        assert_eq!(monitor.x(), 0);
        assert_eq!(monitor.y(), 0);
        assert_eq!(monitor.width().unwrap(), 3840);
        assert_eq!(monitor.height().unwrap(), 2160);
        assert_eq!(monitor.raw_width(), 3840);
        assert_eq!(monitor.raw_height(), 2160);
        assert_eq!(monitor.logical_width(), 1920);
        assert_eq!(monitor.logical_height(), 1080);
        assert_eq!(monitor.scale_factor(), 2.0);
        assert!(monitor.is_primary());
    }

    #[test]
    fn test_monitor_all() {
        let _sck_guard = crate::capture::lock_sck_globals();
        let result = Monitor::all();
        let _ = result;
    }

    #[tokio::test]
    async fn test_monitor_all_async() {
        let result = Monitor::all_async().await;
        let _ = result;
    }
}
