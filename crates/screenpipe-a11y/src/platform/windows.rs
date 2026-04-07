//! Windows UI event capture using native SetWindowsHookEx and UI Automation
//!
//! Uses low-level Windows hooks for keyboard and mouse input capture.

use crate::activity_feed::{ActivityFeed, ActivityKind};
use crate::config::UiCaptureConfig;
use crate::events::{ElementContext, EventData, UiEvent, WindowTreeSnapshot};
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

use super::windows_uia::{self, ClickElementRequest};

use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetKeyState, VK_CAPITAL, VK_CONTROL, VK_LCONTROL, VK_LMENU, VK_LSHIFT, VK_LWIN, VK_MENU,
    VK_RCONTROL, VK_RMENU, VK_RSHIFT, VK_RWIN, VK_SHIFT,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetForegroundWindow, GetMessageW, GetWindowTextW,
    GetWindowThreadProcessId, PostThreadMessageW, SetTimer, SetWindowsHookExW, TranslateMessage,
    UnhookWindowsHookEx, EVENT_SYSTEM_FOREGROUND, HC_ACTION, HHOOK, KBDLLHOOKSTRUCT, MSG,
    MSLLHOOKSTRUCT, WH_KEYBOARD_LL, WH_MOUSE_LL, WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS,
    WM_KEYDOWN, WM_KEYUP, WM_LBUTTONDOWN, WM_MBUTTONDOWN, WM_MOUSEMOVE, WM_MOUSEWHEEL, WM_QUIT,
    WM_RBUTTONDOWN, WM_SYSKEYDOWN, WM_SYSKEYUP, WM_TIMER, WM_XBUTTONDOWN,
};

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

/// UI Event recorder for Windows
pub struct UiRecorder {
    config: UiCaptureConfig,
}

/// Handle to a running recording session
pub struct RecordingHandle {
    stop: Arc<AtomicBool>,
    events_rx: Receiver<UiEvent>,
    tree_rx: Receiver<WindowTreeSnapshot>,
    threads: Vec<thread::JoinHandle<()>>,
}

impl RecordingHandle {
    pub fn stop(self) {
        self.stop.store(true, Ordering::SeqCst);
        // Give threads time to see the stop flag
        std::thread::sleep(std::time::Duration::from_millis(100));
        for t in self.threads {
            let _ = t.join();
        }
    }

    pub fn is_running(&self) -> bool {
        !self.stop.load(Ordering::Relaxed)
    }

    pub fn receiver(&self) -> &Receiver<UiEvent> {
        &self.events_rx
    }

    /// Receiver for accessibility tree snapshots
    pub fn tree_receiver(&self) -> &Receiver<WindowTreeSnapshot> {
        &self.tree_rx
    }

    pub fn try_recv(&self) -> Option<UiEvent> {
        self.events_rx.try_recv().ok()
    }

    pub fn recv(&self) -> Option<UiEvent> {
        self.events_rx.recv().ok()
    }

    pub fn recv_timeout(&self, timeout: std::time::Duration) -> Option<UiEvent> {
        self.events_rx.recv_timeout(timeout).ok()
    }

    /// Try to receive a tree snapshot without blocking
    pub fn try_recv_tree(&self) -> Option<WindowTreeSnapshot> {
        self.tree_rx.try_recv().ok()
    }
}

impl UiRecorder {
    pub fn new(config: UiCaptureConfig) -> Self {
        Self { config }
    }

    pub fn with_defaults() -> Self {
        Self::new(UiCaptureConfig::new())
    }

    /// Windows doesn't require explicit permissions for hooks
    pub fn check_permissions(&self) -> PermissionStatus {
        PermissionStatus {
            accessibility: true,
            input_monitoring: true,
        }
    }

    pub fn request_permissions(&self) -> PermissionStatus {
        self.check_permissions()
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
        let activity_feed = ActivityFeed::new();
        let stop = Arc::new(AtomicBool::new(false));

        let feed_clone = activity_feed.clone();
        let stop_clone = stop.clone();

        // Spawn minimal hook thread
        thread::spawn(move || {
            run_activity_only_hooks(feed_clone, stop_clone);
        });

        Ok(activity_feed)
    }

