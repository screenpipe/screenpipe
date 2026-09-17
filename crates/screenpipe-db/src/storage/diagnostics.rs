// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Offline migration diagnostics. The observer never queries SQLite, takes its
//! writer, or cancels work. A separate OS thread survives a blocked async worker.

use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fmt::Display,
    future::Future,
    io::Read,
    path::{Path, PathBuf},
    sync::{mpsc, Arc, Mutex},
    time::{Duration, Instant},
};

const DIRECTORY: &str = "storage-migration-diagnostics";
const KEEP_ATTEMPTS: usize = 3;
const MAX_SNAPSHOT_BYTES: u64 = 64 * 1024;
const HEARTBEAT: Duration = Duration::from_secs(30);
const STALL_AFTER: Duration = Duration::from_secs(120);

tokio::task_local! {
    static ACTIVE: Arc<Mutex<Run>>;
}

/// Contains counters and operation names only, never captured text or SQL.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Snapshot {
    pub schema_version: u32,
    pub process_id: u32,
    pub database_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_version: Option<String>,
    pub attempt_id: String,
    pub kind: String,
    pub started_at: String,
    pub observed_at: String,
    pub status: String,
    pub stage: String,
    pub table: Option<String>,
    pub first_id: Option<i64>,
    pub last_id: Option<i64>,
    pub batch_rows: Option<u64>,
    pub batch_bytes: Option<u64>,
    pub completed_records: Option<u64>,
    pub total_records: Option<u64>,
    pub table_records: BTreeMap<String, u64>,
    pub elapsed_seconds: u64,
    pub idle_seconds: u64,
    pub failure_stage: Option<String>,
    pub error: Option<String>,
}

struct Run {
    snapshot: Snapshot,
    started: Instant,
    advanced: Instant,
    revision: u64,
}

impl Run {
    fn snapshot(&self, now: Instant) -> Snapshot {
        let mut snapshot = self.snapshot.clone();
        snapshot.observed_at = chrono::Utc::now().to_rfc3339();
        snapshot.elapsed_seconds = now.duration_since(self.started).as_secs();
        snapshot.idle_seconds = now.duration_since(self.advanced).as_secs();
        snapshot
    }

    fn advance(&mut self) {
        self.advanced = Instant::now();
        self.revision += 1;
    }
}

/// Name the operation BEFORE starting it, including lock and connection waits.
pub fn stage(name: &'static str) {
    let _ = ACTIVE.try_with(|run| {
        let mut run = run.lock().unwrap_or_else(|e| e.into_inner());
        if run.snapshot.stage != name {
            run.snapshot.stage = name.into();
            run.advance();
        }
    });
}

pub fn app_version(version: String) {
    let _ = ACTIVE.try_with(|run| {
        run.lock()
            .unwrap_or_else(|e| e.into_inner())
            .snapshot
            .app_version = Some(version);
    });
}

pub(super) fn batch(
    table: &str,
    first: Option<i64>,
    last: Option<i64>,
    rows: Option<u64>,
    bytes: Option<u64>,
) {
    let _ = ACTIVE.try_with(|run| {
        let mut run = run.lock().unwrap_or_else(|e| e.into_inner());
        let s = &mut run.snapshot;
        if s.table.as_deref() != Some(table)
            || s.first_id != first
            || s.last_id != last
            || s.batch_rows != rows
            || s.batch_bytes != bytes
        {
            s.table = Some(table.into());
            s.first_id = first;
            s.last_id = last;
            s.batch_rows = rows;
            s.batch_bytes = bytes;
            run.advance();
        }
    });
}

pub(super) fn counts(completed: u64, total: u64) {
    let _ = ACTIVE.try_with(|run| {
        let mut run = run.lock().unwrap_or_else(|e| e.into_inner());
        if run.snapshot.completed_records != Some(completed) {
            run.advance();
        }
        run.snapshot.completed_records = Some(completed);
        run.snapshot.total_records = Some(total);
    });
}

