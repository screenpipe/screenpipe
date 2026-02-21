//! macOS UI event capture using CGEventTap and Accessibility APIs
//!
//! Uses native macOS APIs - no rdev dependency.

use crate::activity_feed::{ActivityFeed, ActivityKind};
use crate::config::UiCaptureConfig;
use crate::events::{ElementContext, EventData, Modifiers, UiEvent};
use anyhow::Result;
use chrono::Utc;
use crossbeam_channel::{bounded, Receiver, Sender};
use parking_lot::Mutex;
use screenpipe_core::pii_removal::remove_pii;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Instant;
use tracing::{debug, error};

use cidre::cg::event::access as cg_access;
use cidre::{ax, cf, cg, ns};

// Keycodes for clipboard operations (macOS)
const KEY_C: u16 = 8;
const KEY_X: u16 = 7;
const KEY_V: u16 = 9;

/// Permission status for UI capture
#[derive(Debug, Clone)]
pub struct PermissionStatus {
    pub accessibility: bool,
    pub input_monitoring: bool,
}

impl PermissionStatus {
    pub fn all_granted(&self) -> bool {
        self.accessibility && self.input_monitoring
    }
}

/// UI Event recorder for macOS
pub struct UiRecorder {
    config: UiCaptureConfig,
}

/// Handle to a running recording session
pub struct RecordingHandle {
    stop: Arc<AtomicBool>,
    events_rx: Receiver<UiEvent>,
    threads: Vec<thread::JoinHandle<()>>,
}

impl RecordingHandle {
    /// Stop the recording
    pub fn stop(self) {
        self.stop.store(true, Ordering::SeqCst);
        for t in self.threads {
            let _ = t.join();
        }
    }

    /// Check if still running
    pub fn is_running(&self) -> bool {
        !self.stop.load(Ordering::Relaxed)
    }

    /// Get the event receiver
    pub fn receiver(&self) -> &Receiver<UiEvent> {
        &self.events_rx
    }

    /// Try to receive an event without blocking
    pub fn try_recv(&self) -> Option<UiEvent> {
        self.events_rx.try_recv().ok()
    }

    /// Receive an event, blocking
    pub fn recv(&self) -> Option<UiEvent> {
        self.events_rx.recv().ok()
    }

    /// Receive with timeout
    pub fn recv_timeout(&self, timeout: std::time::Duration) -> Option<UiEvent> {
        self.events_rx.recv_timeout(timeout).ok()
    }
}

impl UiRecorder {
    /// Create a new recorder with the given config
    pub fn new(config: UiCaptureConfig) -> Self {
        Self { config }
    }

    /// Create with default config
    pub fn with_defaults() -> Self {
        Self::new(UiCaptureConfig::new())
    }

    /// Check current permission status
    pub fn check_permissions(&self) -> PermissionStatus {
        PermissionStatus {
            accessibility: ax::is_process_trusted(),
            input_monitoring: cg_access::listen_preflight(),
        }
    }

    /// Request permissions (shows system dialogs)
    pub fn request_permissions(&self) -> PermissionStatus {
        PermissionStatus {
            accessibility: ax::is_process_trusted_with_prompt(true),
            input_monitoring: cg_access::listen_request(),
        }
    }

    /// Start capturing events (without activity feed)
    pub fn start(&self) -> Result<RecordingHandle> {
        let (handle, _) = self.start_internal(None)?;
        Ok(handle)
    }

    /// Start capturing with activity feed for adaptive FPS
    pub fn start_with_activity_feed(&self) -> Result<(RecordingHandle, ActivityFeed)> {
        let activity_feed = ActivityFeed::new();
        let (handle, _) = self.start_internal(Some(activity_feed.clone()))?;
        Ok((handle, activity_feed))
    }

    /// Start activity feed only (minimal hooks, no full event capture)
    pub fn start_activity_only(&self) -> Result<ActivityFeed> {
        let perms = self.check_permissions();
        if !perms.input_monitoring {
            anyhow::bail!("Missing input monitoring permission");
        }

        let activity_feed = ActivityFeed::new();
        let stop = Arc::new(AtomicBool::new(false));

        let feed_clone = activity_feed.clone();
        let stop_clone = stop.clone();

        // Spawn minimal event tap thread (activity only)
        thread::spawn(move || {
            run_activity_only_tap(feed_clone, stop_clone);
        });

        Ok(activity_feed)
    }

