use anyhow::{anyhow, Result};
use chrono::Utc;
use serde::Serialize;
use sqlx::{Row, SqlitePool};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;
use tokio::{sync::mpsc, task::JoinHandle, time};
use tracing::{debug, error, info, warn};

use crate::DatabaseManager;

/// Status of a migration job
#[derive(Debug, Clone, PartialEq, Serialize)]
pub enum MigrationStatus {
    /// Migration is currently running
    Running {
        total_records: i64,
        processed_records: i64,
    },
    /// Migration completed successfully
    Completed {
        total_records: i64,
        duration_secs: u64,
    },
    /// Migration is paused and can be resumed
    Paused {
        total_records: i64,
        processed_records: i64,
    },
    /// Migration failed with an error
    Failed {
        total_records: i64,
        processed_records: i64,
        error: String,
    },
    /// Migration has not been started yet
    NotStarted,
}

/// Commands that can be sent to control the migration worker
#[derive(Debug, Clone)]
pub enum MigrationCommand {
    /// Start or resume the migration
    Start,
    /// Pause the migration (can be resumed later)
    Pause,
    /// Stop the migration (cannot be resumed)
    Stop,
    /// Request current migration status
    Status,
}

/// Response from the migration worker, including current status
#[derive(Serialize)]
pub struct MigrationResponse {
    pub status: MigrationStatus,
}

/// Configuration for the migration worker
#[derive(Debug, Clone)]
pub struct MigrationConfig {
    /// Number of records to process in a single batch
    pub batch_size: i64,
    /// Delay between batches to reduce database load
    pub batch_delay_ms: u64,
    /// Whether to continue processing if an error occurs
    pub continue_on_error: bool,
}

impl Default for MigrationConfig {
    fn default() -> Self {
        Self {
            batch_size: 200,
            batch_delay_ms: 100,
            continue_on_error: true,
        }
    }
}

/// Worker that handles background migration of data
pub struct MigrationWorker {
    db: Arc<DatabaseManager>,
    status: MigrationStatus,
    is_running: Arc<AtomicBool>,
    is_paused: Arc<AtomicBool>,
    config: MigrationConfig,
    cmd_rx: mpsc::Receiver<MigrationCommand>,
    status_tx: mpsc::Sender<MigrationResponse>,
    worker_handle: Option<JoinHandle<()>>,
}

impl MigrationWorker {
    /// Create a new migration worker
    pub fn new(
        db: Arc<DatabaseManager>,
        cmd_rx: mpsc::Receiver<MigrationCommand>,
        status_tx: mpsc::Sender<MigrationResponse>,
        config: MigrationConfig,
    ) -> Self {
        Self {
            db,
            status: MigrationStatus::NotStarted,
            is_running: Arc::new(AtomicBool::new(false)),
            is_paused: Arc::new(AtomicBool::new(false)),
            config,
            cmd_rx,
            status_tx,
            worker_handle: None,
        }
    }

    /// Start the migration worker to process commands
    pub fn start(mut self) -> JoinHandle<()> {
        tokio::spawn(async move {
            info!("Migration worker started");
            while let Some(cmd) = self.cmd_rx.recv().await {
                match cmd {
                    MigrationCommand::Start => {
                        self.start_migration().await;
                    }
                    MigrationCommand::Pause => {
                        self.pause_migration();
                    }
                    MigrationCommand::Stop => {
                        self.stop_migration();
                        break;
                    }
                    MigrationCommand::Status => {
                        let _ = self
                            .status_tx
                            .send(MigrationResponse {
                                status: self.status.clone(),
                            })
                            .await;
                    }
                }
            }
            info!("Migration worker stopped");
        })
    }

