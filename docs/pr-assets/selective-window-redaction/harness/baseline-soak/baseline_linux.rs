// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use super::*;
use anyhow::{anyhow, ensure};
use once_cell::sync::Lazy;
use std::sync::Arc;
use tokio::sync::Semaphore;
use xcb::{composite, x, XidNew};

static CAPTURE_SLOT: Lazy<Arc<Semaphore>> = Lazy::new(|| Arc::new(Semaphore::new(1)));

pub(crate) async fn capture_filtered(
    monitor: &SafeMonitor,
    filters: &WindowFilters,
    sources: ExclusionSources,
    _fresh: bool,
) -> anyhow::Result<DynamicImage> {
    // XWayland enumeration cannot account for native Wayland windows. Never
    // substitute a portal/whole-monitor capture when a window policy is set.
    ensure!(
        std::env::var_os("WAYLAND_DISPLAY").is_none()
            && std::env::var("XDG_SESSION_TYPE").unwrap_or_default() != "wayland",
        "window-filtered screenshots require X11 window surfaces"
    );
    let permit = tokio::time::timeout(Duration::from_secs(1), CAPTURE_SLOT.clone().acquire_owned())
        .await
        .map_err(|_| anyhow!("window-filtered capture is still busy"))??;
    let monitor = monitor.get_info();
    let filters = filters.clone();
    let work = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        capture(&monitor, &filters, sources)
    });
    tokio::time::timeout(Duration::from_secs(5), work)
        .await
        .map_err(|_| anyhow!("window-filtered capture timed out"))??
}

fn capture(
    monitor: &crate::monitor::MonitorData,
    filters: &WindowFilters,
    sources: ExclusionSources,
) -> anyhow::Result<DynamicImage> {
    let detector = sources
        .ignore_incognito_windows
        .then(|| screenpipe_a11y::incognito::create_detector(sources.enhanced_incognito_detection));
    let (conn, _) = xcb::Connection::connect(None)?;
    conn.wait_for_reply(conn.send_request(&composite::QueryVersion {
        client_major_version: 0,
        client_minor_version: 4,
    }))?;
    let mut windows = xcap::Window::all()?;
    // xcap orders front to back; draw back to front on an opaque black canvas.
    windows.reverse();
    let mut canvas =
        image::RgbaImage::from_pixel(monitor.width, monitor.height, image::Rgba([0, 0, 0, 255]));
    let mut captured = 0;
    for window in windows {
        let (Ok(id), Ok(app), Ok(title), Ok(false)) = (
            window.id(),
            window.app_name(),
            window.title(),
            window.is_minimized(),
        ) else {
            continue;
        };
        // _NET_WM_PID is optional in X11 (e.g. Tk does not publish it).
        let pid = window.pid().unwrap_or(0);
        if !window_allowed(filters, detector.as_deref(), &app, &title, pid as i32) {
            continue;
        }
        let (wx, wy, width, height) = (window.x()?, window.y()?, window.width()?, window.height()?);
        if i64::from(wx) + i64::from(width) <= i64::from(monitor.x)
            || i64::from(wy) + i64::from(height) <= i64::from(monitor.y)
            || i64::from(wx) >= i64::from(monitor.x) + i64::from(monitor.width)
            || i64::from(wy) >= i64::from(monitor.y) + i64::from(monitor.height)
        {
            continue;
        }
        ensure!(
            width > 0 && height > 0 && width <= 16384 && height <= 16384,
            "invalid window dimensions"
        );
        let native = x::Window::new(id);
        // XGetImage(window) can contain undefined pixels where another window
        // obscures it. Read the window's own Composite backing pixmap instead.
        // Connection teardown releases our redirects on every success/error.
        conn.check_request(conn.send_request_checked(&composite::RedirectWindow {
            window: native,
            update: composite::Redirect::Automatic,
        }))?;
        let pixmap: x::Pixmap = conn.generate_id();
        conn.check_request(conn.send_request_checked(&composite::NameWindowPixmap {
            window: native,
            pixmap,
        }))?;
        let reply = conn.wait_for_reply(conn.send_request(&x::GetImage {
            format: x::ImageFormat::ZPixmap,
            drawable: x::Drawable::Pixmap(pixmap),
            x: 0,
            y: 0,
            width: width as u16,
            height: height as u16,
            plane_mask: u32::MAX,
        }))?;
        conn.send_request(&x::FreePixmap { pixmap });
        let setup = conn.get_setup();
        let format = setup
            .pixmap_formats()
            .iter()
            .find(|f| f.depth() == reply.depth())
            .ok_or_else(|| anyhow!("missing window pixel format"))?;
        ensure!(
            format.bits_per_pixel() == 32
                && format.scanline_pad() == 32
                && setup.image_byte_order() == x::ImageOrder::LsbFirst
                && matches!(reply.depth(), 24 | 32),
            "unsupported window pixel format"
        );
        let attrs =
            conn.wait_for_reply(conn.send_request(&x::GetWindowAttributes { window: native }))?;
        let true_color = setup.roots().any(|s| {
            s.allowed_depths().any(|d| {
                d.visuals().iter().any(|v| {
                    v.visual_id() == attrs.visual()
                        && v.class() == x::VisualClass::TrueColor
                        && v.red_mask() == 0xff0000
                        && v.green_mask() == 0xff00
                        && v.blue_mask() == 0xff
                })
            })
        });
        ensure!(true_color, "unsupported window visual");
        // A close/reuse/title/geometry transition invalidates the whole frame.
        ensure!(
            window.app_name()? == app
                && window.title()? == title
                && window.pid().unwrap_or(0) == pid
                && !window.is_minimized()?
                && (window.x()?, window.y()?, window.width()?, window.height()?)
                    == (wx, wy, width, height),
            "allowed window changed during capture"
        );
        let data = reply.data();
        ensure!(
            data.len() == width as usize * height as usize * 4,
            "invalid window pixel storage"
        );
        for y in 0..height {
            let dest_y = i64::from(wy) - i64::from(monitor.y) + i64::from(y);
            if dest_y < 0 || dest_y >= i64::from(monitor.height) {
                continue;
            }
            for x in 0..width {
                let dest_x = i64::from(wx) - i64::from(monitor.x) + i64::from(x);
                if dest_x < 0 || dest_x >= i64::from(monitor.width) {
                    continue;
                }
                let p = &data[(y as usize * width as usize + x as usize) * 4..][..4];
                canvas.put_pixel(
                    dest_x as u32,
                    dest_y as u32,
                    image::Rgba([p[2], p[1], p[0], 255]),
                );
            }
        }
        captured += 1;
    }
    ensure!(captured > 0, "no verified allowed windows on monitor");
    Ok(DynamicImage::ImageRgba8(canvas))
}