    fn start_internal(
        &self,
        activity_feed: Option<ActivityFeed>,
    ) -> Result<(RecordingHandle, Option<ActivityFeed>)> {
        let (tx, rx) = bounded::<UiEvent>(self.config.max_buffer_size);
        let (tree_tx, tree_rx) = bounded::<WindowTreeSnapshot>(32);
        let stop = Arc::new(AtomicBool::new(false));
        let start_time = Instant::now();

        let mut threads = Vec::new();

        // Shared state for current app/window between threads
        let current_app = Arc::new(Mutex::new(None::<String>));
        let current_window = Arc::new(Mutex::new(None::<String>));

        // Shared state for UIA thread
        let click_queue = Arc::new(Mutex::new(Vec::<ClickElementRequest>::new()));
        let focused_element = Arc::new(Mutex::new(None::<ElementContext>));

        // Thread 1: Native Windows hooks for input events
        let tx1 = tx.clone();
        let stop1 = stop.clone();
        let config1 = self.config.clone();
        let app1 = current_app.clone();
        let window1 = current_window.clone();
        let feed1 = activity_feed.clone();
        let click_queue1 = click_queue.clone();
        let focused_element1 = focused_element.clone();
        threads.push(thread::spawn(move || {
            run_native_hooks(
                tx1,
                stop1,
                start_time,
                config1,
                app1,
                window1,
                feed1,
                click_queue1,
                focused_element1,
            );
        }));

        // Thread 2: App/window observer
        let tx2 = tx.clone();
        let stop2 = stop.clone();
        let config2 = self.config.clone();
        let app2 = current_app.clone();
        let window2 = current_window.clone();
        let focused_element2 = focused_element.clone();
        threads.push(thread::spawn(move || {
            run_app_observer(
                tx2,
                stop2,
                start_time,
                config2,
                app2,
                window2,
                focused_element2,
            );
        }));

        // Thread 3: UI Automation worker (tree capture, element context, clipboard)
        let (element_tx, element_rx) = bounded::<(ClickElementRequest, ElementContext)>(100);
        let stop3 = stop.clone();
        let config3 = self.config.clone();
        let click_queue3 = click_queue.clone();
        let focused_element3 = focused_element.clone();
        threads.push(thread::spawn(move || {
            windows_uia::run_uia_thread(
                tree_tx,
                element_tx,
                click_queue3,
                focused_element3,
                stop3,
                config3,
            );
        }));

        // Thread 4: Element context enrichment (sends enriched click events)
        let tx4 = tx.clone();
        let stop4 = stop.clone();
        threads.push(thread::spawn(move || {
            while !stop4.load(Ordering::Relaxed) {
                match element_rx.recv_timeout(std::time::Duration::from_millis(100)) {
                    Ok((req, ctx)) => {
                        // Send a supplementary event with the element context for the click
                        let event = UiEvent {
                            id: None,
                            timestamp: req.timestamp,
                            relative_ms: 0,
                            data: EventData::Click {
                                x: req.x,
                                y: req.y,
                                button: 0,
                                click_count: 0, // Marker: this is an element-context-only event
                                modifiers: 0,
                            },
                            app_name: None,
                            window_title: None,
                            browser_url: None,
                            element: Some(ctx),
                            frame_id: None,
                        };
                        let _ = tx4.try_send(event);
                    }
                    Err(crossbeam_channel::RecvTimeoutError::Timeout) => continue,
                    Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
                }
            }
        }));

        Ok((
            RecordingHandle {
                stop,
                events_rx: rx,
                tree_rx,
                threads,
            },
            activity_feed,
        ))
    }
}

// ============================================================================
// Thread-local state for hook callbacks
// ============================================================================

struct HookState {
    tx: Sender<UiEvent>,
    start: Instant,
    config: UiCaptureConfig,
    last_mouse_pos: (i32, i32),
    text_buf: String,
    last_text_time: Option<Instant>,
    current_app: Arc<Mutex<Option<String>>>,
    current_window: Arc<Mutex<Option<String>>>,
    activity_feed: Option<ActivityFeed>,
    click_queue: Arc<Mutex<Vec<ClickElementRequest>>>,
    focused_element: Arc<Mutex<Option<ElementContext>>>,
}

// Thread-local storage for hook state
thread_local! {
    static HOOK_STATE: std::cell::RefCell<Option<Box<HookState>>> = const { std::cell::RefCell::new(None) };
    static KEYBOARD_HOOK: std::cell::RefCell<Option<HHOOK>> = const { std::cell::RefCell::new(None) };
    static MOUSE_HOOK: std::cell::RefCell<Option<HHOOK>> = const { std::cell::RefCell::new(None) };
}

// ============================================================================
// Native Windows Hooks
// ============================================================================

