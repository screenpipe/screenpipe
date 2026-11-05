// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Metadata-only first observed human input. This is a heuristic, never a shift
//! boundary or proof that no work happened before recording began.
use crate::DatabaseManager;
use chrono::{DateTime, Duration, Utc};
use serde::Serialize;

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct DayStartEvidence {
    pub event_id: i64,
    pub timestamp: String,
    pub event_type: String,
    pub machine_id: Option<String>,
}

pub fn validate_day_window(start: DateTime<Utc>, end: DateTime<Utc>) -> Result<(), &'static str> {
    if start >= end || end - start > Duration::hours(25) {
        return Err("start_time and end_time must bound one day (at most 25 hours), end exclusive");
    }
    Ok(())
}

impl DatabaseManager {
    /// None selects device-local input only. Enterprise callers resolve the
    /// authorized device to its source IDs before passing Some(ids).
    pub async fn first_input_for_day(
        &self,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
        machines: Option<&[String]>,
    ) -> Result<Option<DayStartEvidence>, sqlx::Error> {
        let machines = machines
            .map(serde_json::to_string)
            .transpose()
            .map_err(|e| sqlx::Error::Protocol(e.to_string()))?;
        // The lexical guard uses the existing timestamp index, with padding for
        // timezone offsets. julianday then handles mixed RFC3339 offsets exactly.
        self.consistent_read(|| async {
            sqlx::query_as(
                "SELECT id AS event_id, timestamp, event_type, machine_id FROM ui_events
             WHERE timestamp >= ?1 AND timestamp < ?2
               AND julianday(timestamp) >= julianday(?3)
               AND julianday(timestamp) < julianday(?4)
               AND ((?5 IS NULL AND machine_id IS NULL)
                    OR machine_id IN (SELECT value FROM json_each(?5)))
               AND event_type IN ('click', 'move', 'scroll', 'key', 'text')
             ORDER BY julianday(timestamp), id LIMIT 1",
            )
            .bind((start - Duration::days(1)).to_rfc3339())
            .bind((end + Duration::days(1)).to_rfc3339())
            .bind(start.to_rfc3339())
            .bind(end.to_rfc3339())
            .bind(machines.as_deref())
            .fetch_optional(&self.pool)
            .await
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn day_window_accepts_dst_but_rejects_unbounded_ranges() {
        let start: DateTime<Utc> = "2026-11-01T07:00:00Z".parse().unwrap();
        assert!(validate_day_window(start, start + Duration::hours(25)).is_ok());
        assert!(validate_day_window(start, start).is_err());
        assert!(validate_day_window(start, start - Duration::hours(1)).is_err());
        assert!(validate_day_window(start, start + Duration::hours(26)).is_err());
    }
    #[tokio::test]
    async fn first_input_excludes_passive_events_and_isolates_devices() {
        let dir = tempfile::tempdir().unwrap();
        let db = DatabaseManager::new(
            dir.path().join("test.db").to_str().unwrap(),
            Default::default(),
        )
        .await
        .unwrap();
        let writer = db.coordinated_writer().lock().await.unwrap();
        for (ts, kind, machine) in [
            ("2026-11-05T07:59:59Z", "click", None),
            ("2026-11-05T08:00:00Z", "app_switch", None),
            ("2026-11-05T09:00:00Z", "click", Some("other")),
            ("2026-11-05T11:00:00+01:00", "key", None),
            ("2026-11-05T09:30:00Z", "scroll", None),
            ("2026-11-06T08:00:00Z", "click", Some("empty")),
        ] {
            sqlx::query("INSERT INTO ui_events(timestamp,event_type,machine_id) VALUES(?,?,?)")
                .bind(ts)
                .bind(kind)
                .bind(machine)
                .execute(writer.pool())
                .await
                .unwrap();
        }
        drop(writer);
        let start = "2026-11-05T08:00:00Z".parse().unwrap();
        let end = "2026-11-06T08:00:00Z".parse().unwrap();
        let local = db
            .first_input_for_day(start, end, None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(local.event_type, "scroll");
        assert!(local.machine_id.is_none());
        let remote = db
            .first_input_for_day(start, end, Some(&["other".into()]))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(remote.machine_id.as_deref(), Some("other"));
        assert!(db
            .first_input_for_day(start, end, Some(&["empty".into()]))
            .await
            .unwrap()
            .is_none());
        assert!(db
            .first_input_for_day(start, end, Some(&[]))
            .await
            .unwrap()
            .is_none());
    }
}
