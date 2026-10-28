// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Manual, isolated privacy benchmarks. All captures are synthetic and stored
//! in a fresh temporary database. No production DB, capture service or network.
//! Run one ignored test per process for meaningful process peak-RSS readings.
use async_trait::async_trait;
use screenpipe_db::{
    privacy_release::ReleasePolicy, ContentType, DatabaseManager, FrameWindowData, OcrEngine,
};
use screenpipe_redact::{
    worker::{Worker, WorkerConfig},
    RedactError, RedactionOutput, Redactor,
};
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

fn env_n(name: &str, fallback: usize) -> usize {
    std::env::var(name)
        .ok()
        .map(|s| s.parse().expect("integer benchmark parameter"))
        .unwrap_or(fallback)
}
fn distribution(mut ms: Vec<f64>) -> Value {
    ms.sort_by(f64::total_cmp);
    let q = |p: f64| ms[((ms.len().saturating_sub(1)) as f64 * p).ceil() as usize];
    if ms.is_empty() {
        return json!({"n":0});
    }
    json!({"n":ms.len(),"samples_ms":ms,"p50_ms":q(0.5),"p95_ms":q(0.95),"p99_ms":q(0.99),"max_ms":q(1.0),"mean_ms":ms.iter().sum::<f64>()/ms.len() as f64})
}
fn usage() -> (f64, f64) {
    #[cfg(unix)]
    {
        let mut r = std::mem::MaybeUninit::<libc::rusage>::zeroed();
        // RUSAGE_SELF fills the complete platform-owned rusage struct.
        assert_eq!(
            unsafe { libc::getrusage(libc::RUSAGE_SELF, r.as_mut_ptr()) },
            0
        );
        let r = unsafe { r.assume_init() };
        let cpu = r.ru_utime.tv_sec as f64
            + r.ru_stime.tv_sec as f64
            + (r.ru_utime.tv_usec + r.ru_stime.tv_usec) as f64 / 1e6;
        let divisor = if cfg!(target_os = "macos") {
            1048576.0
        } else {
            1024.0
        };
        (cpu, r.ru_maxrss as f64 / divisor)
    }
    #[cfg(not(unix))]
    {
        (0.0, 0.0)
    }
}
fn emit(phase: &str, context: &Value, start: Instant, cpu: f64, data: Value) {
    let elapsed = start.elapsed().as_secs_f64();
    let (now, rss) = usage();
    println!(
        "PRIVACY_METRIC {}",
        json!({"phase":phase,"context":context,"elapsed_s":elapsed,"cpu_s":now-cpu,"one_core_cpu_percent":100.0*(now-cpu)/elapsed,"process_peak_rss_mib":rss,"data":data})
    );
}
fn policy(text: bool, images: bool) -> ReleasePolicy {
    ReleasePolicy {
        identity: "bench:v1".into(),
        text,
        images,
    }
}
async fn db() -> (tempfile::TempDir, Arc<DatabaseManager>) {
    let root = tempfile::tempdir().unwrap();
    let db = Arc::new(
        DatabaseManager::new(
            root.path().join("db.sqlite").to_str().unwrap(),
            Default::default(),
        )
        .await
        .unwrap(),
    );
    db.insert_video_chunk("synthetic.png", "bench")
        .await
        .unwrap();
    (root, db)
}
async fn seed(db: &DatabaseManager, n: usize) {
    // Setup only: no receipt here asserts detector quality. Ready fixtures below
    // isolate gate overhead from inference and are labelled in the report.
    for first in (1..=n).step_by(1000) {
        let end = (first + 999).min(n);
        db.execute_raw_sql_write(&format!("WITH RECURSIVE ids(n) AS (SELECT {first} UNION ALL SELECT n+1 FROM ids WHERE n<{end}) INSERT INTO frames(id,video_chunk_id,timestamp,name,full_text,text_json,app_name,focused) SELECT n,1,strftime('%Y-%m-%dT%H:%M:%fZ','2020-01-01','+'||n||' seconds'),'synthetic.png','Synthetic project planning record '||n||' marker technical review status agenda milestone ordinary public fixture.','[]','Synthetic editor',1 FROM ids")).await.unwrap();
    }
}
async fn certify_fixture(db: &DatabaseManager, n: usize) {
    db.execute_raw_sql_write(&format!("INSERT INTO _privacy_release(kind,id,policy) SELECT 'frames',CAST(id AS TEXT),(SELECT receipt_key FROM _privacy_policy WHERE id=1) FROM frames; INSERT INTO _privacy_release(kind,id,policy) SELECT 'image',CAST(id AS TEXT),(SELECT receipt_key FROM _privacy_policy WHERE id=1) FROM frames; INSERT INTO _privacy_discovery(kind,policy,after_id,complete) VALUES('frames','bench:v1',{n},1),('image','bench:v1',{n},1)")).await.unwrap();
}
async fn capture(db: &DatabaseManager, sequence: usize) -> Vec<i64> {
    let window = FrameWindowData {
        app_name: Some("Synthetic editor".into()),
        window_name: Some(format!("Synthetic window {sequence}")),
        browser_url: None,
        focused: true,
        text: format!(
            "SYNTHETIC_SECRET {sequence}: {}",
            "ordinary planning context ".repeat(20)
        ),
        text_json: r#"[{"text":"SYNTHETIC_SECRET"}]"#.into(),
    };
    let windows = (0..3)
        .map(|index| {
            let mut w = window.clone();
            if std::env::var("PRIVACY_BENCH_DUPLICATE_WINDOWS").is_err() {
                w.text.push_str(&format!(" distinct window {index}"));
                w.window_name = Some(format!("Synthetic window {sequence}/{index}"));
            }
            w
        })
        .collect::<Vec<_>>();
    let rows = db
        .insert_frames_with_ocr_batch(
            "bench",
            Some(chrono::Utc::now()),
            sequence as i64,
            &windows,
            Arc::new(OcrEngine::default()),
        )
        .await
        .unwrap();
    assert_eq!(rows.len(), 3);
    rows.into_iter().map(|(id, _)| id).collect()
}
async fn search(db: &DatabaseManager) -> usize {
    db.search(
        "marker",
        ContentType::OCR,
        50,
        0,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap()
    .len()
}
struct SyntheticDetector {
    fail: AtomicBool,
    attempts: AtomicUsize,
}
#[async_trait]
impl Redactor for SyntheticDetector {
    fn name(&self) -> &str {
        "synthetic-stress-detector"
    }
    fn version(&self) -> u32 {
        1
    }
    fn provides_model_detection(&self) -> bool {
        true
    }
    async fn redact_batch(&self, texts: &[String]) -> Result<Vec<RedactionOutput>, RedactError> {
        self.attempts.fetch_add(1, Ordering::Relaxed);
        if self.fail.load(Ordering::Relaxed) {
            return Err(RedactError::Unavailable("synthetic failure".into()));
        }
        Ok(texts
            .iter()
            .map(|text| RedactionOutput {
                evidence: None,
                input: text.clone(),
                redacted: text.replace("SYNTHETIC_SECRET", "[SECRET]"),
                spans: vec![],
            })
            .collect())
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "manual release-build paired gate benchmark"]
async fn scale_overhead() {
    let n = env_n("PRIVACY_BENCH_HISTORY", 100_000);
    let samples = env_n("PRIVACY_BENCH_SAMPLES", 500);
    let mode = std::env::var("PRIVACY_BENCH_MODE").unwrap_or("ready".into());
    assert!([
        "off",
        "disabled",
        "ready",
        "pending",
        "sparse",
        "discovery",
        "failure",
        "worker"
    ]
    .contains(&mode.as_str()));
    let context = json!({"history":n,"mode":mode,"samples":samples,"profile":if cfg!(debug_assertions){"debug"}else{"release"},"pid":std::process::id()});
    println!(
        "PRIVACY_PHASE {}",
        json!({"phase":"setup","context":context})
    );
    let (root, db) = db().await;
    seed(&db, n).await;
    if mode != "off" {
        db.configure_release(&policy(mode != "disabled", mode != "disabled"))
            .await
            .unwrap();
    }
    if ["ready", "disabled"].contains(&mode.as_str()) {
        certify_fixture(&db, n).await;
    }
    if ["pending", "sparse", "failure", "worker"].contains(&mode.as_str()) {
        db.execute_raw_sql_write(&format!("INSERT INTO _privacy_release(kind,id) SELECT 'frames',CAST(id AS TEXT) FROM frames; INSERT INTO _privacy_release(kind,id) SELECT 'image',CAST(id AS TEXT) FROM frames; INSERT INTO _privacy_discovery(kind,policy,after_id,complete) VALUES('frames','bench:v1',{n},1),('image','bench:v1',{n},1)")).await.unwrap();
    }
    if mode == "sparse" {
        db.execute_raw_sql_write("UPDATE _privacy_release SET policy=(SELECT receipt_key FROM _privacy_policy WHERE id=1) WHERE kind='frames' AND CAST(id AS INTEGER)<=50").await.unwrap();
    }
    db.execute_raw_sql_write("PRAGMA wal_checkpoint(TRUNCATE)")
        .await
        .unwrap();
    let read = if ["off", "disabled"].contains(&mode.as_str()) {
        db.clone()
    } else {
        db.protected_reads().await.unwrap()
    };
    let schema_bytes = std::fs::metadata(root.path().join("db.sqlite"))
        .unwrap()
        .len();
    let start = Instant::now();
    let cpu = usage().0;
    let mut latest = vec![];
    let mut queries = vec![];
    let mut counts = vec![];
    let mut queue = vec![];
    let mut status = vec![];
    let read_samples = env_n("PRIVACY_BENCH_READ_SAMPLES", 100);
    let expected = if ["off", "disabled", "ready"].contains(&mode.as_str()) {
        n
    } else if mode == "sparse" {
        n.min(50)
    } else {
        0
    };
    for turn in 0..read_samples {
        let t = Instant::now();
        let rows: Vec<i64> =
            sqlx::query_scalar("SELECT id FROM frames ORDER BY timestamp DESC LIMIT 50")
                .fetch_all(&read.pool)
                .await
                .unwrap();
        assert_eq!(rows.len(), expected.min(50));
        latest.push(t.elapsed().as_secs_f64() * 1e3);
        if turn < read_samples {
            let t = Instant::now();
            assert_eq!(search(&read).await, expected.min(50));
            queries.push(t.elapsed().as_secs_f64() * 1e3);
            let t = Instant::now();
            let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM frames")
                .fetch_one(&read.pool)
                .await
                .unwrap();
            assert_eq!(count as usize, expected);
            counts.push(t.elapsed().as_secs_f64() * 1e3);
        }
    }
    emit(
        "reads",
        &context,
        start,
        cpu,
        json!({"latest":distribution(latest),"fts_search":distribution(queries),"count":distribution(counts),"visible_records":expected,"db_bytes_after_seed":schema_bytes}),
    );
    let start = Instant::now();
    let cpu = usage().0;
    if mode != "off" && mode != "discovery" {
        for _ in 0..read_samples {
            let t = Instant::now();
            db.release_pending("frames", 16).await.unwrap();
            queue.push(t.elapsed().as_secs_f64() * 1e3);
            let t = Instant::now();
            db.release_queue_status().await.unwrap();
            status.push(t.elapsed().as_secs_f64() * 1e3);
        }
    }
    emit(
        "queue",
        &context,
        start,
        cpu,
        json!({"queue":distribution(queue),"status":distribution(status)}),
    );
    let stop = Arc::new(AtomicBool::new(false));
    let background = if mode == "discovery" {
        let db = db.clone();
        let stop = stop.clone();
        Some(tokio::spawn(async move {
            let mut times = vec![];
            while !stop.load(Ordering::Relaxed) {
                let t = Instant::now();
                db.release_pending("frames", 1).await.unwrap();
                db.release_pending_ordered("image", 1, 60, true)
                    .await
                    .unwrap();
                times.push(t.elapsed().as_secs_f64() * 1e3);
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
            times
        }))
    } else {
        None
    };
    let shutdown = Arc::new(tokio::sync::Notify::new());
    let detector = Arc::new(SyntheticDetector {
        fail: AtomicBool::new(mode == "failure"),
        attempts: AtomicUsize::new(0),
    });
    let worker = if ["failure", "worker"].contains(&mode.as_str()) {
        Some(
            Worker::new_with_writer(
                db.pool.clone(),
                db.coordinated_writer(),
                detector.clone(),
                WorkerConfig::default(),
            )
            .with_frame_storage(db.clone())
            .spawn_with_shutdown(shutdown.clone()),
        )
    } else {
        None
    };
    if worker.is_some() {
        tokio::time::timeout(Duration::from_secs(30), async {
            while detector.attempts.load(Ordering::Relaxed) == 0 {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .unwrap();
    }
    let attempts_before = detector.attempts.load(Ordering::Relaxed);
    let concurrent_reader = {
        let read = read.clone();
        let stop = stop.clone();
        tokio::spawn(async move {
            let mut times = vec![];
            while !stop.load(Ordering::Relaxed) {
                let t = Instant::now();
                let _: Vec<i64> =
                    sqlx::query_scalar("SELECT id FROM frames ORDER BY timestamp DESC LIMIT 50")
                        .fetch_all(&read.pool)
                        .await
                        .unwrap();
                times.push(t.elapsed().as_secs_f64() * 1e3);
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            times
        })
    };
    let start = Instant::now();
    let cpu = usage().0;
    let mut writes = vec![];
    for i in 0..samples {
        let t = Instant::now();
        capture(&db, i).await;
        writes.push(t.elapsed().as_secs_f64() * 1e3);
    }
    let capture_elapsed = start.elapsed().as_secs_f64();
    let capture_cpu = usage().0 - cpu;
    let attempts_at_capture_end = detector.attempts.load(Ordering::Relaxed);
    stop.store(true, Ordering::Relaxed);
    let concurrent_reads = concurrent_reader.await.unwrap();
    let background_times = if let Some(task) = background {
        task.await.unwrap()
    } else {
        vec![]
    };
    shutdown.notify_one();
    if let Some(task) = worker {
        task.await.unwrap();
    }
    let durable: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM frames")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(durable as usize, n + 3 * samples);
    emit(
        "capture_contention",
        &context,
        start,
        cpu,
        json!({"capture_3_windows":distribution(writes),"capture_elapsed_s":capture_elapsed,"capture_cpu_s":capture_cpu,"capture_records_per_s":3.0*samples as f64/capture_elapsed,"concurrent_latest":distribution(concurrent_reads),"background_discovery":distribution(background_times),"durable_records":durable,"detector_attempts_before_capture":attempts_before,"detector_attempts_during_capture":attempts_at_capture_end-attempts_before,"db_bytes":std::fs::metadata(root.path().join("db.sqlite")).unwrap().len(),"wal_bytes":std::fs::metadata(root.path().join("db.sqlite-wal")).map(|m|m.len()).unwrap_or(0)}),
    );
    if !Arc::ptr_eq(&read, &db) {
        let leaked: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM frames WHERE full_text LIKE '%SYNTHETIC_SECRET%'",
        )
        .fetch_one(&read.pool)
        .await
        .unwrap();
        assert_eq!(leaked, 0);
        read.close().await;
    }
    db.close().await;
}

#[cfg(feature = "onnx-cpu")]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "manual sustained real text-model pipeline benchmark"]
async fn real_text_sustained() {
    use screenpipe_redact::adapters::onnx::{OnnxConfig, OnnxRedactor};
    let seconds = env_n("PRIVACY_BENCH_SECONDS", 60);
    let rate = env_n("PRIVACY_BENCH_RATE", 2);
    let initial = env_n("PRIVACY_BENCH_BACKLOG", 30);
    let mixed = std::env::var("PRIVACY_BENCH_MIXED").is_ok();
    let context = json!({"seconds":seconds,"capture_cycles_per_s":rate,"records_per_cycle":3,"initial_records":initial,"duplicate_windows":std::env::var("PRIVACY_BENCH_DUPLICATE_WINDOWS").is_ok(),"model":"v50 local ONNX production regex/cache pipeline","mixed_images":mixed,"profile":if cfg!(debug_assertions){"debug"}else{"release"}});
    let (root, db) = db().await;
    db.configure_release(&policy(true, mixed)).await.unwrap();
    seed(&db, initial).await;
    let image_source = std::env::var("PRIVACY_BENCH_IMAGES")
        .ok()
        .map(|p| std::path::PathBuf::from(p).join("512x512.png"));
    if mixed {
        for id in 1..=initial as i64 {
            attach_image(&db, root.path(), image_source.as_ref().unwrap(), id).await;
        }
    }
    let start = Instant::now();
    let cpu = usage().0;
    let detector = Arc::new(OnnxRedactor::load(OnnxConfig::default()).unwrap());
    emit("model_load", &context, start, cpu, json!({}));
    let detector = Arc::new(screenpipe_redact::pipeline::Pipeline::regex_then_ai(
        detector,
        Default::default(),
    ));
    let worker = Worker::new_with_writer(
        db.pool.clone(),
        db.coordinated_writer(),
        detector,
        WorkerConfig::default(),
    )
    .with_frame_storage(db.clone());
    let monitor = worker.clone();
    let shutdown = Arc::new(tokio::sync::Notify::new());
    let image_shutdown = Arc::new(tokio::sync::Notify::new());
    let mut image_monitor = None;
    let image_worker = if mixed {
        use screenpipe_redact::{
            adapters::rfdetr::{RfdetrConfig, RfdetrRedactor},
            image::worker::{ImageWorker, ImageWorkerConfig},
        };
        let detector = Arc::new(RfdetrRedactor::load(RfdetrConfig::default()).unwrap());
        let worker = ImageWorker::new_with_writer(
            db.pool.clone(),
            db.coordinated_writer(),
            detector,
            ImageWorkerConfig::default(),
        )
        .with_release_storage(db.clone());
        image_monitor = Some(worker.clone());
        Some(worker)
    } else {
        None
    };
    let start = Instant::now();
    let cpu = usage().0;
    let task = worker.spawn_with_shutdown(shutdown.clone());
    let image_task = image_worker.map(|w| w.spawn_with_shutdown(image_shutdown.clone()));
    let mut writes = vec![];
    let mut backlog = vec![];
    let mut tick = tokio::time::interval(Duration::from_secs_f64(1.0 / rate as f64));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    for i in 0..seconds * rate {
        tick.tick().await;
        let t = Instant::now();
        let ids = capture(&db, i).await;
        writes.push(t.elapsed().as_secs_f64() * 1e3);
        if mixed {
            for id in ids {
                attach_image(&db, root.path(), image_source.as_ref().unwrap(), id).await;
            }
        }
        if i % rate == 0 {
            backlog.push(json!({"seconds":start.elapsed().as_secs_f64(),"completed":frame_ready_count(&db).await,"captured":initial+3*(i+1),"image_completed":if let Some(m) = &image_monitor {m.status().await.frames_redacted_total}else{0}}));
        }
    }
    let capture_duration = start.elapsed().as_secs_f64();
    let completed_at_capture_end = frame_ready_count(&db).await;
    let drain_start = Instant::now();
    let total = initial + seconds * rate * 3;
    let drained = tokio::time::timeout(Duration::from_secs(120), async {
        while frame_ready_count(&db).await < total as i64 || text_pending_count(&db).await > 0 {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .is_ok();
    let drain_seconds = drain_start.elapsed().as_secs_f64();
    shutdown.notify_one();
    task.await.unwrap();
    image_shutdown.notify_one();
    if let Some(t) = image_task {
        t.await.unwrap();
    }
    let images_processed: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM _privacy_release WHERE kind='image' AND policy=(SELECT receipt_key FROM _privacy_policy WHERE id=1)",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    let processed = monitor.status().await.redacted_total;
    let ready: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM _privacy_release WHERE kind='frames' AND policy=(SELECT receipt_key FROM _privacy_policy WHERE id=1)",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    if drained {
        assert_eq!(ready as usize, total);
    }
    let durable: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM frames")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(durable as usize, initial + seconds * rate * 3);
    emit(
        "sustained_text",
        &context,
        start,
        cpu,
        json!({"capture":distribution(writes),"capture_duration_s":capture_duration,"completed_at_capture_end":completed_at_capture_end,"drain_s":drain_seconds,"text_drained":drained,"images_processed":images_processed,"image_pending":if mixed {total as i64-images_processed}else{0},"processed":ready,"all_text_surface_completions":processed,"processed_per_s":ready as f64/start.elapsed().as_secs_f64(),"pending":durable-ready,"pending_text_surfaces_at_end":text_pending_count(&db).await,"backlog_samples":backlog,"wal_bytes":std::fs::metadata(root.path().join("db.sqlite-wal")).map(|m|m.len()).unwrap_or(0)}),
    );
    db.close().await;
}

#[cfg(feature = "onnx-cpu")]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "manual real image-model and media publication benchmark"]
async fn real_image_pipeline() {
    use screenpipe_redact::{
        adapters::rfdetr::{RfdetrConfig, RfdetrRedactor},
        image::{
            worker::{ImageWorker, ImageWorkerConfig},
            ImageRedactor,
        },
    };
    let folder = std::path::PathBuf::from(
        std::env::var("PRIVACY_BENCH_IMAGES").expect("synthetic image fixture folder"),
    );
    let start = Instant::now();
    let cpu = usage().0;
    let detector = Arc::new(RfdetrRedactor::load(RfdetrConfig::default()).unwrap());
    emit(
        "image_model_load",
        &json!({"model":"rfdetr_v38","backend":"ONNX CPU"}),
        start,
        cpu,
        json!({}),
    );
    for (w, h) in [(512, 512), (1920, 1080), (3840, 2160)] {
        let context = json!({"width":w,"height":h,"tiling":true,"backend":"ONNX CPU"});
        let source = folder.join(format!("{w}x{h}.png"));
        let start = Instant::now();
        let cpu = usage().0;
        let mut times = vec![];
        let mut regions = vec![];
        let cold = Instant::now();
        detector.detect(&source).await.unwrap();
        let first_ms = cold.elapsed().as_secs_f64() * 1e3;
        for _ in 0..env_n("PRIVACY_BENCH_IMAGE_SAMPLES", 20) {
            let t = Instant::now();
            let result = detector.detect(&source).await.unwrap();
            times.push(t.elapsed().as_secs_f64() * 1e3);
            regions.push(result.len());
        }
        emit(
            "image_inference",
            &context,
            start,
            cpu,
            json!({"inference":distribution(times),"first_call_ms":first_ms,"region_counts":regions,"recall":"not measured"}),
        );
        let (root, db) = db().await;
        db.configure_release(&policy(false, true)).await.unwrap();
        for i in 1..=4 {
            let path = root.path().join(format!("{i}.png"));
            std::fs::copy(&source, &path).unwrap();
            db.execute_raw_sql_write(&format!(
                "INSERT INTO frames(id,timestamp,name) VALUES({i},'2020-01-01T00:00:00Z','{}')",
                path.display()
            ))
            .await
            .unwrap();
        }
        for id in 1..=4 {
            assert!(db.get_frame_timestamp(id).await.unwrap().is_some());
        }
        let worker = ImageWorker::new_with_writer(
            db.pool.clone(),
            db.coordinated_writer(),
            detector.clone(),
            ImageWorkerConfig::default(),
        )
        .with_release_storage(db.clone());
        let monitor = worker.clone();
        let shutdown = Arc::new(tokio::sync::Notify::new());
        let start = Instant::now();
        let cpu = usage().0;
        let task = worker.spawn_with_shutdown(shutdown.clone());
        let complete = tokio::time::timeout(Duration::from_secs(120), async {
            while monitor.status().await.frames_redacted_total < 4 {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await;
        shutdown.notify_one();
        task.await.unwrap();
        assert!(
            complete.is_ok(),
            "image worker deadline: {:?}",
            monitor.status().await
        );
        for i in 1..=4 {
            assert!(db.release_ready("image", &i.to_string()).await.unwrap());
            assert!(image::open(root.path().join(format!("{i}.png"))).is_ok());
        }
        emit(
            "image_worker",
            &context,
            start,
            cpu,
            json!({"released":4,"frames_per_s":4.0/start.elapsed().as_secs_f64()}),
        );
        db.close().await;
    }
}

#[cfg(feature = "onnx-cpu")]
async fn attach_image(
    db: &DatabaseManager,
    root: &std::path::Path,
    source: &std::path::Path,
    id: i64,
) {
    let dest = root.join(format!("synthetic-{id}.png"));
    std::fs::copy(source, &dest).unwrap();
    // Deliberately mature synthetic captures isolate processing capacity from
    // the production 60-second image age requirement.
    db.execute_raw_sql_write(&format!(
        "UPDATE frames SET name='{}',timestamp='2020-01-01T00:00:00Z' WHERE id={id}",
        dest.display()
    ))
    .await
    .unwrap();
    assert!(db.get_frame_timestamp(id).await.unwrap().is_some());
}

#[cfg(feature = "onnx-cpu")]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "manual large-field inference and capture interference stress"]
async fn real_large_fields() {
    use screenpipe_redact::adapters::onnx::{OnnxConfig, OnnxRedactor};
    let detector = Arc::new(screenpipe_redact::pipeline::Pipeline::regex_then_ai(
        Arc::new(OnnxRedactor::load(OnnxConfig::default()).unwrap()),
        Default::default(),
    ));
    for bytes in [4_096, 65_536, 1_048_576] {
        let (root, db) = db().await;
        db.configure_release(&policy(true, false)).await.unwrap();
        let text = "Synthetic planning notes, public milestones and ordinary review context. "
            .repeat(bytes / 71 + 1);
        let text = text[..bytes].to_string();
        let stop = Arc::new(AtomicBool::new(false));
        let ready = Arc::new(tokio::sync::Notify::new());
        let capture_task = {
            let stop = stop.clone();
            let ready = ready.clone();
            let db = db.clone();
            tokio::spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_millis(50));
                interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                let mut samples = Vec::new();
                let mut sequence = 0;
                ready.notify_one();
                while !stop.load(Ordering::Relaxed) {
                    interval.tick().await;
                    if stop.load(Ordering::Relaxed) {
                        break;
                    }
                    let start = Instant::now();
                    capture(&db, sequence).await;
                    samples.push((start, Instant::now()));
                    sequence += 1;
                }
                samples
            })
        };
        ready.notified().await;
        let start = Instant::now();
        let cpu = usage().0;
        let result = detector.redact_required(&text).await.unwrap();
        let inference_end = Instant::now();
        let inference_s = inference_end.duration_since(start).as_secs_f64();
        stop.store(true, Ordering::Relaxed);
        let captures = capture_task
            .await
            .unwrap()
            .into_iter()
            .filter(|(a, b)| *a < inference_end && *b > start)
            .map(|(a, b)| b.duration_since(a).as_secs_f64() * 1e3)
            .collect();
        assert!(!result.redacted.is_empty());
        emit(
            "large_field",
            &json!({"bytes":bytes,"model":"v50 CPU production required pipeline","inference_samples":1}),
            start,
            cpu,
            json!({"inference_s":inference_s,"capture":distribution(captures),"output_bytes":result.redacted.len(),"wal_bytes":std::fs::metadata(root.path().join("db.sqlite-wal")).map(|m|m.len()).unwrap_or(0)}),
        );
        db.close().await;
    }
}

#[cfg(feature = "onnx-cpu")]
async fn frame_ready_count(db: &DatabaseManager) -> i64 {
    // WorkerStatus aggregates all seven streams. OCR capture also creates
    // element records, so that counter is not a frame-throughput numerator.
    sqlx::query_scalar(
        "SELECT COUNT(*) FROM _privacy_release WHERE kind='frames' AND policy=(SELECT receipt_key FROM _privacy_policy WHERE id=1)",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap()
}

#[cfg(feature = "onnx-cpu")]
async fn text_pending_count(db: &DatabaseManager) -> i64 {
    sqlx::query_scalar(
        "SELECT COUNT(*) FROM _privacy_release WHERE kind!='image' AND policy IS NULL",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "manual receipt policy identity length sensitivity"]
async fn policy_identity_overhead() {
    let history = env_n("PRIVACY_BENCH_HISTORY", 100_000);
    let bytes = env_n("PRIVACY_BENCH_POLICY_BYTES", 512);
    assert!((8..=4096).contains(&bytes));
    let identity = "x".repeat(bytes);
    let legacy = std::env::var_os("PRIVACY_BENCH_LEGACY_RECEIPTS").is_some();
    let (root, db) = db().await;
    seed(&db, history).await;
    db.configure_release(&ReleasePolicy {
        identity: identity.clone(),
        text: true,
        images: true,
    })
    .await
    .unwrap();
    let receipt: String = if legacy {
        identity.clone()
    } else {
        sqlx::query_scalar("SELECT CAST(receipt_key AS TEXT) FROM _privacy_policy WHERE id=1")
            .fetch_one(&db.pool)
            .await
            .unwrap()
    };
    let mut tx = db.begin_immediate_with_retry().await.unwrap();
    for kind in ["frames", "image"] {
        sqlx::query(
            "INSERT INTO _privacy_release(kind,id,policy) SELECT ?,CAST(id AS TEXT),? FROM frames",
        )
        .bind(kind)
        .bind(&receipt)
        .execute(&mut **tx.conn())
        .await
        .unwrap();
    }
    tx.commit().await.unwrap();
    db.execute_raw_sql_write("PRAGMA wal_checkpoint(TRUNCATE)")
        .await
        .unwrap();
    let read = db.protected_reads().await.unwrap();
    if legacy {
        let columns: Vec<String> =
            sqlx::query_scalar("SELECT name FROM pragma_table_info('frames')")
                .fetch_all(&db.pool)
                .await
                .unwrap();
        let projection = columns.iter().map(|column| {
            if matches!(column.as_str(), "name" | "snapshot_path" | "video_chunk_id") {
                format!("CASE WHEN gate.image_required=0 OR EXISTS(SELECT 1 FROM _privacy_release r INDEXED BY _privacy_certified WHERE r.kind='image' AND r.policy=gate.identity AND r.id=CAST(s.id AS TEXT)) THEN s.\"{column}\" END AS \"{column}\"")
            } else { format!("s.\"{column}\"") }
        }).collect::<Vec<_>>().join(",");
        let view = format!("DROP VIEW temp.frames; CREATE TEMP VIEW frames AS SELECT {projection} FROM _privacy_policy gate CROSS JOIN main.frames s WHERE gate.id=1 AND (gate.text_required=0 OR EXISTS(SELECT 1 FROM _privacy_release r WHERE r.kind='frames' AND r.policy=gate.identity)) AND (gate.text_required=0 OR EXISTS(SELECT 1 FROM _privacy_release r INDEXED BY _privacy_certified WHERE r.kind='frames' AND r.policy=gate.identity AND r.id=CAST(s.id AS TEXT)))");
        let mut connections = vec![];
        for _ in 0..read.pool.options().get_max_connections() {
            let mut connection = read.pool.acquire().await.unwrap();
            sqlx::query("PRAGMA query_only=OFF")
                .execute(&mut *connection)
                .await
                .unwrap();
            sqlx::raw_sql(sqlx::AssertSqlSafe(view.clone()))
                .execute(&mut *connection)
                .await
                .unwrap();
            sqlx::query("PRAGMA query_only=ON")
                .execute(&mut *connection)
                .await
                .unwrap();
            connections.push(connection);
        }
        drop(connections);
    }

    let start = Instant::now();
    let cpu = usage().0;
    let mut latest = vec![];
    let mut queries = vec![];
    let mut counts = vec![];
    let read_samples = env_n("PRIVACY_BENCH_READ_SAMPLES", 30);
    for _ in 0..read_samples {
        let t = Instant::now();
        let ids: Vec<i64> =
            sqlx::query_scalar("SELECT id FROM frames ORDER BY timestamp DESC LIMIT 50")
                .fetch_all(&read.pool)
                .await
                .unwrap();
        assert_eq!(ids.len(), 50);
        latest.push(t.elapsed().as_secs_f64() * 1e3);
        let t = Instant::now();
        assert_eq!(search(&read).await, 50);
        queries.push(t.elapsed().as_secs_f64() * 1e3);
        let t = Instant::now();
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM frames")
            .fetch_one(&read.pool)
            .await
            .unwrap();
        assert_eq!(count as usize, history);
        counts.push(t.elapsed().as_secs_f64() * 1e3);
    }
    let stop = Arc::new(AtomicBool::new(false));
    let reader = {
        let read = read.clone();
        let stop = stop.clone();
        tokio::spawn(async move {
            while !stop.load(Ordering::Relaxed) {
                let _: Vec<i64> =
                    sqlx::query_scalar("SELECT id FROM frames ORDER BY timestamp DESC LIMIT 50")
                        .fetch_all(&read.pool)
                        .await
                        .unwrap();
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
    };
    let capture_start = Instant::now();
    let capture_cpu_start = usage().0;
    let mut writes = vec![];
    for i in 0..1000 {
        let t = Instant::now();
        capture(&db, i).await;
        writes.push(t.elapsed().as_secs_f64() * 1e3);
    }
    let capture_s = capture_start.elapsed().as_secs_f64();
    let capture_cpu_s = usage().0 - capture_cpu_start;
    stop.store(true, Ordering::Relaxed);
    reader.await.unwrap();
    let durable: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM frames")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(durable as usize, history + 3000);
    let visible: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM frames WHERE full_text LIKE '%SYNTHETIC_SECRET%'")
            .fetch_one(&read.pool)
            .await
            .unwrap();
    assert_eq!(visible, 0);
    emit(
        "identity_sensitivity",
        &json!({"history":history,"policy_bytes":bytes,"legacy_receipts":legacy,"profile":if cfg!(debug_assertions){"debug"}else{"release"},"read_samples":read_samples,"capture_samples":1000}),
        start,
        cpu,
        json!({"latest":distribution(latest),"fts_search":distribution(queries),"count":distribution(counts),"capture":distribution(writes),"capture_s":capture_s,"capture_cpu_s":capture_cpu_s,"db_bytes":std::fs::metadata(root.path().join("db.sqlite")).unwrap().len(),"wal_bytes":std::fs::metadata(root.path().join("db.sqlite-wal")).map(|m|m.len()).unwrap_or(0)}),
    );
    read.close().await;
    db.close().await;
}

#[tokio::test]
#[ignore = "manual real-model before/after equivalence and step latency"]
async fn resumable_model_windows() {
    use screenpipe_redact::adapters::onnx::{OnnxConfig, OnnxRedactor};
    let model = Arc::new(OnnxRedactor::load(OnnxConfig::default()).unwrap());
    let text = "Technical project planning. Contact Alice Smith at alice@example.com. "
        .repeat(env_n("PRIVACY_BENCH_REPEAT", 128));
    let started = Instant::now();
    let before = model.redact_required(&text).await.unwrap();
    let before_ms = started.elapsed().as_secs_f64() * 1000.0;
    let mut session = model.required_session(text.clone());
    let mut steps = vec![];
    let after = loop {
        let started = Instant::now();
        let output = session.step().await.unwrap();
        steps.push(started.elapsed().as_secs_f64() * 1000.0);
        if let Some(output) = output {
            break output;
        }
        tokio::task::yield_now().await;
    };
    assert_eq!(
        before, after,
        "window scheduling must preserve every detection and offset"
    );
    assert!(steps.len() > 1);
    println!(
        "PRIVACY_WINDOW_METRIC {}",
        json!({"bytes":text.len(),"before_indivisible_ms":before_ms,"after_steps":distribution(steps)})
    );
}
