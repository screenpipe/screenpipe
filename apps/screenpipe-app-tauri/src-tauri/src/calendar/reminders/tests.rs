// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use super::*;
use serde_json::json;

const NOW: i64 = 1_800_000_000;

fn event(id: &str, starts_in: i64) -> CalendarEventItem {
    CalendarEventItem {
        id: id.into(),
        title: "Private customer call".into(),
        start: DateTime::from_timestamp(NOW + starts_in, 0)
            .unwrap()
            .to_rfc3339(),
        end: DateTime::from_timestamp(NOW + starts_in + 1800, 0)
            .unwrap()
            .to_rfc3339(),
        start_display: String::new(),
        end_display: String::new(),
        attendees: vec!["private@example.com".into()],
        location: None,
        meeting_url: Some("https://example.zoom.us/j/123?pwd=secret".into()),
        calendar_name: "Private calendar".into(),
        is_all_day: false,
        source: "google".into(),
    }
}

fn snapshot(events: Vec<CalendarEventItem>) -> snapshots::CalendarSnapshots {
    snapshots::CalendarSnapshots {
        sources: BTreeMap::from([(CalendarSource::Google, events)]),
    }
}

#[test]
fn reminder_clock_fires_at_configured_offset_without_another_calendar_refresh() {
    let snapshot = snapshot(vec![event("one", 120)]);
    let ledger = Ledger::default();
    assert!(ledger.due(&snapshot, NOW + 89, 30).is_empty());
    assert_eq!(ledger.due(&snapshot, NOW + 90, 30).len(), 1);
    assert_eq!(ledger.due(&snapshot, NOW, 120).len(), 1);
    assert!(ledger.due(&snapshot, NOW + 120, 30).is_empty());
    assert!(ledger.due(&snapshot, NOW + 500, 30).is_empty());
}

#[test]
fn reminder_skips_all_day_invalid_and_non_conference_events() {
    let mut all_day = event("all-day", 30);
    all_day.is_all_day = true;
    let mut document = event("document", 30);
    document.meeting_url = Some("https://docs.google.com/private".into());
    let mut missing = event("missing", 30);
    missing.meeting_url = None;
    let mut invalid = event("invalid", 30);
    invalid.start = "not a time".into();
    let mut backwards = event("backwards", 30);
    backwards.end = backwards.start.clone();
    assert!(Ledger::default()
        .due(
            &snapshot(vec![all_day, document, missing, invalid, backwards]),
            NOW,
            30
        )
        .is_empty());
}

#[test]
fn reminder_receipt_survives_dismissal_restart_and_renaming() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.json");
    let mut snapshot = snapshot(vec![event("one", 30)]);
    let mut ledger = Ledger::default();
    ledger.reconcile(&snapshot, NOW);
    let (occurrence, _) = ledger.due(&snapshot, NOW, 30).pop().unwrap();
    ledger.record(&occurrence, Disposition::Emitted);
    write_ledger(&path, &ledger).unwrap();
    // The transient notification may be dismissed or deleted; its independent
    // receipt remains. Changing the title must not re-offer the occurrence.
    snapshot.sources.get_mut(&CalendarSource::Google).unwrap()[0].title = "Renamed".into();
    let mut restarted = read_ledger(&path).unwrap();
    restarted.reconcile(&snapshot, NOW);
    assert!(restarted.due(&snapshot, NOW, 300).is_empty());
    let persisted = std::fs::read_to_string(path).unwrap();
    for private in ["Private", "private@example.com", "secret", "zoom.us", "one"] {
        assert!(!persisted.contains(private), "state leaked {private}");
    }
}

#[test]
fn reminder_removal_is_durable_and_suppresses_a_stale_duplicate() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.json");
    let original = event("google-one", 30);
    let mut duplicate = original.clone();
    duplicate.id = "native-one".into();
    let mut snapshot = snapshot(vec![original]);
    snapshot
        .sources
        .insert(CalendarSource::Native, vec![duplicate]);
    let mut ledger = Ledger::default();
    ledger.reconcile(&snapshot, NOW - 60);
    assert_eq!(ledger.due(&snapshot, NOW, 30).len(), 1);
    // A successful provider snapshot no longer includes the deleted/declined
    // event. The OS calendar's older copy must not resurrect it.
    snapshot.sources.insert(CalendarSource::Google, vec![]);
    ledger.reconcile(&snapshot, NOW);
    write_ledger(&path, &ledger).unwrap();
    let restarted = read_ledger(&path).unwrap();
    assert!(restarted.due(&snapshot, NOW, 30).is_empty());
}

