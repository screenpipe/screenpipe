//! UI Event types optimized for storage and AI consumption
//!
//! Events are stored as simple structs that serialize to compact JSON.
//! Based on bigbrother's event format with extensions for screenpipe integration.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// A UI event with full context
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UiEvent {
    /// Unique event ID (assigned by database)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<i64>,

    /// UTC timestamp
    pub timestamp: DateTime<Utc>,

    /// Milliseconds since recording session start
    pub relative_ms: u64,

    /// Event type and data
    #[serde(flatten)]
    pub data: EventData,

    /// Application context
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_name: Option<String>,

    /// Window title
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_title: Option<String>,

    /// Browser URL (for browser windows)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub browser_url: Option<String>,

    /// Element context at event position
    #[serde(skip_serializing_if = "Option::is_none")]
    pub element: Option<ElementContext>,

    /// Associated screenshot frame ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frame_id: Option<i64>,
}

/// Event data - tagged union for different event types
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "event_type")]
pub enum EventData {
    /// Mouse click
    #[serde(rename = "click")]
    Click {
        x: i32,
        y: i32,
        /// Button: 0=left, 1=right, 2=middle
        button: u8,
        /// Click count: 1=single, 2=double, 3=triple
        click_count: u8,
        /// Modifier keys packed: 1=shift, 2=ctrl, 4=opt, 8=cmd
        modifiers: u8,
    },

    /// Mouse move (throttled)
    #[serde(rename = "move")]
    Move { x: i32, y: i32 },

    /// Mouse scroll
    #[serde(rename = "scroll")]
    Scroll {
        x: i32,
        y: i32,
        delta_x: i16,
        delta_y: i16,
    },

    /// Key press (for shortcuts/special keys)
    #[serde(rename = "key")]
    Key {
        /// Platform-specific keycode
        key_code: u16,
        /// Modifier keys packed
        modifiers: u8,
    },

    /// Aggregated text input
    #[serde(rename = "text")]
    Text {
        /// The typed text
        content: String,
        /// Number of characters
        #[serde(skip_serializing_if = "Option::is_none")]
        char_count: Option<usize>,
    },

    /// Application activated
    #[serde(rename = "app_switch")]
    AppSwitch {
        /// Application name
        name: String,
        /// Process ID
        pid: i32,
    },

    /// Window focused
    #[serde(rename = "window_focus")]
    WindowFocus {
        /// Application name
        app: String,
        /// Window title
        #[serde(skip_serializing_if = "Option::is_none")]
        title: Option<String>,
    },

    /// Clipboard operation
    #[serde(rename = "clipboard")]
    Clipboard {
        /// Operation: 'c'=copy, 'x'=cut, 'v'=paste
        operation: char,
        /// Content preview (truncated)
        #[serde(skip_serializing_if = "Option::is_none")]
        content: Option<String>,
    },
}

/// Element context from accessibility API
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ElementContext {
    /// Accessibility role (e.g., "AXButton", "AXTextField")
    pub role: String,

    /// Element name/label
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,

    /// Element value (for inputs)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,

    /// Element description
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    /// Automation ID (Windows)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub automation_id: Option<String>,

    /// Bounding rectangle
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds: Option<ElementBounds>,
}

/// Element bounding rectangle
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ElementBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

// ============================================================================
// Accessibility Tree Types (for full window tree capture)
// ============================================================================

/// A node in the accessibility tree
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccessibilityNode {
    /// Control type (e.g., "Button", "Edit", "Text", "Window")
    pub control_type: String,

    /// Element name/label
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,

    /// Automation ID (stable identifier across sessions)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub automation_id: Option<String>,

    /// Win32 class name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub class_name: Option<String>,

    /// Current value (for text fields, combo boxes, etc.)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,

    /// Bounding rectangle in screen coordinates
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds: Option<ElementBounds>,

    /// Whether the element is enabled
    pub is_enabled: bool,

    /// Whether the element currently has keyboard focus
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_focused: Option<bool>,

    /// Whether the element can receive keyboard focus
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_keyboard_focusable: Option<bool>,

    /// Child elements
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<AccessibilityNode>,
}

