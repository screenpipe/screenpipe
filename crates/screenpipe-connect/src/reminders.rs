//! Apple Reminders integration via EventKit.
//!
//! Wraps `eventkit-rs` for core CRUD and adds:
//! - `ensure_list()` — idempotent list creation
//! - `create_reminder_with_due()` — natural language due date parsing
//!
//! All operations are synchronous and safe to call from a tokio blocking task.

use chrono::Datelike;
use eventkit::{
    AuthorizationStatus, CalendarInfo, EventKitError, ReminderItem, RemindersManager,
    Result as EKResult,
};
use objc2::rc::Retained;
use objc2::Message;
use objc2_event_kit::{EKCalendar, EKEntityType, EKEventStore, EKReminder, EKSource, EKSourceType};
use objc2_foundation::{NSDateComponents, NSString};
use tracing::{debug, warn};

/// Thin wrapper around `eventkit::RemindersManager` with screenpipe-specific additions.
pub struct ScreenpipeReminders {
    manager: RemindersManager,
    store: Retained<EKEventStore>,
}

impl ScreenpipeReminders {
    /// Create a new instance. Does NOT trigger any permission popup.
    pub fn new() -> Self {
        let manager = RemindersManager::new();
        let store = unsafe { EKEventStore::new() };
        Self { manager, store }
    }

    // ── Authorization ──────────────────────────────────────────────────

    /// Check current TCC status without triggering a popup.
    pub fn authorization_status() -> AuthorizationStatus {
        RemindersManager::authorization_status()
    }

    /// Request full access (shows popup on first call, then persists).
    pub fn request_access(&self) -> EKResult<bool> {
        self.manager.request_access()
    }

    /// Ensure we have authorization, requesting if needed.
    pub fn ensure_authorized(&self) -> EKResult<()> {
        self.manager.ensure_authorized()
    }

    // ── List / Calendar management ─────────────────────────────────────

    /// List all reminder calendars.
    pub fn list_calendars(&self) -> EKResult<Vec<CalendarInfo>> {
        self.manager.list_calendars()
    }

    /// Ensure a named reminders list exists. Returns (calendar_title, created).
    /// Idempotent — safe to call repeatedly.
    pub fn ensure_list(&self, name: &str) -> EKResult<(String, bool)> {
        self.ensure_authorized()?;

        // Check if it already exists
        let calendars = unsafe { self.store.calendarsForEntityType(EKEntityType::Reminder) };
        for cal in calendars.iter() {
            let title = unsafe { cal.title() };
            if title.to_string() == name {
                debug!("reminders list '{}' already exists", name);
                return Ok((name.to_string(), false));
            }
        }

        // Find a local or iCloud source for the new calendar
        let source = self.find_best_source()?;

        // Create the calendar
        let calendar = unsafe {
            EKCalendar::calendarForEntityType_eventStore(EKEntityType::Reminder, &self.store)
        };
        let ns_title = NSString::from_str(name);
        unsafe {
            calendar.setTitle(&ns_title);
            calendar.setSource(Some(&source));
        }

        unsafe {
            self.store
                .saveCalendar_commit_error(&calendar, true)
                .map_err(|e| EventKitError::SaveFailed(format!("{:?}", e)))?;
        }

        debug!("created reminders list '{}'", name);
        Ok((name.to_string(), true))
    }

    // ── Reminder CRUD ──────────────────────────────────────────────────