#[test]
fn reminder_restart_waits_for_each_source_before_retiring_its_events() {
    let mut ledger = Ledger::default();
    ledger.reconcile(&snapshot(vec![event("google", 30)]), NOW - 60);
    let native_boot = snapshots::CalendarSnapshots {
        sources: BTreeMap::from([(CalendarSource::Native, vec![])]),
    };
    ledger.reconcile(&native_boot, NOW);
    assert!(ledger.receipts.is_empty());
    assert_eq!(
        ledger
            .due(&snapshot(vec![event("google", 30)]), NOW, 30)
            .len(),
        1
    );
}

#[test]
fn reminder_rescheduling_replaces_the_old_deadline_and_keeps_recurring_occurrences_distinct() {
    let mut ledger = Ledger::default();
    ledger.reconcile(&snapshot(vec![event("series", 30)]), NOW);
    let moved = snapshot(vec![event("series", 600)]);
    ledger.reconcile(&moved, NOW);
    assert!(ledger.due(&moved, NOW, 30).is_empty());
    assert_eq!(ledger.due(&moved, NOW + 570, 30).len(), 1);
    let mut next_week = event("series", 7 * 86400);
    // Same title, room and series ID, but a different occurrence.
    let occurrence = Occurrence::from_event(
        CalendarSource::Google,
        &moved.sources[&CalendarSource::Google][0],
    )
    .unwrap();
    ledger.record(&occurrence, Disposition::Emitted);
    next_week.title = "Same standup".into();
    assert_eq!(
        ledger
            .due(&snapshot(vec![next_week]), NOW + 7 * 86400 - 30, 30)
            .len(),
        1
    );
}

#[test]
fn reminder_duplicate_identity_normalizes_timezones_and_join_credentials() {
    let first = event("google", 30);
    let mut second = first.clone();
    second.id = "native".into();
    second.start = DateTime::parse_from_rfc3339(&first.start)
        .unwrap()
        .with_timezone(&chrono::FixedOffset::west_opt(7 * 3600).unwrap())
        .to_rfc3339();
    second.meeting_url = Some("https://zoom.us/j/123?pwd=different&utm_source=calendar".into());
    let mut snapshot = snapshot(vec![first]);
    snapshot
        .sources
        .insert(CalendarSource::Native, vec![second]);
    assert_eq!(Ledger::default().due(&snapshot, NOW, 30).len(), 1);
    let mut ledger = Ledger::default();
    ledger.reconcile(&snapshot, NOW);
    let (occurrence, _) = ledger.due(&snapshot, NOW, 30).pop().unwrap();
    assert!(matches_bound_event(&snapshot, &occurrence, "google"));
    assert!(matches_bound_event(&snapshot, &occurrence, "native"));
    assert!(!matches_bound_event(
        &snapshot,
        &occurrence,
        "previous-call"
    ));
    ledger.record(&occurrence, Disposition::Emitted);
    snapshot.sources.get_mut(&CalendarSource::Google).unwrap()[0].meeting_url =
        Some("https://meet.google.com/new-room".into());
    ledger.reconcile(&snapshot, NOW);
    assert!(ledger.due(&snapshot, NOW, 30).is_empty());
}

#[test]
fn reminder_preferences_keep_opt_out_and_bound_lead_time() {
    assert_eq!(preferences(None), (true, 30));
    assert_eq!(
        preferences(Some(&json!({"meetingLiveNotes": false}))),
        (false, 30)
    );
    assert_eq!(
        preferences(Some(
            &json!({"meetingLiveNotes": false, "meetingReminders": true, "meetingReminderLeadSeconds": 120})
        )),
        (true, 120)
    );
    assert_eq!(
        preferences(Some(&json!({"meetingReminderLeadSeconds": -1}))).1,
        1
    );
    assert_eq!(
        preferences(Some(&json!({"meetingReminderLeadSeconds": 999999}))).1,
        MAX_LEAD_SECONDS
    );
}

#[tokio::test]
async fn reminder_event_reaches_the_existing_bus_with_camel_case_join_fields() {
    use futures::StreamExt;
    let mut subscriber = screenpipe_events::subscribe_to_event::<Value>("meeting_about_to_start");
    publish_reminder(event("bus", 30), 30).unwrap();
    let payload = tokio::time::timeout(Duration::from_secs(1), subscriber.next())
        .await
        .unwrap()
        .unwrap()
        .data;
    assert_eq!(payload["secondsUntilStart"], 30);
    assert_eq!(
        payload["meetingUrl"],
        "https://example.zoom.us/j/123?pwd=secret"
    );
    let consumer: MeetingPrewarmEvent = serde_json::from_value(payload).unwrap();
    assert_eq!(consumer.seconds_until_start, 30);
}