    fn start_internal(
        &self,
        activity_feed: Option<ActivityFeed>,
    ) -> Result<(RecordingHandle, Option<ActivityFeed>)> {
        let perms = self.check_permissions();
        if !perms.all_granted() {
            anyhow::bail!(
                "Missing permissions - accessibility: {}, input_monitoring: {}",
                perms.accessibility,
                perms.input_monitoring
            );
        }

        let (tx, rx) = bounded::<UiEvent>(self.config.max_buffer_size);
        let stop = Arc::new(AtomicBool::new(false));
        let start_time = Instant::now();

        let mut threads = Vec::new();

        // Shared state for current app/window between threads
        let current_app = Arc::new(Mutex::new(None::<String>));
        let current_window = Arc::new(Mutex::new(None::<String>));

        // Thread 1: CGEventTap for input events
        let tx1 = tx.clone();
        let stop1 = stop.clone();
        let config1 = self.config.clone();
        let app1 = current_app.clone();
        let window1 = current_window.clone();
        let feed1 = activity_feed.clone();
        threads.push(thread::spawn(move || {
            run_event_tap(tx1, stop1, start_time, config1, app1, window1, feed1);
        }));

        // Thread 2: App/window observer
        let tx2 = tx.clone();
        let stop2 = stop.clone();
        let config2 = self.config.clone();
        let app2 = current_app.clone();
        let window2 = current_window.clone();
        threads.push(thread::spawn(move || {
            run_app_observer(tx2, stop2, start_time, config2, app2, window2);
        }));

        Ok((
            RecordingHandle {
                stop,
                events_rx: rx,
                threads,
            },
            activity_feed,
        ))
    }
}

// ============================================================================
// Event Tap Implementation
// ============================================================================

struct TapState {
    tx: Sender<UiEvent>,
    start: Instant,
    config: UiCaptureConfig,
    last_mouse: Mutex<(f64, f64)>,
    text_buf: Mutex<TextBuffer>,
    current_app: Arc<Mutex<Option<String>>>,
    current_window: Arc<Mutex<Option<String>>>,
    activity_feed: Option<ActivityFeed>,
}

struct TextBuffer {
    chars: String,
    last_time: Option<Instant>,
    timeout_ms: u64,
}

impl TextBuffer {
    fn new(timeout_ms: u64) -> Self {
        Self {
            chars: String::new(),
            last_time: None,
            timeout_ms,
        }
    }

    fn push(&mut self, c: char) {
        if c == '\x08' {
            // Backspace - remove last char
            self.chars.pop();
        } else {
            self.chars.push(c);
        }
        self.last_time = Some(Instant::now());
    }

    fn flush(&mut self) -> Option<String> {
        if self.chars.is_empty() {
            return None;
        }
        let s = std::mem::take(&mut self.chars);
        self.last_time = None;
        Some(s)
    }

    fn should_flush(&self) -> bool {
        self.last_time
            .map(|t| t.elapsed().as_millis() as u64 >= self.timeout_ms)
            .unwrap_or(false)
    }
}