    async fn start_migration(&mut self) {
        if self.is_running.load(Ordering::SeqCst) {
            if self.is_paused.load(Ordering::SeqCst) {
                // Resume migration
                info!("Resuming migration");
                self.is_paused.store(false, Ordering::SeqCst);
                let _ = self
                    .status_tx
                    .send(MigrationResponse {
                        status: self.status.clone(),
                    })
                    .await;
                return;
            }
            warn!("Migration is already running");
            return;
        }

        // Start the migration worker
        self.is_running.store(true, Ordering::SeqCst);

        // Create clones of shared resources for the worker task
        let db = self.db.clone();
        let config = self.config.clone();
        let is_running = self.is_running.clone();
        let is_paused = self.is_paused.clone();
        let status_tx = self.status_tx.clone();

        // Spawn a task to handle the actual migration work
        let handle = tokio::spawn(async move {
            // Start the migration process
            let result = migrate_ocr_data_to_frames(
                &db,
                config,
                is_running.clone(),
                is_paused.clone(),
                status_tx.clone(),
            )
            .await;

            // Handle completion or failure
            match result {
                Ok((total, duration)) => {
                    info!("Migration completed successfully: {total} records processed in {duration} seconds");
                    let _ = status_tx
                        .send(MigrationResponse {
                            status: MigrationStatus::Completed {
                                total_records: total,
                                duration_secs: duration,
                            },
                        })
                        .await;
                }
                Err(e) => {
                    let error_msg = e.to_string();
                    error!("Migration failed: {error_msg}");

                    // Try to get the current progress
                    let processed = get_migration_progress(&db.pool).await.unwrap_or(0);
                    let total = get_total_records(&db.pool).await.unwrap_or(0);

                    let _ = status_tx
                        .send(MigrationResponse {
                            status: MigrationStatus::Failed {
                                total_records: total,
                                processed_records: processed,
                                error: error_msg,
                            },
                        })
                        .await;
                }
            }

            is_running.store(false, Ordering::SeqCst);
        });

        self.worker_handle = Some(handle);
    }

    fn pause_migration(&self) {
        if self.is_running.load(Ordering::SeqCst) {
            info!("Pausing migration");
            self.is_paused.store(true, Ordering::SeqCst);
        } else {
            warn!("Cannot pause migration: not running");
        }
    }

    fn stop_migration(&self) {
        if self.is_running.load(Ordering::SeqCst) {
            info!("Stopping migration");
            self.is_running.store(false, Ordering::SeqCst);

            // Cancel the worker task if it's running
            if let Some(handle) = &self.worker_handle {
                handle.abort();
            }
        } else {
            warn!("Cannot stop migration: not running");
        }
    }
}

/// Create a migration progress table if it doesn't exist
async fn ensure_migration_table(pool: &SqlitePool) -> Result<()> {
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS migration_progress (
            id INTEGER PRIMARY KEY,
            migration_name TEXT NOT NULL,
            last_processed_id INTEGER NOT NULL,
            total_records INTEGER NOT NULL,
            processed_records INTEGER NOT NULL,
            started_at TIMESTAMP NOT NULL,
            updated_at TIMESTAMP NOT NULL,
            completed_at TIMESTAMP
        )
        "#,
    )
    .execute(pool)
    .await?;

    Ok(())
}

/// Get the current migration progress
async fn get_migration_progress(pool: &SqlitePool) -> Result<i64> {
    ensure_migration_table(pool).await?;

    let progress = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT processed_records FROM migration_progress 
        WHERE migration_name = 'ocr_text_to_frames'
        ORDER BY id DESC LIMIT 1
        "#,
    )
    .fetch_optional(pool)
    .await?
    .unwrap_or(0);

    Ok(progress)
}

/// Get the total number of records to migrate
async fn get_total_records(pool: &SqlitePool) -> Result<i64> {
    let total = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT COUNT(DISTINCT frame_id) FROM ocr_text
        WHERE (app_name IS NOT NULL AND app_name != '')
           OR (window_name IS NOT NULL AND window_name != '')
           OR (focused IS NOT NULL)
        "#,
    )
    .fetch_one(pool)
    .await?;

    Ok(total)
}

