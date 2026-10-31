// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use super::*;
use anyhow::{anyhow, ensure};
use cidre::{api, cv, ns, sc};
use once_cell::sync::Lazy;
use std::sync::Arc;
use tokio::sync::Semaphore;

// A native call may never return. Keep its permit in the worker, including
// after timeout, so a hung WindowServer cannot accumulate blocking workers.
static CAPTURE_SLOT: Lazy<Arc<Semaphore>> = Lazy::new(|| Arc::new(Semaphore::new(1)));
const DEADLINE: Duration = Duration::from_secs(5);

pub(crate) async fn capture_filtered(
    monitor: &SafeMonitor,
    filters: &WindowFilters,
    sources: ExclusionSources,
    _fresh: bool,
) -> anyhow::Result<DynamicImage> {
    ensure!(
        api::macos_available("14.0"),
        "window-filtered screenshots require macOS 14 or newer"
    );
    let permit = tokio::time::timeout(Duration::from_secs(1), CAPTURE_SLOT.clone().acquire_owned())
        .await
        .map_err(|_| anyhow!("window-filtered capture is still busy"))??;
    let id = monitor.id();
    let filters = filters.clone();
    let runtime = tokio::runtime::Handle::current();
    let work = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        cidre::objc::ar_pool(|| {
            runtime
                .block_on(capture(id, &filters, sources))
                .map_err(|e| e.to_string())
        })
        .map_err(anyhow::Error::msg)
    });
    tokio::time::timeout(DEADLINE, work)
        .await
        .map_err(|_| anyhow!("window-filtered capture timed out"))??
}

#[derive(Clone, Debug, PartialEq)]
struct Surface {
    id: u32,
    pid: i32,
    app: String,
    title: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    alpha: f64,
    layer: i64,
}

/// WindowServer order is authoritative; SCShareableContent does not promise
/// stacking order. Include desktop and shell surfaces, not just layer-zero apps.
fn snapshot(display: cidre::cg::Rect) -> anyhow::Result<Vec<Surface>> {
    window_list(
        display,
        core_graphics::window::kCGWindowListOptionOnScreenOnly,
    )
}

fn window_list(display: cidre::cg::Rect, options: u32) -> anyhow::Result<Vec<Surface>> {
    use core_foundation::{
        base::{CFType, TCFType},
        dictionary::CFDictionary,
        number::CFNumber,
        string::CFString,
    };
    use core_graphics::window::{copy_window_info, kCGNullWindowID};
    let list = copy_window_info(options, kCGNullWindowID)
        .ok_or_else(|| anyhow!("window scene unavailable"))?;
    let mut result = Vec::new();
    for ptr in list.iter() {
        let dict: CFDictionary<CFString, CFType> =
            unsafe { CFDictionary::wrap_under_get_rule(*ptr as _) };
        let number = |key: &str| -> Option<f64> {
            dict.find(CFString::new(key))?
                .downcast::<CFNumber>()?
                .to_f64()
        };
        let text = |key: &str| -> String {
            dict.find(CFString::new(key))
                .and_then(|v| v.downcast::<CFString>())
                .map(|s| s.to_string())
                .unwrap_or_default()
        };
        let bounds = dict
            .find(CFString::new("kCGWindowBounds"))
            .and_then(|v| v.downcast::<CFDictionary>())
            .map(|d| unsafe {
                CFDictionary::<CFString, CFType>::wrap_under_get_rule(d.as_concrete_TypeRef())
            })
            .ok_or_else(|| anyhow!("window geometry unavailable"))?;
        let bound = |key: &str| -> anyhow::Result<f64> {
            bounds
                .find(CFString::new(key))
                .and_then(|v| v.downcast::<CFNumber>())
                .and_then(|n| n.to_f64())
                .ok_or_else(|| anyhow!("invalid window geometry"))
        };
        let (x, y, width, height) = (bound("X")?, bound("Y")?, bound("Width")?, bound("Height")?);
        let alpha = number("kCGWindowAlpha").unwrap_or(1.0);
        let layer = number("kCGWindowLayer").unwrap_or(0.0) as i64;
        ensure!(
            [x, y, width, height, alpha].iter().all(|v| v.is_finite()),
            "non-finite window geometry"
        );
        if width <= 0.0 || height <= 0.0 || alpha <= 0.0 || layer == 2147483630 {
            continue;
        }
        if options != core_graphics::window::kCGWindowListOptionAll
            && (x + width <= display.origin.x
                || y + height <= display.origin.y
                || x >= display.origin.x + display.size.width
                || y >= display.origin.y + display.size.height)
        {
            continue;
        }
        result.push(Surface {
            id: number("kCGWindowNumber").ok_or_else(|| anyhow!("window id unavailable"))? as u32,
            pid: number("kCGWindowOwnerPID").unwrap_or(0.0) as i32,
            app: text("kCGWindowOwnerName"),
            title: text("kCGWindowName"),
            x,
            y,
            width,
            height,
            alpha,
            layer,
        });
    }
    result.reverse(); // bottom-to-top
    Ok(result)
}