fn run_event_tap(
    tx: Sender<UiEvent>,
    stop: Arc<AtomicBool>,
    start: Instant,
    config: UiCaptureConfig,
    current_app: Arc<Mutex<Option<String>>>,
    current_window: Arc<Mutex<Option<String>>>,
    activity_feed: Option<ActivityFeed>,
) {
    // Build event mask - always include KEY_UP for activity tracking
    let mut mask = cg::EventType::LEFT_MOUSE_DOWN.mask()
        | cg::EventType::LEFT_MOUSE_UP.mask()
        | cg::EventType::RIGHT_MOUSE_DOWN.mask()
        | cg::EventType::RIGHT_MOUSE_UP.mask()
        | cg::EventType::KEY_DOWN.mask()
        | cg::EventType::KEY_UP.mask()
        | cg::EventType::SCROLL_WHEEL.mask();

    if config.capture_mouse_move || activity_feed.is_some() {
        mask |= cg::EventType::MOUSE_MOVED.mask()
            | cg::EventType::LEFT_MOUSE_DRAGGED.mask()
            | cg::EventType::RIGHT_MOUSE_DRAGGED.mask();
    }

    let state = Box::leak(Box::new(TapState {
        tx,
        start,
        config: config.clone(),
        last_mouse: Mutex::new((0.0, 0.0)),
        text_buf: Mutex::new(TextBuffer::new(config.text_timeout_ms)),
        current_app,
        current_window,
        activity_feed,
    }));

    let tap = cg::EventTap::new(
        cg::EventTapLocation::Session,
        cg::EventTapPlacement::TailAppend,
        cg::EventTapOpts::LISTEN_ONLY,
        mask,
        tap_callback,
        state as *mut TapState,
    );

    let Some(tap) = tap else {
        error!("Failed to create CGEventTap");
        return;
    };

    let Some(src) = cf::MachPort::run_loop_src(&tap, 0) else {
        error!("Failed to create run loop source");
        return;
    };

    let rl = cf::RunLoop::current();
    rl.add_src(&src, cf::RunLoopMode::default());

    debug!("Event tap started");

    while !stop.load(Ordering::Relaxed) {
        cf::RunLoop::run_in_mode(cf::RunLoopMode::default(), 0.05, true);

        // Check text buffer timeout
        let mut buf = state.text_buf.lock();
        if buf.should_flush() {
            if let Some(s) = buf.flush() {
                let text = if state.config.apply_pii_removal {
                    remove_pii(&s)
                } else {
                    s
                };
                let event =
                    UiEvent::text(Utc::now(), state.start.elapsed().as_millis() as u64, text);
                let _ = state.tx.try_send(event);
            }
        }
    }

    // Final flush
    let mut buf = state.text_buf.lock();
    if let Some(s) = buf.flush() {
        let text = if state.config.apply_pii_removal {
            remove_pii(&s)
        } else {
            s
        };
        let event = UiEvent::text(Utc::now(), state.start.elapsed().as_millis() as u64, text);
        let _ = state.tx.try_send(event);
    }

    rl.remove_src(&src, cf::RunLoopMode::default());
    debug!("Event tap stopped");
}

