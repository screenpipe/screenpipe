// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Calendar reminders run independently of capture and the meeting detector.
//! Calendar snapshots replace the schedule; a local clock drives delivery.
//! Only hashed identities and occurrence times are persisted, never join URLs,
//! titles or attendees. Receipts survive dismissals, inbox deletion and restart.

use super::{snapshots, CalendarEventItem, CalendarSource};
use crate::store::SettingsStore;
use chrono::{DateTime, Utc};
use screenpipe_engine::meeting_watcher::meeting_url_identity;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tracing::{info, warn};

const DEFAULT_LEAD_SECONDS: i64 = 30;
const MAX_LEAD_SECONDS: i64 = 30 * 60;
const RETENTION_SECONDS: i64 = 7 * 24 * 60 * 60;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MeetingPrewarmEvent {
    pub title: String,
    pub start: String,
    pub end: String,
    pub meeting_url: Option<String>,
    pub seconds_until_start: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Occurrence {
    provider_key: String,
    room_key: String,
    start: i64,
    end: i64,
}

impl Occurrence {
    fn from_event(source: CalendarSource, event: &CalendarEventItem) -> Option<Self> {
        if event.is_all_day {
            return None;
        }
        let start = DateTime::parse_from_rfc3339(&event.start).ok()?.timestamp();
        let end = DateTime::parse_from_rfc3339(&event.end).ok()?.timestamp();
        if end <= start {
            return None;
        }
        // A join reminder needs an actual supported conference link. Native
        // calendars can put arbitrary document URLs in their URL field.
        let room = meeting_url_identity(event.meeting_url.as_deref()?)?;
        let room_key = digest(&format!("{room}|{start}"));
        let provider_key = if event.id.is_empty() {
            room_key.clone()
        } else {
            digest(&format!(
                "{source:?}|{}|{}|{start}",
                event.calendar_name, event.id
            ))
        };
        Some(Self {
            provider_key,
            room_key,
            start,
            end,
        })
    }

    fn keys(&self) -> [&str; 2] {
        [&self.provider_key, &self.room_key]
    }
}

fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
enum Disposition {
    Emitted,
    Removed,
    AlreadyJoined,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Receipt {
    expires_at: i64,
    disposition: Disposition,
}

#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
struct Ledger {
    // Persist the last observed identities per provider so a deletion noticed
    // after restart also retires stale copies in another calendar source.
    observed: BTreeMap<CalendarSource, BTreeMap<String, Occurrence>>,
    receipts: BTreeMap<String, Receipt>,
}

impl Ledger {
    fn record(&mut self, occurrence: &Occurrence, disposition: Disposition) {
        // Remember every provider alias of this occurrence, so editing one
        // copy's join URL cannot bypass a dismissal recorded through another.
        let aliases: Vec<_> = self
            .observed
            .values()
            .flat_map(|events| events.values())
            .filter(|event| event.room_key == occurrence.room_key)
            .flat_map(|event| event.keys().map(str::to_owned))
            .chain(occurrence.keys().map(str::to_owned))
            .collect();
        for key in aliases {
            self.receipts.insert(
                key,
                Receipt {
                    expires_at: occurrence.end + RETENTION_SECONDS,
                    disposition: disposition.clone(),
                },
            );
        }
    }

    fn suppressed(&self, occurrence: &Occurrence) -> bool {
        occurrence
            .keys()
            .iter()
            .any(|key| self.receipts.contains_key(*key))
    }

    fn reconcile(&mut self, snapshot: &snapshots::CalendarSnapshots, now: i64) {
        self.receipts.retain(|_, receipt| receipt.expires_at > now);
        for previous in self.observed.values_mut() {
            previous.retain(|_, event| event.end + RETENTION_SECONDS > now);
        }
        // Sources that have not refreshed yet are deliberately untouched.
        // The first native snapshot at startup cannot delete Google's events.
        for (source, events) in &snapshot.sources {
            let current: BTreeMap<_, _> = events
                .iter()
                .filter_map(|event| Occurrence::from_event(source.clone(), event))
                .filter(|event| event.end + RETENTION_SECONDS > now)
                .map(|event| (event.provider_key.clone(), event))
                .collect();
            if let Some(previous) = self.observed.insert(source.clone(), current.clone()) {
                for (key, occurrence) in previous {
                    if !current.contains_key(&key) && occurrence.start > now {
                        self.record(&occurrence, Disposition::Removed);
                    }
                }
            }
        }
    }

    fn due(
        &self,
        snapshot: &snapshots::CalendarSnapshots,
        now: i64,
        lead: i64,
    ) -> Vec<(Occurrence, CalendarEventItem)> {
        let mut due = BTreeMap::new();
        for (source, events) in &snapshot.sources {
            for event in events {
                let Some(occurrence) = Occurrence::from_event(source.clone(), event) else {
                    continue;
                };
                // Never catch up a reminder for a call that has already started
                // after sleep or a clock jump. Late discovery before start is OK.
                if occurrence.start > now
                    && occurrence.start - now <= lead
                    && !self.suppressed(&occurrence)
                {
                    due.entry(occurrence.room_key.clone())
                        .or_insert((occurrence, event.clone()));
                }
            }
        }
        due.into_values().collect()
    }
}

pub(crate) fn preferences(prefs: Option<&Value>) -> (bool, i64) {
    let enabled = prefs
        .and_then(|p| p.get("meetingReminders"))
        .and_then(Value::as_bool)
        // Preserve the opt-out of users who disabled the formerly shared toggle.
        .or_else(|| {
            prefs
                .and_then(|p| p.get("meetingLiveNotes"))
                .and_then(Value::as_bool)
        })
        .unwrap_or(true);
    let lead = prefs
        .and_then(|p| p.get("meetingReminderLeadSeconds"))
        .and_then(Value::as_i64)
        .unwrap_or(DEFAULT_LEAD_SECONDS)
        .clamp(1, MAX_LEAD_SECONDS);
    (enabled, lead)
}

pub(crate) fn enabled(app: &AppHandle) -> bool {
    SettingsStore::get(app)
        .ok()
        .flatten()
        .map(|settings| preferences(settings.extra.get("notificationPrefs")).0)
        .unwrap_or(false)
}

fn read_ledger(path: &Path) -> std::io::Result<Ledger> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Ledger::default()),
        Err(error) => Err(error),
    }
}

