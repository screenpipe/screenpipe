// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use crate::{
    capture_screenshot_by_window::{ExclusionSources, WindowFilters},
    monitor::{MonitorData, SafeMonitor},
};
use anyhow::{anyhow, bail, Context, Result};
use image::{imageops, DynamicImage, Rgba, RgbaImage};
use once_cell::sync::Lazy;
use screenpipe_a11y::incognito::create_detector;
#[cfg(target_arch = "aarch64")]
use std::{ffi::c_void, mem};
use std::{sync::Arc, time::Duration};
use tokio::sync::Semaphore;
use xcap::Window;

#[cfg(target_arch = "aarch64")]
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct BitmapInfoHeader {
    size: u32,
    width: i32,
    height: i32,
    planes: u16,
    bit_count: u16,
    compression: u32,
    size_image: u32,
    x_pixels_per_meter: i32,
    y_pixels_per_meter: i32,
    colors_used: u32,
    colors_important: u32,
}

#[cfg(target_arch = "aarch64")]
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct RgbQuad {
    blue: u8,
    green: u8,
    red: u8,
    reserved: u8,
}

#[cfg(target_arch = "aarch64")]
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct BitmapInfo {
    header: BitmapInfoHeader,
    colors: [RgbQuad; 1],
}

#[cfg(target_arch = "aarch64")]
#[link(name = "user32")]
extern "system" {
    fn GetWindowDC(hwnd: isize) -> isize;
    fn ReleaseDC(hwnd: isize, dc: isize) -> i32;
    fn PrintWindow(hwnd: isize, dc: isize, flags: u32) -> i32;
}

#[cfg(target_arch = "aarch64")]
#[link(name = "gdi32")]
extern "system" {
    fn CreateCompatibleDC(dc: isize) -> isize;
    fn CreateCompatibleBitmap(dc: isize, width: i32, height: i32) -> isize;
    fn SelectObject(dc: isize, object: isize) -> isize;
    fn DeleteObject(object: isize) -> i32;
    fn DeleteDC(dc: isize) -> i32;
    fn PatBlt(dc: isize, x: i32, y: i32, width: i32, height: i32, operation: u32) -> i32;
    fn GetDIBits(
        dc: isize,
        bitmap: isize,
        start: u32,
        lines: u32,
        bits: *mut c_void,
        info: *mut BitmapInfo,
        usage: u32,
    ) -> i32;
}

#[cfg(target_arch = "aarch64")]
const PW_RENDERFULLCONTENT: u32 = 2;
#[cfg(target_arch = "aarch64")]
const DIB_RGB_COLORS: u32 = 0;

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

#[cfg(target_arch = "aarch64")]
fn capture_with_print_window(window: &WindowMetadata) -> Result<RgbaImage> {
    let width = i32::try_from(window.width).context("window width exceeds Win32 range")?;
    let height = i32::try_from(window.height).context("window height exceeds Win32 range")?;
    let hwnd = window.id as isize;

    unsafe {
        let window_dc = GetWindowDC(hwnd);
        if window_dc == 0 {
            bail!("GetWindowDC failed for window {}", window.id);
        }
        let memory_dc = CreateCompatibleDC(window_dc);
        if memory_dc == 0 {
            let _ = ReleaseDC(hwnd, window_dc);
            bail!("CreateCompatibleDC failed for window {}", window.id);
        }
        let bitmap = CreateCompatibleBitmap(window_dc, width, height);
        if bitmap == 0 {
            let _ = DeleteDC(memory_dc);
            let _ = ReleaseDC(hwnd, window_dc);
            bail!("CreateCompatibleBitmap failed for window {}", window.id);
        }
        let previous = SelectObject(memory_dc, bitmap);
        if previous == 0 || previous == -1 {
            let _ = DeleteObject(bitmap);
            let _ = DeleteDC(memory_dc);
            let _ = ReleaseDC(hwnd, window_dc);
            bail!("SelectObject failed for window {}", window.id);
        }

        // Deliberately no BitBlt fallback: it could copy overlapping excluded pixels.
        // A compatible bitmap starts uninitialized. Clear it before asking the
        // target to draw, because a successful partial paint must stay opaque.
        const BLACKNESS: u32 = 0x00000042;
        let printed = PatBlt(memory_dc, 0, 0, width, height, BLACKNESS) != 0
            && PrintWindow(hwnd, memory_dc, PW_RENDERFULLCONTENT) != 0;
        // GetDIBits requires the bitmap not to be selected into a DC.
        let deselected = SelectObject(memory_dc, previous);
        let deselected = deselected != 0 && deselected != -1;
        let byte_len = usize::try_from(window.width)
            .ok()
            .and_then(|w| {
                usize::try_from(window.height)
                    .ok()
                    .and_then(|h| w.checked_mul(h))
            })
            .and_then(|pixels| pixels.checked_mul(4))
            .ok_or_else(|| anyhow!("window {} image dimensions overflow", window.id));
        let mut pixels = byte_len.map(|len| vec![0u8; len]);
        if let Ok(buffer) = &mut pixels {
            let mut info = BitmapInfo {
                header: BitmapInfoHeader {
                    size: mem::size_of::<BitmapInfoHeader>() as u32,
                    width,
                    height: -height,
                    planes: 1,
                    bit_count: 32,
                    size_image: buffer.len() as u32,
                    ..Default::default()
                },
                ..Default::default()
            };
            if !printed
                || !deselected
                || GetDIBits(
                    memory_dc,
                    bitmap,
                    0,
                    height as u32,
                    buffer.as_mut_ptr().cast(),
                    &mut info,
                    DIB_RGB_COLORS,
                ) != height
            {
                pixels = Err(anyhow!("PrintWindow failed for window {}", window.id));
            } else {
                for bgra in buffer.chunks_exact_mut(4) {
                    bgra.swap(0, 2);
                    bgra[3] = 255;
                }
            }
        }

        let _ = DeleteDC(memory_dc);
        let _ = DeleteObject(bitmap);
        let _ = ReleaseDC(hwnd, window_dc);

        let pixels = pixels?;
        RgbaImage::from_raw(window.width, window.height, pixels)
            .ok_or_else(|| anyhow!("invalid PrintWindow image for window {}", window.id))
    }
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

        // xcap's wgc feature is enabled on x86_64 and uses CreateForWindow,
        // never monitor pixels. ARM64's xcap fallback can use BitBlt, so bypass
        // it with a PrintWindow-only path and withhold on failure.
        #[cfg(not(target_arch = "aarch64"))]
        let image = window
            .capture_image()
            .context("isolated WGC window capture")?;
        #[cfg(target_arch = "aarch64")]
        let image = capture_with_print_window(&before)?;
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
