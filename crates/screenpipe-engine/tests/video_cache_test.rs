use anyhow::Result;
use chrono::{Duration, Utc};
use screenpipe_core::paths;
use std::sync::Arc;
use tracing::{debug, error};

use screenpipe_db::DatabaseManager;
use screenpipe_engine::video_cache::FrameCache;

async fn setup_test_env() -> Result<(FrameCache, Arc<DatabaseManager>)> {
    // enabled tracing logging
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::DEBUG)
        .init();

    let screenpipe_dir = paths::default_screenpipe_data_dir().join("data");

    debug!("using real screenpipe data dir: {:?}", screenpipe_dir);

    let db = Arc::new(
        DatabaseManager::new(
            paths::default_screenpipe_data_dir()
                .join("db.sqlite")
                .to_str()
                .unwrap(),
            Default::default(),
        )
        .await
        .unwrap(),
    );

    let cache = FrameCache::new(screenpipe_dir, db.clone()).await?;
    Ok((cache, db))
}

#[tokio::test]
#[ignore]
async fn test_frame_jpeg_integrity() -> Result<()> {
    let (cache, _db) = setup_test_env().await?;

    // Get a frame from 5 minutes ago
    let target_time = Utc::now() - Duration::minutes(5);
    debug!("hi");

    let (tx, mut rx) = tokio::sync::mpsc::channel(100);
    cache.get_frames(target_time, 1, tx, true).await?;
    debug!("bye");

    let frame = rx.recv().await;

    if let Some(frame_data) = frame {
        // Read the frame data from the file
        debug!(
            "checking frame at {}, size: {} bytes",
            target_time,
            frame_data.frame_data[0].image_data.len()
        );

        // Check JPEG header (SOI marker)
        let has_jpeg_header = frame_data.frame_data[0]
            .image_data
            .starts_with(&[0xFF, 0xD8]);

        // Check JPEG footer (EOI marker)
        let has_jpeg_footer = frame_data.frame_data[0].image_data.ends_with(&[0xFF, 0xD9]);

        // Basic size sanity check (typical JPEG frame should be between 10KB and 1MB)
        let has_valid_size = frame_data.frame_data[0].image_data.len() > 10_000
            && frame_data.frame_data[0].image_data.len() < 1_000_000;

        if has_jpeg_header && has_jpeg_footer && has_valid_size {
            debug!("frame passed JPEG validation");
        } else {
            error!(
                "invalid JPEG frame: header={}, footer={}, size={}",
                has_jpeg_header,
                has_jpeg_footer,
                frame_data.frame_data[0].image_data.len()
            );

            // Log first and last few bytes for debugging
            if frame_data.frame_data[0].image_data.len() >= 4 {
                debug!(
                    "first 4 bytes: {:02X} {:02X} {:02X} {:02X}",
                    frame_data.frame_data[0].image_data[0],
                    frame_data.frame_data[0].image_data[1],
                    frame_data.frame_data[0].image_data[2],
                    frame_data.frame_data[0].image_data[3]
                );
            }
            if frame_data.frame_data[0].image_data.len() >= 4 {
                let len = frame_data.frame_data[0].image_data.len();
                debug!(
                    "last 4 bytes: {:02X} {:02X} {:02X} {:02X}",
                    frame_data.frame_data[0].image_data[len - 4],
                    frame_data.frame_data[0].image_data[len - 3],
                    frame_data.frame_data[0].image_data[len - 2],
                    frame_data.frame_data[0].image_data[len - 1]
                );
            }
        }

        // Assert frame validity
        assert!(has_jpeg_header, "Frame should have valid JPEG header");
        assert!(has_jpeg_footer, "Frame should have valid JPEG footer");
        assert!(
            has_valid_size,
            "Frame size should be within reasonable bounds"
        );
    } else {
        debug!("no frame found for timestamp {}", target_time);
    }

    Ok(())
}

async fn measure_frame_retrieval(
    cache: &FrameCache,
    time_ago: Duration,
    duration_minutes: i64,
) -> Result<(usize, f64)> {
    let start_time = Utc::now() - time_ago;
    let mut frames = Vec::new();

    let (tx, mut rx) = tokio::sync::mpsc::channel(100);

    let timer = std::time::Instant::now();
    cache
        .get_frames(start_time, duration_minutes, tx, true)
        .await?;

    // Collect frames with timeout
    let timeout = tokio::time::sleep(std::time::Duration::from_secs(30));
    tokio::pin!(timeout);

    loop {
        tokio::select! {
            frame = rx.recv() => {
                match frame {
                    Some(frame) => {
                        frames.push(frame);
                    },
                    None => break,
                }
            }
            _ = &mut timeout => {
                debug!("timeout reached after 30s");
                break;
            }
        }
    }

    let elapsed = timer.elapsed().as_secs_f64();
    Ok((frames.len(), elapsed))
}

