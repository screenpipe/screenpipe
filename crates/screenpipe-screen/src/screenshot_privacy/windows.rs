// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use crate::{
    capture_screenshot_by_window::{ExclusionSources, WindowFilters},
    monitor::{MonitorData, SafeMonitor},
    wgc_capture::PersistentCapture,
};
use anyhow::{anyhow, bail, Context, Result};
use image::{DynamicImage, Rgba, RgbaImage};
use once_cell::sync::Lazy;
use screenpipe_a11y::incognito::create_detector;
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::sync::Semaphore;
use windows::Win32::{
    Foundation::{GetLastError, SetLastError, BOOL, COLORREF, ERROR_SUCCESS, HWND, LPARAM, RECT},
    Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS},
    UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetLayeredWindowAttributes, GetShellWindow, GetWindowLongW,
        GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindowVisible,
        GWL_EXSTYLE, LAYERED_WINDOW_ATTRIBUTES_FLAGS, LWA_ALPHA, LWA_COLORKEY, WS_EX_LAYERED,
    },
};
use xcap::Window;

#[derive(Debug, Clone, PartialEq, Eq)]
struct PolicyMetadata {
    pid: u32,
    app_name: String,
    title: String,
}
#[derive(Debug, Clone, PartialEq, Eq)]
enum SurfacePolicy {
    Allowed,
    Blocked,
    Unknown,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SurfaceOpacity {
    Ordinary,
    PerPixel,
    Constant {
        alpha: u8,
        color_key: Option<[u8; 3]>,
    },
}

impl SurfaceOpacity {
    fn alpha(self) -> u8 {
        match self {
            Self::Constant { alpha, .. } => alpha,
            _ => 255,
        }
    }

