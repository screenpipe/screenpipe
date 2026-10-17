// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Clicked-element attribution on Linux through AT-SPI2 focus events.
//!
//! macOS and Windows hit-test the click position against the accessibility
//! tree. Linux cannot: evdev only reports relative pointer motion, and
//! Wayland gives clients no global pointer position, so there is no reliable
//! screen point to hit-test. What every toolkit does report, on X11 and on
//! Wayland, is focus: buttons, links, fields, tabs and menu items take focus
//! when clicked, and GTK, Qt and Chromium emit
//! `object:state-changed:focused` on the AT-SPI2 bus when that happens.
//!
//! A process-wide listener follows those events and keeps a short history.
//! A click is attributed to:
//!
//! 1. the element that gains focus within [`CLICK_SETTLE`] after the click;
//! 2. otherwise the element that already had focus, unless it belongs to an
//!    app other than the one the click landed in.
//!
//! The recorder holds each click for [`CLICK_SETTLE`] before emitting it so
//! the focus event has time to arrive. Element values are never read: only
//! role, name and description, plus the ancestor chain, the same shape as the
//! macOS click context.

use crate::events::{ancestors_to_json, AncestorHop, ElementContext};
use anyhow::{Context, Result};
use parking_lot::Mutex;
use std::collections::VecDeque;
use std::sync::{Arc, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
use tracing::debug;
use zbus::blocking::Connection;
use zbus::names::{BusName, InterfaceName};
use zbus::zvariant::{ObjectPath, OwnedObjectPath, OwnedValue};

/// How long a click waits for the focus change it causes.
pub(crate) const CLICK_SETTLE: Duration = Duration::from_millis(150);

/// Focus records kept. Only the last few seconds matter.
const HISTORY_LEN: usize = 16;
/// Bound on every D-Bus call so one hung app cannot stall the listener.
const DBUS_TIMEOUT: Duration = Duration::from_millis(300);
/// Delay before reconnecting when the AT-SPI2 bus is missing or went away
/// (e.g. screenpipe started at login before the accessibility bus).
const RECONNECT_DELAY: Duration = Duration::from_secs(10);
/// Parents walked above the focused element, and hops kept in the JSON.
const MAX_ANCESTOR_WALK: usize = 16;
const MAX_ANCESTORS_KEPT: usize = 8;
/// Labels longer than this are truncated (window titles, long link texts).
const MAX_LABEL_CHARS: usize = 200;

const ATSPI_ACCESSIBLE: &str = "org.a11y.atspi.Accessible";
const DBUS_PROPERTIES: &str = "org.freedesktop.DBus.Properties";
const ATSPI_NULL_PATH: &str = "/org/a11y/atspi/null";
const ATSPI_ROOT_PATH: &str = "/org/a11y/atspi/accessible/root";
/// AT-SPI2 state bit for "focused" (atspi-constants.h).
const STATE_FOCUSED: u32 = 12;

/// One focus change seen on the AT-SPI2 bus.
#[derive(Debug, Clone)]
pub(crate) struct FocusRecord {
    pub at: Instant,
    /// `bus_name + object_path` of the accessible.
    pub key: String,
    /// Name of the application that owns the element, when known.
    pub app: Option<String>,
    /// `None` records that the element lost focus.
    pub element: Option<ElementContext>,
}

/// Recent focus changes, oldest first.
#[derive(Debug, Default)]
pub(crate) struct FocusHistory {
    records: VecDeque<FocusRecord>,
}

impl FocusHistory {
    pub fn push(&mut self, record: FocusRecord) {
        if self.records.len() == HISTORY_LEN {
            self.records.pop_front();
        }
        self.records.push_back(record);
    }

    /// Record that `key` lost focus, if it is the element currently focused.
    pub fn focus_lost(&mut self, at: Instant, key: &str) {
        let is_current = self
            .records
            .back()
            .is_some_and(|r| r.key == key && r.element.is_some());
        if is_current {
            self.push(FocusRecord {
                at,
                key: key.to_string(),
                app: None,
                element: None,
            });
        }
    }

    /// The element a click at `click_at` landed on, once `CLICK_SETTLE` has
    /// elapsed. `clicked_app` is the focused app the click was attributed to.
    pub fn element_for_click(
        &self,
        click_at: Instant,
        clicked_app: Option<&str>,
    ) -> Option<ElementContext> {
        // 1. The click moved focus: that element is what was clicked.
        let settle_end = click_at + CLICK_SETTLE;
        if let Some(record) = self
            .records
            .iter()
            .find(|r| r.at >= click_at && r.at <= settle_end && r.element.is_some())
        {
            return record.element.clone();
        }

        // 2. Focus did not move: fall back to the element that had it, as
        //    long as it is in the app that received the click.
        let current = self.records.iter().rev().find(|r| r.at < click_at)?;
        let element = current.element.as_ref()?;
        match (clicked_app, current.app.as_deref()) {
            (Some(clicked), Some(owner)) if !same_app(clicked, owner) => None,
            _ => Some(element.clone()),
        }
    }
}

/// App names come from different sources (process name for the click, AT-SPI
/// application name for the element), e.g. `firefox` vs `Firefox`.
fn same_app(a: &str, b: &str) -> bool {
    let a = a.trim().to_lowercase();
    let b = b.trim().to_lowercase();
    !a.is_empty() && !b.is_empty() && (a == b || a.contains(&b) || b.contains(&a))
}

/// Shared focus history, fed by a background listener started on first use.
pub(crate) fn focus_history() -> Arc<Mutex<FocusHistory>> {
    static FOCUS: OnceLock<Arc<Mutex<FocusHistory>>> = OnceLock::new();
    FOCUS
        .get_or_init(|| {
            let history = Arc::new(Mutex::new(FocusHistory::default()));
            let listener_history = history.clone();
            if let Err(e) = thread::Builder::new()
                .name("atspi-focus".into())
                .spawn(move || run_listener(listener_history))
            {
                debug!("could not start the AT-SPI2 focus listener: {}", e);
            }
            history
        })
        .clone()
}

fn run_listener(history: Arc<Mutex<FocusHistory>>) {
    loop {
        match listen(&history) {
            Ok(()) => debug!("AT-SPI2 focus stream ended, reconnecting"),
            Err(e) => debug!("AT-SPI2 focus listener unavailable: {:#}", e),
        }
        thread::sleep(RECONNECT_DELAY);
    }
}

fn listen(history: &Mutex<FocusHistory>) -> Result<()> {
    let conn = connect_to_atspi_bus()?;
    // Toolkits only emit events once a listener registered for them. This
    // also makes running Chromium/Electron apps build their AT-SPI2 tree.
    let _ = call(
        &conn,
        "org.a11y.atspi.Registry",
        "/org/a11y/atspi/registry",
        "org.a11y.atspi.Registry",
        "RegisterEvent",
        &("object:state-changed:focused",),
    );

    let rule = zbus::MatchRule::builder()
        .msg_type(zbus::message::Type::Signal)
        .interface("org.a11y.atspi.Event.Object")?
        .member("StateChanged")?
        .add_arg("focused")?
        .build();
    let messages = zbus::blocking::MessageIterator::for_match_rule(rule, &conn, Some(256))?;
    debug!("AT-SPI2 focus listener connected");

    for message in messages {
        let message = message?;
        let header = message.header();
        let (Some(sender), Some(path)) = (header.sender(), header.path()) else {
            continue;
        };
        let target = Target {
            bus: sender.to_string(),
            path: path.to_string(),
        };
        let at = Instant::now();
        // Read the state instead of the signal body: its signature differs
        // between at-spi2-core versions.
        if !is_focused(&conn, &target) {
            history.lock().focus_lost(at, &target.key());
            continue;
        }
        let record = FocusRecord {
            at,
            key: target.key(),
            app: application_name(&conn, &target),
            element: Some(describe(&conn, &target)),
        };
        history.lock().push(record);
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq)]
struct Target {
    bus: String,
    path: String,
}

impl Target {
    fn key(&self) -> String {
        format!("{}{}", self.bus, self.path)
    }
}

fn connect_to_atspi_bus() -> Result<Connection> {
    let address = match std::env::var("AT_SPI_BUS_ADDRESS") {
        Ok(address) if !address.is_empty() => address,
        _ => {
            let session = Connection::session().context("no D-Bus session bus")?;
            call(
                &session,
                "org.a11y.Bus",
                "/org/a11y/bus",
                "org.a11y.Bus",
                "GetAddress",
                &(),
            )
            .context("AT-SPI2 bus not available")?
            .body()
            .deserialize::<String>()?
        }
    };
    Ok(
        zbus::blocking::connection::Builder::address(address.as_str())?
            .method_timeout(DBUS_TIMEOUT)
            .build()?,
    )
}

fn call<B: serde::ser::Serialize + zbus::zvariant::DynamicType>(
    conn: &Connection,
    dest: &str,
    path: &str,
    iface: &str,
    method: &str,
    body: &B,
) -> zbus::Result<zbus::Message> {
    let dest: BusName = dest.try_into().map_err(zbus::Error::from)?;
    let path: ObjectPath = path.try_into().map_err(zbus::Error::from)?;
    let iface: InterfaceName = iface.try_into().map_err(zbus::Error::from)?;
    conn.call_method(Some(dest), path, Some(iface), method, body)
}

fn property(conn: &Connection, target: &Target, name: &str) -> Option<OwnedValue> {
    call(
        conn,
        &target.bus,
        &target.path,
        DBUS_PROPERTIES,
        "Get",
        &(ATSPI_ACCESSIBLE, name),
    )
    .ok()?
    .body()
    .deserialize::<OwnedValue>()
    .ok()
}

fn string_property(conn: &Connection, target: &Target, name: &str) -> Option<String> {
    let value: String = property(conn, target, name)?.try_into().ok()?;
    non_empty_label(&value)
}

fn non_empty_label(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.chars().take(MAX_LABEL_CHARS).collect())
    }
}

