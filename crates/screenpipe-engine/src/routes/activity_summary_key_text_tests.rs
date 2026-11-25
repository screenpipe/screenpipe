// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use super::{key_texts_query, resolved_frames_cte};
use rusqlite::{Connection, StatementStatus};
use std::time::{Duration, Instant};

// Migrate through the real manager, then close its pools/background maintenance.
// A single connection makes planner-statistics state and VM work reproducible.
async fn fixture(history_frames: usize, recent_frames: usize) -> (Connection, tempfile::TempDir) {
    let (db, dir) = super::db_tests::fresh_db().await;
    db.close().await;
    drop(db);
    let conn = Connection::open(dir.path().join("test.db")).unwrap();
    conn.execute_batch(&format!(
        "BEGIN;
         WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < {history_frames})
         INSERT INTO frames (timestamp, app_name, window_name)
         SELECT datetime('2026-01-01', '+' || (x * 30) || ' seconds'),
                'OldApp', 'OldWindow' FROM n;
         WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < {recent_frames})
         INSERT INTO frames (timestamp, app_name, window_name)
         SELECT datetime('2026-06-02', '+' || ((x-1) * 30) || ' seconds'),
                CASE WHEN x % 17 = 0 THEN NULL ELSE 'App' || ((x / 12) % 4) END,
                'Window' || (x % 12) FROM n;
         INSERT INTO ui_events (timestamp, relative_ms, event_type, app_name, window_title, frame_id)
         SELECT timestamp, 0, 'click', 'Recovered', 'RecoveredWindow', id
         FROM frames WHERE app_name IS NULL;
         WITH slots(n) AS (VALUES(0),(1),(2),(3),(4),(5),(6),(7),(8),(9))
         INSERT INTO elements (frame_id, source, role, text)
         SELECT f.id,
                CASE WHEN n = 9 THEN 'ocr' ELSE 'accessibility' END,
                CASE WHEN n < 2 THEN 'AXTextField' ELSE 'AXStaticText' END,
                printf('Planning context for frame %06d, candidate %d: ', f.id, n)
                  || substr('abcdefghij', 1, n)
         FROM frames f CROSS JOIN slots;
         COMMIT;
         ANALYZE;
         DELETE FROM sqlite_stat1;
         DELETE FROM sqlite_stat4;
         ANALYZE sqlite_schema;"
    ))
    .unwrap();
    (conn, dir)
}

fn unoptimized_key_texts_query(resolved_frames_cte: &str, app_filter_f: &str) -> String {
    format!(
        "{resolved_frames_cte}, ranked_contexts AS ( \
           SELECT e.text, f.app_name, \
             COALESCE(f.window_name, '') as window_name, \
             f.timestamp, \
             DATE(f.timestamp) AS bucket, \
             ROW_NUMBER() OVER ( \
               PARTITION BY DATE(f.timestamp), f.app_name, f.window_name \
               ORDER BY \
                 CASE WHEN e.role IN ('AXTextArea', 'AXTextField') THEN 0 ELSE 1 END, \
                 LENGTH(e.text) DESC, \
                 f.timestamp DESC \
             ) as rn \
           FROM resolved_frames f \
           CROSS JOIN elements e ON e.frame_id = f.id \
           WHERE 1 = 1{app_filter_f} \
           AND e.text IS NOT NULL \
           AND e.source = 'accessibility' \
           AND LENGTH(e.text) BETWEEN 30 AND 300 \
           AND e.text NOT LIKE 'http%' \
           AND e.text NOT LIKE 'cdn.%' \
         ), balanced AS ( \
           SELECT text, app_name, window_name, timestamp, bucket, \
             ROW_NUMBER() OVER (PARTITION BY bucket ORDER BY timestamp DESC) AS bucket_rank \
           FROM ranked_contexts \
           WHERE rn = 1 \
         ) \
         SELECT text, app_name, window_name, timestamp \
         FROM balanced \
         ORDER BY bucket_rank ASC, timestamp ASC \
         LIMIT 20"
    )
}