/// Update the migration progress
async fn update_migration_progress(
    pool: &SqlitePool,
    last_id: i64,
    total: i64,
    processed: i64,
    completed: bool,
) -> Result<()> {
    ensure_migration_table(pool).await?;

    let now = Utc::now();
    let completed_at = if completed { Some(now) } else { None };

    // Check if we have an existing record
    let existing = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT id FROM migration_progress 
        WHERE migration_name = 'ocr_text_to_frames'
        "#,
    )
    .fetch_optional(pool)
    .await?;

    if let Some(id) = existing {
        // Update existing record
        sqlx::query(
            r#"
            UPDATE migration_progress
            SET last_processed_id = ?,
                total_records = ?,
                processed_records = ?,
                updated_at = ?,
                completed_at = ?
            WHERE id = ?
            "#,
        )
        .bind(last_id)
        .bind(total)
        .bind(processed)
        .bind(now)
        .bind(completed_at)
        .bind(id)
        .execute(pool)
        .await?;
    } else {
        // Insert new record
        sqlx::query(
            r#"
            INSERT INTO migration_progress
            (migration_name, last_processed_id, total_records, processed_records, started_at, updated_at, completed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind("ocr_text_to_frames")
        .bind(last_id)
        .bind(total)
        .bind(processed)
        .bind(now)
        .bind(now)
        .bind(completed_at)
        .execute(pool)
        .await?;
    }

    Ok(())
}

/// Perform the actual migration of data from ocr_text to frames
async fn migrate_ocr_data_to_frames(
    db: &DatabaseManager,
    config: MigrationConfig,
    is_running: Arc<AtomicBool>,
    is_paused: Arc<AtomicBool>,
    status_tx: mpsc::Sender<MigrationResponse>,
) -> Result<(i64, u64)> {
    let pool = &db.pool;
    let start_time = std::time::Instant::now();

    // Ensure migration table exists
    ensure_migration_table(pool).await?;

    // Get the total number of records to migrate
    let total_records = get_total_records(pool).await?;

    if total_records == 0 {
        info!("No records to migrate");
        return Ok((0, 0));
    }

    // Get the last processed ID
    let last_processed_id = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT last_processed_id FROM migration_progress 
        WHERE migration_name = 'ocr_text_to_frames'
        ORDER BY id DESC LIMIT 1
        "#,
    )
    .fetch_optional(pool)
    .await?
    .unwrap_or(0);

    let mut processed_records = get_migration_progress(pool).await?;

    info!(
        "Starting migration: total_records={}, already_processed={}, last_processed_id={}",
        total_records, processed_records, last_processed_id
    );

    // Update the initial status
    let _ = status_tx
        .send(MigrationResponse {
            status: MigrationStatus::Running {
                total_records,
                processed_records,
            },
        })
        .await;

    // Process in batches
    let batch_size = config.batch_size;
    let mut last_id = last_processed_id;

    while is_running.load(Ordering::SeqCst) && processed_records < total_records {
        // Check if we should pause
        while is_paused.load(Ordering::SeqCst) && is_running.load(Ordering::SeqCst) {
            let _ = status_tx
                .send(MigrationResponse {
                    status: MigrationStatus::Paused {
                        total_records,
                        processed_records,
                    },
                })
                .await;
            time::sleep(Duration::from_millis(500)).await;
        }

        if !is_running.load(Ordering::SeqCst) {
            break;
        }

        // Process a batch
        match process_batch(db, last_id, batch_size).await {
            Ok((batch_processed, new_last_id)) => {
                if batch_processed == 0 {
                    // No more records to process
                    break;
                }

                processed_records += batch_processed;
                last_id = new_last_id;

                // Update progress
                if let Err(e) = update_migration_progress(
                    pool,
                    last_id,
                    total_records,
                    processed_records,
                    processed_records >= total_records,
                )
                .await
                {
                    warn!("Failed to update migration progress: {}", e);
                }

                // Update status
                let _ = status_tx
                    .send(MigrationResponse {
                        status: MigrationStatus::Running {
                            total_records,
                            processed_records,
                        },
                    })
                    .await;

                // Delay between batches to reduce database load
                time::sleep(Duration::from_millis(config.batch_delay_ms)).await;
            }
            Err(e) => {
                error!("Error processing batch: {}", e);

                if !config.continue_on_error {
                    return Err(anyhow!("Migration failed: {}", e));
                }

                // Try to continue with the next batch
                last_id += batch_size;

                // Delay a bit longer after an error
                time::sleep(Duration::from_millis(config.batch_delay_ms * 5)).await;
            }
        }
    }

    let duration = start_time.elapsed().as_secs();

    // Final update to mark as completed
    if processed_records >= total_records {
        update_migration_progress(pool, last_id, total_records, processed_records, true).await?;
    }

    Ok((processed_records, duration))
}

