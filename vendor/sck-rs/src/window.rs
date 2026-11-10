//! Window capture using ScreenCaptureKit via cidre

use cidre::ns;
use image::RgbaImage;
use tracing::debug;

/// Get the PID of the frontmost application using cidre's NSWorkspace API.
fn get_frontmost_pid() -> i32 {
    let workspace = ns::Workspace::shared();
    let apps = workspace.running_apps();
    for i in 0..apps.len() {
        if let Ok(app) = apps.get(i) {
            if app.is_active() {
                return app.pid();
            }
        }
    }
    -1
}

use crate::capture;
use crate::error::{XCapError, XCapResult};

/// Represents a capturable window
///
/// This type provides an API compatible with xcap::Window
#[derive(Debug, Clone)]
pub struct Window {
    /// The window ID
    window_id: u32,
    /// The owning application name
    app_name: String,
    /// The window title
    title: String,
    /// Process ID of the owning application
    pid: i32,
    /// Window position X
    x: i32,
    /// Window position Y
    y: i32,
    /// Window width
    width: u32,
    /// Window height
    height: u32,
    /// Whether the window is on screen
    is_on_screen: bool,
    /// Whether the owning application is the frontmost/active app
    is_app_active: bool,
    /// The window layer (0 = normal, >0 = overlay/floating/panel)
    window_layer: isize,
}

impl Window {
    /// Get all available windows
    ///
    /// Returns a list of all windows that can be captured.
    /// Requires screen recording permission.
    pub fn all() -> XCapResult<Vec<Window>> {
        let content = capture::get_shareable_content()?;

        let sc_windows = content.windows();

        if sc_windows.is_empty() {
            return Err(XCapError::no_windows());
        }

        // Get the frontmost app PID once for all windows
        let frontmost_pid = get_frontmost_pid();

        let windows: Vec<Window> =
            sc_windows
                .iter()
                .filter_map(|w| {
                    // Get window properties
                    let title = w.title().map(|s| s.to_string()).unwrap_or_default();

                    let (app_name, pid) = match w.owning_app() {
                        Some(app) => (app.app_name().to_string(), app.process_id()),
                        None => (String::new(), -1),
                    };
                    let is_app_active = pid >= 0 && pid == frontmost_pid;

                    // Get window layer (0 = normal, >0 = overlay/floating)
                    let window_layer = w.window_layer();

                    // Get window frame
                    let frame = w.frame();
                    let width = frame.size.width as u32;
                    let height = frame.size.height as u32;

                    // Skip windows that are too small (likely invisible)
                    if width < 10 || height < 10 {
                        debug!("Skipping small window: {} ({}x{})", title, width, height);
                        return None;
                    }

                    debug!(
                    "Found window: id={}, app={}, title={}, {}x{} at ({}, {}), layer={}, active={}",
                    w.id(), app_name, title, width, height, frame.origin.x, frame.origin.y,
                    window_layer, is_app_active
                );

                    Some(Window {
                        window_id: w.id(),
                        app_name,
                        title,
                        pid,
                        x: frame.origin.x as i32,
                        y: frame.origin.y as i32,
                        width,
                        height,
                        is_on_screen: w.is_on_screen(),
                        is_app_active,
                        window_layer,
                    })
                })
                .collect();

        if windows.is_empty() {
            return Err(XCapError::no_windows());
        }

        Ok(windows)
    }

    /// Get the window ID
    pub fn id(&self) -> XCapResult<u32> {
        Ok(self.window_id)
    }

    /// Get the window's raw ID (non-Result version for convenience)
    pub fn raw_id(&self) -> u32 {
        self.window_id
    }

    /// Get the window's process ID
    pub fn pid(&self) -> XCapResult<u32> {
        if self.pid < 0 {
            return Err(XCapError::new("Process ID not available"));
        }
        Ok(self.pid as u32)
    }

    /// Get the application name
    pub fn app_name(&self) -> XCapResult<String> {
        Ok(self.app_name.clone())
    }

    /// Get the window title
    pub fn title(&self) -> XCapResult<String> {
        Ok(self.title.clone())
    }

    /// Get the window X position
    pub fn x(&self) -> XCapResult<i32> {
        Ok(self.x)
    }

    /// Get the window Y position
    pub fn y(&self) -> XCapResult<i32> {
        Ok(self.y)
    }