extern "C" fn tap_callback(
    _proxy: *mut cg::EventTapProxy,
    event_type: cg::EventType,
    event: &mut cg::Event,
    user_info: *mut TapState,
) -> Option<&cg::Event> {
    let state = unsafe { &*user_info };
    let t = state.start.elapsed().as_millis() as u64;
    let timestamp = Utc::now();
    let loc = event.location();
    let flags = event.flags().0;
    let mods = Modifiers::from_cg_flags(flags);

    // Get current app/window context
    let app_name = state.current_app.lock().clone();
    let window_title = state.current_window.lock().clone();

    // Check if we should capture based on app/window exclusions
    if let Some(ref app) = app_name {
        if !state.config.should_capture_app(app) {
            return Some(event);
        }
    }
    if let Some(ref window) = window_title {
        if !state.config.should_capture_window(window) {
            return Some(event);
        }
    }

    match event_type {
        cg::EventType::LEFT_MOUSE_DOWN | cg::EventType::RIGHT_MOUSE_DOWN => {
            // Record activity
            if let Some(ref feed) = state.activity_feed {
                feed.record(ActivityKind::MouseClick);
            }

            if !state.config.capture_clicks {
                return Some(event);
            }

            let btn = if event_type == cg::EventType::LEFT_MOUSE_DOWN {
                0
            } else {
                1
            };
            let clicks = event.field_i64(cg::EventField::MOUSE_EVENT_CLICK_STATE) as u8;

            let mut ui_event = UiEvent::click(
                timestamp,
                t,
                loc.x as i32,
                loc.y as i32,
                btn,
                clicks,
                mods.0,
            );
            ui_event.app_name = app_name.clone();
            ui_event.window_title = window_title.clone();

            let _ = state.tx.try_send(ui_event);

            // Capture element context in background
            if state.config.capture_context {
                let tx = state.tx.clone();
                let x = loc.x;
                let y = loc.y;
                let start = state.start;
                let config = state.config.clone();
                let app = app_name.clone();
                let window = window_title.clone();

                std::thread::spawn(move || {
                    if let Some(element) = get_element_at_position(x, y, &config) {
                        // Create a context-only event that can be associated with the click
                        let ctx_event = UiEvent {
                            id: None,
                            timestamp: Utc::now(),
                            relative_ms: start.elapsed().as_millis() as u64,
                            data: EventData::Click {
                                x: x as i32,
                                y: y as i32,
                                button: 0,
                                click_count: 0, // Mark as context-only
                                modifiers: 0,
                            },
                            app_name: app,
                            window_title: window,
                            browser_url: None,
                            element: Some(element),
                            frame_id: None,
                        };
                        let _ = tx.try_send(ctx_event);
                    }
                });
            }
        }

        cg::EventType::MOUSE_MOVED
        | cg::EventType::LEFT_MOUSE_DRAGGED
        | cg::EventType::RIGHT_MOUSE_DRAGGED => {
            let mut last = state.last_mouse.lock();
            let dx = loc.x - last.0;
            let dy = loc.y - last.1;
            let dist = (dx * dx + dy * dy).sqrt();

            if dist >= state.config.mouse_move_threshold {
                // Record activity (throttled by distance)
                if let Some(ref feed) = state.activity_feed {
                    feed.record(ActivityKind::MouseMove);
                }

                *last = (loc.x, loc.y);

                if state.config.capture_mouse_move {
                    let ui_event = UiEvent {
                        id: None,
                        timestamp,
                        relative_ms: t,
                        data: EventData::Move {
                            x: loc.x as i32,
                            y: loc.y as i32,
                        },
                        app_name,
                        window_title,
                        browser_url: None,
                        element: None,
                        frame_id: None,
                    };
                    let _ = state.tx.try_send(ui_event);
                }
            }
        }

        cg::EventType::SCROLL_WHEEL => {
            // Record activity for adaptive FPS even when scroll capture is off
            if let Some(ref feed) = state.activity_feed {
                feed.record(ActivityKind::Scroll);
            }

            if state.config.capture_scroll {
                let dy = event.field_i64(cg::EventField::SCROLL_WHEEL_EVENT_DELTA_AXIS1) as i16;
                let dx = event.field_i64(cg::EventField::SCROLL_WHEEL_EVENT_DELTA_AXIS2) as i16;
                if dx != 0 || dy != 0 {
                    let ui_event = UiEvent {
                        id: None,
                        timestamp,
                        relative_ms: t,
                        data: EventData::Scroll {
                            x: loc.x as i32,
                            y: loc.y as i32,
                            delta_x: dx,
                            delta_y: dy,
                        },
                        app_name,
                        window_title,
                        browser_url: None,
                        element: None,
                        frame_id: None,
                    };
                    let _ = state.tx.try_send(ui_event);
                }
            }
        }

        cg::EventType::KEY_UP => {
            // Record key release activity
            if let Some(ref feed) = state.activity_feed {
                feed.record(ActivityKind::KeyRelease);
            }
        }

        cg::EventType::KEY_DOWN => {
            // Record key press activity
            if let Some(ref feed) = state.activity_feed {
                feed.record(ActivityKind::KeyPress);
            }
            let keycode = event.field_i64(cg::EventField::KEYBOARD_EVENT_KEYCODE) as u16;

            // Check for clipboard operations (Cmd+C, Cmd+X, Cmd+V)
            if mods.has_cmd() && !mods.has_ctrl() && state.config.capture_clipboard {
                match keycode {
                    KEY_C => {
                        let tx = state.tx.clone();
                        let start = state.start;
                        let capture_content = state.config.capture_clipboard_content;
                        let apply_pii = state.config.apply_pii_removal;
                        std::thread::spawn(move || {
                            std::thread::sleep(std::time::Duration::from_millis(50));
                            let content = if capture_content {
                                get_clipboard().map(|s| {
                                    let truncated = truncate(&s, 1000);
                                    if apply_pii {
                                        remove_pii(&truncated)
                                    } else {
                                        truncated
                                    }
                                })
                            } else {
                                None
                            };
                            let event = UiEvent {
                                id: None,
                                timestamp: Utc::now(),
                                relative_ms: start.elapsed().as_millis() as u64,
                                data: EventData::Clipboard {
                                    operation: 'c',
                                    content,
                                },
                                app_name: None,
                                window_title: None,
                                browser_url: None,
                                element: None,
                                frame_id: None,
                            };
                            let _ = tx.try_send(event);
                        });
                    }
                    KEY_X => {
                        let tx = state.tx.clone();
                        let start = state.start;
                        let capture_content = state.config.capture_clipboard_content;
                        let apply_pii = state.config.apply_pii_removal;
                        std::thread::spawn(move || {
                            std::thread::sleep(std::time::Duration::from_millis(50));
                            let content = if capture_content {
                                get_clipboard().map(|s| {
                                    let truncated = truncate(&s, 1000);
                                    if apply_pii {
                                        remove_pii(&truncated)
                                    } else {
                                        truncated
                                    }
                                })
                            } else {
                                None
                            };
                            let event = UiEvent {
                                id: None,
                                timestamp: Utc::now(),
                                relative_ms: start.elapsed().as_millis() as u64,
                                data: EventData::Clipboard {
                                    operation: 'x',
                                    content,
                                },
                                app_name: None,
                                window_title: None,
                                browser_url: None,
                                element: None,
                                frame_id: None,
                            };
                            let _ = tx.try_send(event);
                        });
                    }
                    KEY_V => {
                        let content = if state.config.capture_clipboard_content {
                            get_clipboard().map(|s| {
                                let truncated = truncate(&s, 1000);
                                if state.config.apply_pii_removal {
                                    remove_pii(&truncated)
                                } else {
                                    truncated
                                }
                            })
                        } else {
                            None
                        };
                        let event = UiEvent {
                            id: None,
                            timestamp,
                            relative_ms: t,
                            data: EventData::Clipboard {
                                operation: 'v',
                                content,
                            },
                            app_name: app_name.clone(),
                            window_title: window_title.clone(),
                            browser_url: None,
                            element: None,
                            frame_id: None,
                        };
                        let _ = state.tx.try_send(event);
                    }
                    _ => {}
                }
            }

            // Record key events for shortcuts
            if mods.any_modifier() {
                let event = UiEvent {
                    id: None,
                    timestamp,
                    relative_ms: t,
                    data: EventData::Key {
                        key_code: keycode,
                        modifiers: mods.0,
                    },
                    app_name,
                    window_title,
                    browser_url: None,
                    element: None,
                    frame_id: None,
                };
                let _ = state.tx.try_send(event);
            } else if state.config.capture_text {
                // Aggregate into text buffer
                if let Some(c) = keycode_to_char(keycode, mods) {
                    state.text_buf.lock().push(c);
                } else if state.config.capture_keystrokes {
                    // Unknown key, record as key event
                    let event = UiEvent {
                        id: None,
                        timestamp,
                        relative_ms: t,
                        data: EventData::Key {
                            key_code: keycode,
                            modifiers: mods.0,
                        },
                        app_name,
                        window_title,
                        browser_url: None,
                        element: None,
                        frame_id: None,
                    };
                    let _ = state.tx.try_send(event);
                }
            }
        }

        _ => {}
    }

    Some(event)
}

