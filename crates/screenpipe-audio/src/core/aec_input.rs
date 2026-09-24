// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use super::aec::AEC_SAMPLE_RATE;
use anyhow::Result;
use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};

/// AEC-only resampling with one capture-clock anchor per continuous stream.
/// Compensate the sinc delay and drain its tail, so differing source rates do
/// not shift render/capture alignment or truncate the end of a recording.
pub(crate) struct AecInput {
    rate: u32,
    resampler: Option<SincFixedIn<f32>>,
    pending: Vec<f32>,
    delay_remaining: usize,
    start_ms: Option<u64>,
    received: u64,
    emitted: u64,
}
impl AecInput {
    pub fn new(rate: u32) -> Result<Self> {
        anyhow::ensure!(rate > 0, "AEC input sample rate must be nonzero");
        let resampler = if rate == AEC_SAMPLE_RATE {
            None
        } else {
            Some(SincFixedIn::new(
                AEC_SAMPLE_RATE as f64 / rate as f64,
                2.0,
                SincInterpolationParameters {
                    sinc_len: 256,
                    f_cutoff: 0.95,
                    interpolation: SincInterpolationType::Linear,
                    oversampling_factor: 256,
                    window: WindowFunction::BlackmanHarris2,
                },
                (rate as usize / 100).max(64),
                1,
            )?)
        };
        let delay_remaining = resampler.as_ref().map_or(0, |r| r.output_delay());
        Ok(Self {
            rate,
            resampler,
            pending: Vec::new(),
            delay_remaining,
            start_ms: None,
            received: 0,
            emitted: 0,
        })
    }
    pub fn rate(&self) -> u32 {
        self.rate
    }
    pub fn discontinuity(&self, timestamp: u64) -> bool {
        self.start_ms.is_some_and(|start| {
            (start + self.received * 1000 / self.rate as u64).abs_diff(timestamp) > 100
        })
    }
    pub fn push(&mut self, samples: &[f32], timestamp: u64) -> Result<(Vec<f32>, u64)> {
        self.start_ms.get_or_insert(timestamp);
        self.received += samples.len() as u64;
        if self.resampler.is_none() {
            return Ok(self.output(samples.to_vec()));
        }
        self.pending.extend_from_slice(samples);
        let mut output = Vec::new();
        let r = self.resampler.as_mut().unwrap();
        let size = r.input_frames_next();
        let mut consumed = 0;
        while self.pending.len() - consumed >= size {
            output.extend(
                r.process(&[&self.pending[consumed..consumed + size]], None)?
                    .remove(0),
            );
            consumed += size;
        }
        self.pending.drain(..consumed);
        Ok(self.output(output))
    }
    fn output(&mut self, mut samples: Vec<f32>) -> (Vec<f32>, u64) {
        let skip = self.delay_remaining.min(samples.len());
        samples.drain(..skip);
        self.delay_remaining -= skip;
        let stamp = self.start_ms.unwrap_or(0) + self.emitted * 1000 / AEC_SAMPLE_RATE as u64;
        self.emitted += samples.len() as u64;
        (samples, stamp)
    }
    pub fn finish(&mut self) -> Result<(Vec<f32>, u64)> {
        let target = self.received * AEC_SAMPLE_RATE as u64 / self.rate as u64;
        let remaining = target.saturating_sub(self.emitted) as usize;
        let mut output = Vec::new();
        if let Some(r) = self.resampler.as_mut() {
            // At most one partial input block plus the finite sinc filter delay.
            let pending = std::mem::take(&mut self.pending);
            if !pending.is_empty() {
                output.extend(r.process_partial(Some(&[&pending]), None)?.remove(0));
            }
            while output.len() < remaining + self.delay_remaining {
                output.extend(r.process_partial::<&[f32]>(None, None)?.remove(0));
            }
        }
        let (mut samples, stamp) = self.output(output);
        let extra = samples.len().saturating_sub(remaining);
        samples.truncate(remaining);
        self.emitted -= extra as u64;
        Ok((samples, stamp))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn aec_resampling_preserves_duration_and_tail_at_device_rates() {
        for rate in [8000, 16000, 44100, 48000, 96000] {
            for size in [1, 133, rate as usize + 137] {
                let mut input = AecInput::new(rate).unwrap();
                let mut count = 0;
                for start in (0..size).step_by(137) {
                    let len = 137.min(size - start);
                    let (audio, stamp) = input
                        .push(&vec![0.2; len], 1000 + start as u64 * 1000 / rate as u64)
                        .unwrap();
                    assert_eq!(stamp, 1000 + count as u64 * 1000 / 16000);
                    count += audio.len();
                }
                count += input.finish().unwrap().0.len();
                assert_eq!(
                    count,
                    size * 16000 / rate as usize,
                    "rate {rate}, size {size}"
                );
                assert!(input.finish().unwrap().0.is_empty());
            }
        }
    }
    #[test]
    fn aec_native_rate_is_bit_exact_and_detects_gaps() {
        let mut input = AecInput::new(16000).unwrap();
        let samples: Vec<_> = (0..160).map(|i| i as f32 / 160.0).collect();
        assert_eq!(input.push(&samples, 1000).unwrap(), (samples, 1000));
        assert!(!input.discontinuity(1010));
        assert!(input.discontinuity(1400));
    }
}