#[tokio::test]
#[ignore]
async fn test_frame_retrieval_at_different_times() -> Result<()> {
    let (cache, _db) = setup_test_env().await?;

    // Give some time for initial cache setup and potential recording
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;

    // Test cases with different time ranges
    let test_cases = vec![
        ("current", Duration::zero()),
        ("5min ago", Duration::minutes(5)),
        ("30min ago", Duration::minutes(30)),
        ("4h ago", Duration::hours(4)),
        ("1 day ago", Duration::days(1)),
        ("2 days ago", Duration::days(2)),
        ("1 week ago", Duration::weeks(1)),
    ];

    println!("\nframe retrieval performance test results:");
    println!("----------------------------------------");
    println!("time range | frames | duration (s) | fps");
    println!("----------------------------------------");

    for (label, time_ago) in test_cases.clone() {
        let (frame_count, elapsed) = measure_frame_retrieval(&cache, time_ago, 1).await?;

        let fps = if elapsed > 0.0 {
            frame_count as f64 / elapsed
        } else {
            0.0
        };

        println!(
            "{:10} | {:6} | {:11.2} | {:6.1}",
            label, frame_count, elapsed, fps
        );

        // More lenient assertions - only verify timing for frames we actually got
        if frame_count > 0 {
            assert!(
                elapsed < 10.0,
                "Processing time for {} should be under 10s, got {}s",
                label,
                elapsed
            );
        } else {
            println!("warning: no frames found for {}", label);
        }
    }

    // Verify we got at least some frames from some time range
    let total_frames: usize = futures::future::join_all(
        test_cases
            .iter()
            .map(|(_, time_ago)| measure_frame_retrieval(&cache, *time_ago, 1)),
    )
    .await
    .into_iter()
    .filter_map(Result::ok)
    .map(|(count, _)| count)
    .sum();

    assert!(
        total_frames > 0,
        "Should find at least some frames across all time ranges"
    );

    Ok(())
}

#[tokio::test]
#[ignore]
async fn test_extended_time_range_retrieval() -> Result<()> {
    let (cache, _db) = setup_test_env().await?;

    // Test retrieving frames over longer durations
    let test_durations = vec![
        ("1min", 1),
        ("5min", 5),
        ("15min", 15),
        ("30min", 30),
        ("1hour", 60),
    ];

    println!("\nextended duration retrieval test results:");
    println!("----------------------------------------");
    println!("duration | frames | retrieval time (s) | fps");
    println!("----------------------------------------");

    for (label, minutes) in test_durations {
        let (frame_count, elapsed) =
            measure_frame_retrieval(&cache, Duration::minutes(minutes), minutes).await?;

        let fps = if elapsed > 0.0 {
            frame_count as f64 / elapsed
        } else {
            0.0
        };

        println!(
            "{:8} | {:6} | {:17.2} | {:6.1}",
            label, frame_count, elapsed, fps
        );

        // More realistic performance expectations:
        // - Allow up to 2 seconds per minute of footage
        // - But require at least some frames if we're looking at recent data
        if frame_count > 0 {
            assert!(
                elapsed < (minutes as f64 * 2.0),
                "Processing time for {} exceeded maximum allowed time",
                label
            );
        } else if minutes <= 5 {
            println!("warning: no frames found for recent timeframe {}", label);
        }
    }

    Ok(())
}

#[tokio::test]
#[ignore]
async fn test_frame_metadata_integrity() -> Result<()> {
    let (cache, _db) = setup_test_env().await?;

    // Get frames from last 5 minutes with a 1-minute duration window
    let target_time = Utc::now() - Duration::minutes(5);
    let (tx, mut rx) = tokio::sync::mpsc::channel(100);

    // Request frames with a 1-minute duration
    cache.get_frames(target_time, 2, tx, false).await?;

    let timeout = tokio::time::sleep(std::time::Duration::from_secs(50));
    tokio::pin!(timeout);

    println!("\nChecking frames for metadata:");
    println!("----------------------------");

    loop {
        tokio::select! {
            frame = rx.recv() => {
                match frame {
                    Some(frame) => {
                        println!("Frame at: {}", frame.timestamp);
                        println!("- data: {:?}", frame.frame_data);
                        println!("----------------------------");

                    },
                    None => {
                        println!("No more frames");
                        break;
                    }
                }
            }
            _ = &mut timeout => {
                println!("Timeout reached after 5s");
                break;
            }
        }
    }
    Ok(())
}