fn role_name(conn: &Connection, target: &Target) -> String {
    call(
        conn,
        &target.bus,
        &target.path,
        ATSPI_ACCESSIBLE,
        "GetRoleName",
        &(),
    )
    .ok()
    .and_then(|reply| reply.body().deserialize::<String>().ok())
    .filter(|role| !role.is_empty())
    .unwrap_or_else(|| "unknown".to_string())
}

fn is_focused(conn: &Connection, target: &Target) -> bool {
    call(
        conn,
        &target.bus,
        &target.path,
        ATSPI_ACCESSIBLE,
        "GetState",
        &(),
    )
    .ok()
    .and_then(|reply| reply.body().deserialize::<Vec<u32>>().ok())
    .is_some_and(|states| has_state(&states, STATE_FOCUSED))
}

fn has_state(states: &[u32], bit: u32) -> bool {
    states
        .get((bit / 32) as usize)
        .is_some_and(|word| word & (1 << (bit % 32)) != 0)
}

fn application_name(conn: &Connection, target: &Target) -> Option<String> {
    let (bus, path) = call(
        conn,
        &target.bus,
        &target.path,
        ATSPI_ACCESSIBLE,
        "GetApplication",
        &(),
    )
    .ok()?
    .body()
    .deserialize::<(String, OwnedObjectPath)>()
    .ok()?;
    string_property(
        conn,
        &Target {
            bus,
            path: path.to_string(),
        },
        "Name",
    )
}