/// Dock thumbnails can reproduce excluded windows. If native tile inspection
/// fails, omit Dock coverage instead of trusting its mirrored app pixels.
fn dock_masks(
    dock_pid: Option<i32>,
    display: cidre::cg::Rect,
    filters: &WindowFilters,
    detector: Option<&dyn screenpipe_a11y::incognito::IncognitoDetector>,
) -> Option<Vec<Surface>> {
    use cidre::{ax, cf};
    let Some(pid) = dock_pid else {
        return Some(Vec::new());
    };
    if !ax::is_process_trusted() {
        return None;
    }
    let app = ax::UiElement::with_app_pid(pid);
    app.set_messaging_timeout_secs(0.1).ok()?;
    let groups = app.children().ok()?;
    let windows = window_list(display, core_graphics::window::kCGWindowListOptionAll).ok()?;
    let text = |element: &ax::UiElement, attr: &ax::Attr| -> Option<String> {
        let value = element.attr_value(attr).ok()?;
        if value.get_type_id() != cf::String::type_id() {
            return None;
        }
        let value: &cf::String = unsafe { std::mem::transmute(&*value) };
        Some(value.to_string())
    };
    let mut masks = Vec::new();
    let mut seen = 0;
    for group in groups.iter() {
        group.set_messaging_timeout_secs(0.1).ok()?;
        let children = group.children().ok()?;
        for tile in children.iter() {
            seen += 1;
            if seen > 512 {
                return None;
            }
            tile.set_messaging_timeout_secs(0.1).ok()?;
            if text(tile, ax::attr::subrole()).as_deref() != Some("AXMinimizedWindowDockItem") {
                continue;
            }
            let title = text(tile, ax::attr::title())?;
            let matches: Vec<_> = windows.iter().filter(|w| w.title == title).collect();
            if !matches.is_empty()
                && matches
                    .iter()
                    .all(|w| window_allowed(filters, detector, &w.app, &w.title, w.pid))
            {
                continue;
            }
            let pos = tile.pos().ok()?.cg_point()?;
            let size = tile.size().ok()?.cg_size()?;
            if ![pos.x, pos.y, size.width, size.height]
                .iter()
                .all(|v| v.is_finite())
                || size.width <= 0.0
                || size.height <= 0.0
            {
                return None;
            }
            masks.push(Surface {
                id: 0,
                pid,
                app: "Dock".into(),
                title,
                x: pos.x,
                y: pos.y,
                width: size.width,
                height: size.height,
                alpha: 1.0,
                layer: 20,
            });
        }
    }
    Some(masks)
}

fn output_rect(
    surface: &Surface,
    display: cidre::cg::Rect,
    width: u32,
    height: u32,
) -> super::scene::Rect {
    let sx = f64::from(width) / display.size.width;
    let sy = f64::from(height) / display.size.height;
    let x = ((surface.x - display.origin.x) * sx).floor();
    let y = ((surface.y - display.origin.y) * sy).floor();
    super::scene::Rect {
        x: x as i64,
        y: y as i64,
        width: (((surface.x + surface.width - display.origin.x) * sx).ceil() - x).max(0.0) as u32,
        height: (((surface.y + surface.height - display.origin.y) * sy).ceil() - y).max(0.0) as u32,
    }
}

