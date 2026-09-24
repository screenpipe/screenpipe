// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
use sonora::{
    config::{
        AdaptiveDigital, EchoCanceller, FixedDigital, GainController2, HighPassFilter,
        NoiseSuppression, NoiseSuppressionLevel,
    },
    AudioProcessing, Config, StreamConfig,
};
use std::collections::VecDeque;
use tracing::{error, info, warn};

pub const AEC_SAMPLE_RATE: u32 = 16000;
pub const FRAME_SIZE_10MS: usize = 160; // 10ms at 16kHz

#[derive(Debug, Clone)]
pub struct AecDiagnostics {
    pub drift_ms: f64,
    pub mic_buffer_depth_ms: f64,
    pub speaker_buffer_depth_ms: f64,
    pub bypass_active: bool,
    pub processed_frames: u64,
    pub aligned_frames: u64,
    pub bypass_frames: u64,
    pub speaker_underflow_frames: u64,
    pub dropped_frames: u64,
}

pub struct SonoraAecProcessor {
    apm: AudioProcessing,
    mic_queue: VecDeque<f32>,
    speaker_queue: VecDeque<f32>,
    mic_start_timestamp_ms: Option<u64>,
    speaker_start_timestamp_ms: Option<u64>,
    processed_count: u64,
    aligned_count: u64,
    bypass_count: u64,
    speaker_underflow_count: u64,
    dropped_count: u64,
    bypass_mode: bool,
    pub estimated_delay_ms: i32,
}

impl SonoraAecProcessor {
    pub fn new() -> Self {
        let stream_config = StreamConfig::new(AEC_SAMPLE_RATE, 1); // Mono
        let config = Config {
            high_pass_filter: Some(HighPassFilter {
                apply_in_full_band: true,
            }),
            echo_canceller: Some(EchoCanceller {
                enforce_high_pass_filtering: true,
                transparent_mode: sonora::config::TransparentModeType::Hmm,
            }),
            noise_suppression: Some(NoiseSuppression {
                level: NoiseSuppressionLevel::VeryHigh,
                analyze_linear_aec_output_when_available: true,
            }),
            gain_controller2: Some(GainController2 {
                input_volume_controller: false,
                adaptive_digital: Some(AdaptiveDigital::default()),
                fixed_digital: FixedDigital::default(),
            }),
            ..Default::default()
        };

        let apm = AudioProcessing::builder()
            .config(config)
            .capture_config(stream_config)
            .render_config(stream_config)
            .build();

        info!("AEC: Sonora WebRTC AEC3 initialized with aggressive VeryHigh Noise Suppression and AGC2");

        Self {
            apm,
            mic_queue: VecDeque::new(),
            speaker_queue: VecDeque::new(),
            mic_start_timestamp_ms: None,
            speaker_start_timestamp_ms: None,
            processed_count: 0,
            aligned_count: 0,
            bypass_count: 0,
            speaker_underflow_count: 0,
            dropped_count: 0,
            bypass_mode: false,
            estimated_delay_ms: 60, // 60ms default delay hint for desktop audio
        }
    }

    /// Reset internal state, queues, and APM filters
    pub fn reset(&mut self) {
        self.mic_queue.clear();
        self.speaker_queue.clear();
        self.mic_start_timestamp_ms = None;
        self.speaker_start_timestamp_ms = None;
        self.processed_count = 0;
        self.aligned_count = 0;
        self.bypass_count = 0;
        self.speaker_underflow_count = 0;
        self.dropped_count = 0;
        self.bypass_mode = false;
        self.estimated_delay_ms = 60;
        // Sonora APM reset
        let stream_config = StreamConfig::new(AEC_SAMPLE_RATE, 1);
        let config = Config {
            high_pass_filter: Some(HighPassFilter {
                apply_in_full_band: true,
            }),
            echo_canceller: Some(EchoCanceller {
                enforce_high_pass_filtering: true,
                transparent_mode: sonora::config::TransparentModeType::Hmm,
            }),
            noise_suppression: Some(NoiseSuppression {
                level: NoiseSuppressionLevel::VeryHigh,
                analyze_linear_aec_output_when_available: true,
            }),
            gain_controller2: Some(GainController2 {
                input_volume_controller: false,
                adaptive_digital: Some(AdaptiveDigital::default()),
                fixed_digital: FixedDigital::default(),
            }),
            ..Default::default()
        };
        self.apm = AudioProcessing::builder()
            .config(config)
            .capture_config(stream_config)
            .render_config(stream_config)
            .build();
        warn!("AEC: Sonora processor reset completed");
    }

    /// Push microphone samples with their capture timestamp
    pub fn push_mic(&mut self, samples: &[f32], timestamp_ms: u64) {
        if self.mic_queue.is_empty() {
            self.mic_start_timestamp_ms = Some(timestamp_ms);
        }
        self.mic_queue.extend(samples);
    }

    /// Push speaker loopback samples with their capture timestamp
    pub fn push_speaker(&mut self, samples: &[f32], timestamp_ms: u64) {
        if self.speaker_queue.is_empty() {
            self.speaker_start_timestamp_ms = Some(timestamp_ms);
        }
        self.speaker_queue.extend(samples);
    }

