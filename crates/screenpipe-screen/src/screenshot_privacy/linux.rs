// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use super::{
    scene::{self, Rect},
    *,
};
use anyhow::{anyhow, ensure};
use once_cell::sync::Lazy;
use std::sync::Arc;
use tokio::sync::Semaphore;
use xcb::{composite, x, Xid, XidNew};

static CAPTURE_SLOT: Lazy<Arc<Semaphore>> = Lazy::new(|| Arc::new(Semaphore::new(1)));

pub(crate) async fn capture_filtered(
    monitor: &SafeMonitor,
    filters: &WindowFilters,
    sources: ExclusionSources,
    _fresh: bool,
) -> anyhow::Result<DynamicImage> {
    // XWayland cannot enumerate native Wayland surfaces. Never fall back to a
    // portal/monitor image when isolated pixels are required.
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

fn atom(conn: &xcb::Connection, name: &str) -> anyhow::Result<x::Atom> {
    Ok(conn
        .wait_for_reply(conn.send_request(&x::InternAtom {
            only_if_exists: true,
            name: name.as_bytes(),
        }))?
        .atom())
}

fn property(
    conn: &xcb::Connection,
    window: x::Window,
    name: &str,
) -> anyhow::Result<x::GetPropertyReply> {
    let property = atom(conn, name)?;
    ensure!(property != x::ATOM_NONE, "missing {name}");
    Ok(conn.wait_for_reply(conn.send_request(&x::GetProperty {
        delete: false,
        window,
        property,
        r#type: x::ATOM_ANY,
        long_offset: 0,
        long_length: 16384,
    }))?)
}

fn text_property(conn: &xcb::Connection, window: x::Window, name: &str) -> String {
    property(conn, window, name)
        .ok()
        .filter(|p| p.format() == 8)
        .map(|p| String::from_utf8_lossy(p.value::<u8>()).into_owned())
        .unwrap_or_default()
}

#[derive(Debug, Clone, PartialEq)]
struct Surface {
    id: u32,
    client: u32,
    pid: u32,
    app: String,
    title: String,
    rect: Rect,
    opacity: u32,
}

/// Actual root children are bottom-to-top, including unmanaged menus, WM
/// decorations, dock and desktop windows. The old client-only list omitted
/// these and could reveal a lower allowed window under a blocked popup.
fn snapshot(
    conn: &xcb::Connection,
    root: x::Window,
    overlay: x::Window,
) -> anyhow::Result<Vec<Surface>> {
    let clients = property(conn, root, "_NET_CLIENT_LIST_STACKING")
        .ok()
        .filter(|p| p.format() == 32)
        .map(|p| p.value::<u32>().to_vec())
        .unwrap_or_default();
    let mut frame_clients = std::collections::HashMap::new();
    for id in clients {
        let mut current = x::Window::new(id);
        for _ in 0..32 {
            let Ok(tree) =
                conn.wait_for_reply(conn.send_request(&x::QueryTree { window: current }))
            else {
                break;
            };
            if tree.parent() == root {
                frame_clients.insert(current.resource_id(), id);
                break;
            }
            if tree.parent().resource_id() == 0 {
                break;
            }
            current = tree.parent();
        }
    }
    let tree = conn.wait_for_reply(conn.send_request(&x::QueryTree { window: root }))?;
    let mut result = Vec::new();
    for &window in tree.children() {
        if window == overlay {
            continue;
        }
        let attrs = conn.wait_for_reply(conn.send_request(&x::GetWindowAttributes { window }))?;
        if attrs.map_state() != x::MapState::Viewable || attrs.class() == x::WindowClass::InputOnly
        {
            continue;
        }
        let geometry = conn.wait_for_reply(conn.send_request(&x::GetGeometry {
            drawable: x::Drawable::Window(window),
        }))?;
        let position = conn.wait_for_reply(conn.send_request(&x::TranslateCoordinates {
            src_window: window,
            dst_window: root,
            src_x: 0,
            src_y: 0,
        }))?;
        let client = *frame_clients
            .get(&window.resource_id())
            .unwrap_or(&window.resource_id());
        let native = x::Window::new(client);
        let class = text_property(conn, native, "WM_CLASS");
        let app = class.split('\0').nth(1).unwrap_or("").to_string();
        let mut title = text_property(conn, native, "_NET_WM_NAME");
        if title.is_empty() {
            title = text_property(conn, native, "WM_NAME");
        }
        let cardinal = |name| {
            property(conn, native, name)
                .ok()
                .filter(|p| p.format() == 32)
                .and_then(|p| p.value::<u32>().first().copied())
        };
        result.push(Surface {
            id: window.resource_id(),
            client,
            pid: cardinal("_NET_WM_PID").unwrap_or(0),
            app,
            title,
            rect: Rect {
                x: i64::from(position.dst_x()),
                y: i64::from(position.dst_y()),
                width: u32::from(geometry.width()),
                height: u32::from(geometry.height()),
            },
            opacity: cardinal("_NET_WM_WINDOW_OPACITY").unwrap_or(u32::MAX),
        });
    }
    Ok(result)
}

fn read_pixmap(
    conn: &xcb::Connection,
    pixmap: x::Pixmap,
    width: u32,
    height: u32,
) -> anyhow::Result<image::RgbaImage> {
    ensure!(
        width > 0 && height > 0 && width <= 16384 && height <= 16384,
        "invalid surface dimensions"
    );
    let reply = conn.wait_for_reply(conn.send_request(&x::GetImage {
        format: x::ImageFormat::ZPixmap,
        drawable: x::Drawable::Pixmap(pixmap),
        x: 0,
        y: 0,
        width: width as u16,
        height: height as u16,
        plane_mask: u32::MAX,
    }))?;
    let setup = conn.get_setup();
    let format = setup
        .pixmap_formats()
        .iter()
        .find(|f| f.depth() == reply.depth())
        .ok_or_else(|| anyhow!("missing surface pixel format"))?;
    ensure!(
        format.bits_per_pixel() == 32
            && format.scanline_pad() == 32
            && setup.image_byte_order() == x::ImageOrder::LsbFirst
            && matches!(reply.depth(), 24 | 32),
        "unsupported surface pixel format"
    );
    let data = reply.data();
    ensure!(
        data.len() == width as usize * height as usize * 4,
        "invalid surface pixel storage"
    );
    let mut image = image::RgbaImage::new(width, height);
    for (s, d) in data.chunks_exact(4).zip(image.pixels_mut()) {
        *d = image::Rgba([
            s[2],
            s[1],
            s[0],
            if reply.depth() == 32 { s[3] } else { 255 },
        ]);
    }
    Ok(image)
}

fn background_id(conn: &xcb::Connection, root: x::Window) -> Option<u32> {
    ["_XROOTPMAP_ID", "ESETROOT_PMAP_ID"]
        .into_iter()
        .find_map(|name| {
            property(conn, root, name)
                .ok()
                .filter(|p| p.format() == 32 && p.r#type() == x::ATOM_PIXMAP)
                .and_then(|p| p.value::<u32>().first().copied())
                .filter(|id| *id != 0)
        })
}

fn capture(
    monitor: &crate::monitor::MonitorData,
    filters: &WindowFilters,
    sources: ExclusionSources,
) -> anyhow::Result<DynamicImage> {
    let detector = sources
        .ignore_incognito_windows
        .then(|| screenpipe_a11y::incognito::create_detector(sources.enhanced_incognito_detection));
    let (conn, index) = xcb::Connection::connect(None)?;
    conn.wait_for_reply(conn.send_request(&composite::QueryVersion {
        client_major_version: 0,
        client_minor_version: 4,
    }))?;
    let setup = conn.get_setup();
    let screen = setup
        .roots()
        .nth(index as usize)
        .ok_or_else(|| anyhow!("missing X11 screen"))?;
    let root = screen.root();
    let overlay = conn
        .wait_for_reply(conn.send_request(&composite::GetOverlayWindow { window: root }))?
        .overlay_win();
    conn.check_request(
        conn.send_request_checked(&composite::ReleaseOverlayWindow { window: root }),
    )?;
    conn.check_request(conn.send_request_checked(&x::ChangeWindowAttributes {
        window: root,
        value_list: &[x::Cw::EventMask(
            x::EventMask::SUBSTRUCTURE_NOTIFY | x::EventMask::PROPERTY_CHANGE,
        )],
    }))?;
    let initial = snapshot(&conn, root, overlay)?;
    for surface in &initial {
        for id in [surface.id, surface.client] {
            conn.check_request(conn.send_request_checked(&x::ChangeWindowAttributes {
                window: x::Window::new(id),
                value_list: &[x::Cw::EventMask(
                    x::EventMask::STRUCTURE_NOTIFY | x::EventMask::PROPERTY_CHANGE,
                )],
            }))?;
        }
    }
    let before = snapshot(&conn, root, overlay)?;
    ensure!(
        initial == before,
        "desktop scene changed during privacy setup"
    );
    let policy_atoms = [
        "_NET_WM_NAME",
        "WM_NAME",
        "WM_CLASS",
        "_NET_WM_PID",
        "_NET_WM_WINDOW_OPACITY",
        "_NET_WM_STATE",
        "_XROOTPMAP_ID",
        "ESETROOT_PMAP_ID",
    ]
    .iter()
    .map(|name| atom(&conn, name))
    .collect::<anyhow::Result<Vec<_>>>()?;
    ensure!(
        !scene_changed(&conn, &policy_atoms)?,
        "desktop changed before privacy capture"
    );
    let wallpaper = background_id(&conn, root);
    let mut canvas =
        image::RgbaImage::from_pixel(monitor.width, monitor.height, image::Rgba([0, 0, 0, 255]));
    // This is the wallpaper resource, never the root framebuffer containing
    // other clients. A desktop manager's own window is also captured below.
    if filters.is_valid("Desktop", "") {
        if let Some(id) = wallpaper {
            let pixmap = x::Pixmap::new(id);
            let size = conn.wait_for_reply(conn.send_request(&x::GetGeometry {
                drawable: x::Drawable::Pixmap(pixmap),
            }))?;
            let image = read_pixmap(
                &conn,
                pixmap,
                u32::from(size.width()),
                u32::from(size.height()),
            )?;
            // X11 tiles a root background pixmap; it may be only 1x1.
            // Use root coordinates so adjacent/negative-origin monitors agree.
            for (x, y, pixel) in canvas.enumerate_pixels_mut() {
                let sx = (i64::from(x) + i64::from(monitor.x)).rem_euclid(i64::from(image.width()))
                    as u32;
                let sy = (i64::from(y) + i64::from(monitor.y)).rem_euclid(i64::from(image.height()))
                    as u32;
                *pixel = *image.get_pixel(sx, sy);
                pixel[3] = 255;
            }
        }
    }
    let monitor_rect = Rect {
        x: i64::from(monitor.x),
        y: i64::from(monitor.y),
        width: monitor.width,
        height: monitor.height,
    };
    for surface in &before {
        if !surface.rect.intersects(monitor_rect) {
            continue;
        }
        let dest = Rect {
            x: surface.rect.x - i64::from(monitor.x),
            y: surface.rect.y - i64::from(monitor.y),
            ..surface.rect
        };
        if !window_allowed(
            filters,
            detector.as_deref(),
            &surface.app,
            &surface.title,
            surface.pid as i32,
        ) {
            scene::paint_black(&mut canvas, dest);
            continue;
        }
        let native = x::Window::new(surface.id);
        let attrs =
            conn.wait_for_reply(conn.send_request(&x::GetWindowAttributes { window: native }))?;
        ensure!(
            setup
                .roots()
                .any(|s| s
                    .allowed_depths()
                    .any(
                        |d| d.visuals().iter().any(|v| v.visual_id() == attrs.visual()
                            && v.class() == x::VisualClass::TrueColor
                            && v.red_mask() == 0xff0000
                            && v.green_mask() == 0xff00
                            && v.blue_mask() == 0xff)
                    )),
            "unsupported surface visual"
        );
        conn.check_request(conn.send_request_checked(&composite::RedirectWindow {
            window: native,
            update: composite::Redirect::Automatic,
        }))?;
        let pixmap: x::Pixmap = conn.generate_id();
        conn.check_request(conn.send_request_checked(&composite::NameWindowPixmap {
            window: native,
            pixmap,
        }))?;
        let mut image = read_pixmap(&conn, pixmap, surface.rect.width, surface.rect.height)?;
        conn.check_request(conn.send_request_checked(&x::FreePixmap { pixmap }))?;
        if surface.opacity != u32::MAX {
            for pixel in image.pixels_mut() {
                for c in &mut pixel.0 {
                    *c = ((u64::from(*c) * u64::from(surface.opacity) + u64::from(u32::MAX) / 2)
                        / u64::from(u32::MAX)) as u8;
                }
            }
        }
        scene::overlay_premultiplied(&mut canvas, &image, dest.x, dest.y, None);
    }
    // Includes blocked/unknown surfaces and stacking order. Never persist a
    // partially reconstructed scene after close/reuse/move/resize/reorder.
    ensure!(
        snapshot(&conn, root, overlay)? == before && background_id(&conn, root) == wallpaper,
        "desktop scene changed during privacy capture"
    );
    // Events retain transient title/geometry changes even if a window returns
    // to the same identity before revalidation (an ABA transition).
    ensure!(
        !scene_changed(&conn, &policy_atoms)?,
        "desktop changed during privacy capture"
    );
    Ok(DynamicImage::ImageRgba8(canvas))
}

fn scene_changed(conn: &xcb::Connection, policy_atoms: &[x::Atom]) -> anyhow::Result<bool> {
    let mut changed = false;
    while let Some(event) = conn.poll_for_event()? {
        if let xcb::Event::X(event) = event {
            changed |= match event {
                x::Event::PropertyNotify(e) => policy_atoms.contains(&e.atom()),
                x::Event::CreateNotify(_)
                | x::Event::DestroyNotify(_)
                | x::Event::MapNotify(_)
                | x::Event::UnmapNotify(_)
                | x::Event::ConfigureNotify(_)
                | x::Event::ReparentNotify(_)
                | x::Event::CirculateNotify(_) => true,
                _ => false,
            };
        }
    }
    Ok(changed)
}