fn queries(start: &str, end: &str, app: Option<&str>) -> [String; 2] {
    let filter = app
        .map(|app| format!(" AND f.app_name = '{}'", super::sql_escape(app)))
        .unwrap_or_default();
    let cte = resolved_frames_cte(start, end);
    let after = key_texts_query(&cte, &filter);
    let before = unoptimized_key_texts_query(&cte, &filter);
    [before, after]
}

type TextRow = (String, Option<String>, String, String);

fn run(conn: &Connection, sql: &str) -> (Vec<TextRow>, i32, Duration) {
    let start = Instant::now();
    let mut statement = conn.prepare(sql).unwrap();
    let rows = statement
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    (
        rows,
        statement.get_status(StatementStatus::VmStep),
        start.elapsed(),
    )
}

fn plan(conn: &Connection, sql: &str) -> Vec<String> {
    conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
        .unwrap()
        .query_map([], |row| row.get(3))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
}

#[tokio::test]
async fn key_text_work_is_bounded_by_frames_in_the_requested_range() {
    let (conn, _dir) = fixture(2_000, 120).await;
    for (start, end) in [
        ("2026-06-02 00:00:00", "2026-06-02 00:05:00"),
        ("2026-07-01 00:00:00", "2026-07-02 00:00:00"),
    ] {
        let [before, after] = queries(start, end, None);
        let (expected, before_steps, _) = run(&conn, &before);
        let (actual, after_steps, _) = run(&conn, &after);
        assert_eq!(actual, expected);
        // A work ceiling, not a wall-clock timeout: at most 11 frames and 99
        // accessibility elements here, regardless of the older history.
        assert!(
            after_steps < 20_000,
            "narrow/empty ranges must not scan history: before={before_steps}, after={after_steps}"
        );
        let details = plan(&conn, &after);
        assert!(
            details
                .iter()
                .any(|line| line.contains("SEARCH e USING INDEX")
                    && line.contains("frame_id=? AND source=?")),
            "expected per-frame indexed element lookup: {details:?}"
        );
    }
}

#[tokio::test]
async fn key_text_join_preserves_selection_filters_and_recovered_attribution() {
    let (conn, _dir) = fixture(200, 120).await;
    // Invalid candidates must never win even with the preferred input role.
    conn.execute_batch(
        "INSERT INTO elements (frame_id, source, role, text)
         SELECT id, 'accessibility', 'AXTextArea', invalid.text
         FROM frames CROSS JOIN (
           SELECT NULL AS text UNION ALL SELECT 'short'
           UNION ALL SELECT 'https://example.com/this-is-not-representative-text'
           UNION ALL SELECT 'cdn.example.com/this-is-not-representative-text'
           UNION ALL SELECT printf('%0301d', 0)
         ) invalid;",
    )
    .unwrap();
    for analyzed in [false, true] {
        if analyzed {
            conn.execute_batch("ANALYZE").unwrap();
        }
        for app in [None, Some("App1"), Some("Recovered"), Some("Absent'app")] {
            let [before, after] = queries("2026-06-02 00:00:00", "2026-06-03 00:00:00", app);
            let (expected, _, _) = run(&conn, &before);
            let (actual, _, _) = run(&conn, &after);
            assert_eq!(actual, expected, "app={app:?}, analyzed={analyzed}");
            if app == Some("Absent'app") {
                assert!(actual.is_empty());
            } else {
                assert!(!actual.is_empty());
                assert!(actual.len() <= 20);
                for (text, name, window, _) in actual {
                    assert!(
                        text.contains("candidate 1:"),
                        "input/length preference: {text}"
                    );
                    if let Some(app) = app {
                        assert_eq!(name.as_deref(), Some(app));
                    }
                    if app == Some("Recovered") {
                        assert_eq!(window, "RecoveredWindow");
                    }
                }
            }
        }
    }
}