fn write_ledger(path: &Path, ledger: &Ledger) -> std::io::Result<()> {
    let json = serde_json::to_string(ledger)?;
    screenpipe_core::memories::external_sync::write_atomic_full(path, &json).map(|_| ())
}

async fn persist(path: &Path, ledger: &Ledger) -> Result<(), String> {
    let path = path.to_path_buf();
    let ledger = ledger.clone();
    tokio::task::spawn_blocking(move || write_ledger(&path, &ledger))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("kind={:?} os_code={:?}: {e}", e.kind(), e.raw_os_error()))
}

pub(crate) fn report_failure(stage: &str, cause: &str) {
    warn!(
        stage,
        cause,
        outcome = "reminder_withheld",
        "meeting reminder scheduler failed"
    );
}

pub(crate) fn start(app: AppHandle) {
    let snapshots = snapshots::subscribe();
    let path = screenpipe_core::paths::default_screenpipe_data_dir().join("meeting-reminders.json");
    tauri::async_runtime::spawn(run(app, path, snapshots));
}

async fn run(
    app: AppHandle,
    path: PathBuf,
    mut snapshots: tokio::sync::watch::Receiver<snapshots::CalendarSnapshots>,
) {
    let read_path = path.clone();
    let mut ledger = match tokio::task::spawn_blocking(move || read_ledger(&read_path)).await {
        Ok(Ok(ledger)) => ledger,
        result => {
            // Resetting corrupt state would re-suggest rejected meetings.
            let cause = match result {
                Ok(Err(error)) => format!(
                    "kind={:?} os_code={:?}: {error}",
                    error.kind(),
                    error.raw_os_error()
                ),
                Err(error) => error.to_string(),
                _ => unreachable!(),
            };
            report_failure("ledger_read", &cause);
            return;
        }
    };
    let mut snapshot = snapshots.borrow_and_update().clone();
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    info!("meeting reminder scheduler started");
    loop {
        tokio::select! {
            _ = tick.tick() => {},
            changed = snapshots.changed() => {
                if changed.is_err() { return; }
                snapshot = snapshots.borrow_and_update().clone();
            }
        }
        // Prefer the latest schedule even when a tick and a deletion arrived
        // together; a timer must never keep a removed event alive.
        if snapshots.has_changed().unwrap_or(false) {
            snapshot = snapshots.borrow_and_update().clone();
        }
        let now = Utc::now().timestamp();
        let mut next = ledger.clone();
        next.reconcile(&snapshot, now);
        if next != ledger {
            if let Err(cause) = persist(&path, &next).await {
                report_failure("snapshot_write", &cause);
                // Do not emit from stale rejection/deletion state.
                tokio::time::sleep(Duration::from_secs(10)).await;
                continue;
            }
            ledger = next;
        }
        let Ok(Some(settings)) = SettingsStore::get(&app) else {
            continue;
        };
        let (enabled, lead) = preferences(settings.extra.get("notificationPrefs"));
        if !enabled || crate::notifications::gate::suppressed_now(&app, Some("meeting"), None) {
            continue;
        }
        for (occurrence, event) in ledger.due(&snapshot, now, lead) {
            let joined = match already_joined(&app, &occurrence, &snapshot).await {
                Ok(joined) => joined,
                Err(cause) => {
                    report_failure("active_meeting_read", &cause);
                    break;
                }
            };
            let mut next = ledger.clone();
            next.record(
                &occurrence,
                if joined {
                    Disposition::AlreadyJoined
                } else {
                    Disposition::Emitted
                },
            );
            // Reserve durably before publishing: an event is offered at most
            // once, even if the user dismisses it or the process restarts.
            if let Err(cause) = persist(&path, &next).await {
                report_failure("receipt_write", &cause);
                break;
            }
            if joined {
                ledger = next;
                continue;
            }
            // Calendar I/O can finish while the DB/state write is in flight.
            // Reconcile that new snapshot before offering anything from the
            // old one; a deletion must win over a pending timer.
            if snapshots.has_changed().unwrap_or(false) {
                if let Err(cause) = persist(&path, &ledger).await {
                    report_failure("receipt_rollback", &cause);
                    return;
                }
                break;
            }
            let seconds_until_start = occurrence.start - Utc::now().timestamp();
            if seconds_until_start <= 0 {
                ledger = next;
                continue;
            }
            if let Err(error) = publish_reminder(event, seconds_until_start) {
                report_failure("event_publish", &error.to_string());
                if let Err(cause) = persist(&path, &ledger).await {
                    report_failure("receipt_rollback", &cause);
                    return;
                }
                break;
            }
            ledger = next;
            info!(occurrence = %occurrence.provider_key, seconds_until_start,
                outcome = "event_emitted", "meeting reminder event published");
        }
    }
}

