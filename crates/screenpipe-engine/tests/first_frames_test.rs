use anyhow::Result;
use chrono::{Duration, Utc};
use screenpipe_core::paths;
use std::sync::Arc;
use std::time::Instant;
use tracing::{error, warn};

use screenpipe_db::DatabaseManager;
use screenpipe_engine::video_utils::extract_frame_from_video;

/// Setup test environment with real screenpipe database
async fn setup_test_env() -> Result<Arc<DatabaseManager>> {
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::DEBUG)
        .try_init()
        .ok();

    let db = Arc::new(
        DatabaseManager::new(
            paths::default_screenpipe_data_dir()
                .join("db.sqlite")
                .to_str()
                .unwrap(),
            Default::default(),
        )
        .await?,
    );

    Ok(db)
}

/// Test to diagnose "first frames not loading" issue
/// This test fetches the most recent frames and attempts to load them,
/// reporting detailed diagnostics about failures
#[tokio::test]
#[ignore = "requires real screenpipe data, run with --ignored"]
async fn test_first_frames_loading() -> Result<()> {
    let db = setup_test_env().await?;

    println!("\n=== First Frames Loading Test ===\n");

    // Get the 10 most recent frames
    let recent_frames = sqlx::query_as::<_, (i64, String, i64, String)>(
        r#"
        SELECT
            f.id as frame_id,
            vc.file_path,
            f.offset_index,
            f.timestamp
        FROM frames f
        JOIN video_chunks vc ON f.video_chunk_id = vc.id
        ORDER BY f.timestamp DESC
        LIMIT 10
        "#,
    )
    .fetch_all(&db.pool)
    .await?;

    println!("Found {} recent frames to test\n", recent_frames.len());
    println!(
        "{:<12} {:<60} {:<12} {:<20} {:<10}",
        "Frame ID", "Video Path", "Offset", "Timestamp", "Status"
    );
    println!("{}", "-".repeat(120));

    let mut success_count = 0;
    let mut failure_count = 0;
    let mut failures: Vec<(i64, String, String)> = Vec::new();

    for (frame_id, file_path, offset_index, timestamp) in &recent_frames {
        let start = Instant::now();

        // Check if video file exists
        let file_exists = tokio::fs::try_exists(&file_path).await.unwrap_or(false);

        if !file_exists {
            println!(
                "{:<12} {:<60} {:<12} {:<20} FILE_MISSING",
                frame_id,
                truncate_path(file_path, 58),
                offset_index,
                truncate_str(timestamp, 18)
            );
            failure_count += 1;
            failures.push((
                *frame_id,
                file_path.clone(),
                "File does not exist".to_string(),
            ));
            continue;
        }

        // Try to extract the frame
        match tokio::time::timeout(
            std::time::Duration::from_secs(10),
            extract_frame_from_video(file_path, *offset_index, "2"),
        )
        .await
        {
            Ok(Ok(frame_path)) => {
                let elapsed = start.elapsed();
                // Verify the extracted frame exists and has content
                match tokio::fs::metadata(&frame_path).await {
                    Ok(meta) if meta.len() > 0 => {
                        println!(
                            "{:<12} {:<60} {:<12} {:<20} OK ({:.1}ms, {} bytes)",
                            frame_id,
                            truncate_path(file_path, 58),
                            offset_index,
                            truncate_str(timestamp, 18),
                            elapsed.as_millis(),
                            meta.len()
                        );
                        success_count += 1;
                    }
                    Ok(meta) => {
                        println!(
                            "{:<12} {:<60} {:<12} {:<20} EMPTY_FILE",
                            frame_id,
                            truncate_path(file_path, 58),
                            offset_index,
                            truncate_str(timestamp, 18)
                        );
                        failure_count += 1;
                        failures.push((
                            *frame_id,
                            file_path.clone(),
                            format!("Empty file: {} bytes", meta.len()),
                        ));
                    }
                    Err(e) => {
                        println!(
                            "{:<12} {:<60} {:<12} {:<20} OUTPUT_ERR",
                            frame_id,
                            truncate_path(file_path, 58),
                            offset_index,
                            truncate_str(timestamp, 18)
                        );
                        failure_count += 1;
                        failures.push((
                            *frame_id,
                            file_path.clone(),
                            format!("Output file error: {}", e),
                        ));
                    }
                }
            }
            Ok(Err(e)) => {
                let elapsed = start.elapsed();
                println!(
                    "{:<12} {:<60} {:<12} {:<20} EXTRACT_FAIL ({:.1}ms)",
                    frame_id,
                    truncate_path(file_path, 58),
                    offset_index,
                    truncate_str(timestamp, 18),
                    elapsed.as_millis()
                );
                failure_count += 1;
                failures.push((
                    *frame_id,
                    file_path.clone(),
                    format!("Extraction failed: {}", e),
                ));
            }
            Err(_) => {
                println!(
                    "{:<12} {:<60} {:<12} {:<20} TIMEOUT",
                    frame_id,
                    truncate_path(file_path, 58),
                    offset_index,
                    truncate_str(timestamp, 18)
                );
                failure_count += 1;
                failures.push((
                    *frame_id,
                    file_path.clone(),
                    "Timeout after 10s".to_string(),
                ));
            }
        }
    }

    println!("\n=== Summary ===");
    println!("Success: {}/{}", success_count, recent_frames.len());
    println!("Failures: {}/{}", failure_count, recent_frames.len());

    if !failures.is_empty() {
        println!("\n=== Failure Details ===");
        for (frame_id, path, reason) in &failures {
            println!("Frame {}: {}", frame_id, reason);
            println!("  Path: {}", path);

            // Additional diagnostics for the video file
            if let Ok(meta) = tokio::fs::metadata(path).await {
                println!("  File size: {} bytes", meta.len());
                if let Ok(modified) = meta.modified() {
                    let age = std::time::SystemTime::now()
                        .duration_since(modified)
                        .unwrap_or_default();
                    println!("  Last modified: {:.1}s ago", age.as_secs_f64());
                }
            }
            println!();
        }
    }

    // Test should pass if at least 80% of frames load successfully
    let success_rate = success_count as f64 / recent_frames.len() as f64;
    assert!(
        success_rate >= 0.8,
        "Only {:.1}% of first frames loaded successfully (expected >= 80%)",
        success_rate * 100.0
    );

    Ok(())
}