#[tokio::test]
async fn key_text_work_is_bounded_on_dense_multi_day_windows() {
    let (conn, _dir) = fixture(0, 3_000).await;
    // Spread 3,000 frames across a 7-day range with heavy repetition per
    // (day, app, window) so an unsampled join probes 30,000 elements while
    // sampled_frames caps element probes to at most 300 frames.
    conn.execute_batch(
        "UPDATE frames
         SET timestamp = datetime('2026-06-01', '+' || ((id - 1) * 200) || ' seconds'),
             app_name = 'Editor',
             window_name = 'Workspace-' || (id % 6);",
    )
    .unwrap();
    let [before, after] = queries("2026-06-01 00:00:00", "2026-06-08 00:00:00", None);
    let (expected, before_steps, _) = run(&conn, &before);
    let (actual, after_steps, _) = run(&conn, &after);
    assert_eq!(actual.len(), 20);
    assert_eq!(actual, expected);
    assert!(
        after_steps * 4 < before_steps,
        "expected >=4x fewer VM steps on dense multi-day range: before={before_steps}, after={after_steps}"
    );
}

/// cargo test -p screenpipe-engine --lib benchmark_activity_summary_key_texts -- --ignored --nocapture
/// SQL-only, synthetic migrated file DB; does not measure HTTP or Windows.
#[tokio::test]
#[ignore = "manual paired benchmark with one million historical elements"]
async fn benchmark_activity_summary_key_texts() {
    let (conn, _dir) = fixture(100_000, 2_880).await;
    eprintln!("SQLite {}, {} {}, 102880 frames, 1028800 elements, 7 alternating samples after one warmup per query",
        rusqlite::version(), std::env::consts::OS, std::env::consts::ARCH);
    for analyzed in [false, true] {
        if analyzed {
            conn.execute_batch("ANALYZE").unwrap();
        }
        for (label, start, end, app) in [
            ("24h", "2026-06-02 00:00:00", "2026-06-03 00:00:00", None),
            ("5m", "2026-06-02 12:00:00", "2026-06-02 12:05:00", None),
            ("empty", "2026-07-01 00:00:00", "2026-07-02 00:00:00", None),
            (
                "24h app filter",
                "2026-06-02 00:00:00",
                "2026-06-03 00:00:00",
                Some("App1"),
            ),
            (
                "all history",
                "2026-01-01 00:00:00",
                "2026-07-01 00:00:00",
                None,
            ),
        ] {
            let sql = queries(start, end, app);
            assert_ne!(sql[0], sql[1], "baseline join replacement must match");
            let expected = run(&conn, &sql[0]).0;
            assert_eq!(run(&conn, &sql[1]).0, expected);
            let mut samples = [Vec::new(), Vec::new()];
            let mut steps = [0, 0];
            for round in 0..7 {
                for index in [round % 2, 1 - round % 2] {
                    let (rows, vm_steps, elapsed) = run(&conn, &sql[index]);
                    assert_eq!(rows, expected, "{label}, analyzed={analyzed}");
                    samples[index].push(elapsed.as_secs_f64() * 1000.0);
                    steps[index] = vm_steps;
                }
            }
            for sample in &mut samples {
                sample.sort_by(f64::total_cmp);
            }
            eprintln!("analyzed={analyzed} {label}: rows={} before_ms={:.3} after_ms={:.3} speedup={:.2}x vm_steps={steps:?} samples_ms={samples:?}",
                expected.len(), samples[0][3], samples[1][3], samples[0][3] / samples[1][3]);
            if label == "24h" {
                for (name, sql) in ["before", "after"].into_iter().zip(&sql) {
                    eprintln!(
                        "analyzed={analyzed} {name} plan:\n{}",
                        plan(&conn, sql).join("\n")
                    );
                }
            }
        }
    }
}
