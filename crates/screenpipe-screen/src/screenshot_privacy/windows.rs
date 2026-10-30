// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use crate::{
    capture_screenshot_by_window::{ExclusionSources, WindowFilters},
    monitor::{MonitorData, SafeMonitor},
    wgc_capture::PersistentCapture,
};
use anyhow::{anyhow, bail, Context, Result};
use image::{imageops, DynamicImage, Rgba, RgbaImage};
use once_cell::sync::Lazy;
use screenpipe_a11y::incognito::create_detector;
use std::{sync::Arc, time::Duration};
use tokio::sync::Semaphore;
use xcap::Window;

#[derive(Debug, Clone, PartialEq, Eq)]
struct WindowMetadata {
    id: u32,
    pid: u32,
    app_name: String,
    title: String,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

fn metadata(window: &Window) -> Result<WindowMetadata> {
    let value = WindowMetadata {
        id: window.id().context("window id")?,
        pid: window.pid().context("window pid")?,
        app_name: window.app_name().context("window app name")?,
        title: window.title().context("window title")?,
        x: window.x().context("window x")?,
        y: window.y().context("window y")?,
        width: window.width().context("window width")?,
        height: window.height().context("window height")?,
    };
    if value.pid == 0 || value.app_name.trim().is_empty() || value.title.trim().is_empty() {
        bail!("window {} has incomplete privacy metadata", value.id);
    }
    if value.width == 0 || value.height == 0 || value.width > 16384 || value.height > 16384 {
        bail!("window {} has invalid dimensions", value.id);
    }
    Ok(value)
}

fn overlaps_monitor(window: &WindowMetadata, monitor: &MonitorData) -> bool {
    let right = i64::from(window.x) + i64::from(window.width);
    let bottom = i64::from(window.y) + i64::from(window.height);
    let monitor_right = i64::from(monitor.x) + i64::from(monitor.width);
    let monitor_bottom = i64::from(monitor.y) + i64::from(monitor.height);
    i64::from(window.x) < monitor_right
        && right > i64::from(monitor.x)
        && i64::from(window.y) < monitor_bottom
        && bottom > i64::from(monitor.y)
}

fn capture_filtered_sync(
    monitor: &MonitorData,
    filters: &WindowFilters,
    sources: ExclusionSources,
) -> Result<DynamicImage> {
    let mut windows = Window::all().context("enumerate visible windows")?;
    let detector = sources
        .ignore_incognito_windows
        .then(|| create_detector(sources.enhanced_incognito_detection));
    let mut output = RgbaImage::from_pixel(monitor.width, monitor.height, Rgba([0, 0, 0, 255]));

    // xcap enumerates top-to-bottom. Paint bottom-to-top so allowed overlap is faithful.
    windows.reverse();
    let mut captured = 0;
    for window in windows {
        // Unknown windows are never selected. An error on an already selected
        // window below invalidates the entire frame.
        if !matches!(window.is_minimized(), Ok(false)) {
            continue;
        }
        let Ok(before) = metadata(&window) else {
            continue;
        };
        if !overlaps_monitor(&before, monitor) {
            continue;
        }
        let allowed = super::window_allowed(
            filters,
            detector.as_deref(),
            &before.app_name,
            &before.title,
            before.pid as i32,
        );
        if !allowed {
            continue;
        }

        // Use Screenpipe's native window capture on every architecture. This
        // never falls back to monitor pixels and supports software D3D devices.
        let capture = PersistentCapture::new_window(before.id)?;
        // The session was just created for this capture. Its primed first frame
        // is fresh even if it arrived before this read, and static windows need
        // not produce a second compositor update to become capturable.
        let image = capture
            .get_latest_image_streaming(Duration::from_secs(2))?
            .into_rgba8();
        drop(capture);
        if image.width() != before.width || image.height() != before.height {
            bail!("window {} capture dimensions changed", before.id);
        }
        // Preserve WGC alpha while compositing onto an opaque black canvas;
        // transparent pixels must not expose their unused RGB storage.
        let after = metadata(&window)?;
        if after != before || window.is_minimized()? {
            bail!("window {} changed during privacy capture", before.id);
        }
        imageops::overlay(
            &mut output,
            &image,
            i64::from(before.x) - i64::from(monitor.x),
            i64::from(before.y) - i64::from(monitor.y),
        );
        captured += 1;
    }
    if captured == 0 {
        bail!("no verified allowed windows on monitor");
    }
    Ok(DynamicImage::ImageRgba8(output))
}

// A timed-out native call retains its permit so it cannot accumulate workers.
static CAPTURE_SLOT: Lazy<Arc<Semaphore>> = Lazy::new(|| Arc::new(Semaphore::new(1)));

pub(crate) async fn capture_filtered(
    monitor: &SafeMonitor,
    filters: &WindowFilters,
    sources: ExclusionSources,
    _fresh: bool,
) -> Result<DynamicImage> {
    let permit = tokio::time::timeout(Duration::from_secs(1), CAPTURE_SLOT.clone().acquire_owned())
        .await
        .map_err(|_| anyhow!("window-filtered capture is still busy"))??;
    let monitor = monitor.get_info();
    let filters = filters.clone();
    let work = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        capture_filtered_sync(&monitor, &filters, sources)
    });
    tokio::time::timeout(Duration::from_secs(5), work)
        .await
        .map_err(|_| anyhow!("window-filtered capture timed out"))?
        .context("Windows privacy capture worker failed")?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlap_math_rejects_adjacent_windows() {
        let window = WindowMetadata {
            id: 1,
            pid: 1,
            app_name: "test".into(),
            title: "test".into(),
            x: 100,
            y: 0,
            width: 10,
            height: 10,
        };
        let monitor = MonitorData {
            name: "test".into(),
            width: 100,
            height: 100,
            x: 0,
            y: 0,
            is_primary: true,
        };
        assert!(!overlaps_monitor(&window, &monitor));
    }
}