    /// Create a reminder with optional natural language due date.
    ///
    /// `due` supports: "today", "tomorrow", weekday names ("monday"–"sunday"),
    /// "next week", ISO dates ("2026-03-15"), or `None` for no due date.
    /// Invalid/unrecognized values are silently ignored (no due date set).
    pub fn create_reminder(
        &self,
        title: &str,
        notes: Option<&str>,
        calendar_title: Option<&str>,
        due: Option<&str>,
    ) -> EKResult<ReminderItem> {
        self.ensure_authorized()?;

        let reminder = unsafe { EKReminder::reminderWithEventStore(&self.store) };

        // Title
        let ns_title = NSString::from_str(title);
        unsafe { reminder.setTitle(Some(&ns_title)) };

        // Notes
        if let Some(n) = notes {
            let ns_notes = NSString::from_str(n);
            unsafe { reminder.setNotes(Some(&ns_notes)) };
        }

        // Calendar
        let calendar = match calendar_title {
            Some(name) => self.find_calendar_by_title(name).ok(),
            None => None,
        };
        let calendar = calendar
            .or_else(|| unsafe { self.store.defaultCalendarForNewReminders() })
            .ok_or(EventKitError::NoDefaultCalendar)?;
        unsafe { reminder.setCalendar(Some(&calendar)) };

        // Due date
        if let Some(due_str) = due {
            if let Some(components) = parse_due_date(due_str) {
                unsafe { reminder.setDueDateComponents(Some(&components)) };
                debug!("set due date from '{}'", due_str);
            } else {
                debug!("ignoring unrecognized due date: '{}'", due_str);
            }
        }

        // Save
        unsafe {
            self.store
                .saveReminder_commit_error(&reminder, true)
                .map_err(|e| EventKitError::SaveFailed(format!("{:?}", e)))?;
        }

        Ok(reminder_to_item(&reminder))
    }

    /// List incomplete reminders, optionally from a specific list.
    pub fn list_reminders(&self, calendar_title: Option<&str>) -> EKResult<Vec<ReminderItem>> {
        match calendar_title {
            Some(title) => self.manager.fetch_reminders(Some(&[title])),
            None => self.manager.fetch_incomplete_reminders(),
        }
    }

    /// Delete a reminder by identifier.
    pub fn delete_reminder(&self, identifier: &str) -> EKResult<()> {
        self.manager.delete_reminder(identifier)
    }

    /// Mark a reminder as complete.
    pub fn complete_reminder(&self, identifier: &str) -> EKResult<ReminderItem> {
        self.manager.complete_reminder(identifier)
    }

    /// Get a reminder by identifier.
    pub fn get_reminder(&self, identifier: &str) -> EKResult<ReminderItem> {
        self.manager.get_reminder(identifier)
    }

    // ── Private helpers ────────────────────────────────────────────────

    fn find_calendar_by_title(&self, title: &str) -> EKResult<Retained<EKCalendar>> {
        let calendars = unsafe { self.store.calendarsForEntityType(EKEntityType::Reminder) };
        for cal in calendars.iter() {
            let cal_title = unsafe { cal.title() };
            if cal_title.to_string() == title {
                return Ok(cal.retain());
            }
        }
        Err(EventKitError::CalendarNotFound(title.to_string()))
    }

    fn find_best_source(&self) -> EKResult<Retained<EKSource>> {
        let sources = unsafe { self.store.sources() };

        // Prefer iCloud, then Local
        let mut local_source = None;
        for source in sources.iter() {
            let source_type = unsafe { source.sourceType() };
            if source_type == EKSourceType::CalDAV {
                // iCloud is CalDAV
                return Ok(source.retain());
            }
            if source_type == EKSourceType::Local && local_source.is_none() {
                local_source = Some(source.retain());
            }
        }

        local_source.ok_or_else(|| {
            EventKitError::SaveFailed("no suitable source found for new calendar".to_string())
        })
    }
}

impl Default for ScreenpipeReminders {
    fn default() -> Self {
        Self::new()
    }
}

// ── Due date parsing ────────────────────────────────────────────────────

/// Parse a natural language due date string into NSDateComponents.
/// Returns None if the string is empty, "null", "none", or unrecognized.
fn parse_due_date(due: &str) -> Option<Retained<NSDateComponents>> {
    let due = due.trim().to_lowercase();
    if due.is_empty() || due == "null" || due == "none" {
        return None;
    }

    let now = chrono::Local::now();

    let target_date = match due.as_str() {
        "today" => Some(now.date_naive()),
        "tomorrow" => Some(now.date_naive() + chrono::Duration::days(1)),
        "next week" => Some(now.date_naive() + chrono::Duration::weeks(1)),
        day_name => {
            // Try weekday name
            if let Some(target_weekday) = parse_weekday(day_name) {
                let current_weekday = now.date_naive().weekday();
                let days_ahead = (target_weekday.num_days_from_monday() as i64
                    - current_weekday.num_days_from_monday() as i64
                    + 7)
                    % 7;
                let days_ahead = if days_ahead == 0 { 7 } else { days_ahead };
                Some(now.date_naive() + chrono::Duration::days(days_ahead))
            }
            // Try ISO date
            else if let Ok(date) = chrono::NaiveDate::parse_from_str(day_name, "%Y-%m-%d") {
                Some(date)
            } else {
                warn!("unrecognized due date format: '{}'", due);
                None
            }
        }
    };

    target_date.map(|date| {
        let components = NSDateComponents::new();
        components.setYear(date.year() as isize);
        components.setMonth(date.month() as isize);
        components.setDay(date.day() as isize);
        components
    })
}