impl AccessibilityNode {
    /// Count total nodes in this subtree (including self)
    pub fn node_count(&self) -> usize {
        1 + self.children.iter().map(|c| c.node_count()).sum::<usize>()
    }

    /// Max depth of this subtree (0 = leaf node)
    pub fn max_depth(&self) -> usize {
        if self.children.is_empty() {
            0
        } else {
            1 + self
                .children
                .iter()
                .map(|c| c.max_depth())
                .max()
                .unwrap_or(0)
        }
    }

    /// Find the first node matching a control type (depth-first)
    pub fn find_by_type(&self, control_type: &str) -> Option<&AccessibilityNode> {
        if self.control_type.eq_ignore_ascii_case(control_type) {
            return Some(self);
        }
        for child in &self.children {
            if let Some(found) = child.find_by_type(control_type) {
                return Some(found);
            }
        }
        None
    }

    /// Find the first node whose name contains the given substring
    pub fn find_by_name(&self, name: &str) -> Option<&AccessibilityNode> {
        if let Some(ref n) = self.name {
            if n.contains(name) {
                return Some(self);
            }
        }
        for child in &self.children {
            if let Some(found) = child.find_by_name(name) {
                return Some(found);
            }
        }
        None
    }

    /// Collect all nodes matching a control type
    pub fn find_all_by_type(&self, control_type: &str) -> Vec<&AccessibilityNode> {
        let mut results = Vec::new();
        self.collect_by_type(control_type, &mut results);
        results
    }

    fn collect_by_type<'a>(&'a self, control_type: &str, out: &mut Vec<&'a AccessibilityNode>) {
        if self.control_type.eq_ignore_ascii_case(control_type) {
            out.push(self);
        }
        for child in &self.children {
            child.collect_by_type(control_type, out);
        }
    }

    /// Collect all nodes whose name matches exactly
    pub fn find_all_by_name(&self, name: &str) -> Vec<&AccessibilityNode> {
        let mut results = Vec::new();
        self.collect_by_name(name, &mut results);
        results
    }

    fn collect_by_name<'a>(&'a self, name: &str, out: &mut Vec<&'a AccessibilityNode>) {
        if self.name.as_deref() == Some(name) {
            out.push(self);
        }
        for child in &self.children {
            child.collect_by_name(name, out);
        }
    }

    /// Print the tree in a human-readable format (for debugging)
    pub fn print_tree(&self, max_depth: usize) {
        self.print_tree_inner(0, max_depth);
    }

    fn print_tree_inner(&self, depth: usize, max_depth: usize) {
        if depth > max_depth {
            return;
        }
        let indent = "  ".repeat(depth);
        println!(
            "{}{} {:?} (id:{:?})",
            indent, self.control_type, self.name, self.automation_id
        );
        for child in &self.children {
            child.print_tree_inner(depth + 1, max_depth);
        }
    }

    /// Estimate heap memory used by this subtree (bytes).
    /// Includes String heap allocations, Vec capacities, and struct overhead.
    /// Does NOT include shallow `size_of::<Self>()` since that's stack/inline.
    pub fn estimated_byte_size(&self) -> usize {
        let mut bytes = std::mem::size_of::<Self>();

        // String heap: each String is 24 bytes on stack + heap data
        fn string_heap(s: &Option<String>) -> usize {
            s.as_ref().map_or(0, |s| s.capacity())
        }
        bytes += string_heap(&self.name);
        bytes += string_heap(&self.automation_id);
        bytes += string_heap(&self.class_name);
        bytes += string_heap(&self.value);
        bytes += self.control_type.capacity();

        // Vec<AccessibilityNode> capacity overhead
        bytes += self.children.capacity() * std::mem::size_of::<AccessibilityNode>();

        // Recurse into children
        for child in &self.children {
            bytes += child.estimated_byte_size();
        }

        bytes
    }

    /// Count nodes that have a non-empty name (i.e., visible text content).
    pub fn named_node_count(&self) -> usize {
        let self_count = if self.name.as_ref().is_some_and(|n| !n.is_empty()) {
            1
        } else {
            0
        };
        self_count
            + self
                .children
                .iter()
                .map(|c| c.named_node_count())
                .sum::<usize>()
    }

    /// Count interactive elements (Button, Edit, Document, ComboBox, CheckBox, RadioButton, Slider, Tab, MenuItem, Hyperlink).
    pub fn interactive_count(&self) -> usize {
        let interactive_types = [
            "Button",
            "Edit",
            "Document",
            "ComboBox",
            "CheckBox",
            "RadioButton",
            "Slider",
            "Tab",
            "TabItem",
            "MenuItem",
            "Hyperlink",
        ];
        let self_count = if interactive_types
            .iter()
            .any(|t| self.control_type.eq_ignore_ascii_case(t))
        {
            1
        } else {
            0
        };
        self_count
            + self
                .children
                .iter()
                .map(|c| c.interactive_count())
                .sum::<usize>()
    }

    /// Count nodes that have bounding rectangles.
    pub fn bounds_count(&self) -> usize {
        let self_count = if self.bounds.is_some() { 1 } else { 0 };
        self_count
            + self
                .children
                .iter()
                .map(|c| c.bounds_count())
                .sum::<usize>()
    }

    /// Compute a hash for diffing (ignores children — diff by comparing node-by-node)
    pub fn content_hash(&self) -> u64 {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        self.control_type.hash(&mut hasher);
        self.name.hash(&mut hasher);
        self.automation_id.hash(&mut hasher);
        self.is_enabled.hash(&mut hasher);
        if let Some(ref b) = self.bounds {
            (b.x as i64).hash(&mut hasher);
            (b.y as i64).hash(&mut hasher);
            (b.width as i64).hash(&mut hasher);
            (b.height as i64).hash(&mut hasher);
        }
        hasher.finish()
    }
}