// ============================================================================
// App/Window Observer
// ============================================================================

fn run_app_observer(
    tx: Sender<UiEvent>,
    stop: Arc<AtomicBool>,
    start: Instant,
    config: UiCaptureConfig,
    current_app: Arc<Mutex<Option<String>>>,
    current_window: Arc<Mutex<Option<String>>>,
) {
    let workspace = ns::Workspace::shared();

    let mut last_app: Option<String> = None;
    let mut last_pid: i32 = 0;
    let mut last_window: Option<String> = None;

    while !stop.load(Ordering::Relaxed) {
        let apps = workspace.running_apps();
        let active_app = apps.iter().find(|app| app.is_active());

        if let Some(app) = active_app {
            let name = app
                .localized_name()
                .map(|s| s.to_string())
                .unwrap_or_else(|| "?".to_string());
            let pid = app.pid();

            // Check exclusions
            if !config.should_capture_app(&name) {
                std::thread::sleep(std::time::Duration::from_millis(100));
                continue;
            }

            let app_changed = last_app.as_ref() != Some(&name) || last_pid != pid;

            if app_changed {
                // Update shared state for event tap thread
                *current_app.lock() = Some(name.clone());

                if config.capture_app_switch {
                    // Capture focused element's context (including text field values)
                    let focused_element = get_focused_element_context(&config);

                    let mut event = UiEvent::app_switch(
                        Utc::now(),
                        start.elapsed().as_millis() as u64,
                        name.clone(),
                        pid,
                    );
                    event.element = focused_element;
                    let _ = tx.try_send(event);
                }
                last_app = Some(name.clone());
                last_pid = pid;
            }

            // Check window change
            let window_title = get_focused_window_title(pid);

            // Check window exclusions
            let should_capture = window_title
                .as_ref()
                .map(|w| config.should_capture_window(w))
                .unwrap_or(true);

            if should_capture && (window_title != last_window || app_changed) {
                // Update shared state for event tap thread
                *current_window.lock() = window_title.clone();

                if config.capture_window_focus {
                    // Capture focused element's context (including text field values)
                    let focused_element = get_focused_element_context(&config);

                    let event = UiEvent {
                        id: None,
                        timestamp: Utc::now(),
                        relative_ms: start.elapsed().as_millis() as u64,
                        data: EventData::WindowFocus {
                            app: name,
                            title: window_title.clone().map(|s| truncate(&s, 200)),
                        },
                        app_name: None,
                        window_title: None,
                        browser_url: None,
                        element: focused_element,
                        frame_id: None,
                    };
                    let _ = tx.try_send(event);
                }
                last_window = window_title;
            }
        }

        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

// ============================================================================
// Accessibility Helpers
// ============================================================================

fn get_element_at_position(x: f64, y: f64, config: &UiCaptureConfig) -> Option<ElementContext> {
    // Skip menu bar area (top ~30 pixels) to avoid conflicts with tray icon accessibility
    // This prevents crashes when clicking tray icons while accessibility capture is active
    if y < 30.0 {
        return None;
    }

    let sys = ax::UiElement::sys_wide();
    let elem = sys.element_at_pos(x as f32, y as f32).ok()?;

    let role = elem.role().ok().map(|r| {
        let s = format!("{:?}", r);
        if let Some(start) = s.find("AX") {
            let rest = &s[start..];
            let end = rest.find([')', '"', '}']).unwrap_or(rest.len());
            rest[..end].to_string()
        } else {
            "Unknown".to_string()
        }
    })?;

    // Try multiple attributes to get the element name/label
    // Different elements use different attributes for their label
    let name = get_string_attr(&elem, ax::attr::title())
        .or_else(|| get_string_attr(&elem, ax::attr::desc()))
        .or_else(|| {
            // For buttons and many controls, the value contains the label
            if role.contains("Button") || role.contains("MenuItem") || role.contains("Link") {
                get_string_attr(&elem, ax::attr::value())
            } else {
                None
            }
        })
        .or_else(|| {
            // Try to get the title from role description
            elem.role_desc().ok().map(|s| s.to_string())
        });

    if config.is_password_field(Some(&role), name.as_deref()) {
        // Don't capture value for password fields
        return Some(ElementContext {
            role,
            name: Some("[password field]".to_string()),
            value: None,
            description: None,
            automation_id: None,
            bounds: None,
        });
    }

    let value =
        if role.contains("TextField") || role.contains("TextArea") || role.contains("ComboBox") {
            get_string_attr(&elem, ax::attr::value())
        } else {
            None
        };
    let description = get_string_attr(&elem, ax::attr::desc());

    Some(ElementContext {
        role,
        name: name.map(|s| truncate(&s, 200)),
        value: value.map(|s| {
            let truncated = truncate(&s, 500);
            if config.apply_pii_removal {
                remove_pii(&truncated)
            } else {
                truncated
            }
        }),
        description: description.map(|s| truncate(&s, 200)),
        automation_id: None,
        bounds: None,
    })
}

fn get_string_attr(elem: &ax::UiElement, attr: &ax::Attr) -> Option<String> {
    elem.attr_value(attr).ok().and_then(|v| {
        if v.get_type_id() == cf::String::type_id() {
            let s: &cf::String = unsafe { std::mem::transmute(&*v) };
            Some(s.to_string())
        } else {
            None
        }
    })
}

fn get_focused_window_title(pid: i32) -> Option<String> {
    let app = ax::UiElement::with_app_pid(pid);
    let focused = app.attr_value(ax::attr::focused_window()).ok()?;

    if focused.get_type_id() == ax::UiElement::type_id() {
        let window: &ax::UiElement = unsafe { std::mem::transmute(&*focused) };
        get_string_attr(window, ax::attr::title())
    } else {
        None
    }
}

/// Get the currently focused UI element's context (for capturing text field values)
fn get_focused_element_context(config: &UiCaptureConfig) -> Option<ElementContext> {
    let sys = ax::UiElement::sys_wide();
    let focused = sys.attr_value(ax::attr::focused_ui_element()).ok()?;

    if focused.get_type_id() != ax::UiElement::type_id() {
        return None;
    }

    let elem: &ax::UiElement = unsafe { std::mem::transmute(&*focused) };

    let role = elem.role().ok().map(|r| {
        let s = format!("{:?}", r);
        if let Some(start) = s.find("AX") {
            let rest = &s[start..];
            let end = rest.find([')', '"', '}']).unwrap_or(rest.len());
            rest[..end].to_string()
        } else {
            "Unknown".to_string()
        }
    })?;

    // Get element name/label
    let name = get_string_attr(elem, ax::attr::title())
        .or_else(|| get_string_attr(elem, ax::attr::desc()))
        .or_else(|| elem.role_desc().ok().map(|s| s.to_string()));

    // Check for password field
    if config.is_password_field(Some(&role), name.as_deref()) {
        return Some(ElementContext {
            role,
            name: Some("[password field]".to_string()),
            value: None,
            description: None,
            automation_id: None,
            bounds: None,
        });
    }

    // Get value for text input elements
    let value = if role.contains("TextField")
        || role.contains("TextArea")
        || role.contains("ComboBox")
        || role.contains("SearchField")
        || role.contains("TextInput")
    {
        get_string_attr(elem, ax::attr::value())
    } else {
        None
    };

    Some(ElementContext {
        role,
        name: name.map(|s| truncate(&s, 200)),
        value: value.map(|s| {
            let truncated = truncate(&s, 1000); // Allow more text for input fields
            if config.apply_pii_removal {
                remove_pii(&truncated)
            } else {
                truncated
            }
        }),
        description: None,
        automation_id: None,
        bounds: None,
    })
}

fn get_clipboard() -> Option<String> {
    std::process::Command::new("pbpaste")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .filter(|s| !s.is_empty())
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        // Find a valid char boundary to avoid panicking on multi-byte UTF-8
        let mut end = max - 3;
        while end > 0 && !s.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}...", &s[..end])
    }
}