fn run_native_hooks(
    tx: Sender<UiEvent>,
    stop: Arc<AtomicBool>,
    start: Instant,
    config: UiCaptureConfig,
    current_app: Arc<Mutex<Option<String>>>,
    current_window: Arc<Mutex<Option<String>>>,
    activity_feed: Option<ActivityFeed>,
    click_queue: Arc<Mutex<Vec<ClickElementRequest>>>,
    focused_element: Arc<Mutex<Option<ElementContext>>>,
) {
    debug!("Starting native Windows hooks");

    // Initialize thread-local state
    HOOK_STATE.with(|state| {
        *state.borrow_mut() = Some(Box::new(HookState {
            tx,
            start,
            config: config.clone(),
            last_mouse_pos: (0, 0),
            text_buf: String::new(),
            last_text_time: None,
            current_app,
            current_window,
            activity_feed,
            click_queue,
            focused_element,
        }));
    });

    unsafe {
        let h_instance: HINSTANCE = GetModuleHandleW(None).unwrap_or_default().into();

        // Install keyboard hook
        let kb_hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_hook_proc), h_instance, 0);

        if let Ok(hook) = kb_hook {
            KEYBOARD_HOOK.with(|h| *h.borrow_mut() = Some(hook));
            debug!("Keyboard hook installed");
        } else {
            error!("Failed to install keyboard hook");
        }

        // Install mouse hook
        let mouse_hook = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook_proc), h_instance, 0);

        if let Ok(hook) = mouse_hook {
            MOUSE_HOOK.with(|h| *h.borrow_mut() = Some(hook));
            debug!("Mouse hook installed");
        } else {
            error!("Failed to install mouse hook");
        }

        // Message loop (required for hooks to receive events)
        // Install a timer so GetMessageW wakes periodically for text buffer flushing.
        // Without this, typed text stays in the buffer until the next input event.
        const TEXT_FLUSH_TIMER_ID: usize = 42;
        SetTimer(HWND::default(), TEXT_FLUSH_TIMER_ID, 100, None);

        let mut msg = MSG::default();
        while !stop.load(Ordering::Relaxed) {
            if GetMessageW(&mut msg, HWND::default(), 0, 0).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }

            // Check for text buffer flush (runs on timer tick and after every message)
            HOOK_STATE.with(|state| {
                // Use try_borrow_mut to avoid panic — LL hook callbacks can
                // fire synchronously during DispatchMessageW above
                if let Ok(mut guard) = state.try_borrow_mut() {
                    if let Some(ref mut s) = *guard {
                        if let Some(last_time) = s.last_text_time {
                            if last_time.elapsed().as_millis() as u64 >= s.config.text_timeout_ms {
                                flush_text_buffer(s);
                            }
                        }
                    }
                }
            });
        }

        // Cleanup hooks
        KEYBOARD_HOOK.with(|h| {
            if let Some(hook) = h.borrow_mut().take() {
                let _ = UnhookWindowsHookEx(hook);
            }
        });

        MOUSE_HOOK.with(|h| {
            if let Some(hook) = h.borrow_mut().take() {
                let _ = UnhookWindowsHookEx(hook);
            }
        });

        // Final text buffer flush
        HOOK_STATE.with(|state| {
            if let Some(ref mut s) = *state.borrow_mut() {
                flush_text_buffer(s);
            }
        });
    }

    debug!("Native Windows hooks stopped");
}

fn flush_text_buffer(state: &mut HookState) {
    if !state.text_buf.is_empty() {
        let content = std::mem::take(&mut state.text_buf);
        let text = if state.config.apply_pii_removal {
            remove_pii(&content)
        } else {
            content
        };
        let event = UiEvent::text(Utc::now(), state.start.elapsed().as_millis() as u64, text);
        let _ = state.tx.try_send(event);
        state.last_text_time = None;
    }
}

unsafe extern "system" fn keyboard_hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        let kb_struct = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
        let vk_code = kb_struct.vkCode as u16;
        let is_key_down = wparam.0 as u32 == WM_KEYDOWN || wparam.0 as u32 == WM_SYSKEYDOWN;
        let is_key_up = wparam.0 as u32 == WM_KEYUP || wparam.0 as u32 == WM_SYSKEYUP;

        HOOK_STATE.with(|state| {
            // Use try_borrow_mut to avoid panic if the RefCell is already borrowed
            // (e.g., during text buffer flush in the message loop)
            let Ok(mut guard) = state.try_borrow_mut() else {
                return;
            };
            if let Some(ref mut s) = *guard {
                // Record activity
                if let Some(ref feed) = s.activity_feed {
                    if is_key_down {
                        feed.record(ActivityKind::KeyPress);
                    } else if is_key_up {
                        feed.record(ActivityKind::KeyRelease);
                    }
                }

                // Only process key down events for UI events
                if !is_key_down {
                    return;
                }

                let timestamp = Utc::now();
                let t = s.start.elapsed().as_millis() as u64;
                let mods = get_modifier_state();

                let app_name = s.current_app.lock().clone();
                let window_title = s.current_window.lock().clone();

                // Check exclusions
                if let Some(ref app) = app_name {
                    if !s.config.should_capture_app(app) {
                        return;
                    }
                }
                if let Some(ref window) = window_title {
                    if !s.config.should_capture_window(window) {
                        return;
                    }
                }

                // Check for clipboard operations (Ctrl+C, Ctrl+X, Ctrl+V)
                if mods & 0x02 != 0 && s.config.capture_clipboard {
                    // Ctrl is pressed
                    let apply_pii = s.config.apply_pii_removal;
                    match vk_code {
                        0x43 => {
                            // C
                            let event = UiEvent {
                                id: None,
                                timestamp,
                                relative_ms: t,
                                data: EventData::Clipboard {
                                    operation: 'c',
                                    content: if s.config.capture_clipboard_content {
                                        get_clipboard_text().map(|c| {
                                            if apply_pii {
                                                remove_pii(&c)
                                            } else {
                                                c
                                            }
                                        })
                                    } else {
                                        None
                                    },
                                },
                                app_name: app_name.clone(),
                                window_title: window_title.clone(),
                                browser_url: None,
                                element: None,
                                frame_id: None,
                            };
                            let _ = s.tx.try_send(event);
                            return;
                        }
                        0x58 => {
                            // X
                            let event = UiEvent {
                                id: None,
                                timestamp,
                                relative_ms: t,
                                data: EventData::Clipboard {
                                    operation: 'x',
                                    content: if s.config.capture_clipboard_content {
                                        get_clipboard_text().map(|c| {
                                            if apply_pii {
                                                remove_pii(&c)
                                            } else {
                                                c
                                            }
                                        })
                                    } else {
                                        None
                                    },
                                },
                                app_name: app_name.clone(),
                                window_title: window_title.clone(),
                                browser_url: None,
                                element: None,
                                frame_id: None,
                            };
                            let _ = s.tx.try_send(event);
                            return;
                        }
                        0x56 => {
                            // V
                            let event = UiEvent {
                                id: None,
                                timestamp,
                                relative_ms: t,
                                data: EventData::Clipboard {
                                    operation: 'v',
                                    content: if s.config.capture_clipboard_content {
                                        get_clipboard_text().map(|c| {
                                            if apply_pii {
                                                remove_pii(&c)
                                            } else {
                                                c
                                            }
                                        })
                                    } else {
                                        None
                                    },
                                },
                                app_name: app_name.clone(),
                                window_title: window_title.clone(),
                                browser_url: None,
                                element: None,
                                frame_id: None,
                            };
                            let _ = s.tx.try_send(event);
                            return;
                        }
                        _ => {}
                    }
                }

                // Record key events for shortcuts (with modifiers)
                if mods & 0x0A != 0 {
                    // Ctrl or Win pressed
                    let event = UiEvent {
                        id: None,
                        timestamp,
                        relative_ms: t,
                        data: EventData::Key {
                            key_code: vk_code,
                            modifiers: mods,
                        },
                        app_name,
                        window_title,
                        browser_url: None,
                        element: None,
                        frame_id: None,
                    };
                    let _ = s.tx.try_send(event);
                } else if s.config.capture_text {
                    // Aggregate text input
                    if let Some(c) = vk_to_char(vk_code, mods) {
                        if c == '\x08' {
                            // Backspace
                            s.text_buf.pop();
                        } else {
                            s.text_buf.push(c);
                        }
                        s.last_text_time = Some(Instant::now());
                    } else if s.config.capture_keystrokes {
                        // Unknown key, record as key event
                        let event = UiEvent {
                            id: None,
                            timestamp,
                            relative_ms: t,
                            data: EventData::Key {
                                key_code: vk_code,
                                modifiers: mods,
                            },
                            app_name,
                            window_title,
                            browser_url: None,
                            element: None,
                            frame_id: None,
                        };
                        let _ = s.tx.try_send(event);
                    }
                }
            }
        });
    }

    // Call next hook
    KEYBOARD_HOOK.with(|h| {
        let hook = h.borrow();
        CallNextHookEx(hook.unwrap_or_default(), code, wparam, lparam)
    })
}