    /// Process and align available audio frames.
    /// Returns a vector of synchronized tuples: (cleaned_mic_frame, original_speaker_frame, timestamp_ms)
    pub fn process(&mut self) -> Vec<(Vec<f32>, Vec<f32>, u64)> {
        let mut output = Vec::new();

        // Keep a bounded 200ms microphone look-behind for async delivery jitter.
        // An alignment/budget decision must never discard microphone samples.
        const MAX_WAIT_SAMPLES: usize = AEC_SAMPLE_RATE as usize / 5;
        while self.mic_queue.len() >= FRAME_SIZE_10MS {
            let mic_start = self.mic_start_timestamp_ms.unwrap();
            if self.speaker_queue.len() < FRAME_SIZE_10MS {
                if self.mic_queue.len() <= MAX_WAIT_SAMPLES {
                    break;
                }
                self.speaker_underflow_count += 1;
                output.push(self.bypass_frame(FRAME_SIZE_10MS));
                continue;
            }
            let speaker_start = self.speaker_start_timestamp_ms.unwrap();
            let drift = mic_start as i64 - speaker_start as i64;
            if drift > 10 {
                // Feed older render frames into AEC history: they may contain
                // precisely the speech that is now echoing in the microphone.
                let speaker: Vec<_> = self.speaker_queue.drain(..FRAME_SIZE_10MS).collect();
                let mut scratch = [0.0; FRAME_SIZE_10MS];
                let _ = self
                    .apm
                    .process_render_f32(&[&speaker], &mut [&mut scratch]);
                self.speaker_start_timestamp_ms = Some(speaker_start + 10);
                continue;
            } else if drift < -10 {
                // Reference starts later than capture. Preserve earlier speech
                // unchanged until timestamps overlap, without AGC boosting echo.
                output.push(self.bypass_frame(FRAME_SIZE_10MS));
                continue;
            }

            self.bypass_mode = false;

            let mic_frame: Vec<f32> = self.mic_queue.drain(..FRAME_SIZE_10MS).collect();
            let speaker_frame: Vec<f32> = self.speaker_queue.drain(..FRAME_SIZE_10MS).collect();

            // Update start timestamps
            self.mic_start_timestamp_ms = Some(mic_start + 10);
            self.speaker_start_timestamp_ms = Some(speaker_start + 10);

            let mut cleaned_mic = vec![0.0; FRAME_SIZE_10MS];
            let mut render_out = vec![0.0; FRAME_SIZE_10MS];

            // 1. Process Render (Speaker)
            if let Err(e) = self
                .apm
                .process_render_f32(&[&speaker_frame], &mut [&mut render_out])
            {
                error!("AEC: Sonora process_render error: {:?}", e);
            }

            // Explicitly set the estimated stream delay before processing capture
            if let Err(e) = self.apm.set_stream_delay_ms(self.estimated_delay_ms) {
                error!("AEC: Failed to set stream delay: {:?}", e);
            }

            // 2. Process Capture (Mic)
            if let Err(e) = self
                .apm
                .process_capture_f32(&[&mic_frame], &mut [&mut cleaned_mic])
            {
                error!("AEC: Sonora process_capture error: {:?}", e);
                cleaned_mic = mic_frame.clone(); // Fallback to raw mic
            }

            self.processed_count += 1;
            self.aligned_count += 1;
            output.push((cleaned_mic, speaker_frame, mic_start));
        }

        // With no microphone, bound render-only history. Never trim a matched
        // burst before processing it or microphone audio would lose its reference.
        let excess = self
            .speaker_queue
            .len()
            .saturating_sub(AEC_SAMPLE_RATE as usize);
        let excess = excess / FRAME_SIZE_10MS * FRAME_SIZE_10MS;
        if excess > 0 {
            self.speaker_queue.drain(..excess);
            if let Some(ts) = &mut self.speaker_start_timestamp_ms {
                *ts += (excess / FRAME_SIZE_10MS * 10) as u64;
            }
            self.dropped_count += (excess / FRAME_SIZE_10MS) as u64;
        }
        output
    }

    fn bypass_frame(&mut self, len: usize) -> (Vec<f32>, Vec<f32>, u64) {
        let timestamp = self.mic_start_timestamp_ms.unwrap();
        let mic = self.mic_queue.drain(..len).collect();
        self.mic_start_timestamp_ms =
            Some(timestamp + (len as u64 * 1000 / AEC_SAMPLE_RATE as u64));
        self.processed_count += 1;
        self.bypass_count += 1;
        self.bypass_mode = true;
        (mic, vec![0.0; len], timestamp)
    }

    /// Drain the bounded wait and partial frame when capture ends. Calling this
    /// twice is safe. Missing reference means raw audio, never fabricated silence.
    pub fn finish(&mut self) -> Vec<(Vec<f32>, Vec<f32>, u64)> {
        let mut output = self.process();
        while !self.mic_queue.is_empty() {
            output.push(self.bypass_frame(self.mic_queue.len().min(FRAME_SIZE_10MS)));
        }
        output
    }