pub(super) fn tables(tables: &[super::lifecycle::TableParity]) {
    let _ = ACTIVE.try_with(|run| {
        let mut run = run.lock().unwrap_or_else(|e| e.into_inner());
        run.snapshot.table_records = tables.iter().map(|t| (t.table.clone(), t.rows)).collect();
    });
}

/// Latch the first cause before pool shutdown or recovery changes the stage.
pub(super) fn failure(error: &impl Display) {
    let _ = ACTIVE.try_with(|run| {
        let mut run = run.lock().unwrap_or_else(|e| e.into_inner());
        if run.snapshot.error.is_none() {
            run.snapshot.failure_stage = Some(run.snapshot.stage.clone());
            run.snapshot.error = Some(error.to_string().chars().take(512).collect());
        }
    });
}

struct Finish {
    run: Arc<Mutex<Run>>,
    stop: mpsc::Sender<()>,
}

impl Drop for Finish {
    fn drop(&mut self) {
        let mut run = self.run.lock().unwrap_or_else(|e| e.into_inner());
        if run.snapshot.status == "running" {
            run.snapshot.status = "interrupted".into();
        }
        drop(run);
        let _ = self.stop.send(());
    }
}

/// Observe one attempt. Nested DB calls reuse the desktop attempt, so pausing,
/// conversion, verification and activation share one ID and one watchdog.
/// Diagnostic I/O and notification failures never change the migration result.
pub async fn observe<T, E: Display>(
    root: &Path,
    kind: &'static str,
    observer: impl Fn(&str, &Snapshot) + Send + 'static,
    work: impl Future<Output = Result<T, E>>,
) -> Result<T, E> {
    observe_with_timing(root, kind, observer, work, HEARTBEAT, STALL_AFTER).await
}

async fn observe_with_timing<T, E: Display>(
    root: &Path,
    kind: &'static str,
    observer: impl Fn(&str, &Snapshot) + Send + 'static,
    work: impl Future<Output = Result<T, E>>,
    heartbeat: Duration,
    stall_after: Duration,
) -> Result<T, E> {
    if ACTIVE.try_with(|_| ()).is_ok() {
        return work.await;
    }
    let started = Instant::now();
    let run = Arc::new(Mutex::new(Run {
        snapshot: Snapshot {
            schema_version: 1,
            process_id: std::process::id(),
            database_version: env!("CARGO_PKG_VERSION").into(),
            app_version: None,
            attempt_id: uuid::Uuid::new_v4().to_string(),
            kind: kind.into(),
            started_at: chrono::Utc::now().to_rfc3339(),
            observed_at: String::new(),
            status: "running".into(),
            stage: "starting".into(),
            table: None,
            first_id: None,
            last_id: None,
            batch_rows: None,
            batch_bytes: None,
            completed_records: None,
            total_records: None,
            table_records: BTreeMap::new(),
            elapsed_seconds: 0,
            idle_seconds: 0,
            failure_stage: None,
            error: None,
        },
        started,
        advanced: started,
        revision: 0,
    }));
    let (stop, stopped) = mpsc::channel();
    let finish = Finish {
        run: run.clone(),
        stop,
    };
    let monitor_run = run.clone();
    let root = root.to_owned();
    if let Err(error) = std::thread::Builder::new()
        .name("storage-migration-watchdog".into())
        .spawn(move || {
            monitor(root, monitor_run, stopped, observer, heartbeat, stall_after);
        })
    {
        tracing::warn!(%error, "could not start migration diagnostics");
    }
    let result = ACTIVE.scope(run.clone(), work).await;
    {
        let mut run = run.lock().unwrap_or_else(|e| e.into_inner());
        run.snapshot.status = if result.is_ok() {
            "completed"
        } else {
            "failed"
        }
        .into();
        if run.snapshot.error.is_none() {
            run.snapshot.error = result
                .as_ref()
                .err()
                .map(|e| e.to_string().chars().take(512).collect());
            if result.is_err() {
                run.snapshot.failure_stage = Some(run.snapshot.stage.clone());
            }
        }
    }
    drop(finish);
    result
}