unsafe extern "system" fn mouse_hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        let mouse_struct = &*(lparam.0 as *const MSLLHOOKSTRUCT);
        let x = mouse_struct.pt.x;
        let y = mouse_struct.pt.y;
        let msg = wparam.0 as u32;

        HOOK_STATE.with(|state| {
            // Use try_borrow_mut to avoid panic if the RefCell is already borrowed
            // (e.g., during text buffer flush in the message loop)
            let Ok(mut guard) = state.try_borrow_mut() else {
                return;
            };
            if let Some(ref mut s) = *guard {
                // Fast path for WM_MOUSEMOVE — no mutex locks to avoid blocking
                // the system-wide mouse input pipeline (critical for RDP cursor rendering)
                if msg == WM_MOUSEMOVE {
                    let (last_x, last_y) = s.last_mouse_pos;
                    let dx = (x - last_x).abs();
                    let dy = (y - last_y).abs();
                    let moved = dx > 10 || dy > 10;

                    if moved {
                        if let Some(ref feed) = s.activity_feed {
                            feed.record(ActivityKind::MouseMove);
                        }
                        s.last_mouse_pos = (x, y);

                        if s.config.capture_mouse_move {
                            let timestamp = Utc::now();
                            let t = s.start.elapsed().as_millis() as u64;
                            // Use try_lock to avoid blocking — skip if contended
                            let app_name = s.current_app.try_lock().map(|g| g.clone());
                            let window_title = s.current_window.try_lock().map(|g| g.clone());
                            let event = UiEvent {
                                id: None,
                                timestamp,
                                relative_ms: t,
                                data: EventData::Move { x, y },
                                app_name: app_name.unwrap_or(None),
                                window_title: window_title.unwrap_or(None),
                                browser_url: None,
                                element: None,
                                frame_id: None,
                            };
                            let _ = s.tx.try_send(event);
                        }
                    }
                    return;
                }

                // Slow path for clicks/scroll — these are infrequent, mutex locks OK
                let timestamp = Utc::now();
                let t = s.start.elapsed().as_millis() as u64;

                let app_name = s.current_app.lock().clone();
                let window_title = s.current_window.lock().clone();

                // Check exclusions
                if let Some(ref app) = app_name {
                    if !s.config.should_capture_app(app) {
                        return;
                    }
                }

                match msg {
                    WM_LBUTTONDOWN | WM_RBUTTONDOWN | WM_MBUTTONDOWN | WM_XBUTTONDOWN => {
                        // Record activity
                        if let Some(ref feed) = s.activity_feed {
                            feed.record(ActivityKind::MouseClick);
                        }

                        if !s.config.capture_clicks {
                            return;
                        }

                        let button = match msg {
                            WM_LBUTTONDOWN => 0,
                            WM_RBUTTONDOWN => 1,
                            WM_MBUTTONDOWN => 2,
                            _ => 0,
                        };

                        // Attach focused element context (approximate, fast)
                        let element = if s.config.capture_context {
                            s.focused_element.lock().clone()
                        } else {
                            None
                        };

                        let mut event =
                            UiEvent::click(timestamp, t, x, y, button, 1, get_modifier_state());
                        event.app_name = app_name.clone();
                        event.window_title = window_title.clone();
                        event.element = element;
                        let _ = s.tx.try_send(event);

                        // Queue ElementFromPoint request for precise element context
                        if s.config.capture_context {
                            s.click_queue
                                .lock()
                                .push(ClickElementRequest { x, y, timestamp });
                        }
                    }

                    WM_MOUSEWHEEL => {
                        // Record activity for adaptive FPS even when scroll capture is off
                        if let Some(ref feed) = s.activity_feed {
                            feed.record(ActivityKind::Scroll);
                        }

                        if s.config.capture_scroll {
                            // High word of mouseData contains wheel delta
                            let delta = (mouse_struct.mouseData >> 16) as i16;

                            let event = UiEvent {
                                id: None,
                                timestamp,
                                relative_ms: t,
                                data: EventData::Scroll {
                                    x,
                                    y,
                                    delta_x: 0,
                                    delta_y: delta,
                                },
                                app_name,
                                window_title,
                                browser_url: None,
                                element: None,
                                frame_id: None,
                            };
                            let _ = s.tx.try_send(event);
                        }
                    }

                    _ => {}
                }
            }
        });
    }

    // Call next hook
    MOUSE_HOOK.with(|h| {
        let hook = h.borrow();
        CallNextHookEx(hook.unwrap_or_default(), code, wparam, lparam)
    })
}