    /// A changed or lagged render stream cannot share the old filter history.
    /// Preserve pending microphone audio for alignment against the new reference.
    pub fn reset_reference(&mut self) {
        let mic = std::mem::take(&mut self.mic_queue);
        let timestamp = self.mic_start_timestamp_ms;
        let counts = (
            self.processed_count,
            self.aligned_count,
            self.bypass_count,
            self.speaker_underflow_count,
            self.dropped_count,
        );
        self.reset();
        self.mic_queue = mic;
        self.mic_start_timestamp_ms = timestamp;
        (
            self.processed_count,
            self.aligned_count,
            self.bypass_count,
            self.speaker_underflow_count,
            self.dropped_count,
        ) = counts;
    }

    /// Retrieve diagnostic metrics of the AEC stage
    pub fn diagnostics(&self) -> AecDiagnostics {
        let drift = match (self.mic_start_timestamp_ms, self.speaker_start_timestamp_ms) {
            (Some(m), Some(s)) => m as f64 - s as f64,
            _ => 0.0,
        };

        AecDiagnostics {
            drift_ms: drift,
            mic_buffer_depth_ms: (self.mic_queue.len() as f64 * 1000.0) / AEC_SAMPLE_RATE as f64,
            speaker_buffer_depth_ms: (self.speaker_queue.len() as f64 * 1000.0)
                / AEC_SAMPLE_RATE as f64,
            bypass_active: self.bypass_mode,
            processed_frames: self.processed_count,
            aligned_frames: self.aligned_count,
            bypass_frames: self.bypass_count,
            speaker_underflow_frames: self.speaker_underflow_count,
            dropped_frames: self.dropped_count,
        }
    }
}

impl Default for SonoraAecProcessor {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod regression_tests {
    use super::*;
    #[test]
    fn capture_burst_is_preserved_while_waiting_for_reference() {
        let mut p = SonoraAecProcessor::new();
        let mic = vec![0.1; 1600];
        p.push_mic(&mic, 1000);
        assert!(
            p.process().is_empty(),
            "100ms delivery jitter must wait for reference"
        );
        p.push_speaker(&vec![0.2; 1600], 1000);
        let output = p.process();
        assert_eq!(output.iter().map(|f| f.0.len()).sum::<usize>(), mic.len());
        assert_eq!(p.diagnostics().bypass_frames, 0);
    }
    #[test]
    fn long_aligned_burst_never_discards_microphone_samples() {
        let mut p = SonoraAecProcessor::new();
        p.push_mic(&vec![0.1; 24000], 1000);
        p.push_speaker(&vec![0.2; 24000], 1000);
        assert_eq!(p.process().iter().map(|f| f.0.len()).sum::<usize>(), 24000);
    }
    #[test]
    fn future_reference_preserves_earlier_microphone_audio() {
        let mut p = SonoraAecProcessor::new();
        p.push_mic(&vec![0.1; 8000], 1000);
        p.push_speaker(&vec![0.2; 160], 1500);
        assert_eq!(p.process().iter().map(|f| f.0.len()).sum::<usize>(), 8000);
    }
    #[test]
    fn missing_reference_and_shutdown_preserve_every_sample_unchanged() {
        let mut p = SonoraAecProcessor::new();
        let expected: Vec<_> = (0..12347).map(|i| (i as f32 * 0.13).sin() * 0.2).collect();
        let mut output = Vec::new();
        for (n, chunk) in expected.chunks(137).enumerate() {
            p.push_mic(chunk, 1000 + n as u64 * 137 * 1000 / 16000);
            output.extend(p.process().into_iter().flat_map(|f| f.0));
            assert!(p.diagnostics().mic_buffer_depth_ms <= 210.0);
        }
        output.extend(p.finish().into_iter().flat_map(|f| f.0));
        assert_eq!(output, expected);
        assert!(p.finish().is_empty());
    }
    #[test]
    fn reference_reset_retains_pending_microphone_tail() {
        let mut p = SonoraAecProcessor::new();
        p.push_mic(&[0.125; 177], 1000);
        p.reset_reference();
        let out = p.finish();
        assert_eq!(
            out.iter().flat_map(|f| f.0.clone()).collect::<Vec<_>>(),
            vec![0.125; 177]
        );
        assert_eq!(out[0].2, 1000);
        assert_eq!(p.diagnostics().dropped_frames, 0);
    }
    #[test]
    fn microphone_first_jitter_does_not_bypass_any_frames() {
        let mut p = SonoraAecProcessor::new();
        let mut count = 0;
        for tick in 0..30 {
            p.push_mic(&[0.05; 1600], 1000 + tick * 100);
            count += p.process().iter().map(|f| f.0.len()).sum::<usize>();
            p.push_speaker(&[0.02; 1600], 1000 + tick * 100);
            count += p.process().iter().map(|f| f.0.len()).sum::<usize>();
        }
        assert_eq!(count, 48000);
        assert_eq!(p.diagnostics().bypass_frames, 0);
        assert_eq!(p.diagnostics().dropped_frames, 0);
    }
}