#[tokio::test]
async fn reminder_real_storage_failure_survives_rotation_and_support_redaction() {
    use std::io::Write;
    use std::sync::{Arc, Mutex};
    #[derive(Clone)]
    struct Writer(Arc<Mutex<Vec<u8>>>);
    impl Write for Writer {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let blocker = dir.path().join("not-a-directory");
    std::fs::write(&blocker, "blocker").unwrap();
    let cause = persist(&blocker.join("state.json"), &Ledger::default())
        .await
        .unwrap_err();
    let writer = Writer(Arc::new(Mutex::new(Vec::new())));
    let target = writer.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_ansi(false)
        .with_writer(move || target.clone())
        .finish();
    tracing::subscriber::with_default(subscriber, || report_failure("receipt_write", &cause));
    let current = dir.path().join("screenpipe-app.2026-09-29.log");
    std::fs::write(&current, writer.0.lock().unwrap().as_slice()).unwrap();
    std::fs::rename(&current, dir.path().join("screenpipe-app.2026-09-29.1.log")).unwrap();
    std::fs::write(
        &current,
        "INFO restarted\nINFO contact=private@example.com\n",
    )
    .unwrap();
    let report = crate::diagnostic_logs::collect_redacted_from_dirs(&[dir.path().to_path_buf()])
        .await
        .unwrap();
    assert!(
        report.contains("meeting reminder scheduler failed"),
        "{report}"
    );
    assert!(report.contains("receipt_write"), "{report}");
    assert!(report.contains("reminder_withheld"), "{report}");
    assert!(
        report.contains(cause.split(": ").next().unwrap()),
        "{report}"
    );
    assert!(!report.contains("private@example.com"));
    let corrupt = dir.path().join("corrupt-state.json");
    std::fs::write(&corrupt, "invalid json").unwrap();
    assert_eq!(
        read_ledger(&corrupt).err().unwrap().kind(),
        std::io::ErrorKind::InvalidData
    );
}

#[test]
fn independent_google_accounts_preserve_failed_account_receipts_across_restart() {
    let healthy = CalendarSource::GoogleAccount("a".repeat(64));
    let failed = CalendarSource::GoogleAccount("b".repeat(64));
    let snapshot = snapshots::CalendarSnapshots {
        sources: BTreeMap::from([
            (healthy.clone(), vec![event("healthy", 30)]),
            (failed.clone(), vec![event("failed", 60)]),
        ]),
    };
    let mut ledger = Ledger::default();
    ledger.reconcile(&snapshot, NOW);
    let path = tempfile::tempdir().unwrap();
    let file = path.path().join("ledger.json");
    write_ledger(&file, &ledger).unwrap();
    let mut restarted = read_ledger(&file).unwrap();
    let healthy_only = snapshots::CalendarSnapshots {
        sources: BTreeMap::from([(healthy, vec![event("healthy", 30)])]),
    };
    restarted.reconcile(&healthy_only, NOW);
    assert_eq!(restarted.observed[&failed].len(), 1);
    assert_eq!(restarted.due(&healthy_only, NOW, 30).len(), 1);
    assert!(restarted
        .receipts
        .values()
        .all(|r| r.disposition != Disposition::Removed));
    // Existing pre-upgrade enum map keys still load.
    assert!(serde_json::from_str::<Ledger>(
        r#"{"observed":{"Google":{},"Native":{},"Ics":{}},"receipts":{}}"#
    )
    .is_ok());
}

#[test]
fn google_account_migration_keeps_previous_reminder_dismissals() {
    let original = snapshot(vec![event("one", 30)]);
    let mut ledger = Ledger::default();
    ledger.reconcile(&original, NOW);
    let (occurrence, _) = ledger.due(&original, NOW, 30).pop().unwrap();
    ledger.record(&occurrence, Disposition::Emitted);
    let serialized = serde_json::to_string(&ledger).unwrap();
    let mut restarted: Ledger = serde_json::from_str(&serialized).unwrap();
    let account = snapshots::CalendarSnapshots {
        sources: BTreeMap::from([(
            CalendarSource::GoogleAccount("a".repeat(64)),
            vec![event("one", 30)],
        )]),
    };
    restarted.reconcile(&account, NOW);
    assert!(restarted.due(&account, NOW, 30).is_empty());
}
