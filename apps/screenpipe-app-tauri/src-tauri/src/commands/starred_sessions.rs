// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use crate::window::GatedWindowPlacement;
use tauri::{Emitter, Manager};

const LABEL: &str = "starred-sessions";
const WIDTH: f64 = 360.0;
const HEIGHT: f64 = 420.0;

/// Place below the trigger, or above it at the bottom edge, in one coordinate space.
fn attached_origin(anchor: (f64, f64, f64, f64), screen: (f64, f64, f64, f64)) -> (f64, f64) {
    let (x, y, w, h) = anchor;
    let (sx, sy, sw, sh) = screen;
    let left = (x + w / 2.0 - WIDTH / 2.0).clamp(sx, (sx + sw - WIDTH).max(sx));
    let below = y + h + 6.0;
    let top = if below + HEIGHT <= sy + sh {
        below
    } else {
        y - HEIGHT - 6.0
    };
    (left, top.clamp(sy, (sy + sh - HEIGHT).max(sy)))
}

#[cfg(target_os = "macos")]
fn position(app: &tauri::AppHandle, window: &tauri::WebviewWindow) -> Result<(), String> {
    use objc::{msg_send, sel, sel_impl};
    use tauri_nspanel::cocoa::{
        appkit::{NSEvent, NSScreen},
        base::{id, nil},
        foundation::{NSArray, NSPoint, NSRect},
    };
    // Keep AppKit points throughout, including displays above/left of the primary.
    unsafe {
        let anchor = crate::native_shortcut_reminder::get_frame();
        let mouse = NSEvent::mouseLocation(nil);
        let point = anchor
            .map(|(x, y, w, h)| NSPoint::new(x + w / 2.0, y + h / 2.0))
            .unwrap_or(mouse);
        let screens = NSScreen::screens(nil);
        for i in 0..NSArray::count(screens) {
            let screen: id = NSArray::objectAtIndex(screens, i);
            let frame = NSScreen::frame(screen);
            if point.x < frame.origin.x
                || point.x >= frame.origin.x + frame.size.width
                || point.y < frame.origin.y
                || point.y >= frame.origin.y + frame.size.height
            {
                continue;
            }
            let visible = NSScreen::visibleFrame(screen);
            // Flip y for the shared top-down placement calculation, then back.
            let (x, y, w, h) = anchor.unwrap_or((
                visible.origin.x + visible.size.width / 2.0 - 11.0,
                visible.origin.y + visible.size.height - 28.0,
                22.0,
                16.0,
            ));
            let (left, top) = attached_origin(
                (x, -y - h, w, h),
                (
                    visible.origin.x,
                    -visible.origin.y - visible.size.height,
                    visible.size.width,
                    visible.size.height,
                ),
            );
            let native = window.ns_window().map_err(|e| e.to_string())? as id;
            let _: () = msg_send![native, setFrameOrigin: NSPoint::new(left,-top-HEIGHT)];
            return Ok(());
        }
    }
    let _ = app;
    Err("No display available for session controls".into())
}

#[cfg(not(target_os = "macos"))]
fn position(app: &tauri::AppHandle, window: &tauri::WebviewWindow) -> Result<(), String> {
    let overlay = app.get_webview_window("shortcut-reminder");
    let monitor = overlay
        .as_ref()
        .and_then(|w| w.current_monitor().ok().flatten())
        .or(app.primary_monitor().map_err(|e| e.to_string())?)
        .ok_or("No display available")?;
    let scale = monitor.scale_factor();
    let p = monitor.position();
    let s = monitor.size();
    let screen = (
        p.x as f64 / scale,
        p.y as f64 / scale,
        s.width as f64 / scale,
        s.height as f64 / scale,
    );
    let anchor = overlay
        .and_then(|w| Some((w.outer_position().ok()?, w.outer_size().ok()?)))
        .map(|(p, s)| {
            (
                p.x as f64 / scale,
                p.y as f64 / scale,
                s.width as f64 / scale,
                s.height as f64 / scale,
            )
        })
        .unwrap_or((
            screen.0 + screen.2 / 2.0 - 11.0,
            screen.1 + 12.0,
            22.0,
            16.0,
        ));
    let (x, y) = attached_origin(anchor, screen);
    window
        .set_position(tauri::PhysicalPosition::new(
            (x * scale) as i32,
            (y * scale) as i32,
        ))
        .map_err(|e| e.to_string())
}

