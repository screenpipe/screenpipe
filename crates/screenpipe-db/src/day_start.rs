// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Metadata-only first observed human input. This is a heuristic, never a shift
//! boundary or proof that no work happened before recording began.
use crate::DatabaseManager;
use chrono::{DateTime, Duration, Utc};
use oasgen::OaSchema;
use serde::Serialize;

#[derive(Debug, Clone, Serialize, OaSchema, sqlx::FromRow)]
pub struct DayStartEvidence {
    pub event_id: i64,
    pub timestamp: String,
    pub event_type: String,
    pub machine_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, OaSchema)]
pub struct DayStartObservation {
    pub status: String,
    pub window_start: DateTime<Utc>,
    pub window_end: DateTime<Utc>,
    pub first_observed_input: Option<DayStartEvidence>,
    pub is_confirmed_work_start: bool,
    pub coverage: String,
    pub activity_sampling_interval_ms: u32,
}
impl DayStartObservation {
    pub fn new(
        status: &str,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
        evidence: Option<DayStartEvidence>,
    ) -> Self {
        Self {
            status: status.into(),
            window_start: start,
            window_end: end,
            first_observed_input: evidence,
            is_confirmed_work_start: false,
            coverage: "recorded_only".into(),
            activity_sampling_interval_ms: 60_000,
        }
    }
}

const FIRST_INPUT_SQL: &str = "SELECT id AS event_id, timestamp, event_type, machine_id
    FROM (SELECT id, timestamp, event_type, machine_id FROM ui_events
          WHERE timestamp >= ?1 AND timestamp < ?2 LIMIT -1 OFFSET 0) AS candidates
    WHERE julianday(timestamp) >= julianday(?3) AND julianday(timestamp) < julianday(?4)
      AND ((?5 IS NULL AND machine_id IS NULL) OR machine_id IN (SELECT value FROM json_each(?5)))
      AND event_type IN ('click', 'move', 'scroll', 'key', 'text', 'keypress', 'text_input')
    ORDER BY julianday(timestamp), id LIMIT 1";

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
        validate_day_window(start, end).map_err(|error| sqlx::Error::Protocol(error.into()))?;
        let lexical_start = start
            .checked_sub_signed(Duration::days(1))
            .ok_or_else(|| sqlx::Error::Protocol("start outside supported range".into()))?;
        let lexical_end = end
            .checked_add_signed(Duration::days(1))
            .ok_or_else(|| sqlx::Error::Protocol("end outside supported range".into()))?;
        let machines = machines
            .map(serde_json::to_string)
            .transpose()
            .map_err(|e| sqlx::Error::Protocol(e.to_string()))?;
        // OFFSET prevents subquery flattening/predicate pushdown: SQLite must
        // range-scan the timestamp index before applying event/device filters.
        // The lexical guard uses the existing timestamp index, with padding for
        // timezone offsets. julianday then handles mixed RFC3339 offsets exactly.
        self.consistent_read(|| async {
            // Existing progress-handler guard interrupts SQLite itself when
            // optional enrichment times out, rather than only dropping its waiter.
            let mut connection = self.acquire_search_read().await?;
            sqlx::query_as(FIRST_INPUT_SQL)
                .bind(lexical_start.to_rfc3339())
                .bind(lexical_end.to_rfc3339())
                .bind(start.to_rfc3339())
                .bind(end.to_rfc3339())
                .bind(machines.as_deref())
                .fetch_optional(&mut *connection)
                .await
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::Executor;
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
    #[tokio::test]
    async fn day_start_query_plan_is_a_timestamp_range_scan() {
        let dir = tempfile::tempdir().unwrap();
        let db = DatabaseManager::new(
            dir.path().join("plan.db").to_str().unwrap(),
            Default::default(),
        )
        .await
        .unwrap();
        let sql = format!("EXPLAIN QUERY PLAN {FIRST_INPUT_SQL}");
        let rows = sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind("2026-11-04")
            .bind("2026-11-07")
            .bind("2026-11-05")
            .bind("2026-11-06")
            .bind(Option::<String>::None)
            .fetch_all(&db.pool)
            .await
            .unwrap();
        use sqlx::Row;
        let plan = rows
            .iter()
            .map(|r| r.get::<String, _>("detail"))
            .collect::<Vec<_>>()
            .join("\n");
        eprintln!("{plan}");
        assert!(plan.contains("idx_ui_events_timestamp"), "{plan}");
        assert!(!plan.contains("idx_ui_events_event_type"), "{plan}");
    }
    #[tokio::test]
    async fn day_start_sparse_input_is_eligible_for_existing_context_only_sync() {
        let dir = tempfile::tempdir().unwrap();
        let db = DatabaseManager::new(
            dir.path().join("sync.db").to_str().unwrap(),
            Default::default(),
        )
        .await
        .unwrap();
        let writer = db.coordinated_writer().lock().await.unwrap();
        writer.pool().execute("INSERT INTO ui_events(timestamp,event_type,x,y) VALUES ('2026-11-05T09:00:00Z','move',NULL,NULL),('2026-11-05T09:00:01Z','move',5,6),('2026-11-05T09:00:02Z','key',NULL,NULL)").await.unwrap();
        drop(writer);
        let rows = db
            .search_ui_events_ordered(
                None,
                None,
                None,
                None,
                None,
                None,
                10,
                0,
                crate::Order::Ascending,
                true,
            )
            .await
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].event_type, crate::UiEventType::Move);
    }
}
