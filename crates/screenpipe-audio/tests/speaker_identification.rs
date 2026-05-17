mod tests {
    use log::LevelFilter;
    use screenpipe_audio::speaker::embedding::EmbeddingExtractor;
    use screenpipe_audio::speaker::embedding_manager::EmbeddingManager;
    use screenpipe_audio::speaker::segment::get_segments;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};

    /// Test that reproduces the speaker fragmentation bug.
    ///
    /// The bug: EmbeddingManager is cloned for each audio chunk processing,
    /// but Clone creates an independent copy. New speakers added to the clone
    /// are lost when the function returns, causing the same voice to get
    /// different speaker IDs across chunks.
    #[test]
    fn test_embedding_manager_clone_does_not_share_state() {
        let mut original = EmbeddingManager::new(100);

        // Create embeddings with different DIRECTIONS (cosine similarity measures angle)
        // embedding1: positive in first half, zero in second half
        let mut embedding1 = vec![0.0; 512];
        for val in &mut embedding1[..256] {
            *val = 1.0;
        }

        // embedding2: zero in first half, positive in second half (orthogonal to embedding1)
        let mut embedding2 = vec![0.0; 512];
        for val in &mut embedding2[256..] {
            *val = 1.0;
        }

        // Simulate: first audio chunk creates speaker 1
        let speaker1 = original.search_speaker(embedding1.clone(), 0.5);
        assert_eq!(speaker1, Some(1), "First speaker should be ID 1");

        // Simulate: what happens in the audio processing loop
        // Each call to process_audio_input gets a CLONE of embedding_manager
        let mut cloned = original.clone();

        // In the clone, add a new speaker (simulating a new voice detected)
        let speaker2_in_clone = cloned.search_speaker(embedding2.clone(), 0.5);
        assert_eq!(
            speaker2_in_clone,
            Some(2),
            "Second speaker should be ID 2 in clone"
        );

        // BUG: The original doesn't see the new speaker!
        // When cloned goes out of scope (function returns), speaker 2 is LOST

        // Next audio chunk gets another clone of original (not the modified clone)
        let mut another_clone = original.clone();

        // The same voice (embedding2) now gets a NEW ID because speaker 2 was never
        // added to original - it only existed in the first clone which was dropped
        let _speaker2_again = another_clone.search_speaker(embedding2.clone(), 0.5);

        // The real test: original should have both speakers if state was shared properly
        let speakers_in_original = original.get_all_speakers();

        // BUG DEMONSTRATION: original only has 1 speaker, not 2
        // This causes the 170+ "Unknown #X" speakers issue
        assert_eq!(
            speakers_in_original.len(),
            1,
            "BUG CONFIRMED: Original only has 1 speaker, clone's additions were lost"
        );

        // What we WANT is for original to have 2 speakers after the clones added one
        // This test documents the current buggy behavior
    }

    /// Test that shows what the CORRECT behavior should be with Arc<Mutex<>>
    #[test]
    fn test_embedding_manager_shared_state_with_arc_mutex() {
        use std::sync::{Arc, Mutex as StdMutex};

        let shared = Arc::new(StdMutex::new(EmbeddingManager::new(100)));

        // Create embeddings with different DIRECTIONS (cosine similarity measures angle)
        let mut embedding1 = vec![0.0; 512];
        for val in &mut embedding1[..256] {
            *val = 1.0;
        }

        let mut embedding2 = vec![0.0; 512];
        for val in &mut embedding2[256..] {
            *val = 1.0;
        }

        // Simulate: first audio chunk creates speaker 1
        {
            let mut manager = shared.lock().unwrap();
            let speaker1 = manager.search_speaker(embedding1.clone(), 0.5);
            assert_eq!(speaker1, Some(1));
        }

        // Simulate: second audio chunk (different "clone" but same Arc)
        {
            let mut manager = shared.lock().unwrap();
            let speaker2 = manager.search_speaker(embedding2.clone(), 0.5);
            assert_eq!(speaker2, Some(2));
        }

        // Simulate: third audio chunk - same voice as embedding2 should match
        {
            let mut manager = shared.lock().unwrap();
            let speaker2_again = manager.search_speaker(embedding2.clone(), 0.5);
            assert_eq!(
                speaker2_again,
                Some(2),
                "Same embedding should return same speaker"
            );
        }

        // Verify: shared state has both speakers
        let manager = shared.lock().unwrap();
        assert_eq!(
            manager.get_all_speakers().len(),
            2,
            "Shared manager should have both speakers"
        );
    }

    fn setup() {
        // Initialize the logger with an info level filter
        env_logger::builder()
            .filter_level(log::LevelFilter::Debug)
            .filter_module("tokenizers", LevelFilter::Error)
            .try_init()
            .unwrap();
    }

    #[tokio::test]
    #[ignore]
    async fn test_audio_speaker_identification() {
        setup();

        let project_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));

        let embedding_model_path = project_dir
            .join("models")
            .join("pyannote")
            .join("wespeaker_en_voxceleb_CAM++.onnx");

        let segmentation_model_path = project_dir
            .join("models")
            .join("pyannote")
            .join("segmentation-3.0.onnx");

        let embedding_extractor = Arc::new(Mutex::new(
            EmbeddingExtractor::new(
                embedding_model_path
                    .to_str()
                    .ok_or_else(|| anyhow::anyhow!("Invalid embedding model path"))
                    .unwrap(),
            )
            .unwrap(),
        ));
        let embedding_manager = Arc::new(Mutex::new(EmbeddingManager::new(usize::MAX)));

        let multiple_speakers_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("test_data/speaker_identification/6_speakers.wav");

        let (mut multiple_speakers_data, multiple_speakers_sample_rate) =
            screenpipe_audio::pcm_decode(&multiple_speakers_path)
                .expect("Failed to decode audio file");

        // reesample if not 16000
        if multiple_speakers_sample_rate != 16000 {
            multiple_speakers_data = screenpipe_audio::resample(
                &multiple_speakers_data,
                multiple_speakers_sample_rate,
                16000,
            )
            .unwrap();
        }

        let obama_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("test_data/speaker_identification/obama.wav");

        let (mut obama_data, obama_sample_rate) =
            screenpipe_audio::pcm_decode(&obama_path).expect("Failed to decode audio file");

        // reesample if not 16000
        if obama_sample_rate != 16000 {
            obama_data = screenpipe_audio::resample(&obama_data, obama_sample_rate, 16000).unwrap();
        }

        multiple_speakers_data.extend_from_slice(&obama_data);
        let multiple_speakers_segments = get_segments(
            &multiple_speakers_data,
            16000,
            &segmentation_model_path,
            embedding_extractor,
            embedding_manager.clone(),
        )
        .unwrap()
        .collect::<Vec<_>>();

        assert!(
            multiple_speakers_segments.len() >= 6,
            "diarization should preserve at least the expected speaker turns"
        );
        let mut speaker_counts = std::collections::HashMap::new();
        for segment in multiple_speakers_segments {
            let segment = segment.unwrap();
            assert!(segment.end > segment.start);
            assert!(!segment.embedding.is_empty());
            *speaker_counts.entry(segment.speaker).or_insert(0usize) += 1;
        }

        assert!(
            speaker_counts.len() >= 2,
            "diarization should identify more than one speaker"
        );
        assert!(
            speaker_counts.values().any(|count| *count >= 2),
            "at least one speaker should stay stable across multiple segments"
        );
    }
}