    fn color_key(self) -> Option<[u8; 3]> {
        match self {
            Self::Constant { color_key, .. } => color_key,
            _ => None,
        }
    }
}

fn surface_opacity(hwnd: HWND) -> Result<SurfaceOpacity> {
    unsafe { SetLastError(ERROR_SUCCESS) };
    let style = unsafe { GetWindowLongW(hwnd, GWL_EXSTYLE) } as u32;
    if style == 0 && unsafe { GetLastError() } != ERROR_SUCCESS {
        bail!("unable to read native window style");
    }
    if style & WS_EX_LAYERED.0 == 0 {
        return Ok(SurfaceOpacity::Ordinary);
    }
    let mut alpha = 255;
    let mut key = COLORREF(0);
    let mut flags = LAYERED_WINDOW_ATTRIBUTES_FLAGS(0);
    if unsafe {
        GetLayeredWindowAttributes(hwnd, Some(&mut key), Some(&mut alpha), Some(&mut flags))
    }
    .is_err()
    {
        return Ok(SurfaceOpacity::PerPixel);
    }
    let color_key = (flags.0 & LWA_COLORKEY.0 != 0).then_some([
        key.0 as u8,
        (key.0 >> 8) as u8,
        (key.0 >> 16) as u8,
    ]);
    Ok(SurfaceOpacity::Constant {
        alpha: if flags.0 & LWA_ALPHA.0 != 0 {
            alpha
        } else {
            255
        },
        color_key,
    })
}
#[derive(Debug, Clone, PartialEq, Eq)]
struct NativeWindow {
    id: u32,
    pid: u32,
    class_name: String,
    title: String,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    policy: SurfacePolicy,
    opacity: SurfaceOpacity,
}

fn wide_text(mut read: impl FnMut(&mut [u16]) -> i32, capacity: usize) -> Result<String> {
    let mut buffer = vec![0; capacity.max(1)];
    unsafe { SetLastError(ERROR_SUCCESS) };
    let length = read(&mut buffer);
    if length == 0 && unsafe { GetLastError() } != ERROR_SUCCESS {
        bail!("native window text read failed");
    }
    Ok(String::from_utf16_lossy(
        &buffer[..(length.max(0) as usize).min(buffer.len())],
    ))
}

unsafe extern "system" fn enum_window(hwnd: HWND, lparam: LPARAM) -> BOOL {
    unsafe { (&mut *(lparam.0 as *mut Vec<HWND>)).push(hwnd) };
    true.into()
}

fn enumerate_hwnds() -> Result<Vec<HWND>> {
    let mut ids = Vec::new();
    unsafe {
        EnumWindows(
            Some(enum_window),
            LPARAM(&mut ids as *mut Vec<HWND> as isize),
        )
    }
    .ok()
    .context("EnumWindows")?;
    Ok(ids)
}

fn policy_metadata() -> Result<HashMap<u32, PolicyMetadata>> {
    let mut result = HashMap::new();
    for window in Window::all().context("enumerate policy windows")? {
        let Ok(id) = window.id() else { continue };
        let value = (|| {
            Ok::<_, anyhow::Error>(PolicyMetadata {
                pid: window.pid().context("window pid")?,
                app_name: window.app_name().context("window app name")?,
                title: window.title().context("window title")?,
            })
        })();
        if let Ok(value) = value {
            if value.pid != 0 && !value.app_name.trim().is_empty() {
                result.insert(id, value);
            }
        }
    }
    Ok(result)
}

fn overlaps_monitor(window: &NativeWindow, monitor: &MonitorData) -> bool {
    let right = i64::from(window.x) + i64::from(window.width);
    let bottom = i64::from(window.y) + i64::from(window.height);
    let monitor_right = i64::from(monitor.x) + i64::from(monitor.width);
    let monitor_bottom = i64::from(monitor.y) + i64::from(monitor.height);
    i64::from(window.x) < monitor_right
        && right > i64::from(monitor.x)
        && i64::from(window.y) < monitor_bottom
        && bottom > i64::from(monitor.y)
}

fn snapshot(
    monitor: &MonitorData,
    filters: &WindowFilters,
    sources: ExclusionSources,
) -> Result<Vec<NativeWindow>> {
    let metadata = policy_metadata()?;
    let detector = sources
        .ignore_incognito_windows
        .then(|| create_detector(sources.enhanced_incognito_detection));
    let shell = unsafe { GetShellWindow() };
    let mut shell_pid = 0;
    unsafe { GetWindowThreadProcessId(shell, Some(&mut shell_pid)) };
    let mut result = Vec::new();
    // EnumWindows is top-to-bottom. Snapshot order is security-relevant.
    for hwnd in enumerate_hwnds()? {
        if !unsafe { IsWindowVisible(hwnd) }.as_bool() || unsafe { IsIconic(hwnd) }.as_bool() {
            continue;
        }
        let mut cloaked = 0u32;
        unsafe {
            DwmGetWindowAttribute(
                hwnd,
                DWMWA_CLOAKED,
                &mut cloaked as *mut u32 as *mut _,
                std::mem::size_of::<u32>() as u32,
            )
        }
        .context("DwmGetWindowAttribute(DWMWA_CLOAKED)")?;
        if cloaked != 0 {
            continue;
        }
        let mut rect = RECT::default();
        if unsafe {
            DwmGetWindowAttribute(
                hwnd,
                DWMWA_EXTENDED_FRAME_BOUNDS,
                &mut rect as *mut RECT as *mut _,
                std::mem::size_of::<RECT>() as u32,
            )
        }
        .is_err()
        {
            // An uncertain visible surface must never be reconstructed from guessed
            // geometry. Withhold the complete frame instead.
            bail!(
                "unable to resolve DWM frame bounds for window {}",
                hwnd.0 as usize
            );
        }
        let width = rect.right.saturating_sub(rect.left) as u32;
        let height = rect.bottom.saturating_sub(rect.top) as u32;
        if width == 0 || height == 0 {
            continue;
        }
        if !overlaps_monitor(
            &NativeWindow {
                id: 0,
                pid: 0,
                class_name: String::new(),
                title: String::new(),
                x: rect.left,
                y: rect.top,
                width,
                height,
                policy: SurfacePolicy::Unknown,
                opacity: SurfaceOpacity::Ordinary,
            },
            monitor,
        ) {
            continue;
        }
        if width > 32768 || height > 32768 {
            bail!("oversized visible window intersects monitor");
        }
        let mut pid = 0;
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
        let class_name = wide_text(|buffer| unsafe { GetClassNameW(hwnd, buffer) }, 256)?;
        if class_name.is_empty() {
            bail!("native window class is unavailable");
        }
        unsafe { SetLastError(ERROR_SUCCESS) };
        let title_length = unsafe { GetWindowTextLengthW(hwnd) };
        if title_length == 0 && unsafe { GetLastError() } != ERROR_SUCCESS {
            bail!("native window title length is unavailable");
        }
        let title_capacity = title_length.max(0) as usize + 1;
        let title = wide_text(
            |buffer| unsafe { GetWindowTextW(hwnd, buffer) },
            title_capacity,
        )?;
        let opacity = surface_opacity(hwnd)?;
        let id = hwnd.0 as usize as u32;
        // Shell-owned switchers and previews can contain live pixels copied from a
        // different source window. Their own PID/title is not authoritative for a
        // tile, so never trust them as ordinary Explorer/XAML surfaces.
        let unverified_preview = matches!(
            class_name.as_str(),
            "TaskListThumbnailWnd"
                | "MultitaskingViewFrame"
                | "XamlExplorerHostIslandWindow"
                | "ForegroundStaging"
                | "Shell_DimLayer"
        ) || class_name.contains("Thumbnail");
        let desktop_surface =
            pid != 0 && pid == shell_pid && matches!(class_name.as_str(), "Progman" | "WorkerW");
        let (policy, geometry) = if unverified_preview {
            (SurfacePolicy::Blocked, (rect.left, rect.top, width, height))
        } else if desktop_surface {
            let allowed = super::window_allowed(
                filters,
                detector.as_deref(),
                "Windows Explorer",
                if title.is_empty() {
                    "Program Manager"
                } else {
                    &title
                },
                pid as i32,
            );
            (
                if allowed {
                    SurfacePolicy::Allowed
                } else {
                    SurfacePolicy::Blocked
                },
                (rect.left, rect.top, width, height),
            )
        } else if let Some(meta) = metadata
            .get(&id)
            .filter(|meta| meta.pid == pid && meta.title == title)
        {
            if super::window_allowed(
                filters,
                detector.as_deref(),
                &meta.app_name,
                &meta.title,
                meta.pid as i32,
            ) {
                (SurfacePolicy::Allowed, (rect.left, rect.top, width, height))
            } else {
                // Redact the conservative native region for blocked surfaces.
                (SurfacePolicy::Blocked, (rect.left, rect.top, width, height))
            }
        } else {
            (SurfacePolicy::Unknown, (rect.left, rect.top, width, height))
        };
        let window = NativeWindow {
            id,
            pid,
            class_name,
            title,
            x: geometry.0,
            y: geometry.1,
            width: geometry.2,
            height: geometry.3,
            policy,
            opacity,
        };
        if overlaps_monitor(&window, monitor) {
            result.push(window);
        }
    }
    Ok(result)
}

fn paint_black(output: &mut RgbaImage, window: &NativeWindow, monitor: &MonitorData) {
    let left = (i64::from(window.x) - i64::from(monitor.x)).max(0) as u32;
    let top = (i64::from(window.y) - i64::from(monitor.y)).max(0) as u32;
    let right = (i64::from(window.x) + i64::from(window.width) - i64::from(monitor.x))
        .clamp(0, i64::from(monitor.width)) as u32;
    let bottom = (i64::from(window.y) + i64::from(window.height) - i64::from(monitor.y))
        .clamp(0, i64::from(monitor.height)) as u32;
    for row in output
        .rows_mut()
        .skip(top as usize)
        .take(bottom.saturating_sub(top) as usize)
    {
        for pixel in row
            .skip(left as usize)
            .take(right.saturating_sub(left) as usize)
        {
            *pixel = Rgba([0, 0, 0, 255]);
        }
    }
}

/// WGC B8G8R8A8 surfaces are premultiplied. `imageops::overlay` expects straight
/// alpha and would multiply RGB a second time, darkening translucent windows.
fn overlay_wgc_premultiplied(
    output: &mut RgbaImage,
    foreground: &RgbaImage,
    x: i64,
    y: i64,
    opacity: SurfaceOpacity,
) {
    for (sx, sy, source) in foreground.enumerate_pixels() {
        let dx = x + i64::from(sx);
        let dy = y + i64::from(sy);
        if dx < 0 || dy < 0 || dx >= i64::from(output.width()) || dy >= i64::from(output.height()) {
            continue;
        }
        if opacity.color_key().is_some_and(|key| source.0[..3] == key) {
            continue;
        }
        let global_alpha = u32::from(opacity.alpha());
        let alpha = (u32::from(source[3]) * global_alpha + 127) / 255;
        if alpha == 0 {
            continue;
        }
        let background = output.get_pixel_mut(dx as u32, dy as u32);
        let inverse = 255 - alpha;
        for channel in 0..3 {
            background[channel] = ((u32::from(source[channel]) * global_alpha + 127) / 255
                + (u32::from(background[channel]) * inverse + 127) / 255)
                .min(255) as u8;
        }
        background[3] = 255;
    }
}

fn capture_filtered_sync(
    monitor: &MonitorData,
    filters: &WindowFilters,
    sources: ExclusionSources,
) -> Result<DynamicImage> {
    let before = snapshot(monitor, filters, sources)?;
    let mut output = RgbaImage::from_pixel(monitor.width, monitor.height, Rgba([0, 0, 0, 255]));
    for window in before.iter().rev() {
        match window.policy {
            SurfacePolicy::Blocked | SurfacePolicy::Unknown => {
                paint_black(&mut output, window, monitor)
            }
            SurfacePolicy::Allowed => {
                let capture = PersistentCapture::new_privacy_window(window.id, window.pid)?;
                let image = capture
                    .get_latest_image_streaming(Duration::from_secs(2))?
                    .into_rgba8();
                drop(capture);
                if (image.width(), image.height()) != (window.width, window.height) {
                    bail!(
                        "window {} ({}) capture geometry {}x{} != native {}x{}",
                        window.id,
                        window.class_name,
                        image.width(),
                        image.height(),
                        window.width,
                        window.height
                    );
                }
                // Blend alpha only onto pixels already proven safe; unused RGB cannot leak.
                overlay_wgc_premultiplied(
                    &mut output,
                    &image,
                    i64::from(window.x) - i64::from(monitor.x),
                    i64::from(window.y) - i64::from(monitor.y),
                    window.opacity,
                );
            }
        }
    }
    if snapshot(monitor, filters, sources)? != before {
        bail!("window scene changed during privacy capture");
    }
    Ok(DynamicImage::ImageRgba8(output))
}

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
        let window = NativeWindow {
            id: 1,
            pid: 1,
            class_name: "test".into(),
            title: "test".into(),
            x: 100,
            y: 0,
            width: 10,
            height: 10,
            policy: SurfacePolicy::Allowed,
            opacity: SurfaceOpacity::Ordinary,
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

    #[test]
    fn premultiplied_alpha_is_not_multiplied_twice() {
        let mut output = RgbaImage::from_pixel(1, 1, Rgba([0, 0, 0, 255]));
        let foreground = RgbaImage::from_pixel(1, 1, Rgba([100, 50, 25, 128]));
        overlay_wgc_premultiplied(&mut output, &foreground, 0, 0, SurfaceOpacity::Ordinary);
        assert_eq!(output.get_pixel(0, 0), &Rgba([100, 50, 25, 255]));
    }

    #[test]
    fn alpha_zero_ignores_rgb_payload() {
        let mut output = RgbaImage::from_pixel(1, 1, Rgba([7, 8, 9, 255]));
        let foreground = RgbaImage::from_pixel(1, 1, Rgba([255, 1, 200, 0]));
        overlay_wgc_premultiplied(&mut output, &foreground, 0, 0, SurfaceOpacity::Ordinary);
        assert_eq!(output.get_pixel(0, 0), &Rgba([7, 8, 9, 255]));
    }

    #[test]
    fn global_opacity_preserves_half_cyan_over_black() {
        let mut output = RgbaImage::from_pixel(1, 1, Rgba([0, 0, 0, 255]));
        let foreground = RgbaImage::from_pixel(1, 1, Rgba([0, 255, 255, 255]));
        overlay_wgc_premultiplied(
            &mut output,
            &foreground,
            0,
            0,
            SurfaceOpacity::Constant {
                alpha: 128,
                color_key: None,
            },
        );
        assert_eq!(output.get_pixel(0, 0), &Rgba([0, 128, 128, 255]));
    }

    #[test]
    fn global_opacity_scales_premultiplied_rgb_once() {
        let mut output = RgbaImage::from_pixel(1, 1, Rgba([0, 0, 0, 255]));
        let foreground = RgbaImage::from_pixel(1, 1, Rgba([100, 50, 25, 128]));
        overlay_wgc_premultiplied(
            &mut output,
            &foreground,
            0,
            0,
            SurfaceOpacity::Constant {
                alpha: 128,
                color_key: None,
            },
        );
        assert_eq!(output.get_pixel(0, 0), &Rgba([50, 25, 13, 255]));
    }

    #[test]
    #[ignore = "requires a live unlocked Windows console"]
    fn filtered_capture_keeps_full_monitor_dimensions() {
        let monitor = xcap::Monitor::all()
            .expect("enumerate monitors")
            .into_iter()
            .next()
            .expect("monitor");
        let info = MonitorData {
            name: monitor.name().expect("monitor name"),
            width: monitor.width().expect("monitor width"),
            height: monitor.height().expect("monitor height"),
            x: monitor.x().expect("monitor x"),
            y: monitor.y().expect("monitor y"),
            is_primary: monitor.is_primary().expect("monitor primary"),
        };
        let filters = WindowFilters::new(&["__screenpipe_no_match__".into()], &[], &[]);
        let image = capture_filtered_sync(&info, &filters, ExclusionSources::default())
            .expect("filtered capture");
        assert_eq!((image.width(), image.height()), (info.width, info.height));
    }
}