// ============================================================================
// Activity-only hooks (minimal, for adaptive FPS without full event capture)
// ============================================================================

thread_local! {
    static ACTIVITY_FEED_ONLY: std::cell::RefCell<Option<ActivityFeed>> = const { std::cell::RefCell::new(None) };
    static ACTIVITY_KB_HOOK: std::cell::RefCell<Option<HHOOK>> = const { std::cell::RefCell::new(None) };
    static ACTIVITY_MOUSE_HOOK: std::cell::RefCell<Option<HHOOK>> = const { std::cell::RefCell::new(None) };
}

fn run_activity_only_hooks(activity_feed: ActivityFeed, stop: Arc<AtomicBool>) {
    debug!("Starting activity-only Windows hooks");

    ACTIVITY_FEED_ONLY.with(|f| *f.borrow_mut() = Some(activity_feed));

    unsafe {
        let h_instance: HINSTANCE = GetModuleHandleW(None).unwrap_or_default().into();

        let kb_hook =
            SetWindowsHookExW(WH_KEYBOARD_LL, Some(activity_keyboard_hook), h_instance, 0);
        if let Ok(hook) = kb_hook {
            ACTIVITY_KB_HOOK.with(|h| *h.borrow_mut() = Some(hook));
        }

        let mouse_hook = SetWindowsHookExW(WH_MOUSE_LL, Some(activity_mouse_hook), h_instance, 0);
        if let Ok(hook) = mouse_hook {
            ACTIVITY_MOUSE_HOOK.with(|h| *h.borrow_mut() = Some(hook));
        }

        let mut msg = MSG::default();
        while !stop.load(Ordering::Relaxed) {
            if GetMessageW(&mut msg, HWND::default(), 0, 0).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }

        ACTIVITY_KB_HOOK.with(|h| {
            if let Some(hook) = h.borrow_mut().take() {
                let _ = UnhookWindowsHookEx(hook);
            }
        });
        ACTIVITY_MOUSE_HOOK.with(|h| {
            if let Some(hook) = h.borrow_mut().take() {
                let _ = UnhookWindowsHookEx(hook);
            }
        });
    }

    debug!("Activity-only hooks stopped");
}

unsafe extern "system" fn activity_keyboard_hook(
    code: i32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if code == HC_ACTION as i32 {
        let is_down = wparam.0 as u32 == WM_KEYDOWN || wparam.0 as u32 == WM_SYSKEYDOWN;
        let is_up = wparam.0 as u32 == WM_KEYUP || wparam.0 as u32 == WM_SYSKEYUP;

        ACTIVITY_FEED_ONLY.with(|f| {
            if let Some(ref feed) = *f.borrow() {
                if is_down {
                    feed.record(ActivityKind::KeyPress);
                } else if is_up {
                    feed.record(ActivityKind::KeyRelease);
                }
            }
        });
    }

    ACTIVITY_KB_HOOK.with(|h| {
        let hook = h.borrow();
        CallNextHookEx(hook.unwrap_or_default(), code, wparam, lparam)
    })
}

