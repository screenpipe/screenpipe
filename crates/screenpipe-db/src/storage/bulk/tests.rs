// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use super::*;
use crate::DatabaseManager;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Condvar,
};
use std::time::Duration;

struct Pause(Arc<(Mutex<bool>, Condvar)>);
impl Pause {
    fn new() -> Self {
        Self(Arc::new((Mutex::new(false), Condvar::new())))
    }
    fn wait(&self) {
        let (lock, wake) = &*self.0;
        let (_guard, timeout) = wake
            .wait_timeout_while(lock.lock().unwrap(), Duration::from_secs(10), |done| !*done)
            .unwrap();
        assert!(!timeout.timed_out(), "test did not release decoder");
    }
    fn release(&self) {
        *self.0 .0.lock().unwrap() = true;
        self.0 .1.notify_all();
    }
}
impl Drop for Pause {
    fn drop(&mut self) {
        self.release();
    }
}

#[tokio::test]
async fn offline_selection_seeks_past_retained_history() {
    use std::sync::atomic::AtomicU64;
    unsafe extern "C" fn count_steps(context: *mut std::ffi::c_void) -> i32 {
        let steps = unsafe { &*context.cast::<AtomicU64>() };
        // Abort a regressed scan instead of letting large fixtures hang CI.
        i32::from(steps.fetch_add(1000, Ordering::Relaxed) > 100_000)
    }

    let root = tempfile::tempdir().unwrap();
    let mut options = crate::storage::MigrationOptions::default();
    options.privacy.identity = "migration-cursor-test".into();
    options.privacy.required_surfaces = 1;
    let db = DatabaseManager::new_hybrid(root.path(), Default::default(), options)
        .await
        .unwrap();
    db.execute_raw_sql_write(
        "INSERT INTO frames(id,timestamp,full_text) VALUES(1,'2026-09-19','private frame')",
    )
    .await
    .unwrap();
    let count = 200_000_i64;
    let mut tx = db.begin_immediate_with_retry().await.unwrap();
    // Keep a large privacy-pending prefix. This models an interrupted migration
    // after recording recovery has restored all elements to the resident table.
    sqlx::query("WITH RECURSIVE n(id) AS (VALUES(1) UNION ALL SELECT id+1 FROM n WHERE id<?) INSERT INTO _bulk_element_rows(id,frame_id,source,role,text,_archive_generation) SELECT id,1,'accessibility','AXText','private',1 FROM n")
        .bind(count).execute(&mut **tx.conn()).await.unwrap();
    sqlx::query("WITH RECURSIVE n(id) AS (VALUES(1) UNION ALL SELECT id+1 FROM n WHERE id<?) INSERT INTO ui_events(id,timestamp,event_type,text_content) SELECT id,'2026-09-19','text','private' FROM n")
        .bind(count).execute(&mut **tx.conn()).await.unwrap();
    // In-place migration deliberately postpones these indexes until completion.
    sqlx::query("DROP INDEX _bulk_ui_events_pending")
        .execute(&mut **tx.conn())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    db.execute_raw_sql_write("INSERT INTO elements(id,frame_id,source,role,text,redacted_at) VALUES(200001,1,'accessibility','AXText','eligible',1); INSERT INTO ui_events(id,timestamp,event_type,text_content,redacted_at) VALUES(200001,'2026-09-19','text','eligible',1)").await.unwrap();

    let storage = db.storage.as_ref().unwrap();
    let index = storage.root.join(&storage.descriptor.index);
    let pool = pool_options(Some(storage.clone()), false)
        .max_connections(1)
        .connect_with(sqlx::sqlite::SqliteConnectOptions::new().filename(&index))
        .await
        .unwrap();
    let writer = screenpipe_sqlite_coordinator::SqliteWritePool::new(
        pool.clone(),
        screenpipe_sqlite_coordinator::sqlite_write_lock(&index),
    );
    let steps = Box::new(AtomicU64::new(0));
    {
        let mut conn = pool.acquire().await.unwrap();
        let mut handle = conn.lock_handle().await.unwrap();
        // Context remains alive until the callback is removed below.
        unsafe {
            libsqlite3_sys::sqlite3_progress_handler(
                handle.as_raw_handle().as_ptr(),
                1000,
                Some(count_steps),
                (&*steps as *const AtomicU64).cast_mut().cast(),
            );
        }
    }
    let bulk = storage
        .select_bulk(&pool, &TABLES[2], None, Some(count))
        .await;
    let elements = elements::seal_after(storage, &pool, &writer, Some(count)).await;
    let work = steps.load(Ordering::Relaxed);
    {
        let mut conn = pool.acquire().await.unwrap();
        let mut handle = conn.lock_handle().await.unwrap();
        unsafe {
            libsqlite3_sys::sqlite3_progress_handler(
                handle.as_raw_handle().as_ptr(),
                0,
                None,
                std::ptr::null_mut(),
            );
        }
    }
    pool.close().await;
    let bulk = bulk
        .unwrap_or_else(|error| panic!("bulk scan exceeded work budget at {work} steps: {error}"));
    assert_eq!(
        bulk.iter().map(|r| r.id).collect::<Vec<_>>(),
        vec![count + 1]
    );
    assert_eq!(
        elements.unwrap_or_else(|error| panic!(
            "element scan exceeded work budget at {work} steps: {error}"
        )),
        (1, Some(count + 1))
    );
    assert!(
        work < 100_000,
        "selection revisited retained history: {work}"
    );
    eprintln!("offline cursor: retained_rows_per_table={count}, sqlite_steps={work}");
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM _bulk_element_rows")
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        count
    );
    db.close().await;
}

