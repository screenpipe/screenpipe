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
use tracing::{debug, error, info, warn};

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

        // Keep at most 1 second queued. AEC needs a recent far-end reference,
        // but stale audio is worse than bypassing.
        const MAX_QUEUE_SAMPLES: usize = AEC_SAMPLE_RATE as usize;
        const MAX_MIC_WAIT_WITHOUT_SPEAKER_SAMPLES: usize = AEC_SAMPLE_RATE as usize / 10;

        if self.speaker_queue.len() > MAX_QUEUE_SAMPLES {
            let dropped_samples = self.speaker_queue.len() - MAX_QUEUE_SAMPLES;
            self.speaker_queue.drain(..dropped_samples);
            if let Some(ref mut ts) = self.speaker_start_timestamp_ms {
                *ts += (dropped_samples as f64 * 1000.0 / AEC_SAMPLE_RATE as f64) as u64;
            }
            self.dropped_count += (dropped_samples / FRAME_SIZE_10MS) as u64;
        }

        if self.mic_queue.is_empty() || self.mic_start_timestamp_ms.is_none() {
            self.bypass_mode = false;
            return output;
        }

        if self.mic_queue.len() > MAX_QUEUE_SAMPLES {
            let dropped_samples = self.mic_queue.len() - MAX_QUEUE_SAMPLES;
            self.mic_queue.drain(..dropped_samples);
            if let Some(ref mut ts) = self.mic_start_timestamp_ms {
                *ts += (dropped_samples as f64 * 1000.0 / AEC_SAMPLE_RATE as f64) as u64;
            }
            self.dropped_count += (dropped_samples / FRAME_SIZE_10MS) as u64;
        }

        if self.speaker_start_timestamp_ms.is_none() || self.speaker_queue.is_empty() {
            if self.mic_queue.len() < MAX_MIC_WAIT_WITHOUT_SPEAKER_SAMPLES {
                self.bypass_mode = false;
                return output;
            }

            // We have mic data but no speaker data yet.
            // Process mic frames in bypass mode (apply NS and AGC2) so we don't introduce lag.
            self.bypass_mode = true;
            while self.mic_queue.len() >= FRAME_SIZE_10MS {
                let mic_start = self.mic_start_timestamp_ms.unwrap();
                let mic_frame: Vec<f32> = self.mic_queue.drain(..FRAME_SIZE_10MS).collect();
                self.mic_start_timestamp_ms = Some(mic_start + 10);

                let mut cleaned_mic = vec![0.0; FRAME_SIZE_10MS];
                let silent_reference = vec![0.0; FRAME_SIZE_10MS];

                let _ = self.apm.process_render_f32(
                    &[&silent_reference],
                    &mut [&mut vec![0.0; FRAME_SIZE_10MS]],
                );
                let _ = self.apm.set_stream_delay_ms(0);
                if let Err(e) = self
                    .apm
                    .process_capture_f32(&[&mic_frame], &mut [&mut cleaned_mic])
                {
                    error!("AEC: Sonora process_capture error (bypass): {:?}", e);
                    cleaned_mic = mic_frame.clone();
                }

                self.processed_count += 1;
                self.bypass_count += 1;
                output.push((cleaned_mic, vec![0.0; FRAME_SIZE_10MS], mic_start));
            }
            return output;
        }

        while self.mic_queue.len() >= FRAME_SIZE_10MS {
            if self.speaker_queue.is_empty() {
                self.speaker_start_timestamp_ms = None;
                break;
            }

            let mic_start = self.mic_start_timestamp_ms.unwrap();
            let speaker_start = self.speaker_start_timestamp_ms.unwrap();

            let drift = mic_start as i64 - speaker_start as i64;

            // Alignment threshold: 10ms (160 samples)
            const ALIGN_THRESHOLD_MS: i64 = 10;

            if drift > ALIGN_THRESHOLD_MS {
                // Speaker is ahead of mic (speaker_start is older/earlier than mic_start).
                // We must drain the older speaker samples to align.
                let samples_to_drain =
                    (((drift as f64) * AEC_SAMPLE_RATE as f64) / 1000.0) as usize;
                let drain_amount = samples_to_drain.min(self.speaker_queue.len());
                if drain_amount > 0 {
                    self.speaker_queue.drain(..drain_amount);
                    let new_speaker_start = speaker_start
                        + ((drain_amount as f64 * 1000.0) / AEC_SAMPLE_RATE as f64) as u64;
                    self.speaker_start_timestamp_ms = Some(new_speaker_start);
                    self.dropped_count += (drain_amount / FRAME_SIZE_10MS) as u64;
                }

                if self.speaker_queue.is_empty() {
                    self.speaker_start_timestamp_ms = None;
                    break; // Wait for more speaker data
                }
                continue;
            } else if drift < -ALIGN_THRESHOLD_MS {
                // Mic is ahead of speaker (mic_start is older/earlier than speaker_start).
                // This means the speaker stream is newer. Preserve the far-end reference and
                // drop stale mic samples toward speaker time rather than resetting speaker AEC.
                let gap = -drift;
                let target_gap_ms = ALIGN_THRESHOLD_MS;
                let samples_to_drain =
                    (((gap - target_gap_ms) as f64 * AEC_SAMPLE_RATE as f64) / 1000.0) as usize;
                let drain_amount = samples_to_drain.min(self.mic_queue.len());

                if drain_amount > 0 {
                    self.mic_queue.drain(..drain_amount);
                    self.mic_start_timestamp_ms = Some(
                        mic_start
                            + ((drain_amount as f64 * 1000.0) / AEC_SAMPLE_RATE as f64) as u64,
                    );
                    self.dropped_count += (drain_amount / FRAME_SIZE_10MS) as u64;
                    if gap > 100 {
                        debug!(
                            "AEC: Large negative drift ({}ms). Dropped {} stale mic samples to preserve speaker reference.",
                            gap, drain_amount
                        );
                    }
                }

                if self.mic_queue.is_empty() {
                    break;
                }
                continue;
            }

            self.bypass_mode = false;

            let mic_frame: Vec<f32> = self.mic_queue.drain(..FRAME_SIZE_10MS).collect();
            let speaker_frame: Vec<f32> = if self.speaker_queue.len() >= FRAME_SIZE_10MS {
                self.speaker_queue.drain(..FRAME_SIZE_10MS).collect()
            } else {
                self.speaker_underflow_count += 1;
                let mut frame: Vec<f32> = self.speaker_queue.drain(..).collect();
                frame.resize(FRAME_SIZE_10MS, 0.0);
                debug_assert_eq!(frame.len(), FRAME_SIZE_10MS);
                self.speaker_start_timestamp_ms = None;
                frame
            };

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

        output
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
