#[cfg(target_os = "windows")]
#[cfg(test)]
mod tests {
    use chrono::Utc;
    use screenpipe_vision::capture_screenshot_by_window::{CapturedWindow, WindowFilters};
    use screenpipe_vision::core::RawCaptureResult;
    use screenpipe_vision::monitor::get_default_monitor;
    use screenpipe_vision::ocr_cache::WindowOcrCache;
    use screenpipe_vision::{process_ocr_task, OcrEngine};
    use std::sync::Arc;
    use std::{path::PathBuf, time::Duration as StdDuration, time::Instant};
    use tokio::sync::{mpsc, Mutex};

    use screenpipe_vision::{continuous_capture, PipelineMetrics};
    use std::time::Duration;
    use tokio::time::timeout;

    #[cfg(target_os = "windows")]
    #[tokio::test]
    async fn test_process_ocr_task_windows() {
        // Use an absolute path that works in both local and CI environments
        let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        path.push("tests");
        path.push("testing_OCR.png");
        println!("Path to testing_OCR.png: {:?}", path);
        let image = image::open(&path).expect("Failed to open image");

        let frame_number = 1;
        let timestamp = Instant::now();
        let ocr_engine = OcrEngine::WindowsNative;

        let window_images = vec![CapturedWindow {
            app_name: "test_app".to_string(),
            window_name: "test_window".to_string(),
            image: image.clone(),
            is_focused: true,
            process_id: 1234,
            browser_url: None,
            window_x: 0,
            window_y: 0,
            window_width: image.width(),
            window_height: image.height(),
        }];

        let raw = RawCaptureResult {
            image: std::sync::Arc::new(image.clone()),
            window_images,
            frame_number,
            timestamp,
            captured_at: Utc::now(),
        };

        let ocr_cache = Arc::new(Mutex::new(WindowOcrCache::new(
            StdDuration::from_secs(60),
            100,
        )));
        let result = process_ocr_task(&raw, &ocr_engine, &[], ocr_cache).await;

        assert!(result.is_ok());
        // Add more specific assertions based on expected behavior
    }

    #[tokio::test]
    #[ignore] // TODO require UI
    async fn test_continuous_capture() {
        // Create channels for communication
        let (result_tx, mut result_rx) = mpsc::channel::<RawCaptureResult>(10);

        // Create a mock monitor
        let monitor = get_default_monitor().await.expect("no monitor found").id();

        // Set up test parameters
        let interval = Duration::from_millis(1000);
        let save_text_files_flag = false;
        let window_filters = Arc::new(WindowFilters::new(&[], &[], &[]));

        // Spawn the continuous_capture function with corrected parameter order
        let metrics = Arc::new(PipelineMetrics::new());
        let capture_handle = tokio::spawn(continuous_capture(
            result_tx,
            interval,
            monitor,
            window_filters,
            save_text_files_flag,
            None, // activity_feed
            metrics,
        ));

        // Wait for a short duration to allow some captures to occur
        let timeout_duration = Duration::from_secs(5);
        let _result = timeout(timeout_duration, async {
            let mut capture_count = 0;
            while let Some(_capture_result) = result_rx.recv().await {
                capture_count += 1;
                // assert!(
                //     capture_result.image.width() == 100 && capture_result.image.height() == 100
                // );
                // println!(
                //     "capture_result: {:?}\n\n",
                //     capture_result.window_ocr_results.join("\n")
                // );
                if capture_count >= 3 {
                    break;
                }
            }
        })
        .await;

        // Stop the continuous_capture task
        capture_handle.abort();

        // Assert that we received some results without timing out
        // assert!(
        //     result.is_ok(),
        //     "Test timed out or failed to receive captures"
        // );
    }
}