// ============================================================================
// Keycode Mapping
// ============================================================================

fn keycode_to_char(keycode: u16, mods: Modifiers) -> Option<char> {
    let shift = mods.0 & Modifiers::SHIFT != 0 || mods.0 & Modifiers::CAPS != 0;

    let c = match keycode {
        // Letters
        0 => 'a',
        1 => 's',
        2 => 'd',
        3 => 'f',
        4 => 'h',
        5 => 'g',
        6 => 'z',
        7 => 'x',
        8 => 'c',
        9 => 'v',
        11 => 'b',
        12 => 'q',
        13 => 'w',
        14 => 'e',
        15 => 'r',
        16 => 'y',
        17 => 't',
        31 => 'o',
        32 => 'u',
        34 => 'i',
        35 => 'p',
        37 => 'l',
        38 => 'j',
        40 => 'k',
        45 => 'n',
        46 => 'm',
        // Numbers
        18 => {
            if shift {
                '!'
            } else {
                '1'
            }
        }
        19 => {
            if shift {
                '@'
            } else {
                '2'
            }
        }
        20 => {
            if shift {
                '#'
            } else {
                '3'
            }
        }
        21 => {
            if shift {
                '$'
            } else {
                '4'
            }
        }
        22 => {
            if shift {
                '^'
            } else {
                '6'
            }
        }
        23 => {
            if shift {
                '%'
            } else {
                '5'
            }
        }
        24 => {
            if shift {
                '+'
            } else {
                '='
            }
        }
        25 => {
            if shift {
                '('
            } else {
                '9'
            }
        }
        26 => {
            if shift {
                '&'
            } else {
                '7'
            }
        }
        27 => {
            if shift {
                '_'
            } else {
                '-'
            }
        }
        28 => {
            if shift {
                '*'
            } else {
                '8'
            }
        }
        29 => {
            if shift {
                ')'
            } else {
                '0'
            }
        }
        // Punctuation
        30 => {
            if shift {
                '}'
            } else {
                ']'
            }
        }
        33 => {
            if shift {
                '{'
            } else {
                '['
            }
        }
        39 => {
            if shift {
                '"'
            } else {
                '\''
            }
        }
        41 => {
            if shift {
                ':'
            } else {
                ';'
            }
        }
        42 => {
            if shift {
                '|'
            } else {
                '\\'
            }
        }
        43 => {
            if shift {
                '<'
            } else {
                ','
            }
        }
        44 => {
            if shift {
                '?'
            } else {
                '/'
            }
        }
        47 => {
            if shift {
                '>'
            } else {
                '.'
            }
        }
        50 => {
            if shift {
                '~'
            } else {
                '`'
            }
        }
        // Whitespace
        36 => '\n',
        48 => '\t',
        49 => ' ',
        // Backspace
        51 => '\x08',
        _ => return None,
    };

    // Handle shift for letters
    if shift && c.is_ascii_lowercase() {
        Some(c.to_ascii_uppercase())
    } else {
        Some(c)
    }
}