async fn take(
    filter: &sc::ContentFilter,
    width: usize,
    height: usize,
    window: bool,
) -> anyhow::Result<image::RgbaImage> {
    let mut cfg = sc::StreamCfg::new();
    cfg.set_width(width);
    cfg.set_height(height);
    cfg.set_pixel_format(cv::PixelFormat::_32_BGRA);
    cfg.set_shows_cursor(false);
    cfg.set_scales_to_fit(true);
    if window {
        cfg.set_ignore_shadows_single_window(true);
    }
    if api::macos_available("15.0") {
        cfg.set_show_mouse_clicks(false);
    }
    let sample = sc::ScreenshotManager::capture_sample_buf(filter, &cfg)
        .await
        .map_err(|e| anyhow!("window-filtered screenshot: {e:?}"))?;
    let mut pixels = sample
        .image_buf()
        .ok_or_else(|| anyhow!("missing screenshot pixels"))?
        .retained();
    Ok(rgba(&mut pixels)?.into_rgba8())
}

async fn capture(
    id: u32,
    filters: &WindowFilters,
    sources: ExclusionSources,
) -> anyhow::Result<DynamicImage> {
    use super::scene::{self, Rect};
    let detector = sources
        .ignore_incognito_windows
        .then(|| screenpipe_a11y::incognito::create_detector(sources.enhanced_incognito_detection));
    let content = sc::ShareableContent::current()
        .await
        .map_err(|e| anyhow!("window enumeration: {e:?}"))?;
    let displays = content.displays();
    let display = displays
        .iter()
        .find(|d| d.display_id().0 == id)
        .ok_or_else(|| anyhow!("filtered display disappeared"))?;
    let frame = display.frame();
    let before = snapshot(frame)?;
    let available = content.windows();
    let native = |surface: &Surface| {
        available.iter().find(|w| {
            w.id() == surface.id
                && w.is_on_screen()
                && w.owning_app()
                    .is_some_and(|a| a.process_id() == surface.pid)
        })
    };
    let dock_pid = before.iter().filter(|s| s.layer == 20).find_map(|s| {
        native(s)
            .filter(|w| {
                w.owning_app()
                    .is_some_and(|a| a.bundle_id().to_string() == "com.apple.dock")
            })
            .map(|_| s.pid)
    });
    let dock_before = dock_masks(dock_pid, frame, filters, detector.as_deref());
    let allowed: Vec<bool> = before
        .iter()
        .map(|s| {
            native(s).is_some()
                && !(Some(s.pid) == dock_pid && s.layer == 20 && dock_before.is_none())
                && window_allowed(filters, detector.as_deref(), &s.app, &s.title, s.pid)
        })
        .collect();
    let selected: Vec<_> = before
        .iter()
        .zip(&allowed)
        .filter_map(|(s, ok)| {
            if *ok {
                native(s).map(|w| w.retained())
            } else {
                None
            }
        })
        .collect();
    let windows = ns::Array::from_slice_retained(&selected);
    let mut filter = sc::ContentFilter::with_display_including_windows(display, &windows);
    // SCDisplay dimensions are logical points on Retina displays. Preserve the
    // native pixel density before applying the user's explicit resolution cap.
    let scale = filter.point_pixel_scale() as f64;
    ensure!(
        scale.is_finite() && scale > 0.0,
        "invalid display pixel scale"
    );
    let nw = (frame.size.width * scale).round() as usize;
    let nh = (frame.size.height * scale).round() as usize;
    ensure!(
        nw > 0 && nh > 0 && nw <= 16384 && nh <= 16384,
        "invalid display dimensions"
    );
    let cap = crate::monitor::sck_capture_max_width() as usize;
    let width = if cap == 0 { nw } else { nw.min(cap) };
    let height = (nh * width / nw).max(1);
    let mut canvas = if selected.is_empty() {
        image::RgbaImage::from_pixel(width as u32, height as u32, image::Rgba([0, 0, 0, 255]))
    } else {
        if api::macos_available("14.2") {
            filter.set_include_menu_bar(before.iter().zip(&allowed).any(|(s, ok)| {
                *ok && s.layer == 24 && s.app == "Window Server" && s.title == "Menubar"
            }));
        }
        let pixels = take(&filter, width, height, false).await?;
        let mut canvas =
            image::RgbaImage::from_pixel(width as u32, height as u32, image::Rgba([0, 0, 0, 255]));
        scene::overlay_premultiplied(&mut canvas, &pixels, 0, 0, None);
        canvas
    };
    let bounds = Rect {
        x: 0,
        y: 0,
        width: width as u32,
        height: height as u32,
    };
    let mut redacted = Vec::<Rect>::new();
    for (surface, ok) in before.iter().zip(&allowed) {
        let rect = output_rect(surface, frame, width as u32, height as u32);
        if !*ok {
            // The system Dock owns a display-sized transparent overlay. Its
            // rectangle is not its visible coverage. Use only native alpha as
            // a mask; none of this excluded surface's RGB enters the output.
            let dock = native(surface).filter(|w| {
                surface.layer == 20
                    && w.owning_app()
                        .is_some_and(|a| a.bundle_id().to_string() == "com.apple.dock")
            });
            if let Some(dock) = dock {
                let filter = sc::ContentFilter::with_desktop_independent_window(dock);
                let coverage =
                    take(&filter, rect.width as usize, rect.height as usize, true).await?;
                scene::paint_black_coverage(&mut canvas, &coverage, rect.x, rect.y);
            } else {
                scene::paint_black(&mut canvas, rect);
            }
            if let Some(clipped) = rect.intersection(bounds) {
                scene::add_region(&mut redacted, clipped);
            }
        } else if redacted.iter().any(|r| rect.intersects(*r)) {
            // Restore only the affected part of an allowed foreground surface.
            // Capturing its native pixels preserves translucent corners without
            // revealing excluded pixels or repainting unrelated foreground UI.
            let window = native(surface).ok_or_else(|| anyhow!("allowed window disappeared"))?;
            let filter = sc::ContentFilter::with_desktop_independent_window(window);
            let pixels = take(&filter, rect.width as usize, rect.height as usize, true).await?;
            for region in &redacted {
                scene::overlay_premultiplied(&mut canvas, &pixels, rect.x, rect.y, Some(*region));
            }
        }
    }
    if let Some(masks) = &dock_before {
        for mask in masks {
            scene::paint_black(
                &mut canvas,
                output_rect(mask, frame, width as u32, height as u32),
            );
        }
    }
    ensure!(
        dock_masks(dock_pid, frame, filters, detector.as_deref()) == dock_before,
        "Dock thumbnail policy changed during capture"
    );
    ensure!(
        snapshot(frame)? == before,
        "desktop scene changed during privacy capture"
    );
    let after = sc::ShareableContent::current()
        .await
        .map_err(|e| anyhow!("window revalidation: {e:?}"))?;
    let after_windows = after.windows();
    for (s, ok) in before.iter().zip(&allowed) {
        if *ok {
            ensure!(
                after_windows.iter().any(|w| w.id() == s.id
                    && w.is_on_screen()
                    && w.owning_app().is_some_and(|a| a.process_id() == s.pid)),
                "allowed window changed during capture"
            );
        }
    }
    Ok(DynamicImage::ImageRgba8(canvas))
}