fn parent(conn: &Connection, target: &Target) -> Option<Target> {
    let (bus, path): (String, OwnedObjectPath) =
        property(conn, target, "Parent")?.try_into().ok()?;
    let path = path.to_string();
    if bus.is_empty() || path == ATSPI_NULL_PATH || path == ATSPI_ROOT_PATH {
        return None;
    }
    Some(Target { bus, path })
}

fn describe(conn: &Connection, target: &Target) -> ElementContext {
    let mut hops = Vec::new();
    let mut current = parent(conn, target);
    while let Some(node) = current {
        if hops.len() == MAX_ANCESTOR_WALK {
            break;
        }
        let role = role_name(conn, &node);
        // The application node is the app itself, not part of the window.
        if role == "application" {
            break;
        }
        hops.push(AncestorHop {
            name: string_property(conn, &node, "Name"),
            role,
        });
        current = parent(conn, &node);
    }

    ElementContext {
        role: role_name(conn, target),
        name: string_property(conn, target, "Name"),
        value: None,
        description: string_property(conn, target, "Description"),
        automation_id: None,
        bounds: None,
        ancestors: ancestors_to_json(hops, MAX_ANCESTORS_KEPT),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn element(role: &str, name: &str) -> ElementContext {
        ElementContext {
            role: role.to_string(),
            name: Some(name.to_string()),
            value: None,
            description: None,
            automation_id: None,
            bounds: None,
            ancestors: None,
        }
    }

    fn record(at: Instant, key: &str, app: &str, element: Option<ElementContext>) -> FocusRecord {
        FocusRecord {
            at,
            key: key.to_string(),
            app: Some(app.to_string()),
            element,
        }
    }

    fn name_of(element: Option<ElementContext>) -> Option<String> {
        element.and_then(|e| e.name)
    }

    #[test]
    fn click_that_moves_focus_is_attributed_to_the_new_element() {
        let t0 = Instant::now();
        let click = t0 + Duration::from_secs(1);
        let mut history = FocusHistory::default();
        history.push(record(t0, "a", "gedit", Some(element("text", "Body"))));
        history.push(record(
            click + Duration::from_millis(40),
            "b",
            "gedit",
            Some(element("push button", "Save")),
        ));

        let clicked = history.element_for_click(click, Some("gedit")).unwrap();
        assert_eq!(clicked.role, "push button");
        assert_eq!(clicked.name.as_deref(), Some("Save"));
    }

    #[test]
    fn focus_change_after_the_settle_window_is_not_the_click() {
        let t0 = Instant::now();
        let click = t0 + Duration::from_secs(1);
        let mut history = FocusHistory::default();
        history.push(record(t0, "a", "gedit", Some(element("text", "Body"))));
        history.push(record(
            click + CLICK_SETTLE + Duration::from_millis(1),
            "b",
            "gedit",
            Some(element("push button", "Later")),
        ));

        assert_eq!(
            name_of(history.element_for_click(click, Some("gedit"))),
            Some("Body".to_string())
        );
    }

    #[test]
    fn click_without_focus_change_falls_back_to_focused_element_of_same_app() {
        let t0 = Instant::now();
        let mut history = FocusHistory::default();
        history.push(record(t0, "a", "Firefox", Some(element("entry", "Search"))));
        let click = t0 + Duration::from_secs(5);

        assert_eq!(
            name_of(history.element_for_click(click, Some("firefox"))),
            Some("Search".to_string())
        );
        // Unknown clicked app: keep the focused element.
        assert_eq!(
            name_of(history.element_for_click(click, None)),
            Some("Search".to_string())
        );
        // The focused element belongs to another app: attribute nothing.
        assert!(history.element_for_click(click, Some("konsole")).is_none());
    }

    #[test]
    fn lost_focus_is_not_used_as_fallback() {
        let t0 = Instant::now();
        let mut history = FocusHistory::default();
        history.push(record(t0, "a", "gedit", Some(element("text", "Body"))));
        history.focus_lost(t0 + Duration::from_millis(10), "a");
        // Losing focus on an element that is not the current one is ignored.
        history.focus_lost(t0 + Duration::from_millis(20), "other");

        assert!(history
            .element_for_click(t0 + Duration::from_secs(1), Some("gedit"))
            .is_none());
    }

    #[test]
    fn empty_history_attributes_nothing() {
        let history = FocusHistory::default();
        assert!(history.element_for_click(Instant::now(), None).is_none());
    }

    #[test]
    fn history_is_bounded() {
        let t0 = Instant::now();
        let mut history = FocusHistory::default();
        for i in 0..(HISTORY_LEN as u64 + 5) {
            history.push(record(
                t0 + Duration::from_millis(i),
                &i.to_string(),
                "app",
                Some(element("text", &i.to_string())),
            ));
        }
        assert_eq!(history.records.len(), HISTORY_LEN);
        assert_eq!(history.records.front().unwrap().key, "5");
    }

    #[test]
    fn app_names_match_across_sources() {
        assert!(same_app("firefox", "Firefox"));
        assert!(same_app("org.gnome.TextEditor", "gnome.texteditor"));
        assert!(!same_app("konsole", "Firefox"));
        assert!(!same_app("", "Firefox"));
    }

    #[test]
    fn labels_are_trimmed_and_bounded() {
        assert_eq!(non_empty_label("  "), None);
        assert_eq!(non_empty_label(" Save "), Some("Save".to_string()));
        assert_eq!(
            non_empty_label(&"é".repeat(500)).unwrap().chars().count(),
            MAX_LABEL_CHARS
        );
    }

    /// Live check against a real AT-SPI2 bus. Start the listener, then move
    /// focus to an element whose name is `SCREENPIPE_ATSPI_EXPECT` (e.g. by
    /// clicking a button labelled that way) within 15 s:
    ///
    /// ```sh
    /// SCREENPIPE_ATSPI_EXPECT="Save draft" \
    ///   cargo test -p screenpipe-a11y --lib live_focus -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "needs a desktop session with AT-SPI2 and a focus change"]
    fn live_focus_change_is_attributed_to_click() {
        let expected =
            std::env::var("SCREENPIPE_ATSPI_EXPECT").expect("set SCREENPIPE_ATSPI_EXPECT");
        let history = focus_history();
        let deadline = Instant::now() + Duration::from_secs(15);
        let record = loop {
            let found = history
                .lock()
                .records
                .iter()
                .find(|r| {
                    r.element
                        .as_ref()
                        .is_some_and(|e| e.name.as_deref() == Some(expected.as_str()))
                })
                .cloned();
            if let Some(record) = found {
                break record;
            }
            assert!(Instant::now() < deadline, "no focus event for {expected:?}");
            thread::sleep(Duration::from_millis(50));
        };
        // A click 40 ms before that focus change resolves to the element.
        let click = record.at - Duration::from_millis(40);
        let element = history
            .lock()
            .element_for_click(click, record.app.as_deref())
            .expect("click attributed");
        println!("app={:?} element={:?}", record.app, element);
        assert_eq!(element.name.as_deref(), Some(expected.as_str()));
        assert_ne!(element.role, "unknown");
    }

    #[test]
    fn focused_state_bit() {
        assert!(has_state(&[1 << STATE_FOCUSED, 0], STATE_FOCUSED));
        assert!(!has_state(&[0, 0], STATE_FOCUSED));
        assert!(!has_state(&[], STATE_FOCUSED));
    }
}