/// A full snapshot of a window's accessibility tree
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowTreeSnapshot {
    /// Timestamp when the tree was captured
    pub timestamp: DateTime<Utc>,

    /// Application name
    pub app_name: String,

    /// Window title
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_title: Option<String>,

    /// Process ID
    pub pid: u32,

    /// Root node of the accessibility tree
    pub root: AccessibilityNode,

    /// Total number of elements in the tree
    pub element_count: usize,

    /// Hash of the tree for diffing (changes when tree content changes)
    pub tree_hash: u64,
}

/// Modifier key flags
#[derive(Debug, Clone, Copy, Default)]
pub struct Modifiers(pub u8);

impl Modifiers {
    pub const SHIFT: u8 = 1 << 0;
    pub const CTRL: u8 = 1 << 1;
    pub const OPT: u8 = 1 << 2; // Alt on Windows/Linux
    pub const CMD: u8 = 1 << 3; // Win on Windows, Super on Linux
    pub const CAPS: u8 = 1 << 4;
    pub const FN: u8 = 1 << 5;

    pub fn new() -> Self {
        Self(0)
    }

    pub fn has_shift(&self) -> bool {
        self.0 & Self::SHIFT != 0
    }
    pub fn has_ctrl(&self) -> bool {
        self.0 & Self::CTRL != 0
    }
    pub fn has_opt(&self) -> bool {
        self.0 & Self::OPT != 0
    }
    pub fn has_cmd(&self) -> bool {
        self.0 & Self::CMD != 0
    }
    pub fn any_modifier(&self) -> bool {
        self.0 & (Self::CMD | Self::CTRL) != 0
    }

    #[cfg(target_os = "macos")]
    pub fn from_cg_flags(flags: u64) -> Self {
        let mut m = 0u8;
        if flags & 0x20000 != 0 {
            m |= Self::SHIFT;
        }
        if flags & 0x40000 != 0 {
            m |= Self::CTRL;
        }
        if flags & 0x80000 != 0 {
            m |= Self::OPT;
        }
        if flags & 0x100000 != 0 {
            m |= Self::CMD;
        }
        if flags & 0x10000 != 0 {
            m |= Self::CAPS;
        }
        if flags & 0x800000 != 0 {
            m |= Self::FN;
        }
        Self(m)
    }
}