// ============================================================================
// Activity-Only Event Tap (minimal, for adaptive FPS without full event capture)
// ============================================================================

fn run_activity_only_tap(activity_feed: ActivityFeed, stop: Arc<AtomicBool>) {
    debug!("Starting activity-only event tap");

    // Minimal event mask for activity detection
    let mask = cg::EventType::KEY_DOWN.mask()
        | cg::EventType::KEY_UP.mask()
        | cg::EventType::LEFT_MOUSE_DOWN.mask()
        | cg::EventType::RIGHT_MOUSE_DOWN.mask()
        | cg::EventType::MOUSE_MOVED.mask()
        | cg::EventType::SCROLL_WHEEL.mask();

    // Store activity feed in a box for the callback
    let feed_ptr = Box::into_raw(Box::new(activity_feed));

    let tap = cg::EventTap::new(
        cg::EventTapLocation::Session,
        cg::EventTapPlacement::TailAppend,
        cg::EventTapOpts::LISTEN_ONLY,
        mask,
        activity_only_callback,
        feed_ptr,
    );

    let Some(tap) = tap else {
        error!("Failed to create activity-only CGEventTap");
        // Clean up the leaked box
        unsafe {
            let _ = Box::from_raw(feed_ptr);
        }
        return;
    };

    let Some(src) = cf::MachPort::run_loop_src(&tap, 0) else {
        error!("Failed to create run loop source");
        unsafe {
            let _ = Box::from_raw(feed_ptr);
        }
        return;
    };

    let rl = cf::RunLoop::current();
    rl.add_src(&src, cf::RunLoopMode::default());

    debug!("Activity-only event tap started");

    while !stop.load(Ordering::Relaxed) {
        cf::RunLoop::run_in_mode(cf::RunLoopMode::default(), 0.05, true);
    }

    rl.remove_src(&src, cf::RunLoopMode::default());

    // Clean up
    unsafe {
        let _ = Box::from_raw(feed_ptr);
    }

    debug!("Activity-only event tap stopped");
}