fn publish_reminder(event: CalendarEventItem, seconds_until_start: i64) -> anyhow::Result<()> {
    screenpipe_events::send_event(
        "meeting_about_to_start",
        MeetingPrewarmEvent {
            title: event.title,
            start: event.start,
            end: event.end,
            meeting_url: event.meeting_url,
            seconds_until_start,
        },
    )
}

fn matches_bound_event(
    snapshot: &snapshots::CalendarSnapshots,
    occurrence: &Occurrence,
    bound: &str,
) -> bool {
    !bound.is_empty()
        && snapshot.sources.iter().any(|(source, events)| {
            events.iter().any(|event| {
                event.id == bound
                    && Occurrence::from_event(source.clone(), event)
                        .is_some_and(|candidate| candidate.room_key == occurrence.room_key)
            })
        })
}

async fn already_joined(
    app: &AppHandle,
    occurrence: &Occurrence,
    snapshot: &snapshots::CalendarSnapshots,
) -> Result<bool, String> {
    let Some(state) = app.try_state::<crate::recording::RecordingState>() else {
        return Ok(false);
    };
    let db = {
        let core = state.server.lock().await;
        core.as_ref().map(|core| core.db.clone())
    };
    let Some(db) = db else { return Ok(false) };
    let Some(active) = db
        .get_most_recent_active_meeting()
        .await
        .map_err(|e| e.to_string())?
    else {
        return Ok(false);
    };
    // Compare the actual bound event, so being in the previous call does not
    // hide a reminder for the next one.
    let bound = db
        .meeting_calendar_event_id(active.id)
        .await
        .map_err(|e| e.to_string())?;
    Ok(bound
        .as_deref()
        .is_some_and(|bound| matches_bound_event(snapshot, occurrence, bound)))
}

#[cfg(test)]
mod tests;
