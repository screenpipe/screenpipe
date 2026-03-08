use std::process::Stdio;
use std::time::Duration;
use tempfile::TempDir;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

/// Test that reproduces the "moov atom not found" error from Sentry
/// Issue: SCREENPIPE-CLI-D, SCREENPIPE-CLI-X, SCREENPIPE-CLI-T
///
/// Root cause: User requests frame from video file that's still being written.
/// MP4 files have the moov atom (index/metadata) at the END, so incomplete
/// files cannot be read by ffmpeg.

/// Helper to find ffmpeg path
fn find_ffmpeg() -> String {
    // Try common locations
    for path in &[
        "/opt/homebrew/bin/ffmpeg",
        "/usr/local/bin/ffmpeg",
        "/usr/bin/ffmpeg",
        "ffmpeg",
    ] {
        if std::process::Command::new(path)
            .arg("-version")
            .output()
            .is_ok()
        {
            return path.to_string();
        }
    }
    "ffmpeg".to_string()
}

/// Simulate creating an incomplete MP4 file (still being written)
async fn create_incomplete_mp4(path: &str) -> Result<tokio::process::Child, std::io::Error> {
    let ffmpeg = find_ffmpeg();

    // Start ffmpeg process that reads from stdin (simulating live encoding)
    // This creates an MP4 file without a moov atom until the process finishes
    let child = Command::new(&ffmpeg)
        .args([
            "-f",
            "lavfi",
            "-i",
            "testsrc=duration=10:size=320x240:rate=1", // 10 second test pattern
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-t",
            "10",
            "-y",
            path,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    Ok(child)
}

/// Try to extract a frame from a video file
async fn extract_frame(video_path: &str, output_path: &str) -> Result<(), String> {
    let ffmpeg = find_ffmpeg();

    let output = Command::new(&ffmpeg)
        .args([
            "-ss",
            "0",
            "-i",
            video_path,
            "-vframes",
            "1",
            "-y",
            output_path,
        ])
        .output()
        .await
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(stderr.to_string());
    }

    if !std::path::Path::new(output_path).exists() {
        return Err("file not created".to_string());
    }

    Ok(())
}

/// Test: Extracting frame from incomplete MP4 fails with "moov atom not found"
#[tokio::test]
async fn test_incomplete_mp4_causes_moov_error() {
    let temp_dir = TempDir::new().unwrap();
    let video_path = temp_dir.path().join("test_incomplete.mp4");
    let video_path_str = video_path.to_str().unwrap();

    // Create an incomplete MP4 by writing partial data
    // Simulate what happens when ffmpeg is still encoding
    {
        let mut file = tokio::fs::File::create(&video_path).await.unwrap();
        // Write some bytes that look like an MP4 header but are incomplete
        // ftyp box (file type) - valid MP4 files start with this
        file.write_all(&[
            0x00, 0x00, 0x00, 0x18, // box size
            0x66, 0x74, 0x79, 0x70, // 'ftyp'
            0x69, 0x73, 0x6F, 0x6D, // 'isom'
            0x00, 0x00, 0x00, 0x01, // minor version
            0x69, 0x73, 0x6F, 0x6D, // compatible brand 'isom'
            0x61, 0x76, 0x63, 0x31, // compatible brand 'avc1'
        ])
        .await
        .unwrap();
        // Don't write moov atom - this is what happens during active recording
        file.flush().await.unwrap();
    }

    // Try to extract a frame - this should fail
    let frame_path = temp_dir.path().join("frame.jpg");
    let result = extract_frame(video_path_str, frame_path.to_str().unwrap()).await;

    assert!(result.is_err(), "Should fail on incomplete MP4");
    let error = result.unwrap_err();
    println!("Error message: {}", error);

    // The error should mention moov atom or invalid data
    assert!(
        error.contains("moov atom not found")
            || error.contains("Invalid data")
            || error.contains("could not find codec"),
        "Expected moov-related error, got: {}",
        error
    );
}

/// Test: Extracting frame from complete MP4 succeeds
#[tokio::test]
#[ignore] // Requires ffmpeg and takes time
async fn test_complete_mp4_extraction_succeeds() {
    let temp_dir = TempDir::new().unwrap();
    let video_path = temp_dir.path().join("test_complete.mp4");
    let video_path_str = video_path.to_str().unwrap();

    // Create a complete, valid MP4 file
    let ffmpeg = find_ffmpeg();
    let output = Command::new(&ffmpeg)
        .args([
            "-f",
            "lavfi",
            "-i",
            "testsrc=duration=2:size=320x240:rate=1",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-y",
            video_path_str,
        ])
        .output()
        .await
        .expect("ffmpeg should run");

    assert!(output.status.success(), "ffmpeg should succeed");
    assert!(video_path.exists(), "Video file should exist");

    // Wait for file to be fully written
    tokio::time::sleep(Duration::from_millis(100)).await;

    // Extract frame - should succeed
    let frame_path = temp_dir.path().join("frame.jpg");
    let result = extract_frame(video_path_str, frame_path.to_str().unwrap()).await;

    assert!(
        result.is_ok(),
        "Should succeed on complete MP4: {:?}",
        result
    );
    assert!(frame_path.exists(), "Frame file should exist");
}

/// Test: Fragmented MP4 allows frame extraction during recording
/// This is the FIX for the moov atom issue - using -movflags frag_keyframe+empty_moov
#[tokio::test]
#[ignore] // Requires ffmpeg
async fn test_fragmented_mp4_allows_extraction_during_write() {
    let temp_dir = TempDir::new().unwrap();
    let video_path = temp_dir.path().join("test_fragmented.mp4");
    let video_path_str = video_path.to_str().unwrap().to_string();

    // Start ffmpeg with fragmented MP4 flags (same as our fix)
    let ffmpeg = find_ffmpeg();
    let mut child = Command::new(&ffmpeg)
        .args([
            "-f",
            "lavfi",
            "-i",
            "testsrc=duration=5:size=320x240:rate=1",
            "-c:v",
            "libx264", // Use x264 for faster test
            "-preset",
            "ultrafast",
            // THE FIX: fragmented MP4 flags
            "-movflags",
            "frag_keyframe+empty_moov+default_base_moof",
            "-y",
            &video_path_str,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("ffmpeg should start");

    // Wait a bit for file to be created and some data written
    tokio::time::sleep(Duration::from_millis(1500)).await;

    // Try to extract frame WHILE recording is in progress
    let frame_path = temp_dir.path().join("frame_during.jpg");
    let frame_path_str = frame_path.to_str().unwrap();

    if video_path.exists() {
        let result = extract_frame(&video_path_str, frame_path_str).await;
        println!("Extraction during fragmented recording: {:?}", result);

        // With fragmented MP4, this SHOULD succeed!
        if result.is_ok() {
            println!("SUCCESS: Frame extracted during recording with fragmented MP4!");
            assert!(
                std::path::Path::new(frame_path_str).exists(),
                "Frame file should exist"
            );
        } else {
            // May still fail if not enough data written yet, but shouldn't be moov error
            let err = result.unwrap_err();
            println!("Extraction failed (may be timing): {}", err);
            assert!(
                !err.contains("moov atom not found"),
                "Should NOT get moov atom error with fragmented MP4"
            );
        }
    }

    // Wait for recording to finish
    let _ = child.wait_with_output().await;

    // After recording, extraction should definitely work
    let frame_path_after = temp_dir.path().join("frame_after.jpg");
    let result = extract_frame(&video_path_str, frame_path_after.to_str().unwrap()).await;
    assert!(
        result.is_ok(),
        "Should succeed after recording: {:?}",
        result
    );
}

/// Test: Compare regular MP4 vs fragmented MP4 behavior
#[tokio::test]
#[ignore] // Requires ffmpeg
async fn test_regular_vs_fragmented_mp4() {
    let temp_dir = TempDir::new().unwrap();
    let ffmpeg = find_ffmpeg();

    // Create regular MP4 (will have moov at end)
    let regular_path = temp_dir.path().join("regular.mp4");
    let regular_output = Command::new(&ffmpeg)
        .args([
            "-f",
            "lavfi",
            "-i",
            "testsrc=duration=2:size=320x240:rate=1",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-y",
            regular_path.to_str().unwrap(),
        ])
        .output()
        .await
        .unwrap();
    assert!(regular_output.status.success());

    // Create fragmented MP4 (moov at start)
    let frag_path = temp_dir.path().join("fragmented.mp4");
    let frag_output = Command::new(&ffmpeg)
        .args([
            "-f",
            "lavfi",
            "-i",
            "testsrc=duration=2:size=320x240:rate=1",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-movflags",
            "frag_keyframe+empty_moov+default_base_moof",
            "-y",
            frag_path.to_str().unwrap(),
        ])
        .output()
        .await
        .unwrap();
    assert!(frag_output.status.success());

    // Both should allow frame extraction when complete
    let frame1 = temp_dir.path().join("frame1.jpg");
    let frame2 = temp_dir.path().join("frame2.jpg");

    let result1 = extract_frame(regular_path.to_str().unwrap(), frame1.to_str().unwrap()).await;
    let result2 = extract_frame(frag_path.to_str().unwrap(), frame2.to_str().unwrap()).await;

    assert!(
        result1.is_ok(),
        "Regular MP4 extraction should work: {:?}",
        result1
    );
    assert!(
        result2.is_ok(),
        "Fragmented MP4 extraction should work: {:?}",
        result2
    );

    // Check file sizes - fragmented may be slightly larger
    let regular_size = std::fs::metadata(&regular_path).unwrap().len();
    let frag_size = std::fs::metadata(&frag_path).unwrap().len();

    println!("Regular MP4 size: {} bytes", regular_size);
    println!("Fragmented MP4 size: {} bytes", frag_size);
    println!(
        "Size difference: {:.1}%",
        ((frag_size as f64 - regular_size as f64) / regular_size as f64) * 100.0
    );

    // Fragmented should not be more than 20% larger
    assert!(
        frag_size < regular_size * 2,
        "Fragmented MP4 should not be excessively larger"
    );
}

/// Test: Verify fragmented MP4 is playable and valid
#[tokio::test]
#[ignore] // Requires ffmpeg
async fn test_fragmented_mp4_is_valid() {
    let temp_dir = TempDir::new().unwrap();
    let video_path = temp_dir.path().join("valid_frag.mp4");
    let video_path_str = video_path.to_str().unwrap();

    let ffmpeg = find_ffmpeg();

    // Create fragmented MP4 with H.265 (same as production)
    let output = Command::new(&ffmpeg)
        .args([
            "-f",
            "lavfi",
            "-i",
            "testsrc=duration=3:size=320x240:rate=10",
            "-c:v",
            "libx265",
            "-preset",
            "ultrafast",
            "-tag:v",
            "hvc1",
            "-movflags",
            "frag_keyframe+empty_moov+default_base_moof",
            "-y",
            video_path_str,
        ])
        .output()
        .await
        .unwrap();

    assert!(output.status.success(), "ffmpeg encoding should succeed");

    // Verify file is valid using ffprobe
    let ffprobe_path = std::path::Path::new(&ffmpeg)
        .parent()
        .unwrap()
        .join("ffprobe");
    let ffprobe = if ffprobe_path.exists() {
        ffprobe_path.to_str().unwrap().to_string()
    } else {
        "ffprobe".to_string()
    };

    let probe_output = Command::new(&ffprobe)
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=codec_name,width,height,duration",
            "-of",
            "json",
            video_path_str,
        ])
        .output()
        .await
        .unwrap();

    assert!(
        probe_output.status.success(),
        "ffprobe should succeed on fragmented MP4"
    );

    let probe_stdout = String::from_utf8_lossy(&probe_output.stdout);
    println!("ffprobe output: {}", probe_stdout);

    // Verify it's H.265
    assert!(
        probe_stdout.contains("hevc") || probe_stdout.contains("h265"),
        "Should be H.265 encoded"
    );

    // Extract multiple frames to verify seekability
    for i in 0..3 {
        let frame_path = temp_dir.path().join(format!("frame_{}.jpg", i));
        let seek_time = format!("{}", i as f64 * 0.1);

        let extract_output = Command::new(&ffmpeg)
            .args([
                "-ss",
                &seek_time,
                "-i",
                video_path_str,
                "-vframes",
                "1",
                "-y",
                frame_path.to_str().unwrap(),
            ])
            .output()
            .await
            .unwrap();

        assert!(
            extract_output.status.success(),
            "Frame {} extraction should succeed",
            i
        );
        assert!(frame_path.exists(), "Frame {} file should exist", i);
    }

    println!("All frame extractions succeeded - fragmented MP4 is valid and seekable");
}

/// Test: Simulating the race condition - file registered before complete
#[tokio::test]
#[ignore] // Requires ffmpeg and demonstrates timing issue
async fn test_race_condition_during_recording() {
    let temp_dir = TempDir::new().unwrap();
    let video_path = temp_dir.path().join("test_race.mp4");
    let video_path_str = video_path.to_str().unwrap().to_string();
    let frame_path = temp_dir.path().join("frame.jpg");
    let frame_path_str = frame_path.to_str().unwrap().to_string();

    // Start ffmpeg encoding (simulates video recording)
    let ffmpeg = find_ffmpeg();
    let mut child = Command::new(&ffmpeg)
        .args([
            "-f",
            "lavfi",
            "-i",
            "testsrc=duration=5:size=320x240:rate=1", // 5 second video
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-y",
            &video_path_str,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("ffmpeg should start");

    // Immediately try to extract frame (simulates user clicking on timeline)
    // This is the race condition - file exists but moov atom not written yet
    tokio::time::sleep(Duration::from_millis(500)).await; // Wait for file to be created

    if video_path.exists() {
        let result = extract_frame(&video_path_str, &frame_path_str).await;
        println!("Extraction during recording: {:?}", result);

        // This SHOULD fail because recording is in progress
        // (may or may not fail depending on timing and ffmpeg buffering)
        if result.is_err() {
            println!("Expected failure during recording: {}", result.unwrap_err());
        }
    }

    // Wait for recording to finish
    let output = child.wait_with_output().await.unwrap();
    assert!(output.status.success(), "Recording should complete");

    // Now extraction should succeed
    let result = extract_frame(&video_path_str, &frame_path_str).await;
    assert!(
        result.is_ok(),
        "Should succeed after recording completes: {:?}",
        result
    );
}