unsafe extern "system" fn activity_mouse_hook(
    code: i32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if code == HC_ACTION as i32 {
        ACTIVITY_FEED_ONLY.with(|f| {
            if let Some(ref feed) = *f.borrow() {
                match wparam.0 as u32 {
                    WM_LBUTTONDOWN | WM_RBUTTONDOWN | WM_MBUTTONDOWN => {
                        feed.record(ActivityKind::MouseClick);
                    }
                    WM_MOUSEMOVE => {
                        feed.record(ActivityKind::MouseMove);
                    }
                    WM_MOUSEWHEEL => {
                        feed.record(ActivityKind::Scroll);
                    }
                    _ => {}
                }
            }
        });
    }

    ACTIVITY_MOUSE_HOOK.with(|h| {
        let hook = h.borrow();
        CallNextHookEx(hook.unwrap_or_default(), code, wparam, lparam)
    })
}

// ============================================================================
// Helper Functions
// ============================================================================

fn get_modifier_state() -> u8 {
    unsafe {
        let mut mods = 0u8;
        if GetKeyState(VK_SHIFT.0 as i32) < 0
            || GetKeyState(VK_LSHIFT.0 as i32) < 0
            || GetKeyState(VK_RSHIFT.0 as i32) < 0
        {
            mods |= 0x01; // Shift
        }
        if GetKeyState(VK_CONTROL.0 as i32) < 0
            || GetKeyState(VK_LCONTROL.0 as i32) < 0
            || GetKeyState(VK_RCONTROL.0 as i32) < 0
        {
            mods |= 0x02; // Ctrl
        }
        if GetKeyState(VK_MENU.0 as i32) < 0
            || GetKeyState(VK_LMENU.0 as i32) < 0
            || GetKeyState(VK_RMENU.0 as i32) < 0
        {
            mods |= 0x04; // Alt
        }
        if GetKeyState(VK_LWIN.0 as i32) < 0 || GetKeyState(VK_RWIN.0 as i32) < 0 {
            mods |= 0x08; // Win
        }
        mods
    }
}

fn vk_to_char(vk: u16, mods: u8) -> Option<char> {
    let shift = mods & 0x01 != 0 || unsafe { GetKeyState(VK_CAPITAL.0 as i32) & 1 != 0 };

    let c = match vk {
        // Letters (A-Z are 0x41-0x5A)
        0x41..=0x5A => {
            let base = (vk - 0x41) as u8 + b'a';
            if shift {
                (base - 32) as char
            } else {
                base as char
            }
        }
        // Numbers (0-9 are 0x30-0x39)
        0x30 => {
            if shift {
                ')'
            } else {
                '0'
            }
        }
        0x31 => {
            if shift {
                '!'
            } else {
                '1'
            }
        }
        0x32 => {
            if shift {
                '@'
            } else {
                '2'
            }
        }
        0x33 => {
            if shift {
                '#'
            } else {
                '3'
            }
        }
        0x34 => {
            if shift {
                '$'
            } else {
                '4'
            }
        }
        0x35 => {
            if shift {
                '%'
            } else {
                '5'
            }
        }
        0x36 => {
            if shift {
                '^'
            } else {
                '6'
            }
        }
        0x37 => {
            if shift {
                '&'
            } else {
                '7'
            }
        }
        0x38 => {
            if shift {
                '*'
            } else {
                '8'
            }
        }
        0x39 => {
            if shift {
                '('
            } else {
                '9'
            }
        }
        // Space, Enter, Tab, Backspace
        0x20 => ' ',
        0x0D => '\n',
        0x09 => '\t',
        0x08 => '\x08', // Backspace
        // Punctuation
        0xBA => {
            if shift {
                ':'
            } else {
                ';'
            }
        }
        0xBB => {
            if shift {
                '+'
            } else {
                '='
            }
        }
        0xBC => {
            if shift {
                '<'
            } else {
                ','
            }
        }
        0xBD => {
            if shift {
                '_'
            } else {
                '-'
            }
        }
        0xBE => {
            if shift {
                '>'
            } else {
                '.'
            }
        }
        0xBF => {
            if shift {
                '?'
            } else {
                '/'
            }
        }
        0xC0 => {
            if shift {
                '~'
            } else {
                '`'
            }
        }
        0xDB => {
            if shift {
                '{'
            } else {
                '['
            }
        }
        0xDC => {
            if shift {
                '|'
            } else {
                '\\'
            }
        }
        0xDD => {
            if shift {
                '}'
            } else {
                ']'
            }
        }
        0xDE => {
            if shift {
                '"'
            } else {
                '\''
            }
        }
        _ => return None,
    };
    Some(c)
}

fn get_clipboard_text() -> Option<String> {
    windows_uia::get_clipboard_text_impl()
}

// ============================================================================
// App Observer (Windows) — event-driven via SetWinEventHook
// ============================================================================

/// Thread-local state for the app observer WinEvent callback.
struct AppObserverState {
    tx: Sender<UiEvent>,
    start: Instant,
    config: UiCaptureConfig,
    current_app: Arc<Mutex<Option<String>>>,
    current_window: Arc<Mutex<Option<String>>>,
    focused_element: Arc<Mutex<Option<ElementContext>>>,
    last_hwnd: isize,
    last_title: Option<String>,
}

thread_local! {
    static APP_OBSERVER_STATE: std::cell::RefCell<Option<Box<AppObserverState>>> = const { std::cell::RefCell::new(None) };
}

/// Timer ID for the safety-net periodic check.
const APP_OBSERVER_TIMER_ID: usize = 1;