fn parse_weekday(s: &str) -> Option<chrono::Weekday> {
    match s {
        "monday" | "mon" => Some(chrono::Weekday::Mon),
        "tuesday" | "tue" => Some(chrono::Weekday::Tue),
        "wednesday" | "wed" => Some(chrono::Weekday::Wed),
        "thursday" | "thu" => Some(chrono::Weekday::Thu),
        "friday" | "fri" => Some(chrono::Weekday::Fri),
        "saturday" | "sat" => Some(chrono::Weekday::Sat),
        "sunday" | "sun" => Some(chrono::Weekday::Sun),
        _ => None,
    }
}

fn reminder_to_item(reminder: &EKReminder) -> ReminderItem {
    let identifier = unsafe { reminder.calendarItemIdentifier() }.to_string();
    let title = unsafe { reminder.title() }.to_string();
    let notes = unsafe { reminder.notes() }.map(|n| n.to_string());
    let completed = unsafe { reminder.isCompleted() };
    let priority = unsafe { reminder.priority() };
    let calendar_title = unsafe { reminder.calendar() }.map(|c| unsafe { c.title() }.to_string());

    ReminderItem {
        identifier,
        title,
        notes,
        completed,
        priority,
        calendar_title,
    }
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_check_authorization() {
        let status = ScreenpipeReminders::authorization_status();
        println!("Reminders authorization: {}", status);
        // Should not crash regardless of status
    }

    #[test]
    fn test_ensure_list_idempotent() {
        let r = ScreenpipeReminders::new();
        if ScreenpipeReminders::authorization_status() != AuthorizationStatus::FullAccess {
            println!("Skipping: not authorized");
            return;
        }

        let list = "Screenpipe Test Idempotent";
        let (_, created1) = r.ensure_list(list).expect("first ensure_list failed");
        assert!(created1, "should be created first time");

        let (_, created2) = r.ensure_list(list).expect("second ensure_list failed");
        assert!(!created2, "should already exist");

        // Cleanup: delete via store
        cleanup_list(&r, list);
        println!("Idempotent test passed!");
    }

    #[test]
    fn test_full_lifecycle() {
        let r = ScreenpipeReminders::new();
        if ScreenpipeReminders::authorization_status() != AuthorizationStatus::FullAccess {
            println!("Skipping: not authorized");
            return;
        }

        let list = "Screenpipe Test Lifecycle";
        r.ensure_list(list).unwrap();

        // Create
        let item = r
            .create_reminder(
                "Test lifecycle",
                Some("notes here"),
                Some(list),
                Some("tomorrow"),
            )
            .expect("create failed");
        println!("Created: {} ({})", item.title, item.identifier);
        assert_eq!(item.title, "Test lifecycle");
        assert_eq!(item.notes.as_deref(), Some("notes here"));

        // List
        let items = r.list_reminders(Some(list)).expect("list failed");
        assert!(items.iter().any(|i| i.identifier == item.identifier));

        // Get
        let got = r.get_reminder(&item.identifier).expect("get failed");
        assert_eq!(got.title, "Test lifecycle");

        // Complete
        let completed = r
            .complete_reminder(&item.identifier)
            .expect("complete failed");
        assert!(completed.completed);

        // Delete
        r.delete_reminder(&item.identifier).expect("delete failed");

        cleanup_list(&r, list);
        println!("Full lifecycle test passed!");
    }

    #[test]
    fn test_due_date_variants() {
        let r = ScreenpipeReminders::new();
        if ScreenpipeReminders::authorization_status() != AuthorizationStatus::FullAccess {
            println!("Skipping: not authorized");
            return;
        }

        let list = "Screenpipe Test Dates";
        r.ensure_list(list).unwrap();

        let cases = vec![
            ("today", true),
            ("tomorrow", true),
            ("friday", true),
            ("next week", true),
            ("2026-03-15", true),
            ("null", true),    // should succeed (no due date)
            ("none", true),    // should succeed (no due date)
            ("", true),        // should succeed (no due date)
            ("garbage", true), // should succeed (no due date)
        ];

        let mut ids = Vec::new();
        for (due, should_succeed) in &cases {
            let due_opt = if due.is_empty() { None } else { Some(*due) };
            match r.create_reminder(&format!("Due {}", due), None, Some(list), due_opt) {
                Ok(item) => {
                    assert!(should_succeed, "should have succeeded for '{}'", due);
                    println!("✅ due='{}' → {}", due, item.identifier);
                    ids.push(item.identifier);
                }
                Err(e) => {
                    assert!(!should_succeed, "should have failed for '{}': {}", due, e);
                    println!("❌ due='{}' → {}", due, e);
                }
            }
        }

        // Cleanup
        for id in &ids {
            let _ = r.delete_reminder(id);
        }
        cleanup_list(&r, list);
        println!("Due date variants test passed!");
    }

    #[test]
    fn test_special_characters() {
        let r = ScreenpipeReminders::new();
        if ScreenpipeReminders::authorization_status() != AuthorizationStatus::FullAccess {
            println!("Skipping: not authorized");
            return;
        }

        let list = "Screenpipe Test Special";
        r.ensure_list(list).unwrap();

        let titles = [
            "Reminder with émojis 🎉🔥",
            "日本語のリマインダー",
            "Reminder with \"quotes\" and 'apostrophes'",
        ];

        let mut ids = Vec::new();
        for title in &titles {
            let item = r
                .create_reminder(title, None, Some(list), None)
                .expect(&format!("failed to create '{}'", title));
            println!("✅ '{}'", title);
            ids.push(item.identifier);
        }

        for id in &ids {
            let _ = r.delete_reminder(id);
        }
        cleanup_list(&r, list);
        println!("Special characters test passed!");
    }

    #[test]
    fn test_stress() {
        let r = ScreenpipeReminders::new();
        if ScreenpipeReminders::authorization_status() != AuthorizationStatus::FullAccess {
            println!("Skipping: not authorized");
            return;
        }

        let list = "Screenpipe Test Stress";
        r.ensure_list(list).unwrap();

        let start = std::time::Instant::now();
        let mut ids = Vec::new();
        for i in 0..20 {
            let item = r
                .create_reminder(&format!("Stress #{}", i), None, Some(list), None)
                .expect(&format!("create #{} failed", i));
            ids.push(item.identifier);
        }
        let create_time = start.elapsed();
        println!(
            "Created 20 in {:?} ({:.1}ms each)",
            create_time,
            create_time.as_millis() as f64 / 20.0
        );

        let start = std::time::Instant::now();
        let listed = r.list_reminders(Some(list)).expect("list failed");
        println!("Listed {} in {:?}", listed.len(), start.elapsed());
        assert!(listed.len() >= 20);

        let start = std::time::Instant::now();
        for id in &ids {
            r.delete_reminder(id).expect("delete failed");
        }
        println!("Deleted 20 in {:?}", start.elapsed());

        cleanup_list(&r, list);
        println!("Stress test passed!");
    }

    /// Helper to remove a test calendar/list
    fn cleanup_list(r: &ScreenpipeReminders, name: &str) {
        let calendars = unsafe { r.store.calendarsForEntityType(EKEntityType::Reminder) };
        for cal in calendars.iter() {
            let title = unsafe { cal.title() };
            if title.to_string() == name {
                let _ = unsafe { r.store.removeCalendar_commit_error(&cal, true) };
                println!("Cleaned up list '{}'", name);
            }
        }
    }
}
