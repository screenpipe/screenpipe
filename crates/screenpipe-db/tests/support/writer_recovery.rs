// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use screenpipe_config::{DbConfig, DeviceTier};
use screenpipe_db::DatabaseManager;

pub async fn writer_starvation_recovery(hybrid: bool) {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use std::time::Duration;

    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("db.sqlite").to_string_lossy().into_owned();
    let mut config = DbConfig::for_tier(DeviceTier::Low);
    config.write_pool_max = 1;
    let db = if hybrid {
        DatabaseManager::new_hybrid(dir.path(), config.clone(), Default::default())
            .await
            .unwrap()
    } else {
        DatabaseManager::new(&db_path, config.clone())
            .await
            .unwrap()
    };
    let historical = db
        .insert_audio_chunk("historical-audio", None)
        .await
        .unwrap();
    db.record_chunk_outcome(
        historical,
        screenpipe_db::ChunkOutcome::Transcribed {
            segments: vec![screenpipe_db::ReplacementAudioTranscription {
                transcription: "historical transcript".into(),
                speaker_id: None,
                start_time: 0.0,
                end_time: 1.0,
            }],
            engine: "test".into(),
            device: "test".into(),
            is_input_device: true,
            timestamp: chrono::Utc::now(),
        },
    )
    .await
    .unwrap();
    let worker = db.coordinated_writer();
    let writer = worker.lock().await.unwrap();
    let shared_pool = writer.pool().clone();
    let held = shared_pool.acquire().await.unwrap();
    drop(writer);
    let restarts = Arc::new(AtomicUsize::new(0));
    let observed = restarts.clone();
    db.set_database_restart_hook(Arc::new(move |reason| {
        assert_eq!(
            reason,
            screenpipe_db::DatabaseRestartReason::PersistentWriteFailure
        );
        observed.fetch_add(1, Ordering::SeqCst);
    }));

    // Model a checked-out writer that bypassed admission. The queue owns the
    // coordinator, but exhausts its real five-second pool acquisition budget.
    // At five failures the old code replaced only the drain loop's pool.
    for _ in 0..5 {
        let error = db
            .insert_audio_chunk("pending-audio", None)
            .await
            .unwrap_err();
        assert!(screenpipe_db::is_write_pool_starved(&error));
    }
    drop(held);
    tokio::time::timeout(Duration::from_secs(2), async {
        while restarts.load(Ordering::SeqCst) == 0 && !shared_pool.is_closed() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(
        !shared_pool.is_closed(),
        "queue recovery must not strand the manager and background writers on a closed pool"
    );
    assert_eq!(restarts.load(Ordering::SeqCst), 1);
    assert_eq!(db.write_queue_health().write_pool_reopens(), 0);

    // Once the borrowed handle returns, every writer still has the same usable
    // pool while the lifecycle owner handles the restart request.
    db.insert_audio_chunk("before-restart", None).await.unwrap();
    db.execute_raw_sql_write(
        "CREATE TABLE recovery_probe(value INTEGER); INSERT INTO recovery_probe VALUES(1)",
    )
    .await
    .unwrap();
    db.wal_checkpoint().await.unwrap();
    db.close().await;
    assert!(shared_pool.is_closed());
    let retired_writer = worker.lock().await.unwrap();
    assert!(retired_writer.pool().is_closed());
    assert!(retired_writer.pool().acquire().await.is_err());
    drop(retired_writer);

    let reopened = DatabaseManager::new(&db_path, config).await.unwrap();
    let pending = reopened
        .insert_audio_chunk("pending-audio", None)
        .await
        .unwrap();
    reopened
        .record_chunk_outcome(
            pending,
            screenpipe_db::ChunkOutcome::Transcribed {
                segments: vec![screenpipe_db::ReplacementAudioTranscription {
                    transcription: "recovered transcript".into(),
                    speaker_id: None,
                    start_time: 0.0,
                    end_time: 1.0,
                }],
                engine: "test".into(),
                device: "test".into(),
                is_input_device: true,
                timestamp: chrono::Utc::now(),
            },
        )
        .await
        .unwrap();
    let transcripts = reopened
        .query_raw_sql("SELECT transcription FROM audio_transcriptions ORDER BY audio_chunk_id")
        .await
        .unwrap();
    assert_eq!(
        transcripts,
        serde_json::json!([
            {"transcription": "historical transcript"},
            {"transcription": "recovered transcript"}
        ])
    );
    reopened
        .execute_raw_sql_write("INSERT INTO recovery_probe VALUES(2)")
        .await
        .unwrap();
    for path in ["historical-audio", "before-restart", "pending-audio"] {
        assert!(reopened.find_audio_chunk_id(path).await.unwrap().is_some());
    }
    let values = reopened
        .query_raw_sql("SELECT value FROM recovery_probe ORDER BY value")
        .await
        .unwrap();
    assert_eq!(values, serde_json::json!([{"value": 1}, {"value": 2}]));
    reopened.close().await;
}