fn monitor(
    root: PathBuf,
    run: Arc<Mutex<Run>>,
    stopped: mpsc::Receiver<()>,
    observer: impl Fn(&str, &Snapshot),
    heartbeat: Duration,
    stall_after: Duration,
) {
    // Coalesce disk writes on their own thread. A stuck fsync must not prevent
    // subsequent heartbeat/remote alerts, or accumulate an unbounded queue.
    let (write, writes) = mpsc::sync_channel(1);
    let pending = Arc::new(Mutex::new(None::<(String, Snapshot)>));
    let disk_pending = pending.clone();
    if let Err(error) = std::thread::Builder::new()
        .name("migration-diagnostic-file".into())
        .spawn(move || {
            while writes.recv().is_ok() {
                let Some((event, snapshot)) = disk_pending
                    .lock().unwrap_or_else(|e| e.into_inner()).take() else { continue; };
                // The app's tracing file layer is synchronous too. Keep both
                // log output and snapshot fsync off the watchdog thread.
                tracing::info!(event, diagnostic = %serde_json::to_string(&snapshot).unwrap_or_default(), "storage migration diagnostic");
                if event == "stalled" {
                    tracing::error!(attempt_id = %snapshot.attempt_id, stage = %snapshot.stage,
                        table = ?snapshot.table, first_id = ?snapshot.first_id, last_id = ?snapshot.last_id,
                        idle_seconds = snapshot.idle_seconds, "storage migration has not advanced");
                }
                if let Err(error) = persist(&root, &snapshot) {
                    tracing::warn!(%error, "could not persist migration diagnostics");
                }
                if snapshot.status != "running" {
                    break;
                }
            }
        })
    {
        tracing::warn!(%error, "could not start migration diagnostic persistence");
    }
    let mut warned_revision = None;
    let mut first = true;
    loop {
        let (snapshot, revision, idle) = {
            let run = run.lock().unwrap_or_else(|e| e.into_inner());
            (
                run.snapshot(Instant::now()),
                run.revision,
                run.advanced.elapsed(),
            )
        };
        let finished = snapshot.status != "running";
        let event = if finished {
            snapshot.status.as_str()
        } else if idle >= stall_after && warned_revision != Some(revision) {
            warned_revision = Some(revision);
            "stalled"
        } else if first {
            "started"
        } else {
            "heartbeat"
        };
        // Neither the rolling logger nor diagnostic filesystem I/O runs here.
        observer(event, &snapshot);
        *pending.lock().unwrap_or_else(|e| e.into_inner()) = Some((event.into(), snapshot));
        let _ = write.try_send(());
        if finished {
            break;
        }
        first = false;
        let _ = stopped.recv_timeout(heartbeat);
    }
}

fn attempt_files(root: &Path) -> std::io::Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    let directory = root.join(DIRECTORY);
    if !directory.exists() {
        return Ok(Vec::new());
    }
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        if entry.file_type()?.is_file()
            && entry.path().extension().is_some_and(|e| e == "json")
            && entry
                .path()
                .file_stem()
                .and_then(|s| s.to_str())
                .is_some_and(|s| uuid::Uuid::parse_str(s).is_ok())
        {
            files.push((entry.metadata()?.modified()?, entry.path()));
        }
    }
    files.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(files.into_iter().map(|(_, path)| path).collect())
}

fn persist(root: &Path, snapshot: &Snapshot) -> Result<(), sqlx::Error> {
    let directory = root.join(DIRECTORY);
    // Do not recreate a deleted/unmounted data root after an attempt ends.
    match std::fs::create_dir(&directory) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    super::durable_json(
        &directory.join(format!("{}.json", snapshot.attempt_id)),
        snapshot,
    )?;
    for file in attempt_files(root)?.into_iter().skip(KEEP_ATTEMPTS) {
        std::fs::remove_file(file)?;
    }
    Ok(())
}