fn rgba(buf: &mut cv::ImageBuf) -> anyhow::Result<DynamicImage> {
    let (w, h) = (buf.width(), buf.height());
    ensure!(
        w > 0 && h > 0 && w <= 16384 && h <= 16384,
        "invalid screenshot dimensions"
    );
    ensure!(
        buf.plane_count() == 0 && buf.pixel_format() == cv::PixelFormat::_32_BGRA,
        "unexpected screenshot format"
    );
    let flags = cv::pixel_buffer::LockFlags::READ_ONLY;
    unsafe { buf.lock_base_addr(flags) }
        .result()
        .map_err(|e| anyhow!("pixel lock: {e:?}"))?;
    // Keep every fallible operation inside this closure so the unlock runs on
    // all error paths. The sample owns the buffer throughout the copy.
    let result = (|| {
        let stride = buf.bytes_per_row();
        let len = stride
            .checked_mul(h)
            .ok_or_else(|| anyhow!("pixel size overflow"))?;
        let ptr = unsafe { buf.base_address() } as *const u8;
        ensure!(
            !ptr.is_null() && stride >= w * 4 && len <= buf.data_size(),
            "invalid screenshot storage"
        );
        let data = unsafe { std::slice::from_raw_parts(ptr, len) };
        let mut image = image::RgbaImage::new(w as u32, h as u32);
        for (source, target) in data
            .chunks_exact(stride)
            .zip(image.as_mut().chunks_exact_mut(w * 4))
        {
            for (s, t) in source[..w * 4]
                .chunks_exact(4)
                .zip(target.chunks_exact_mut(4))
            {
                t.copy_from_slice(&[s[2], s[1], s[0], s[3]]);
            }
        }
        Ok(DynamicImage::ImageRgba8(image))
    })();
    unsafe { buf.unlock_lock_base_addr(flags) };
    result
}