#[tokio::test]
async fn element_publication_ignores_new_captures_but_rejects_changed_range_members() {
    for archived in [false, true] {
        for mutation in [
            "INSERT INTO elements(id,frame_id,source,role,text,redacted_at) VALUES(30,1,'accessibility','AXText','new capture',1)",
            "UPDATE elements SET text='edited while encoding' WHERE id=10",
            "DELETE FROM elements WHERE id=10",
            "INSERT INTO elements(id,frame_id,source,role,text,redacted_at) VALUES(15,1,'accessibility','AXText','inserted gap',1)",
            "INSERT INTO elements(id,frame_id,source,role,text,redacted_at) VALUES(15,1,'accessibility','AXText','private gap',NULL)",
            "UPDATE elements SET redacted_at=NULL WHERE id=10",
            "DELETE FROM elements WHERE id=10; INSERT INTO elements(id,frame_id,source,role,text,redacted_at) VALUES(10,1,'accessibility','AXText','reused ID',1)",
        ] {
            let root = tempfile::tempdir().unwrap();
            let db = Arc::new(DatabaseManager::new_hybrid(root.path(), Default::default(),
                crate::storage::MigrationOptions {
                    privacy: crate::storage::PrivacyPolicy { identity: "private".into(), required_surfaces: 1 },
                    ..Default::default()
                }).await.unwrap());
            db.execute_raw_sql_write("INSERT INTO frames(id,timestamp,full_text) VALUES(1,'2026-09-17','pending frame'); INSERT INTO elements(id,frame_id,source,role,text,redacted_at) VALUES(10,1,'accessibility','AXText','ten',1),(20,1,'accessibility','AXText','twenty',1)").await.unwrap();
            if archived {
                assert_eq!(db.seal_payloads().await.unwrap(), 2);
                db.execute_raw_sql_write("UPDATE elements SET text='restaged ten' WHERE id=10").await.unwrap();
            }
            let storage = db.storage.as_ref().unwrap();
            let encoded = Arc::new(tokio::sync::Notify::new());
            let announced = encoded.clone();
            let pause = Pause::new();
            let held = Pause(pause.0.clone());
            *storage.bulk.element_publish_hook.lock().unwrap() = Some(Arc::new(move || {
                announced.notify_one();
                held.wait();
            }));
            let sealing = db.clone();
            let task = tokio::spawn(async move { sealing.seal_payloads().await });
            tokio::time::timeout(Duration::from_secs(10), encoded.notified()).await.unwrap();
            // The archive is fully encoded while the writer remains available.
            db.execute_raw_sql_write(mutation).await.unwrap();
            let expected = db.query_raw_sql("SELECT id,text,redacted_at FROM elements ORDER BY id").await.unwrap();
            pause.release();
            let count = task.await.unwrap().unwrap();
            assert_eq!(count, if mutation.contains("VALUES(30,") || (!archived && mutation.contains("private gap")) { 2 } else { 0 }, "archived={archived}; {mutation}");
            *storage.bulk.element_publish_hook.lock().unwrap() = None;
            assert_eq!(db.query_raw_sql("SELECT id,text,redacted_at FROM elements ORDER BY id").await.unwrap(), expected);
            while db.seal_payloads().await.unwrap() != 0 {}
            db.verify_storage().await.unwrap();
            assert_eq!(db.query_raw_sql("SELECT id,text,redacted_at FROM elements ORDER BY id").await.unwrap(), expected);
            db.close().await;
        }
    }
}