/// Feedback reads bounded snapshots without opening the migration database.
pub fn recent(root: &Path) -> std::io::Result<Vec<Snapshot>> {
    attempt_files(root)?
        .into_iter()
        .take(KEEP_ATTEMPTS)
        .map(|path| {
            let mut bytes = Vec::new();
            std::fs::File::open(path)?
                .take(MAX_SNAPSHOT_BYTES)
                .read_to_end(&mut bytes)?;
            serde_json::from_slice(&bytes).map_err(std::io::Error::other)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_HEARTBEAT: Duration = Duration::from_millis(10);
    const TEST_STALL: Duration = Duration::from_millis(40);

    async fn saved(root: &Path, status: &str) -> Snapshot {
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if let Ok(snapshots) = recent(root) {
                    if let Some(snapshot) = snapshots.into_iter().find(|s| s.status == status) {
                        return snapshot;
                    }
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap()
    }

    #[tokio::test(flavor = "current_thread")]
    async fn watchdog_reports_while_async_worker_is_blocked() {
        let root = tempfile::tempdir().unwrap();
        let (send, receive) = mpsc::channel::<Snapshot>();
        observe_with_timing(
            root.path(),
            "conversion",
            move |event, snapshot| {
                if event == "stalled" {
                    send.send(snapshot.clone()).unwrap();
                }
            },
            async {
                counts(1_400_109, 158_432_108);
                batch("elements", Some(1), Some(32768), Some(32768), Some(1024));
                stage("indexing_element_search");
                // Deliberately block the only async runtime thread. A Tokio timer
                // on this runtime cannot report the incident until the work resumes.
                let snapshot = receive.recv_timeout(Duration::from_secs(2)).unwrap();
                assert_eq!(snapshot.stage, "indexing_element_search");
                assert_eq!(snapshot.completed_records, Some(1_400_109));
                assert_eq!(snapshot.last_id, Some(32768));
                assert!(
                    receive.recv_timeout(TEST_STALL * 2).is_err(),
                    "one alert per stalled operation"
                );
                Ok::<_, String>(())
            },
            TEST_HEARTBEAT,
            TEST_STALL,
        )
        .await
        .unwrap();
        assert_eq!(
            saved(root.path(), "completed").await.table.as_deref(),
            Some("elements")
        );
    }

    #[tokio::test]
    async fn occupied_single_connection_is_identified_and_migration_can_continue() {
        let root = tempfile::tempdir().unwrap();
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        let occupied = pool.acquire().await.unwrap();
        let (send, mut receive) = tokio::sync::mpsc::unbounded_channel::<Snapshot>();
        observe_with_timing(root.path(), "conversion", move |event, snapshot| {
            if event == "stalled" { let _ = send.send(snapshot.clone()); }
        }, async {
            batch("elements", Some(42), Some(84), Some(43), None);
            stage("waiting_for_element_connection");
            let acquire = pool.acquire();
            tokio::pin!(acquire);
            tokio::select! {
                result = &mut acquire => panic!("connection should still be occupied: {result:?}"),
                snapshot = receive.recv() => {
                    let snapshot = snapshot.unwrap();
                    assert_eq!(snapshot.stage, "waiting_for_element_connection");
                    assert_eq!(snapshot.first_id, Some(42));
                }
            }
            drop(occupied);
            let connection = acquire.await.unwrap();
            drop(connection);
            Ok::<_, String>(())
        }, TEST_HEARTBEAT, TEST_STALL).await.unwrap();
        saved(root.path(), "completed").await;
        pool.close().await;
    }

    #[tokio::test]
    async fn original_failure_survives_cleanup_and_recovery_has_its_own_attempt() {
        let root = tempfile::tempdir().unwrap();
        let result = observe(root.path(), "conversion", |_, _| {}, async {
            stage("encoding_and_verifying_elements");
            failure(&"element record exceeds sealing budget");
            stage("closing_conversion_pool");
            Err::<(), _>("outer cleanup error")
        })
        .await;
        assert_eq!(result, Err("outer cleanup error"));
        let failed = saved(root.path(), "failed").await;
        assert_eq!(
            failed.failure_stage.as_deref(),
            Some("encoding_and_verifying_elements")
        );
        assert_eq!(
            failed.error.as_deref(),
            Some("element record exceeds sealing budget")
        );
        observe(root.path(), "recovery", |_, _| {}, async {
            Ok::<_, String>(())
        })
        .await
        .unwrap();
        let recovered = saved(root.path(), "completed").await;
        assert_eq!(recovered.kind, "recovery");
        assert_ne!(failed.attempt_id, recovered.attempt_id);
        assert!(recent(root.path())
            .unwrap()
            .iter()
            .any(|s| s.attempt_id == failed.attempt_id));
    }

    #[tokio::test]
    async fn cancellation_is_persisted_and_snapshot_failures_do_not_fail_work() {
        let root = tempfile::tempdir().unwrap();
        let result = tokio::time::timeout(
            Duration::from_millis(40),
            observe(root.path(), "conversion", |_, _| {}, async {
                stage("reading_elements_to_seal");
                std::future::pending::<Result<(), String>>().await
            }),
        )
        .await;
        assert!(result.is_err());
        assert_eq!(
            saved(root.path(), "interrupted").await.stage,
            "reading_elements_to_seal"
        );
        let unavailable = root.path().join("not-a-directory");
        std::fs::write(&unavailable, "owned test fixture").unwrap();
        let (send, receive) = mpsc::channel();
        let result = observe(
            &unavailable,
            "conversion",
            move |event, _| {
                if event == "completed" {
                    let _ = send.send(());
                }
            },
            async { Ok::<_, String>(42) },
        )
        .await;
        assert_eq!(result, Ok(42));
        receive.recv_timeout(Duration::from_secs(2)).unwrap();
    }

    #[tokio::test]
    async fn advancing_parity_cursor_does_not_report_a_conversion_stall() {
        let root = tempfile::tempdir().unwrap();
        let (send, receive) = mpsc::channel();
        observe_with_timing(
            root.path(),
            "conversion",
            move |event, _| {
                if event == "stalled" {
                    let _ = send.send(());
                }
            },
            async {
                counts(1_400_109, 158_432_108);
                stage("reading_parity_rows");
                for cursor in 0..12 {
                    batch(
                        "elements",
                        Some(cursor * 128),
                        None,
                        Some(cursor as u64 * 128),
                        None,
                    );
                    tokio::time::sleep(TEST_HEARTBEAT).await;
                }
                Ok::<_, String>(())
            },
            TEST_HEARTBEAT,
            TEST_STALL,
        )
        .await
        .unwrap();
        saved(root.path(), "completed").await;
        assert!(receive.try_recv().is_err());
    }

    #[tokio::test]
    async fn feedback_snapshots_are_bounded_and_nested_attempts_are_reused() {
        let root = tempfile::tempdir().unwrap();
        let (send, receive) = mpsc::channel();
        observe(root.path(), "conversion", |_, _| {}, async {
            let outer = ACTIVE.with(|run| run.lock().unwrap().snapshot.attempt_id.clone());
            observe(
                root.path(),
                "conversion",
                move |_, _| {
                    let _ = send.send(());
                },
                async {
                    assert_eq!(
                        outer,
                        ACTIVE.with(|run| run.lock().unwrap().snapshot.attempt_id.clone())
                    );
                    Ok::<_, String>(())
                },
            )
            .await
        })
        .await
        .unwrap();
        let mut snapshot = saved(root.path(), "completed").await;
        assert!(receive.try_recv().is_err());
        for _ in 0..KEEP_ATTEMPTS + 2 {
            snapshot.attempt_id = uuid::Uuid::new_v4().to_string();
            persist(root.path(), &snapshot).unwrap();
        }
        assert_eq!(recent(root.path()).unwrap().len(), KEEP_ATTEMPTS);
        std::fs::write(
            root.path().join(DIRECTORY).join("user-notes.json"),
            "leave alone",
        )
        .unwrap();
        persist(root.path(), &snapshot).unwrap();
        assert!(root.path().join(DIRECTORY).join("user-notes.json").exists());
        let missing_root = root.path().join("removed-data-root");
        assert!(persist(&missing_root, &snapshot).is_err());
        assert!(!missing_root.exists());
    }
}
