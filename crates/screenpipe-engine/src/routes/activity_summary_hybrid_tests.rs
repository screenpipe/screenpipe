// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use super::resolved_frames_cte;
use rusqlite::{functions::FunctionFlags, Connection, StatementStatus};
use screenpipe_db::DatabaseManager;
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Instant,
};

// Use the real hybrid schema and seal real UI-event payloads before measuring
// SQL work. The counting reader below substitutes only Parquet I/O; it makes
// unrelated payload visits deterministic without timing-dependent assertions.
async fn fixture(history_events: usize) -> (Connection, Arc<AtomicUsize>, tempfile::TempDir) {
    let root = tempfile::tempdir().unwrap();
    let db = DatabaseManager::new_hybrid(root.path(), Default::default(), Default::default())
        .await
        .unwrap();
    db.execute_raw_sql_write(&format!(
        "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < {history_events})
         INSERT INTO ui_events(id,timestamp,relative_ms,event_type,app_name,window_title,browser_url)
         SELECT x,'2026-01-01 10:00:00',0,'click','OldApp','Window' || x,'https://example.test/' || x FROM n;
         INSERT INTO frames(id,timestamp,app_name,window_name) VALUES
           (1,'2026-06-02 10:00:00','Native','NativeWindow'),
           (2,'2026-06-02 10:00:10',NULL,NULL),
           (3,'2026-06-02 10:00:20','',NULL);
         INSERT INTO ui_events(id,timestamp,relative_ms,event_type,app_name,window_title,browser_url,frame_id)
         VALUES ({linked},'2026-06-02 10:00:09',0,'click','Recovered','Window{linked}','https://example.test/{linked}',2);",
        linked = history_events + 1,
    )).await.unwrap();
    while db.seal_payloads().await.unwrap() != 0 {}
    let cte = resolved_frames_cte("2026-06-02 10:00:00", "2026-06-02 10:01:00");
    // Verify actual Parquet reads before replacing the I/O with a counter.
    let rows = db
        .query_raw_sql(&format!("{cte} SELECT * FROM resolved_frames ORDER BY id"))
        .await
        .unwrap();
    assert_eq!(rows[0]["app_name"], "Native");
    assert_eq!(
        rows[1]["window_name"],
        format!("Window{}", history_events + 1)
    );
    assert_eq!(rows[2]["app_name"], "Recovered");
    let index = root.path().join(&db.storage_descriptor().unwrap().index);
    db.close().await;
    drop(db);
    let conn = Connection::open(index).unwrap();
    let reads = Arc::new(AtomicUsize::new(0));
    let observed = reads.clone();
    conn.create_scalar_function(
        "screenpipe_bulk",
        5,
        FunctionFlags::SQLITE_UTF8,
        move |ctx| {
            observed.fetch_add(1, Ordering::Relaxed);
            let id: i64 = ctx.get(3)?;
            let column: i64 = ctx.get(4)?;
            Ok(match column {
                5 => format!("Window{id}"),
                6 => format!("https://example.test/{id}"),
                _ => String::new(),
            })
        },
    )
    .unwrap();
    conn.execute_batch("CREATE TEMP VIEW ui_events AS SELECT * FROM main._bulk_logical_ui_events;")
        .unwrap();
    (conn, reads, root)
}

fn queries() -> [String; 2] {
    let after = resolved_frames_cte("2026-06-02 10:00:00", "2026-06-02 10:01:00");
    // Exact pre-fix resolved_frames relation. Selection of fallback IDs and
    // attribution semantics remain identical for the paired measurement.
    let (prefix, _) = after
        .split_once(", resolved_frames AS MATERIALIZED")
        .unwrap();
    let prefix = prefix.replace("FROM main.ui_events u", "FROM ui_events u");
    let before = format!("{prefix}, resolved_frames AS MATERIALIZED (
        SELECT f.id, f.timestamp,
          COALESCE(NULLIF(f.app_name, ''), NULLIF(u.app_name, '')) AS app_name,
          CASE WHEN f.app_name IS NULL OR f.app_name = '' THEN NULLIF(u.window_title, '') ELSE NULLIF(f.window_name, '') END AS window_name,
          CASE WHEN f.app_name IS NULL OR f.app_name = '' THEN NULLIF(u.browser_url, '') ELSE NULLIF(f.browser_url, '') END AS browser_url,
          f.focused, f.document_path,
          CASE WHEN f.app_name IS NOT NULL AND f.app_name != '' THEN 'frame'
            WHEN u.app_name IS NOT NULL AND u.app_name != '' THEN 'ui_event' ELSE NULL END AS attribution_source
        FROM frame_fallback f LEFT JOIN ui_events u ON u.id = f.fallback_event_id
      )");
    [before, after].map(|cte| format!("{cte} SELECT id, app_name, window_name, browser_url, attribution_source FROM resolved_frames ORDER BY id"))
}

type Row = (
    i64,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

fn run(conn: &Connection, sql: &str) -> (Vec<Row>, i32) {
    let mut statement = conn.prepare(sql).unwrap();
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    (rows, statement.get_status(StatementStatus::VmStep))
}

#[tokio::test]
async fn activity_summary_hybrid_reads_only_selected_fallback_payloads() {
    let (conn, reads, _root) = fixture(2_000).await;
    for analyzed in [false, true] {
        if analyzed {
            conn.execute_batch("ANALYZE").unwrap();
        }
        let [before, after] = queries();
        reads.store(0, Ordering::Relaxed);
        let expected = run(&conn, &before).0;
        assert!(
            reads.load(Ordering::Relaxed) >= 4_000,
            "baseline must reproduce the archive scan"
        );
        reads.store(0, Ordering::Relaxed);
        let (actual, steps) = run(&conn, &after);
        assert_eq!(actual, expected);
        // Two recovered frames, two payload columns each; the native frame
        // must not read any UI-event payload, including its nearby event.
        assert_eq!(reads.load(Ordering::Relaxed), 4);
        assert!(
            steps < 2_000,
            "work must follow selected frames, got {steps} VM steps"
        );
    }
}

/// SQL-only paired benchmark; archive calls are counted, not timed as disk I/O.
#[tokio::test]
#[ignore = "manual paired benchmark with 100,000 unrelated archived UI events"]
async fn benchmark_activity_summary_hybrid_lookup() {
    let (conn, reads, _root) = fixture(100_000).await;
    let queries = queries();
    let expected = run(&conn, &queries[0]).0;
    assert_eq!(run(&conn, &queries[1]).0, expected);
    for (label, sql) in ["before", "after"].into_iter().zip(queries) {
        let mut times = Vec::new();
        let mut steps = 0;
        let mut payloads = 0;
        for _ in 0..7 {
            reads.store(0, Ordering::Relaxed);
            let start = Instant::now();
            let result = run(&conn, &sql);
            times.push(start.elapsed().as_secs_f64() * 1000.0);
            assert_eq!(result.0, expected);
            steps = result.1;
            payloads = reads.load(Ordering::Relaxed);
        }
        times.sort_by(f64::total_cmp);
        eprintln!(
            "{label}: median_ms={:.3} vm_steps={steps} payload_calls={payloads} sqlite={}",
            times[3],
            rusqlite::version()
        );
    }
}
