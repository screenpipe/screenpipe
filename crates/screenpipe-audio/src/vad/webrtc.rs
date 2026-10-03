// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use anyhow;
use vad_rs::VadStatus;

use super::VadEngine;

pub struct WebRtcVad {
    vad: webrtc_vad::Vad,
}

impl WebRtcVad {
    pub fn new() -> Self {
        let vad = webrtc_vad::Vad::new_with_rate(webrtc_vad::SampleRate::Rate16kHz);
        Self { vad }
    }
}
impl Default for WebRtcVad {
    fn default() -> Self {
        Self::new()
    }
}
impl VadEngine for WebRtcVad {
    fn frame_size(&self) -> usize {
        // WebRTC accepts 10, 20 or 30 ms frames, not Silero's 32 ms window.
        480
    }

    fn is_voice_segment(&mut self, audio_chunk: &[f32]) -> anyhow::Result<bool> {
        // Convert f32 to i16
        let i16_chunk: Vec<i16> = audio_chunk.iter().map(|&x| (x * 32767.0) as i16).collect();

        self.vad.set_mode(webrtc_vad::VadMode::Aggressive);

        let result = self
            .vad
            .is_voice_segment(&i16_chunk)
            .map_err(|e| anyhow::anyhow!("WebRTC VAD error: {:?}", e))?;

        Ok(result)
    }
    fn audio_type(&mut self, audio_chunk: &[f32]) -> anyhow::Result<VadStatus> {
        // Convert f32 to i16
        let i16_chunk: Vec<i16> = audio_chunk.iter().map(|&x| (x * 32767.0) as i16).collect();

        self.vad.set_mode(webrtc_vad::VadMode::Aggressive);

        let result = self
            .vad
            .is_voice_segment(&i16_chunk)
            .map_err(|e| anyhow::anyhow!("WebRTC VAD error: {:?}", e))?;

        if !result {
            return Ok(VadStatus::Silence);
        }

        Ok(VadStatus::Speech)
    }

    fn set_speech_threshold(&mut self, _threshold: Option<f32>) {
        // WebRTC VAD uses mode-based sensitivity, not probability thresholds.
        // No-op — only affects Silero VAD.
    }
}