/// Process a batch of records
async fn process_batch(db: &DatabaseManager, last_id: i64, batch_size: i64) -> Result<(i64, i64)> {
    let mut tx = db.begin_immediate_with_retry().await?;

    // Query to get a batch of records with unique frame_ids that need migration
    let records = sqlx::query(
        r#"
        SELECT DISTINCT ocr_text.frame_id, 
               ocr_text.app_name, 
               ocr_text.window_name, 
               ocr_text.focused
        FROM ocr_text
        JOIN frames ON ocr_text.frame_id = frames.id
        WHERE ocr_text.frame_id > ?
          AND (
            -- We need to migrate this data
            (ocr_text.app_name IS NOT NULL AND ocr_text.app_name != '' AND frames.app_name IS NULL) OR
            (ocr_text.window_name IS NOT NULL AND ocr_text.window_name != '' AND frames.window_name IS NULL) OR
            (ocr_text.focused IS NOT NULL AND frames.focused IS NULL) 
          )
        ORDER BY ocr_text.frame_id
        LIMIT ?
        "#,
    )
    .bind(last_id)
    .bind(batch_size)
    .fetch_all(&mut **tx.conn())
    .await?;

    let mut count = 0;
    let mut max_id = last_id;

    // Process each record
    for record in records.iter() {
        let frame_id: i64 = record.try_get("frame_id")?;
        let app_name: Option<String> = record.try_get("app_name").unwrap_or(None);
        let window_name: Option<String> = record.try_get("window_name").unwrap_or(None);
        let focused: Option<bool> = record.try_get("focused").unwrap_or(None);

        // Update the frames table
        sqlx::query(
            r#"
            UPDATE frames
            SET app_name = COALESCE(?, app_name),
                window_name = COALESCE(?, window_name),
                focused = COALESCE(?, focused)
            WHERE id = ?
            "#,
        )
        .bind(app_name)
        .bind(window_name)
        .bind(focused)
        .bind(frame_id)
        .execute(&mut **tx.conn())
        .await?;

        count += 1;
        max_id = std::cmp::max(max_id, frame_id);
    }

    // Commit the transaction (auto-rollback on drop if this fails)
    tx.commit().await?;

    debug!("Processed batch: {} records, max_id={}", count, max_id);

    Ok((count, max_id))
}

impl MigrationConfig {
    pub fn new(batch_size: i64, batch_delay_ms: u64, continue_on_error: bool) -> Self {
        Self {
            batch_size,
            batch_delay_ms,
            continue_on_error,
        }
    }
}

/// Create a database migration worker and return channels to control it
pub fn create_migration_worker(
    db: Arc<DatabaseManager>,
    config: Option<MigrationConfig>,
) -> (
    mpsc::Sender<MigrationCommand>,
    mpsc::Receiver<MigrationResponse>,
    JoinHandle<()>,
) {
    let (cmd_tx, cmd_rx) = mpsc::channel(100);
    let (status_tx, status_rx) = mpsc::channel(100);

    let worker = MigrationWorker::new(db, cmd_rx, status_tx, config.unwrap_or_default());

    let handle = worker.start();

    (cmd_tx, status_rx, handle)
}