/// Test frame loading with concurrent requests (simulates timeline scrolling)
#[tokio::test]
#[ignore = "requires real screenpipe data, run with --ignored"]
async fn test_concurrent_frame_loading() -> Result<()> {
    let db = setup_test_env().await?;

    println!("\n=== Concurrent Frame Loading Test ===\n");

    // Get 20 recent frames
    let recent_frames = sqlx::query_as::<_, (i64, String, i64)>(
        r#"
        SELECT
            f.id as frame_id,
            vc.file_path,
            f.offset_index
        FROM frames f
        JOIN video_chunks vc ON f.video_chunk_id = vc.id
        ORDER BY f.timestamp DESC
        LIMIT 20
        "#,
    )
    .fetch_all(&db.pool)
    .await?;

    println!("Loading {} frames concurrently...\n", recent_frames.len());

    let start = Instant::now();

    // Spawn all frame extractions concurrently
    let handles: Vec<_> = recent_frames
        .into_iter()
        .map(|(frame_id, file_path, offset_index)| {
            tokio::spawn(async move {
                let result = tokio::time::timeout(
                    std::time::Duration::from_secs(10),
                    extract_frame_from_video(&file_path, offset_index, "2"),
                )
                .await;
                (frame_id, result)
            })
        })
        .collect();

    let mut success = 0;
    let mut timeout = 0;
    let mut failed = 0;

    for handle in handles {
        match handle.await {
            Ok((_frame_id, Ok(Ok(_)))) => {
                success += 1;
            }
            Ok((frame_id, Ok(Err(e)))) => {
                failed += 1;
                warn!("Frame {} failed: {}", frame_id, e);
            }
            Ok((frame_id, Err(_))) => {
                timeout += 1;
                warn!("Frame {} timed out", frame_id);
            }
            Err(e) => {
                failed += 1;
                error!("Task join error: {}", e);
            }
        }
    }

    let elapsed = start.elapsed();

    println!("Results:");
    println!("  Success: {}", success);
    println!("  Timeout: {}", timeout);
    println!("  Failed: {}", failed);
    println!("  Total time: {:.2}s", elapsed.as_secs_f64());
    println!(
        "  Avg time per frame: {:.2}ms",
        elapsed.as_millis() as f64 / 20.0
    );

    assert!(
        success >= 16,
        "Expected at least 80% success rate for concurrent loading"
    );

    Ok(())
}