    /// Get the window width
    pub fn width(&self) -> XCapResult<u32> {
        Ok(self.width)
    }

    /// Get the window height
    pub fn height(&self) -> XCapResult<u32> {
        Ok(self.height)
    }

    /// Check if the window is minimized
    pub fn is_minimized(&self) -> XCapResult<bool> {
        // SCK provides is_on_screen which is the inverse
        Ok(!self.is_on_screen)
    }

    /// Check if the window is maximized
    pub fn is_maximized(&self) -> XCapResult<bool> {
        // TODO: Compare with monitor size
        Ok(false)
    }

    /// Check if the window is focused
    ///
    /// A window is considered focused if:
    /// 1. Its owning app is the frontmost/active application
    /// 2. Its window layer is 0 (normal level, not a floating overlay)
    ///
    /// This prevents always-on-top overlay apps (like Wispr Flow, Bartender)
    /// from being reported as focused when their floating status windows
    /// happen to belong to the "active" app.
    pub fn is_focused(&self) -> XCapResult<bool> {
        Ok(self.is_app_active && self.window_layer == 0)
    }

    /// Check if the window is on screen
    pub fn is_on_screen(&self) -> bool {
        self.is_on_screen
    }

    /// Get the window layer level
    ///
    /// Layer 0 = normal app window
    /// Layer > 0 = floating panel, overlay, status item, etc.
    pub fn window_layer(&self) -> isize {
        self.window_layer
    }

    /// Capture an image of the window
    ///
    /// Returns an RGBA image of the window contents.
    pub fn capture_image(&self) -> XCapResult<RgbaImage> {
        capture::capture_window_sync(self.window_id, self.width, self.height)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_window_getters() {
        let window = Window {
            window_id: 123,
            app_name: "TestApp".to_string(),
            title: "Test Window".to_string(),
            pid: 456,
            x: 100,
            y: 200,
            width: 800,
            height: 600,
            is_on_screen: true,
            is_app_active: true,
            window_layer: 0,
        };

        assert_eq!(window.id().unwrap(), 123);
        assert_eq!(window.raw_id(), 123);
        assert_eq!(window.app_name().unwrap(), "TestApp");
        assert_eq!(window.title().unwrap(), "Test Window");
        assert_eq!(window.pid().unwrap(), 456);
        assert_eq!(window.x().unwrap(), 100);
        assert_eq!(window.y().unwrap(), 200);
        assert_eq!(window.width().unwrap(), 800);
        assert_eq!(window.height().unwrap(), 600);
        assert!(!window.is_minimized().unwrap());
        assert!(window.is_on_screen());
        assert!(window.is_focused().unwrap());
    }

    #[test]
    fn test_overlay_window_not_focused() {
        let window = Window {
            window_id: 1,
            app_name: "Wispr Flow".to_string(),
            title: "Status".to_string(),
            pid: 100,
            x: 0,
            y: 0,
            width: 200,
            height: 50,
            is_on_screen: true,
            is_app_active: true,  // App is frontmost...
            window_layer: 3isize, // ...but window is an overlay
        };

        // Should NOT be considered focused because layer > 0
        assert!(!window.is_focused().unwrap());
    }

    #[test]
    fn test_inactive_app_not_focused() {
        let window = Window {
            window_id: 2,
            app_name: "Background App".to_string(),
            title: "Main".to_string(),
            pid: 200,
            x: 0,
            y: 0,
            width: 800,
            height: 600,
            is_on_screen: true,
            is_app_active: false, // Not the frontmost app
            window_layer: 0,      // Normal window level
        };

        assert!(!window.is_focused().unwrap());
    }

    #[test]
    fn test_window_minimized() {
        let window = Window {
            window_id: 1,
            app_name: "App".to_string(),
            title: "Title".to_string(),
            pid: 1,
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            is_on_screen: false,
            is_app_active: false,
            window_layer: 0,
        };

        assert!(window.is_minimized().unwrap());
        assert!(!window.is_on_screen());
    }

    #[test]
    fn test_window_all() {
        let _sck_guard = crate::capture::lock_sck_globals();
        // This test verifies the API works
        // It will fail or succeed based on permission state
        let result = Window::all();
        // We just check it returns a result, not panics
        let _ = result;
    }
}