impl UiEvent {
    /// Create a new click event
    pub fn click(
        timestamp: DateTime<Utc>,
        relative_ms: u64,
        x: i32,
        y: i32,
        button: u8,
        click_count: u8,
        modifiers: u8,
    ) -> Self {
        Self {
            id: None,
            timestamp,
            relative_ms,
            data: EventData::Click {
                x,
                y,
                button,
                click_count,
                modifiers,
            },
            app_name: None,
            window_title: None,
            browser_url: None,
            element: None,
            frame_id: None,
        }
    }

    /// Create a new text event
    pub fn text(timestamp: DateTime<Utc>, relative_ms: u64, content: String) -> Self {
        let char_count = Some(content.chars().count());
        Self {
            id: None,
            timestamp,
            relative_ms,
            data: EventData::Text {
                content,
                char_count,
            },
            app_name: None,
            window_title: None,
            browser_url: None,
            element: None,
            frame_id: None,
        }
    }

    /// Create an app switch event
    pub fn app_switch(timestamp: DateTime<Utc>, relative_ms: u64, name: String, pid: i32) -> Self {
        Self {
            id: None,
            timestamp,
            relative_ms,
            data: EventData::AppSwitch { name, pid },
            app_name: None,
            window_title: None,
            browser_url: None,
            element: None,
            frame_id: None,
        }
    }

    /// Get the event type as a string
    pub fn event_type(&self) -> &'static str {
        match &self.data {
            EventData::Click { .. } => "click",
            EventData::Move { .. } => "move",
            EventData::Scroll { .. } => "scroll",
            EventData::Key { .. } => "key",
            EventData::Text { .. } => "text",
            EventData::AppSwitch { .. } => "app_switch",
            EventData::WindowFocus { .. } => "window_focus",
            EventData::Clipboard { .. } => "clipboard",
        }
    }

    /// Get text content if this is a text event
    pub fn text_content(&self) -> Option<&str> {
        match &self.data {
            EventData::Text { content, .. } => Some(content),
            EventData::Clipboard {
                content: Some(c), ..
            } => Some(c),
            _ => None,
        }
    }

    /// Set element context
    pub fn with_element(mut self, element: ElementContext) -> Self {
        self.element = Some(element);
        self
    }

    /// Set app context
    pub fn with_app(mut self, app_name: String, window_title: Option<String>) -> Self {
        self.app_name = Some(app_name);
        self.window_title = window_title;
        self
    }

    /// Set frame ID
    pub fn with_frame(mut self, frame_id: i64) -> Self {
        self.frame_id = Some(frame_id);
        self
    }
}

/// Event type for database filtering
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventType {
    Click,
    Move,
    Scroll,
    Key,
    Text,
    AppSwitch,
    WindowFocus,
    Clipboard,
}

impl EventType {
    pub fn as_str(&self) -> &'static str {
        match self {
            EventType::Click => "click",
            EventType::Move => "move",
            EventType::Scroll => "scroll",
            EventType::Key => "key",
            EventType::Text => "text",
            EventType::AppSwitch => "app_switch",
            EventType::WindowFocus => "window_focus",
            EventType::Clipboard => "clipboard",
        }
    }

    #[allow(clippy::should_implement_trait)]
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "click" | "c" => Some(EventType::Click),
            "move" | "m" => Some(EventType::Move),
            "scroll" | "s" => Some(EventType::Scroll),
            "key" | "k" => Some(EventType::Key),
            "text" | "t" => Some(EventType::Text),
            "app_switch" | "app" | "a" => Some(EventType::AppSwitch),
            "window_focus" | "window" | "w" => Some(EventType::WindowFocus),
            "clipboard" | "paste" | "p" => Some(EventType::Clipboard),
            _ => None,
        }
    }
}

// ============================================================================
// Database Conversion (optional feature)
// ============================================================================