extern "C" fn activity_only_callback(
    _proxy: *mut cg::EventTapProxy,
    event_type: cg::EventType,
    event: &mut cg::Event,
    user_info: *mut ActivityFeed,
) -> Option<&cg::Event> {
    let feed = unsafe { &*user_info };

    match event_type {
        cg::EventType::KEY_DOWN => {
            feed.record(ActivityKind::KeyPress);
        }
        cg::EventType::KEY_UP => {
            feed.record(ActivityKind::KeyRelease);
        }
        cg::EventType::LEFT_MOUSE_DOWN | cg::EventType::RIGHT_MOUSE_DOWN => {
            feed.record(ActivityKind::MouseClick);
        }
        cg::EventType::MOUSE_MOVED => {
            feed.record(ActivityKind::MouseMove);
        }
        cg::EventType::SCROLL_WHEEL => {
            feed.record(ActivityKind::Scroll);
        }
        _ => {}
    }

    Some(event)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_permission_check() {
        // This will fail without permissions, but should not panic
        let recorder = UiRecorder::with_defaults();
        let perms = recorder.check_permissions();
        // Just verify we get a result
        let _ = perms.all_granted();
    }

    #[test]
    fn test_keycode_mapping() {
        assert_eq!(keycode_to_char(0, Modifiers::new()), Some('a'));
        assert_eq!(keycode_to_char(0, Modifiers(Modifiers::SHIFT)), Some('A'));
        assert_eq!(keycode_to_char(49, Modifiers::new()), Some(' '));
        assert_eq!(keycode_to_char(36, Modifiers::new()), Some('\n'));
    }

    #[test]
    fn test_truncate() {
        assert_eq!(truncate("hello", 10), "hello");
        assert_eq!(truncate("hello world", 8), "hello...");
    }
}