/// Test the /frames/:id endpoint response times
#[tokio::test]
#[ignore = "requires running screenpipe server, run with --ignored"]
async fn test_frame_endpoint_response_times() -> Result<()> {
    let db = setup_test_env().await?;

    println!("\n=== Frame Endpoint Response Time Test ===\n");

    // Get 5 recent frame IDs
    let frame_ids: Vec<i64> =
        sqlx::query_scalar("SELECT id FROM frames ORDER BY timestamp DESC LIMIT 5")
            .fetch_all(&db.pool)
            .await?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()?;

    println!(
        "{:<12} {:<15} {:<15} {:<15}",
        "Frame ID", "Status", "Time (ms)", "Size (bytes)"
    );
    println!("{}", "-".repeat(60));

    for frame_id in &frame_ids {
        let start = Instant::now();
        let url = format!("http://localhost:3030/frames/{}", frame_id);

        match client.get(&url).send().await {
            Ok(response) => {
                let elapsed = start.elapsed();
                let status = response.status();
                let size = response.content_length().unwrap_or(0);

                println!(
                    "{:<12} {:<15} {:<15.1} {:<15}",
                    frame_id,
                    status.as_str(),
                    elapsed.as_millis(),
                    size
                );
            }
            Err(e) => {
                let elapsed = start.elapsed();
                println!(
                    "{:<12} {:<15} {:<15.1} ERROR: {}",
                    frame_id,
                    "FAILED",
                    elapsed.as_millis(),
                    e
                );
            }
        }
    }

    Ok(())
}

/// Test to check if video files for recent frames are still being written
#[tokio::test]
#[ignore = "requires real screenpipe data, run with --ignored"]
async fn test_video_file_write_status() -> Result<()> {
    let db = setup_test_env().await?;

    println!("\n=== Video File Write Status Test ===\n");

    // Get unique video files from the last 5 minutes
    let five_mins_ago = Utc::now() - Duration::minutes(5);

    let video_files: Vec<(String, String)> = sqlx::query_as(
        r#"
        SELECT DISTINCT vc.file_path, MAX(f.timestamp) as latest_frame
        FROM video_chunks vc
        JOIN frames f ON f.video_chunk_id = vc.id
        WHERE f.timestamp > ?
        GROUP BY vc.file_path
        ORDER BY latest_frame DESC
        "#,
    )
    .bind(five_mins_ago)
    .fetch_all(&db.pool)
    .await?;

    println!(
        "Checking {} video files from last 5 minutes\n",
        video_files.len()
    );
    println!(
        "{:<70} {:<15} {:<20}",
        "Video Path", "Size (MB)", "Last Modified"
    );
    println!("{}", "-".repeat(110));

    for (file_path, _latest_frame) in &video_files {
        match tokio::fs::metadata(file_path).await {
            Ok(meta) => {
                let size_mb = meta.len() as f64 / 1024.0 / 1024.0;
                let modified = meta
                    .modified()
                    .ok()
                    .map(|t| {
                        let age = std::time::SystemTime::now()
                            .duration_since(t)
                            .unwrap_or_default();
                        format!("{:.1}s ago", age.as_secs_f64())
                    })
                    .unwrap_or_else(|| "unknown".to_string());

                println!(
                    "{:<70} {:<15.2} {:<20}",
                    truncate_path(file_path, 68),
                    size_mb,
                    modified
                );

                // Check if file might still be open for writing
                if let Ok(mtime) = meta.modified() {
                    let age = std::time::SystemTime::now()
                        .duration_since(mtime)
                        .unwrap_or_default();
                    if age.as_secs() < 10 {
                        println!("  ^ WARNING: File modified very recently, may still be writing!");
                    }
                }
            }
            Err(e) => {
                println!(
                    "{:<70} {:<15} ERROR: {}",
                    truncate_path(file_path, 68),
                    "-",
                    e
                );
            }
        }
    }

    Ok(())
}

fn truncate_path(path: &str, max_len: usize) -> String {
    if path.len() <= max_len {
        path.to_string()
    } else {
        format!("...{}", &path[path.len() - max_len + 3..])
    }
}

fn truncate_str(s: &str, max_len: usize) -> String {
    if s.len() <= max_len {
        s.to_string()
    } else {
        format!("{}...", &s[..max_len - 3])
    }
}
