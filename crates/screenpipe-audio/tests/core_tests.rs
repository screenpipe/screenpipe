#[cfg(test)]
mod tests {
    use anyhow::anyhow;
    use chrono::Utc;
    use log::{debug, LevelFilter};
    use screenpipe_audio::core::device::{
        default_input_device, default_output_device, list_audio_devices, parse_audio_device,
    };
    use screenpipe_audio::core::engine::AudioTranscriptionEngine;
    use screenpipe_audio::core::record_and_transcribe;
    use screenpipe_audio::core::stream::AudioStream;
    use screenpipe_audio::speaker::embedding::EmbeddingExtractor;
    use screenpipe_audio::speaker::embedding_manager::EmbeddingManager;
    use screenpipe_audio::speaker::prepare_segments;
    use screenpipe_audio::transcription::whisper::model::{
        create_whisper_context_parameters, download_whisper_model,
    };
    use screenpipe_audio::vad::{silero::SileroVad, VadEngine};
    use screenpipe_audio::{pcm_decode, stt, AudioInput};
    use screenpipe_core::Language;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::str::FromStr;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};
    use tokio::sync::Mutex;
    use whisper_rs::WhisperContext;

    fn setup() {
        // Initialize the logger with an info level filter
        if env_logger::builder()
            .filter_level(log::LevelFilter::Debug)
            .filter_module("tokenizers", LevelFilter::Error)
            .try_init()
            .is_ok()
        {};
    }

    // ! what happen in github action?
    #[tokio::test]
    #[ignore]
    async fn test_list_audio_devices() {
        let devices = list_audio_devices().await.unwrap();
        assert!(!devices.is_empty());
    }

    #[test]
    fn test_parse_audio_device() {
        let spec = parse_audio_device("Test Device (input)").unwrap();
        assert_eq!(spec.to_string(), "Test Device (input)");
    }

    #[tokio::test]
    #[ignore] // Add this if you want to skip this test in regular test runs
    async fn test_record_and_transcribe() {
        setup();

        // Setup
        let device_spec = Arc::new(default_output_device().await.unwrap());
        let duration = Duration::from_secs(30); // Record for 3 seconds
        let time = Utc::now().timestamp_millis();
        let output_path = PathBuf::from(format!("test_output_{}.mp4", time));
        let (sender, receiver) = crossbeam::channel::bounded(100);
        let is_running = Arc::new(AtomicBool::new(true));
        let is_running_clone = Arc::clone(&is_running);

        let audio_stream = AudioStream::from_device(device_spec, is_running_clone)
            .await
            .unwrap();

        // Act
        let start_time = Instant::now();
        println!("Starting record_and_transcribe");
        let result = record_and_transcribe(
            Arc::new(audio_stream),
            duration,
            Arc::new(sender),
            is_running,
            Arc::new(screenpipe_audio::metrics::AudioPipelineMetrics::new()),
        )
        .await;
        println!("record_and_transcribe completed");
        let elapsed_time = start_time.elapsed();

        // Assert
        assert!(result.is_ok(), "record_and_transcribe should succeed");

        // Check if the recording duration is close to the specified duration
        assert!(
            elapsed_time >= duration && elapsed_time < duration + Duration::from_secs(3),
            "Recording duration should be close to the specified duration"
        );

        // Check if the file was created
        assert!(output_path.exists(), "Output file should exist");

        // Check if we received the correct AudioInput
        let audio_input = receiver.try_recv().unwrap();
        assert_eq!(audio_input.data.len(), 0);
        println!("Audio input: {:?}", audio_input);

        // Verify file format (you might need to install the `infer` crate for this)
        let kind = infer::get_from_path(&output_path).unwrap().unwrap();
        assert_eq!(
            kind.mime_type(),
            "audio/mpeg",
            "File should be in mp3 format"
        );

        // Clean up
        std::fs::remove_file(output_path).unwrap();
    }

    #[tokio::test]
    #[ignore]
    async fn test_record_and_transcribe_interrupt_before_end() {
        setup();

        // Setup
        let device_spec = Arc::new(default_output_device().await.unwrap());
        let duration = Duration::from_secs(30);
        let time = Utc::now().timestamp_millis();
        let output_path = PathBuf::from(format!("test_output_interrupt_{}.mp4", time));
        let (sender, receiver) = crossbeam::channel::bounded(100);
        let is_running = Arc::new(AtomicBool::new(true));
        let is_running_clone = Arc::clone(&is_running);

        let audio_stream = AudioStream::from_device(device_spec, is_running_clone.clone())
            .await
            .unwrap();

        // interrupt in 10 seconds
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(10)).await;
            is_running_clone.store(false, Ordering::Relaxed);
        });

        // Act
        let start_time = Instant::now();

        record_and_transcribe(
            Arc::new(audio_stream),
            duration,
            Arc::new(sender),
            is_running,
            Arc::new(screenpipe_audio::metrics::AudioPipelineMetrics::new()),
        )
        .await
        .unwrap();

        let elapsed_time = start_time.elapsed();

        println!("Elapsed time: {:?}", elapsed_time);
        // Assert
        assert!(
            elapsed_time < duration,
            "Recording should have been interrupted before the full duration"
        );
        assert!(
            elapsed_time >= Duration::from_secs(3),
            "Recording should have lasted at least 3 seconds"
        );

        // Check if the file was created
        assert!(output_path.exists(), "Output file should exist");

        // Check if we received the correct AudioInput
        let audio_input = receiver.try_recv().unwrap();
        assert_eq!(audio_input.data.len(), 0);

        // Verify file format
        let kind = infer::get_from_path(&output_path).unwrap().unwrap();
        assert_eq!(
            kind.mime_type(),
            "audio/mpeg",
            "File should be in mp3 format"
        );

        // Verify file duration
        let file_duration = get_audio_duration(&output_path).unwrap();
        assert!(
            file_duration >= Duration::from_secs(3) && file_duration < duration,
            "File duration should be between 3 seconds and the full duration"
        );

        // Clean up
        std::fs::remove_file(output_path).unwrap();
    }

    // Helper function to get audio duration (you'll need to implement this)
    fn get_audio_duration(path: &Path) -> Result<Duration, Box<dyn std::error::Error>> {
        let output = Command::new("ffprobe")
            .args([
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                path.to_str().unwrap(),
            ])
            .output()?;

        let duration_str = String::from_utf8(output.stdout)?;
        let duration_secs = f64::from_str(duration_str.trim())?;

        Ok(Duration::from_secs_f64(duration_secs))
    }

    #[tokio::test]
    #[ignore]
    async fn test_audio_transcription_language() {
        setup();
        use std::sync::Arc;

        let engine = Arc::new(AudioTranscriptionEngine::WhisperLargeV3TurboQuantized);

        // Setup
        let context_params = create_whisper_context_parameters(engine.clone()).unwrap();

        let quantized_path = download_whisper_model(engine).unwrap();
        let whisper_context = Arc::new(
            WhisperContext::new_with_params(&quantized_path.to_string_lossy(), context_params)
                .expect("failed to load model"),
        );

        let vad_engine: Arc<tokio::sync::Mutex<Box<dyn VadEngine + Send>>> = Arc::new(
            tokio::sync::Mutex::new(Box::new(SileroVad::new().await.unwrap())),
        );
        let audio_data = screenpipe_audio::pcm_decode("test_data/Arifi.wav")
            .expect("Failed to decode audio file");

        let audio_input = AudioInput {
            data: Arc::new(audio_data.0),
            sample_rate: 44100, // hardcoded based on test data sample rate
            channels: 1,
            device: Arc::new(default_input_device().unwrap()),
            capture_timestamp: 0,
        };

        // Create the missing parameters
        let project_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let segmentation_model_path = project_dir
            .join("models")
            .join("pyannote")
            .join("segmentation-3.0.onnx");
        let embedding_model_path = project_dir
            .join("models")
            .join("pyannote")
            .join("wespeaker_en_voxceleb_CAM++.onnx");

        let embedding_extractor = Arc::new(std::sync::Mutex::new(
            EmbeddingExtractor::new(
                embedding_model_path
                    .to_str()
                    .ok_or_else(|| anyhow!("Invalid embedding model path"))
                    .unwrap(),
            )
            .unwrap(),
        ));
        let embedding_manager = Arc::new(std::sync::Mutex::new(EmbeddingManager::new(usize::MAX)));

        let (mut segments, _, _) = prepare_segments(
            &audio_input.data,
            vad_engine.clone(),
            &segmentation_model_path,
            embedding_manager,
            embedding_extractor,
            &audio_input.device.to_string(),
        )
        .await
        .unwrap();

        let mut whisper_state = whisper_context
            .create_state()
            .expect("failed to create whisper state");

        let mut transcription_result = String::new();
        while let Some(segment) = segments.recv().await {
            let transcript = stt(
                &segment.samples,
                audio_input.sample_rate,
                &audio_input.device.to_string(),
                Arc::new(AudioTranscriptionEngine::WhisperLargeV3Turbo),
                None,
                vec![Language::Arabic],
                &mut whisper_state,
            )
            .await
            .unwrap();

            transcription_result.push_str(&transcript);
            transcription_result.push('\n');
        }

        debug!("Received transcription: {:?}", transcription_result);
        // Check if we received a valid transcription
        assert!(!transcription_result.is_empty(), "Transcription is empty");

        println!("Received transcription: {}", transcription_result);

        assert!(
            transcription_result.contains("موسيقى")
                || transcription_result.contains("تعال")
                || transcription_result.contains("الحيوانات")
        );
    }

    #[tokio::test]
    #[ignore]
    async fn test_stt_speed() {
        setup();

        // Load a sample audio file for testing
        let audio_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("test_data")
            .join("selah.mp4");
        let audio_data = pcm_decode(&audio_path).expect("Failed to decode audio file");

        // Create AudioInput from the audio data
        let audio_input = AudioInput {
            data: Arc::new(audio_data.0),
            sample_rate: 16000, // Adjust this based on your test audio
            channels: 1,
            device: Arc::new(default_output_device().await.unwrap()),
            capture_timestamp: 0,
        };

        let project_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let segmentation_model_path = project_dir
            .join("models")
            .join("pyannote")
            .join("segmentation-3.0.onnx");
        let embedding_model_path = project_dir
            .join("models")
            .join("pyannote")
            .join("wespeaker_en_voxceleb_CAM++.onnx");

        let embedding_extractor = Arc::new(std::sync::Mutex::new(
            EmbeddingExtractor::new(
                embedding_model_path
                    .to_str()
                    .ok_or_else(|| anyhow!("Invalid embedding model path"))
                    .unwrap(),
            )
            .unwrap(),
        ));

        let embedding_manager = Arc::new(std::sync::Mutex::new(EmbeddingManager::new(usize::MAX)));

        let engine = Arc::new(AudioTranscriptionEngine::WhisperLargeV3TurboQuantized);

        // Setup
        let context_params = create_whisper_context_parameters(engine.clone()).unwrap();

        let quantized_path = download_whisper_model(engine).unwrap();
        let whisper_context = Arc::new(
            WhisperContext::new_with_params(&quantized_path.to_string_lossy(), context_params)
                .expect("failed to load model"),
        );

        // Initialize VAD engine
        let vad_engine: Box<dyn VadEngine + Send> = Box::new(SileroVad::new().await.unwrap());
        let vad_engine = Arc::new(Mutex::new(vad_engine));

        // Measure transcription time
        let start_time = Instant::now();

        let (mut segments, _, _) = prepare_segments(
            &audio_input.data,
            vad_engine.clone(),
            &segmentation_model_path,
            embedding_manager,
            embedding_extractor,
            &audio_input.device.to_string(),
        )
        .await
        .unwrap();

        let mut whisper_state = whisper_context
            .create_state()
            .expect("failed to create whisper state");

        let mut transcription = String::new();
        while let Some(segment) = segments.recv().await {
            let transcript = stt(
                &segment.samples,
                audio_input.sample_rate,
                &audio_input.device.to_string(),
                Arc::new(AudioTranscriptionEngine::WhisperLargeV3Turbo),
                None,
                vec![Language::English],
                &mut whisper_state,
            )
            .await
            .unwrap();

            transcription.push_str(&transcript);
        }

        let elapsed_time = start_time.elapsed();

        debug!("Transcription completed in {:?}", elapsed_time);
    }
}