#[tokio::test]
#[ignore]
async fn test_basic_frame_retrieval() -> Result<()> {
    let (cache, _db) = setup_test_env().await?;

    // Get frames from last minute
    let target_time = Utc::now() - Duration::minutes(4);
    let (tx, mut rx) = tokio::sync::mpsc::channel(100);

    println!("\nbasic frame retrieval test:");
    println!("-------------------------");
    println!("target time: {}", target_time);

    // Request frames with a 2-minute window (1 min before and after target)
    cache.get_frames(target_time, 2, tx, true).await?;

    let mut frame_count = 0;
    let timeout = tokio::time::sleep(std::time::Duration::from_secs(60));
    tokio::pin!(timeout);

    loop {
        tokio::select! {
            frame = rx.recv() => {
                match frame {
                    Some(f) => {
                        println!("received frame at time: {}", f.timestamp);
                        frame_count += 1;
                    }
                    None => break,
                }
            }
            _ = &mut timeout => {
                println!("timeout waiting for frames!");
                break;
            }
        }
    }

    println!("total frames retrieved: {}", frame_count);
    if frame_count == 0 {
        println!("warning: no frames found - checking time ranges:");
    }

    Ok(())
}

#[tokio::test]
#[ignore]
async fn test_frame_ordering() -> Result<()> {
    let (cache, _db) = setup_test_env().await?;

    // Get frames from last 10 minutes to ensure we have enough samples
    let target_time = Utc::now() - Duration::minutes(5);
    let (tx, mut rx) = tokio::sync::mpsc::channel(100);

    println!("\nframe ordering test:");
    println!("------------------");
    println!("target time: {}", target_time);

    // Request frames with a 10-minute window
    cache.get_frames(target_time, 10, tx, true).await?;

    let mut frames = Vec::new();
    let timeout = tokio::time::sleep(std::time::Duration::from_secs(30));
    tokio::pin!(timeout);

    // Collect all frames
    loop {
        tokio::select! {
            frame = rx.recv() => {
                match frame {
                    Some(f) => {
                        frames.push(f);
                    }
                    None => break,
                }
            }
            _ = &mut timeout => {
                println!("timeout waiting for frames!");
                break;
            }
        }
    }

    println!("received {} frames", frames.len());

    // Verify ordering
    let mut is_ordered = true;
    let mut prev_timestamp = None;

    for (i, frame) in frames.iter().enumerate() {
        if let Some(prev) = prev_timestamp {
            if frame.timestamp > prev {
                is_ordered = false;
                println!(
                    "❌ ordering violation at index {}: {} > {} (should be descending)",
                    i, frame.timestamp, prev
                );
            }
        }
        prev_timestamp = Some(frame.timestamp);
    }

    assert!(
        is_ordered,
        "frames should be in descending order (newest first)"
    );

    // Print first few and last few timestamps to visualize the ordering
    println!("\nfirst 3 frames (should be newest):");
    for frame in frames.iter().take(3) {
        println!("  {}", frame.timestamp);
    }

    if frames.len() > 3 {
        println!("\nlast 3 frames (should be oldest):");
        for frame in frames.iter().rev().take(3) {
            println!("  {}", frame.timestamp);
        }
    }

    Ok(())
}