/// Process a foreground window change in the app observer.
fn process_foreground_change(state: &mut AppObserverState) {
    unsafe {
        let hwnd = GetForegroundWindow();
        let hwnd_val = hwnd.0 as isize;

        if hwnd_val == state.last_hwnd {
            return;
        }

        // Get window title
        let mut title_buf = [0u16; 512];
        let len = GetWindowTextW(hwnd, &mut title_buf);
        let title = if len > 0 {
            Some(String::from_utf16_lossy(&title_buf[..len as usize]))
        } else {
            None
        };

        // Get process ID
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));

        // Get process name
        let app_name = get_process_name(pid).unwrap_or_else(|| "Unknown".to_string());

        // Check exclusions
        if !state.config.should_capture_app(&app_name) {
            state.last_hwnd = hwnd_val;
            return;
        }

        if let Some(ref t) = title {
            if !state.config.should_capture_window(t) {
                state.last_hwnd = hwnd_val;
                return;
            }
        }

        // Update shared state for event listener thread
        *state.current_app.lock() = Some(app_name.clone());
        *state.current_window.lock() = title.clone();

        // Get focused element context from UIA thread
        let element = if state.config.capture_context {
            state.focused_element.lock().clone()
        } else {
            None
        };

        // Send app switch event
        if state.config.capture_app_switch {
            let mut event = UiEvent::app_switch(
                Utc::now(),
                state.start.elapsed().as_millis() as u64,
                app_name.clone(),
                pid as i32,
            );
            event.element = element.clone();
            let _ = state.tx.try_send(event);
        }

        // Send window focus event
        if state.config.capture_window_focus && title != state.last_title {
            let event = UiEvent {
                id: None,
                timestamp: Utc::now(),
                relative_ms: state.start.elapsed().as_millis() as u64,
                data: EventData::WindowFocus {
                    app: app_name,
                    title: title.clone(),
                },
                app_name: None,
                window_title: None,
                browser_url: None,
                element,
                frame_id: None,
            };
            let _ = state.tx.try_send(event);
        }

        state.last_hwnd = hwnd_val;
        state.last_title = title;
    }
}

/// WinEvent callback for EVENT_SYSTEM_FOREGROUND changes.
unsafe extern "system" fn foreground_event_proc(
    _hook: HWINEVENTHOOK,
    _event: u32,
    _hwnd: HWND,
    _id_object: i32,
    _id_child: i32,
    _event_thread: u32,
    _event_time: u32,
) {
    APP_OBSERVER_STATE.with(|state| {
        if let Ok(mut guard) = state.try_borrow_mut() {
            if let Some(ref mut s) = *guard {
                process_foreground_change(s);
            }
        }
    });
}