async fn fixture_mode(hybrid: bool) -> (tempfile::TempDir, Arc<DatabaseManager>) {
    let root = tempfile::tempdir().unwrap();
    let db = Arc::new(
        if hybrid {
            DatabaseManager::new_hybrid(root.path(), Default::default(), Default::default()).await
        } else {
            DatabaseManager::new(
                root.path().join("db.sqlite").to_str().unwrap(),
                Default::default(),
            )
            .await
        }
        .unwrap(),
    );
    db.execute_raw_sql_write("INSERT INTO frames(id,timestamp,full_text) VALUES(1,'2026-09-12','frame'); INSERT INTO elements(id,frame_id,source,role,text) VALUES(1,1,'accessibility','AXText','original'); INSERT INTO audio_chunks(id,file_path) VALUES(1,'test.wav'); INSERT INTO audio_transcriptions(id,audio_chunk_id,offset_index,timestamp,transcription,device) VALUES(1,1,0,'2026-09-12','audio original','test');").await.unwrap();
    if hybrid {
        while db.seal_payloads().await.unwrap() != 0 {}
    }
    (root, db)
}

async fn fixture() -> (tempfile::TempDir, Arc<DatabaseManager>) {
    fixture_mode(true).await
}

#[tokio::test]
async fn element_scans_decode_each_file_once_and_point_reads_stay_selective() {
    let root = tempfile::tempdir().unwrap();
    let db = DatabaseManager::new_hybrid(root.path(), Default::default(), Default::default())
        .await
        .unwrap();
    db.execute_raw_sql_write("INSERT INTO frames(id,timestamp) VALUES(1,'2026-09-15'),(2,'2026-09-15'),(3,'2026-09-15'); INSERT INTO elements(id,frame_id,source,role,text) VALUES(1,1,'accessibility','AXText','one'),(2,2,'accessibility','AXText','two'),(3,3,'accessibility','AXText','three');").await.unwrap();
    while db.seal_payloads().await.unwrap() != 0 {}
    let storage = db.storage.as_ref().unwrap();
    let paths: Vec<String> =
        sqlx::query_scalar("SELECT path FROM _bulk_files WHERE table_name='elements'")
            .fetch_all(&db.pool)
            .await
            .unwrap();
    assert_eq!(paths.len(), 1);
    storage.bulk.cache.retire(&paths).unwrap();
    let decoded = Arc::new(Mutex::new(Vec::<String>::new()));
    let observed = decoded.clone();
    *storage.bulk.decode_hook.lock().unwrap() = Some(Arc::new(move |key| {
        observed.lock().unwrap().push(key.to_owned());
    }));
    // Migration receipts use ID windows across all frames, including multiple
    // windows in one file. A frame projection must not be decoded per window.
    for (id, expected) in [(1, "one"), (2, "two"), (3, "three")] {
        let actual: String =
            sqlx::query_scalar("SELECT text FROM elements WHERE id>=? ORDER BY id LIMIT 1")
                .bind(id)
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert_eq!(actual, expected);
    }
    {
        let keys = decoded.lock().unwrap();
        assert_eq!(keys.iter().filter(|k| k.starts_with("records:")).count(), 1);
        assert!(!keys.iter().any(|k| k.starts_with("element-frame:")));
    }
    for sql in [
        "SELECT text FROM elements WHERE id=2",
        "SELECT text FROM elements WHERE frame_id=2",
    ] {
        storage.bulk.cache.retire(&paths).unwrap();
        decoded.lock().unwrap().clear();
        let actual: String = sqlx::query_scalar(sql).fetch_one(&db.pool).await.unwrap();
        assert_eq!(actual, "two");
        let keys = decoded.lock().unwrap();
        assert_eq!(
            keys.iter()
                .filter(|k| k.starts_with("element-frame:"))
                .count(),
            1
        );
        assert!(!keys.iter().any(|k| k.starts_with("records:")));
    }
    db.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cache_hits_and_unrelated_readers_progress_during_a_decode() {
    let (_root, db) = fixture().await;
    let storage = db.storage.as_ref().unwrap();
    let element_path: String =
        sqlx::query_scalar("SELECT path FROM _bulk_files WHERE table_name='elements'")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    let expected: String =
        sqlx::query_scalar("SELECT transcription FROM audio_transcriptions WHERE id=1")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    // Force only the element file cold; the audio cache hit must remain usable.
    storage.bulk.cache.retire(&[element_path.clone()]).unwrap();
    let capacity = storage.decoder.clone().acquire_owned().await.unwrap();
    let pause = Pause::new();
    let hold = pause.0.clone();
    let (started, ready) = tokio::sync::oneshot::channel();
    let started = Mutex::new(Some(started));
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    *storage.bulk.decode_hook.lock().unwrap() = Some(Arc::new(move |key| {
        if key.starts_with("element-frame:") && key.contains(&element_path) {
            counter.fetch_add(1, Ordering::SeqCst);
            if let Some(started) = started.lock().unwrap().take() {
                let _ = started.send(());
            }
            Pause(hold.clone()).wait();
        }
    }));
    let reader = db.clone();
    let reading = tokio::spawn(async move {
        sqlx::query_scalar::<_, String>("SELECT text FROM elements WHERE id=1")
            .fetch_one(&reader.pool)
            .await
    });
    tokio::time::timeout(Duration::from_secs(2), ready)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(storage.decoder.available_permits(), 0);
    let hit = tokio::time::timeout(
        Duration::from_secs(1),
        sqlx::query_scalar::<_, String>(
            "SELECT transcription FROM audio_transcriptions WHERE id=1",
        )
        .fetch_one(&db.pool),
    )
    .await;
    let write = tokio::time::timeout(
        Duration::from_secs(1),
        db.execute_raw_sql_write("INSERT INTO frames(id,timestamp,full_text) VALUES(2,'2026-09-12','concurrent capture')"),
    )
    .await;
    pause.release();
    assert_eq!(reading.await.unwrap().unwrap(), "original");
    assert_eq!(
        hit.expect("cached reader was blocked by an unrelated decoder")
            .unwrap(),
        expected
    );
    write.unwrap().unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    drop(capacity);
    db.close().await;
}

#[test]
fn parity_scan_completes_across_many_cold_element_files() {
    use crate::storage::parity::{hash_cell, scan};
    use rusqlite::types::ValueRef;
    use sha2::{Digest, Sha256};

    // A regressed blocking scan cannot be aborted by Tokio. Shut the test
    // runtime down with a timeout so the regression fails instead of hanging CI.
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let (expected, result) = runtime.block_on(async {
        let root = tempfile::tempdir().unwrap();
        let db = DatabaseManager::new_hybrid(root.path(), Default::default(), Default::default())
            .await
            .unwrap();
        db.execute_raw_sql_write("INSERT INTO frames(id,timestamp) VALUES(1,'2026-09-22')")
            .await
            .unwrap();
        let mut expected = Sha256::new();
        // Two cold projections per file cross Tokio's cooperative budget in
        // one synchronous SQLite statement, as migration verification does.
        for id in 1..=96 {
            db.execute_raw_sql_write(&format!("INSERT INTO elements(id,frame_id,source,role,text) VALUES({id},1,'accessibility','AXText','history {id}')"))
                .await.unwrap();
            while db.seal_payloads().await.unwrap() != 0 {}
            hash_cell(&mut expected, ValueRef::Integer(id));
            hash_cell(
                &mut expected,
                ValueRef::Text(format!("history {id}").as_bytes()),
            );
            expected.update(b"E");
        }
        let paths: Vec<String> =
            sqlx::query_scalar("SELECT path FROM _bulk_files WHERE table_name='elements'")
                .fetch_all(&db.pool)
                .await
                .unwrap();
        assert_eq!(paths.len(), 96);
        db.storage
            .as_ref()
            .unwrap()
            .bulk
            .cache
            .retire(&paths)
            .unwrap();
        let result = tokio::time::timeout(
            Duration::from_secs(10),
            scan(
                db.pool.clone(),
                "elements".into(),
                "SELECT id,id,text FROM elements ORDER BY id".into(),
            ),
        )
        .await;
        if result.is_ok() {
            db.close().await;
        }
        (format!("{:x}", expected.finalize()), result)
    });
    runtime.shutdown_timeout(Duration::from_secs(1));
    let receipt = result
        .expect("parity scan stalled while decoding cold element files")
        .unwrap();
    assert_eq!(receipt.rows, 96);
    assert_eq!(receipt.sha256, expected);
}

#[tokio::test]
async fn sql_readers_start_during_file_unlink_without_interrupts() {
    let (_root, db) = fixture().await;
    let storage = db.storage.as_ref().unwrap();
    // Reclamation has passed its reader cutoff. New SQLite snapshots can only
    // see current locators, so they can read while obsolete files are unlinked.
    let unlink = storage.leases.clone().write_owned().await;
    let result = sqlx::query_scalar::<_, String>("SELECT text FROM elements WHERE id=1")
        .fetch_one(&db.pool)
        .await;
    drop(unlink);
    assert_eq!(result.unwrap(), "original");
    db.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cold_files_decode_concurrently_with_shared_bounded_admission() {
    let (_root, db) = fixture().await;
    let storage = db.storage.as_ref().unwrap();
    let paths: Vec<String> = sqlx::query_scalar("SELECT path FROM _bulk_files")
        .fetch_all(&db.pool)
        .await
        .unwrap();
    storage.bulk.cache.retire(&paths).unwrap();
    let pause = Pause::new();
    let hold = pause.0.clone();
    let (started, mut ready) = tokio::sync::mpsc::unbounded_channel();
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    *storage.bulk.decode_hook.lock().unwrap() = Some(Arc::new(move |key| {
        if key.starts_with("records:") || key.starts_with("element-frame:") {
            counter.fetch_add(1, Ordering::SeqCst);
            started.send(()).unwrap();
            Pause(hold.clone()).wait();
        }
    }));
    let mut reads = Vec::new();
    for sql in [
        "SELECT text FROM elements WHERE id=1",
        "SELECT transcription FROM audio_transcriptions WHERE id=1",
        "SELECT text FROM elements WHERE id=1",
    ] {
        let db = db.clone();
        reads.push(tokio::spawn(async move {
            sqlx::query_scalar::<_, String>(sql)
                .fetch_one(&db.pool)
                .await
        }));
    }
    for _ in 0..2 {
        tokio::time::timeout(Duration::from_secs(2), ready.recv())
            .await
            .expect("independent cold files did not decode concurrently")
            .unwrap();
    }
    assert_eq!(storage.decoder.available_permits(), 0);
    tokio::time::timeout(Duration::from_secs(2), async {
        while storage.bulk.cache.max_in_flight_readers() < 2 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("same-file reader did not join the pending decode");
    // Frame payloads use the same two decoder slots. Cancelling a queued
    // frame read must leave these active bulk jobs and their leases intact.
    assert!(tokio::time::timeout(
        Duration::from_millis(100),
        db.frame_payloads(&[1], crate::storage::Projection::All)
    )
    .await
    .is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    pause.release();
    for (read, expected) in reads
        .into_iter()
        .zip(["original", "audio original", "original"])
    {
        assert_eq!(read.await.unwrap().unwrap(), expected);
    }
    assert_eq!(
        calls.load(Ordering::SeqCst),
        2,
        "same-file readers must share the decode"
    );
    // Join the already-dispatched frame decode before checking its permit.
    assert_eq!(
        db.frame_payloads(&[1], crate::storage::Projection::All)
            .await
            .unwrap()[&1]
            .full_text
            .as_deref(),
        Some("frame")
    );
    assert_eq!(storage.decoder.available_permits(), 2);
    db.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn snapshots_and_streams_match_sqlite_while_writing_and_reclaiming() {
    use futures::TryStreamExt;
    for hybrid in [false, true] {
        let (root, db) = fixture_mode(hybrid).await;
        let originals: Vec<String> = if hybrid {
            sqlx::query_scalar("SELECT path FROM _bulk_files")
                .fetch_all(&db.pool)
                .await
                .unwrap()
        } else {
            vec![]
        };
        let mut snapshot = db.pool.begin().await.unwrap();
        // Establish the snapshot before requesting any archived column.
        let _: i64 = sqlx::query_scalar("SELECT count(*) FROM frames")
            .fetch_one(&mut *snapshot)
            .await
            .unwrap();
        let mut connection = db.pool.acquire().await.unwrap();
        let mut stream = sqlx::query_scalar::<_, String>("WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<1000) SELECT e.text FROM seq CROSS JOIN elements e WHERE e.id=1").fetch(&mut *connection);
        assert_eq!(
            stream.try_next().await.unwrap().as_deref(),
            Some("original")
        );
        tokio::time::timeout(Duration::from_secs(2), db.execute_raw_sql_write("UPDATE elements SET text='replacement' WHERE id=1; UPDATE audio_transcriptions SET transcription='audio replacement' WHERE id=1;")).await.unwrap().unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT text FROM elements WHERE id=1")
                .fetch_one(&db.pool)
                .await
                .unwrap(),
            "replacement"
        );
        if hybrid {
            for _ in 0..3 {
                db.reclaim_frame_payloads().await.unwrap();
            }
            assert!(originals.iter().all(|p| root.path().join(p).exists()));
            db.storage
                .as_ref()
                .unwrap()
                .bulk
                .cache
                .retire(&originals)
                .unwrap();
        }
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT text FROM elements WHERE id=1")
                .fetch_one(&mut *snapshot)
                .await
                .unwrap(),
            "original"
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT transcription FROM audio_transcriptions WHERE id=1"
            )
            .fetch_one(&mut *snapshot)
            .await
            .unwrap(),
            "audio original"
        );
        snapshot.rollback().await.unwrap();
        if hybrid {
            for _ in 0..3 {
                db.reclaim_frame_payloads().await.unwrap();
            }
            assert!(
                originals.iter().all(|p| root.path().join(p).exists()),
                "stream must pin originals independently of transaction"
            );
        }
        let mut rows = 1;
        while let Some(text) = stream.try_next().await.unwrap() {
            assert_eq!(text, "original");
            rows += 1;
        }
        assert_eq!(rows, 1000);
        drop(stream);
        drop(connection);
        if hybrid {
            for _ in 0..3 {
                db.reclaim_frame_payloads().await.unwrap();
            }
            assert!(originals.iter().all(|p| !root.path().join(p).exists()));
        }
        db.verify_storage().await.unwrap();
        db.close().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn shutdown_releases_sql_workers_waiting_for_decoder_admission() {
    let (_root, db) = fixture().await;
    let storage = db.storage.as_ref().unwrap();
    let paths: Vec<String> = sqlx::query_scalar("SELECT path FROM _bulk_files")
        .fetch_all(&db.pool)
        .await
        .unwrap();
    storage.bulk.cache.retire(&paths).unwrap();
    let capacity = storage.decoder.clone().acquire_many_owned(2).await.unwrap();
    let reader = db.clone();
    let reading = tokio::spawn(async move {
        sqlx::query_scalar::<_, String>("SELECT text FROM elements WHERE id=1")
            .fetch_one(&reader.pool)
            .await
    });
    tokio::time::timeout(Duration::from_secs(2), async {
        while storage.bulk.cache.max_in_flight_readers() == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let owner = db.clone();
    let closing = tokio::spawn(async move { owner.close().await });
    assert!(tokio::time::timeout(Duration::from_secs(2), reading)
        .await
        .unwrap()
        .unwrap()
        .is_err());
    drop(capacity);
    tokio::time::timeout(Duration::from_secs(2), closing)
        .await
        .unwrap()
        .unwrap();
    assert!(!storage.sql_readers_active());
}