#[tokio::test]
#[ignore]
async fn test_cache_effectiveness() -> Result<()> {
    let (cache, _db) = setup_test_env().await?;

    println!("\ncache effectiveness test:");
    println!("-----------------------");

    // First request - should process and cache frames
    let target_time = Utc::now() - Duration::minutes(5);
    let (tx1, mut rx1) = tokio::sync::mpsc::channel(100);

    println!("first request - should process and cache frames");
    let start = std::time::Instant::now();
    cache.get_frames(target_time, 2, tx1, true).await?;

    let mut first_request_frames = Vec::new();
    while let Some(frame) = rx1.recv().await {
        first_request_frames.push(frame);
    }
    let first_request_time = start.elapsed();

    println!(
        "first request: {} frames in {:.2}s",
        first_request_frames.len(),
        first_request_time.as_secs_f64()
    );

    // Wait a moment to ensure async operations complete
    tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;

    // Second request - should use cached frames
    let (tx2, mut rx2) = tokio::sync::mpsc::channel(100);

    println!("\nsecond request - should use cached frames");
    let start = std::time::Instant::now();
    cache.get_frames(target_time, 2, tx2, true).await?;

    let mut second_request_frames = Vec::new();
    while let Some(frame) = rx2.recv().await {
        second_request_frames.push(frame);
    }
    let second_request_time = start.elapsed();

    println!(
        "second request: {} frames in {:.2}s",
        second_request_frames.len(),
        second_request_time.as_secs_f64()
    );

    // Verify cache effectiveness
    assert_eq!(
        first_request_frames.len(),
        second_request_frames.len(),
        "both requests should return the same number of frames"
    );

    // Second request should be significantly faster (at least 2x)
    assert!(
        second_request_time < first_request_time / 2,
        "cached request should be at least 2x faster: first={:.2}s, second={:.2}s",
        first_request_time.as_secs_f64(),
        second_request_time.as_secs_f64()
    );

    // Verify frame data integrity between requests
    for (i, (first, second)) in first_request_frames
        .iter()
        .zip(second_request_frames.iter())
        .enumerate()
    {
        assert_eq!(
            first.timestamp, second.timestamp,
            "frame {} timestamps should match",
            i
        );

        for (first_device, second_device) in first.frame_data.iter().zip(second.frame_data.iter()) {
            assert_eq!(
                first_device.device_id, second_device.device_id,
                "frame {} device IDs should match",
                i
            );
            assert_eq!(
                first_device.image_data, second_device.image_data,
                "frame {} image data should match",
                i
            );
        }
    }

    println!("\ncache effectiveness metrics:");
    println!(
        "- first request time:  {:.2}s",
        first_request_time.as_secs_f64()
    );
    println!(
        "- second request time: {:.2}s",
        second_request_time.as_secs_f64()
    );
    println!(
        "- speedup factor:      {:.2}x",
        first_request_time.as_secs_f64() / second_request_time.as_secs_f64()
    );
    println!("- frames processed:    {}", first_request_frames.len());

    Ok(())
}

#[tokio::test]
#[ignore]
async fn test_cache_cleanup() -> Result<()> {
    let (cache, _db) = setup_test_env().await?;

    println!("\ncache cleanup test:");
    println!("-----------------");

    // First, populate cache with some frames
    let target_time = Utc::now() - Duration::minutes(5);
    let (tx1, mut rx1) = tokio::sync::mpsc::channel(100);

    println!("populating cache with initial frames...");
    cache.get_frames(target_time, 10, tx1, true).await?;

    let mut initial_frames = Vec::new();
    while let Some(frame) = rx1.recv().await {
        initial_frames.push(frame);
    }

    println!("initial cache population: {} frames", initial_frames.len());

    // Wait for cleanup interval (we'll use a shorter interval for testing)
    println!("waiting for cleanup cycle...");
    tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;

    // Request frames again to verify cache state
    let (tx2, mut rx2) = tokio::sync::mpsc::channel(100);
    cache.get_frames(target_time, 10, tx2, true).await?;

    let mut post_cleanup_frames = Vec::new();
    while let Some(frame) = rx2.recv().await {
        post_cleanup_frames.push(frame);
    }

    println!("post-cleanup frames: {}", post_cleanup_frames.len());

    // Verify that frames within retention period are still present
    let retained_frames = post_cleanup_frames
        .iter()
        .filter(|frame| {
            let age = Utc::now() - frame.timestamp;
            age.num_days() < 7 // default retention period
        })
        .count();

    println!("\ncleanup metrics:");
    println!("- initial frames:      {}", initial_frames.len());
    println!("- post-cleanup frames: {}", post_cleanup_frames.len());
    println!("- retained frames:     {}", retained_frames);

    // Assert that frames within retention period are kept
    assert!(
        retained_frames > 0,
        "should retain frames within retention period"
    );

    // Verify that very old frames are removed
    let old_frames = post_cleanup_frames
        .iter()
        .filter(|frame| {
            let age = Utc::now() - frame.timestamp;
            age.num_days() > 7
        })
        .count();

    assert_eq!(
        old_frames, 0,
        "should not have frames older than retention period"
    );

    Ok(())
}