fn run_app_observer(
    tx: Sender<UiEvent>,
    stop: Arc<AtomicBool>,
    start: Instant,
    config: UiCaptureConfig,
    current_app: Arc<Mutex<Option<String>>>,
    current_window: Arc<Mutex<Option<String>>>,
    focused_element: Arc<Mutex<Option<ElementContext>>>,
) {
    // Initialize thread-local state
    APP_OBSERVER_STATE.with(|state| {
        *state.borrow_mut() = Some(Box::new(AppObserverState {
            tx,
            start,
            config,
            current_app,
            current_window,
            focused_element,
            last_hwnd: 0,
            last_title: None,
        }));
    });

    // Save thread ID so the stop logic can post WM_QUIT
    let thread_id = unsafe { GetCurrentThreadId() };

    // Spawn a watcher that posts WM_QUIT when stop is signaled
    let stop_clone = stop.clone();
    thread::spawn(move || {
        while !stop_clone.load(Ordering::Relaxed) {
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        unsafe {
            let _ = PostThreadMessageW(thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
        }
    });

    unsafe {
        // Register WinEvent hook for foreground window changes (event-driven, no polling)
        let hook = SetWinEventHook(
            EVENT_SYSTEM_FOREGROUND,
            EVENT_SYSTEM_FOREGROUND,
            None,
            Some(foreground_event_proc),
            0,
            0,
            WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
        );

        // Safety-net timer: re-check foreground every 2s in case a hook event was missed
        SetTimer(HWND::default(), APP_OBSERVER_TIMER_ID, 2000, None);

        // Process initial foreground window
        APP_OBSERVER_STATE.with(|state| {
            if let Some(ref mut s) = *state.borrow_mut() {
                process_foreground_change(s);
            }
        });

        // Block on message pump (wakes only on events/timer, no busy-polling)
        let mut msg = MSG::default();
        loop {
            let ret = GetMessageW(&mut msg, HWND::default(), 0, 0);
            if ret.0 <= 0 {
                break; // WM_QUIT or error
            }

            // Handle timer messages as a safety-net foreground check
            if msg.message == WM_TIMER && msg.wParam.0 == APP_OBSERVER_TIMER_ID {
                APP_OBSERVER_STATE.with(|state| {
                    if let Ok(mut guard) = state.try_borrow_mut() {
                        if let Some(ref mut s) = *guard {
                            process_foreground_change(s);
                        }
                    }
                });
            }

            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }

        // Cleanup
        if !hook.is_invalid() {
            let _ = UnhookWinEvent(hook);
        }
    }

    debug!("App observer stopped");
}

/// Cached PID→process name mapping with TTL to avoid CreateToolhelp32Snapshot on every lookup.
static PROCESS_NAME_CACHE: std::sync::OnceLock<
    Mutex<std::collections::HashMap<u32, (String, Instant)>>,
> = std::sync::OnceLock::new();

fn process_name_cache() -> &'static Mutex<std::collections::HashMap<u32, (String, Instant)>> {
    PROCESS_NAME_CACHE.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

pub(crate) fn get_process_name(pid: u32) -> Option<String> {
    let now = Instant::now();
    // Check cache first
    {
        let cache = process_name_cache().lock();
        if let Some((name, cached_at)) = cache.get(&pid) {
            if now.duration_since(*cached_at) < std::time::Duration::from_secs(60) {
                return Some(name.clone());
            }
        }
    }
    // Cache miss — do the expensive lookup
    let name = get_process_name_uncached(pid)?;
    {
        let mut cache = process_name_cache().lock();
        // Evict if too large
        if cache.len() > 200 {
            cache.clear();
        }
        cache.insert(pid, (name.clone(), now));
    }
    Some(name)
}

fn get_process_name_uncached(pid: u32) -> Option<String> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).ok()?;

        let mut entry = PROCESSENTRY32W::default();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;

        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                if entry.th32ProcessID == pid {
                    let name_len = entry
                        .szExeFile
                        .iter()
                        .position(|&c| c == 0)
                        .unwrap_or(entry.szExeFile.len());
                    let name = String::from_utf16_lossy(&entry.szExeFile[..name_len]);
                    let _ = CloseHandle(snapshot);
                    return Some(name);
                }

                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }

        let _ = CloseHandle(snapshot);
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_permission_check() {
        let recorder = UiRecorder::with_defaults();
        let perms = recorder.check_permissions();
        assert!(perms.all_granted()); // Windows always grants
    }

    #[test]
    fn test_vk_to_char() {
        assert_eq!(vk_to_char(0x41, 0), Some('a')); // A key, no shift
        assert_eq!(vk_to_char(0x41, 1), Some('A')); // A key, with shift
        assert_eq!(vk_to_char(0x20, 0), Some(' ')); // Space
        assert_eq!(vk_to_char(0x31, 0), Some('1')); // 1 key
        assert_eq!(vk_to_char(0x31, 1), Some('!')); // 1 key with shift
    }

    #[test]
    fn test_modifier_constants() {
        // Verify modifier bit positions
        assert_eq!(0x01, 1); // Shift
        assert_eq!(0x02, 2); // Ctrl
        assert_eq!(0x04, 4); // Alt
        assert_eq!(0x08, 8); // Win
    }

    fn make_test_state(tx: tokio::sync::mpsc::Sender<UiEvent>, text: &str) -> HookState {
        HookState {
            tx,
            start: std::time::Instant::now(),
            config: crate::config::UiCaptureConfig::default(),
            last_mouse_pos: (0, 0),
            text_buf: text.to_string(),
            last_text_time: if text.is_empty() {
                None
            } else {
                Some(std::time::Instant::now())
            },
            current_app: Arc::new(parking_lot::Mutex::new(Some("test".into()))),
            current_window: Arc::new(parking_lot::Mutex::new(Some("test window".into()))),
            activity_feed: None,
            click_queue: Arc::new(parking_lot::Mutex::new(Vec::new())),
            focused_element: Arc::new(parking_lot::Mutex::new(None)),
        }
    }

    #[test]
    fn test_flush_text_buffer() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        let mut state = make_test_state(tx, "hello world");

        // Buffer has content — flush should send a Text event
        flush_text_buffer(&mut state);
        assert!(state.text_buf.is_empty());
        assert!(state.last_text_time.is_none());

        let event = rx.try_recv().unwrap();
        match event.data {
            EventData::Text { ref content, .. } => {
                assert_eq!(content, "hello world");
            }
            _ => panic!("expected Text event, got {:?}", event.data),
        }
    }

    #[test]
    fn test_flush_empty_buffer_is_noop() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        let mut state = make_test_state(tx, "");

        flush_text_buffer(&mut state);
        assert!(rx.try_recv().is_err()); // No event sent
    }

    #[test]
    fn test_vk_to_char_punctuation() {
        assert_eq!(vk_to_char(0xBA, 0), Some(';'));
        assert_eq!(vk_to_char(0xBA, 1), Some(':'));
        assert_eq!(vk_to_char(0xBE, 0), Some('.'));
        assert_eq!(vk_to_char(0xBF, 0), Some('/'));
        assert_eq!(vk_to_char(0xBF, 1), Some('?'));
        assert_eq!(vk_to_char(0x0D, 0), Some('\n')); // Enter
        assert_eq!(vk_to_char(0x08, 0), Some('\x08')); // Backspace
    }

    #[test]
    fn test_vk_to_char_unknown_returns_none() {
        // F1-F12 and other non-printable keys should return None
        assert_eq!(vk_to_char(0x70, 0), None); // F1
        assert_eq!(vk_to_char(0x7B, 0), None); // F12
        assert_eq!(vk_to_char(0x2E, 0), None); // Delete
        assert_eq!(vk_to_char(0x25, 0), None); // Left arrow
    }
}
