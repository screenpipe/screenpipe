// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! The calendar bus carries a complete snapshot, not a provider delta. Keep
//! each provider's latest list so an empty native refresh cannot erase ICS or
//! Google events needed for titles and back-to-back meeting boundaries.

use super::CalendarEventItem;
use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum CalendarSource {
    Native,
    Google,
    Ics,
}

#[derive(Default)]
struct CalendarSnapshots {
    sources: BTreeMap<CalendarSource, Vec<CalendarEventItem>>,
}

impl CalendarSnapshots {
    fn replace(
        &mut self,
        source: CalendarSource,
        events: Vec<CalendarEventItem>,
    ) -> Vec<CalendarEventItem> {
        self.sources.insert(source, events);
        // Provider IDs and metadata stay intact. In particular, do not dedupe
        // by title or conference URL: consecutive meetings can share both.
        self.sources.values().flatten().cloned().collect()
    }
}

pub(crate) fn publish_calendar_events(
    source: CalendarSource,
    events: Vec<CalendarEventItem>,
) -> anyhow::Result<()> {
    static SNAPSHOTS: OnceLock<Mutex<CalendarSnapshots>> = OnceLock::new();
    let mut snapshots = SNAPSHOTS
        .get_or_init(|| Mutex::new(CalendarSnapshots::default()))
        .lock()
        .map_err(|_| anyhow::anyhow!("calendar snapshot lock poisoned"))?;
    let merged = snapshots.replace(source, events);
    // Keep publication inside the lock. Otherwise concurrent providers could
    // publish an older merged snapshot after a newer one. This is a bounded,
    // synchronous event-bus send; no network/OS calls occur under this lock.
    screenpipe_events::send_event("calendar_events", merged)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(id: &str, source: &str, start: &str, end: &str) -> CalendarEventItem {
        CalendarEventItem {
            id: id.into(),
            title: "Client call".into(),
            start: start.into(),
            end: end.into(),
            start_display: String::new(),
            end_display: String::new(),
            attendees: vec!["person@example.test".into()],
            location: None,
            meeting_url: Some("https://teams.microsoft.com/l/meetup-join/example".into()),
            calendar_name: "Work".into(),
            is_all_day: false,
            source: source.into(),
        }
    }

    fn sample(id: &str, source: &str) -> CalendarEventItem {
        event(id, source, "2026-09-24T13:00:00Z", "2026-09-24T14:00:00Z")
    }

    fn ids(events: &[CalendarEventItem]) -> Vec<&str> {
        events.iter().map(|event| event.id.as_str()).collect()
    }

    #[test]
    fn empty_native_refresh_preserves_ics_titles_and_consecutive_boundaries() {
        let mut snapshots = CalendarSnapshots::default();
        snapshots.replace(
            CalendarSource::Ics,
            vec![
                sample("first", "ics"),
                event(
                    "second",
                    "ics",
                    "2026-09-24T14:00:00Z",
                    "2026-09-24T15:00:00Z",
                ),
            ],
        );
        for _ in 0..10 {
            let merged = snapshots.replace(CalendarSource::Native, vec![]);
            assert_eq!(ids(&merged), ["first", "second"]);
            assert_eq!(merged[0].end, merged[1].start);
            assert_eq!(merged[0].title, "Client call");
            assert_eq!(merged[0].attendees, ["person@example.test"]);
            assert_eq!(merged[0].meeting_url, merged[1].meeting_url);
        }
    }

    #[test]
    fn source_order_does_not_change_the_combined_snapshot() {
        let sources = [
            CalendarSource::Native,
            CalendarSource::Google,
            CalendarSource::Ics,
        ];
        let mut forward = CalendarSnapshots::default();
        let mut reverse = CalendarSnapshots::default();
        for (source, name) in sources.iter().zip(["native", "google", "ics"]) {
            forward.replace(*source, vec![sample(name, name)]);
        }
        for (source, name) in sources.iter().zip(["native", "google", "ics"]).rev() {
            reverse.replace(*source, vec![sample(name, name)]);
        }
        assert_eq!(
            serde_json::to_value(forward.replace(CalendarSource::Native, vec![])).unwrap(),
            serde_json::to_value(reverse.replace(CalendarSource::Native, vec![])).unwrap(),
        );
    }

    #[test]
    fn refreshing_a_source_replaces_edited_and_deleted_events_only_in_that_source() {
        let mut snapshots = CalendarSnapshots::default();
        snapshots.replace(CalendarSource::Native, vec![sample("native", "native")]);
        snapshots.replace(
            CalendarSource::Ics,
            vec![sample("old", "ics"), sample("edit", "ics")],
        );
        let mut edited = sample("edit", "ics");
        edited.title = "Updated title".into();
        let merged = snapshots.replace(CalendarSource::Ics, vec![edited]);
        assert_eq!(ids(&merged), ["native", "edit"]);
        assert_eq!(merged[1].title, "Updated title");
    }

    #[test]
    fn disconnecting_each_source_preserves_the_others_and_can_clear_the_last_event() {
        let mut snapshots = CalendarSnapshots::default();
        snapshots.replace(CalendarSource::Native, vec![sample("native", "native")]);
        snapshots.replace(CalendarSource::Google, vec![sample("google", "google")]);
        snapshots.replace(CalendarSource::Ics, vec![sample("ics", "ics")]);
        assert_eq!(
            ids(&snapshots.replace(CalendarSource::Google, vec![])),
            ["native", "ics"]
        );
        assert_eq!(
            ids(&snapshots.replace(CalendarSource::Ics, vec![])),
            ["native"]
        );
        assert!(snapshots.replace(CalendarSource::Native, vec![]).is_empty());
    }

    #[tokio::test]
    async fn calendar_bus_delivers_combined_snapshots_after_concurrent_refreshes() {
        use futures::StreamExt;
        use std::time::Duration;

        // Clear process-local test state before subscribing, then exercise the
        // actual serialized bus contract used by all three meeting consumers.
        for source in [
            CalendarSource::Native,
            CalendarSource::Google,
            CalendarSource::Ics,
        ] {
            publish_calendar_events(source, vec![]).unwrap();
        }
        let mut subscription =
            screenpipe_events::subscribe_to_event::<Vec<CalendarEventItem>>("calendar_events");
        publish_calendar_events(CalendarSource::Ics, vec![sample("ics", "ics")]).unwrap();
        publish_calendar_events(CalendarSource::Native, vec![]).unwrap();
        for _ in 0..2 {
            let received = tokio::time::timeout(Duration::from_secs(1), subscription.next())
                .await
                .unwrap()
                .unwrap()
                .data;
            assert_eq!(ids(&received), ["ics"]);
        }

        std::thread::scope(|scope| {
            scope.spawn(|| {
                publish_calendar_events(CalendarSource::Google, vec![sample("google", "google")])
                    .unwrap()
            });
            scope.spawn(|| {
                publish_calendar_events(CalendarSource::Native, vec![sample("native", "native")])
                    .unwrap()
            });
        });
        let mut received = Vec::new();
        for _ in 0..2 {
            received = tokio::time::timeout(Duration::from_secs(1), subscription.next())
                .await
                .unwrap()
                .unwrap()
                .data;
        }
        assert_eq!(ids(&received), ["native", "google", "ics"]);
        for source in [
            CalendarSource::Native,
            CalendarSource::Google,
            CalendarSource::Ics,
        ] {
            publish_calendar_events(source, vec![]).unwrap();
        }
    }
}