#[cfg(feature = "db")]
impl UiEvent {
    /// Convert to database insert format
    pub fn to_db_insert(&self, session_id: Option<String>) -> screenpipe_db::InsertUiEvent {
        use screenpipe_db::{InsertUiEvent, UiEventType};

        let (
            event_type,
            x,
            y,
            delta_x,
            delta_y,
            button,
            click_count,
            key_code,
            modifiers,
            text_content,
            app_pid,
        ) = match &self.data {
            EventData::Click {
                x,
                y,
                button,
                click_count,
                modifiers,
            } => (
                UiEventType::Click,
                Some(*x),
                Some(*y),
                None,
                None,
                Some(*button),
                Some(*click_count),
                None,
                Some(*modifiers),
                None,
                None,
            ),
            EventData::Move { x, y } => (
                UiEventType::Move,
                Some(*x),
                Some(*y),
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
            ),
            EventData::Scroll {
                x,
                y,
                delta_x,
                delta_y,
            } => (
                UiEventType::Scroll,
                Some(*x),
                Some(*y),
                Some(*delta_x),
                Some(*delta_y),
                None,
                None,
                None,
                None,
                None,
                None,
            ),
            EventData::Key {
                key_code,
                modifiers,
            } => (
                UiEventType::Key,
                None,
                None,
                None,
                None,
                None,
                None,
                Some(*key_code),
                Some(*modifiers),
                None,
                None,
            ),
            EventData::Text { content, .. } => (
                UiEventType::Text,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                Some(content.clone()),
                None,
            ),
            EventData::AppSwitch { name, pid } => (
                UiEventType::AppSwitch,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                Some(name.clone()), // Store app name in text_content
                Some(*pid),
            ),
            EventData::WindowFocus { app, title } => (
                UiEventType::WindowFocus,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                title.clone().or_else(|| Some(app.clone())), // Use title, fallback to app name
                None,
            ),
            EventData::Clipboard { operation, content } => (
                UiEventType::Clipboard,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                Some(*operation as u8),
                content.clone(),
                None,
            ),
        };

        let (
            element_role,
            element_name,
            element_value,
            element_description,
            element_automation_id,
            element_bounds,
        ) = if let Some(ref elem) = self.element {
            (
                Some(elem.role.clone()),
                elem.name.clone(),
                elem.value.clone(),
                elem.description.clone(),
                elem.automation_id.clone(),
                elem.bounds.as_ref().map(|b| {
                    serde_json::json!({
                        "x": b.x,
                        "y": b.y,
                        "width": b.width,
                        "height": b.height
                    })
                    .to_string()
                }),
            )
        } else {
            (None, None, None, None, None, None)
        };

        // Extract app_name and window_title from EventData for certain event types
        let (final_app_name, final_window_title) = match &self.data {
            EventData::AppSwitch { name, .. } => (Some(name.clone()), self.window_title.clone()),
            EventData::WindowFocus { app, title } => (Some(app.clone()), title.clone()),
            _ => (self.app_name.clone(), self.window_title.clone()),
        };

        InsertUiEvent {
            timestamp: self.timestamp,
            session_id,
            relative_ms: self.relative_ms as i64,
            event_type,
            x,
            y,
            delta_x,
            delta_y,
            button,
            click_count,
            key_code,
            modifiers,
            text_content,
            app_name: final_app_name,
            app_pid,
            window_title: final_window_title,
            browser_url: self.browser_url.clone(),
            element_role,
            element_name,
            element_value,
            element_description,
            element_automation_id,
            element_bounds,
            frame_id: self.frame_id,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_event_serialization() {
        let event = UiEvent::click(Utc::now(), 100, 500, 300, 0, 1, 0);

        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"event_type\":\"click\""));
        assert!(json.contains("\"x\":500"));
    }

    #[test]
    fn test_modifiers() {
        let mods = Modifiers(Modifiers::SHIFT | Modifiers::CMD);
        assert!(mods.has_shift());
        assert!(mods.has_cmd());
        assert!(!mods.has_ctrl());
        assert!(mods.any_modifier());
    }

    #[test]
    fn test_event_type_parsing() {
        assert_eq!(EventType::from_str("click"), Some(EventType::Click));
        assert_eq!(EventType::from_str("c"), Some(EventType::Click));
        assert_eq!(EventType::from_str("text"), Some(EventType::Text));
        assert_eq!(EventType::from_str("invalid"), None);
    }
}