pub(crate) fn hide(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(LABEL) {
        #[cfg(target_os = "macos")]
        {
            use tauri_nspanel::ManagerExt;
            if let Ok(panel) = app.get_webview_panel(LABEL) {
                panel.order_out(None);
            }
        }
        window.hide().map_err(|e| e.to_string())?;
        let _ = window.emit("starred-sessions-visibility", false);
    }
    Ok(())
}

/// Called on the main thread by both the global shortcut and overlay star button.
pub(crate) fn toggle(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(LABEL) {
        if window.is_visible().unwrap_or(false) {
            return hide(app);
        }
    }
    let window = match app.get_webview_window(LABEL) {
        Some(window) => window,
        None => {
            let window = tauri::WebviewWindowBuilder::new(
                app,
                LABEL,
                tauri::WebviewUrl::App("starred-sessions".into()),
            )
            .title("Starred work sessions")
            .inner_size(WIDTH, HEIGHT)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .resizable(false)
            .skip_taskbar(true)
            .always_on_top_gated(true)
            .visible_on_all_workspaces_gated(true)
            .focused_gated(false)
            .visible(false)
            .build()
            .map(crate::window::finalize_webview_window)
            .map_err(|e| e.to_string())?;
            let handle = app.clone();
            window.on_window_event(move |event| {
                if matches!(event, tauri::WindowEvent::Focused(false)) {
                    let _ = hide(&handle);
                }
            });
            window
        }
    };
    position(app, &window)?;
    #[cfg(target_os = "macos")]
    {
        use crate::window::GatedPanelPlacement;
        use objc::{msg_send, sel, sel_impl};
        use tauri_nspanel::{
            cocoa::appkit::NSWindowCollectionBehavior as Behavior, ManagerExt, WebviewWindowExt,
        };
        let panel = match app.get_webview_panel(LABEL) {
            Ok(panel) => panel,
            Err(_) => window.to_panel().map_err(|e| e.to_string())?,
        };
        panel.set_style_mask(128); // NSNonactivatingPanelMask: no app/Space activation.
        panel.set_level_gated(1002);
        panel.set_hides_on_deactivate(false);
        panel.set_collection_behaviour_gated(
            Behavior::NSWindowCollectionBehaviorCanJoinAllSpaces
                | Behavior::NSWindowCollectionBehaviorFullScreenAuxiliary
                | Behavior::NSWindowCollectionBehaviorIgnoresCycle,
        );
        let sharing: u64 = if crate::window::native_overlay_is_capturable(app) {
            1
        } else {
            0
        };
        unsafe {
            let _: () = msg_send![&*panel,setSharingType: sharing];
        }
        window.show().map_err(|e| e.to_string())?;
        panel.order_front_regardless();
        crate::window::make_panel_key_if_allowed(&panel);
        unsafe {
            crate::window::make_webview_first_responder(&panel);
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        window.show().map_err(|e| e.to_string())?;
        crate::window::focus_window(&window);
    }
    let _ = window.emit("starred-sessions-visibility", true);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn toggle_starred_sessions(app_handle: tauri::AppHandle) -> Result<(), String> {
    let (send, recv) = tokio::sync::oneshot::channel();
    let app = app_handle.clone();
    app_handle
        .run_on_main_thread(move || {
            let _ = send.send(toggle(&app));
        })
        .map_err(|e| e.to_string())?;
    recv.await.map_err(|e| e.to_string())?
}

#[tauri::command]
#[specta::specta]
pub async fn hide_starred_sessions(app_handle: tauri::AppHandle) -> Result<(), String> {
    let (send, recv) = tokio::sync::oneshot::channel();
    let app = app_handle.clone();
    app_handle
        .run_on_main_thread(move || {
            let _ = send.send(hide(&app));
        })
        .map_err(|e| e.to_string())?;
    recv.await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn starred_panel_hugs_trigger_and_stays_on_its_display() {
        assert_eq!(
            attached_origin((700.0, 12.0, 22.0, 16.0), (0.0, 0.0, 1440.0, 900.0)),
            (531.0, 34.0)
        );
        assert_eq!(
            attached_origin((1400.0, 850.0, 22.0, 16.0), (0.0, 0.0, 1440.0, 900.0)),
            (1080.0, 424.0)
        );
        assert_eq!(
            attached_origin(
                (-1440.0, -880.0, 22.0, 16.0),
                (-1440.0, -900.0, 1440.0, 900.0)
            ),
            (-1440.0, -858.0)
        );
    }
}
