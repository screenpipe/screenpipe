// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpi.pe

use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::{anyhow, Result};
use tokio::sync::broadcast;
use tracing::{debug, error, info, warn};

use crate::{
    core::{device::DeviceType, update_device_capture_time},
    meeting_streaming::{MeetingAudioFrame, MeetingAudioTap},
    metrics::AudioPipelineMetrics,
    utils::audio::StreamResampler,
    AudioInput,
};

use super::aec::SonoraAecProcessor;
use super::source_buffer::SourceBuffer;
use super::AudioStream;

/// Timeout for receiving audio data before considering the stream dead.
///
/// 8 seconds is the chosen balance:
///   - long enough to absorb normal hiccups (Bluetooth packet loss bursts,
///     OS resource pressure, brief context switches)
///   - short enough to detect genuine stalls quickly (another app
///     hijacking the mic mid-session — e.g. Wispr Flow, FaceTime — or
///     a CoreAudio internal failure)
///
/// Previously 30s, but that meant ~30s of lost audio per recovery event
/// AND noisy WARN logs that looked alarming. With the proactive
/// stream-rebuild on screen unlock (below), the timeout becomes a
/// safety-net for the rare cases that don't correlate with lock/wake
/// transitions, so we can afford to be more aggressive.
///
/// Per-platform notes on output devices (handled separately in
/// recv_audio_chunk):
///   - macOS ScreenCaptureKit: now treats silence as non-fatal — SCK
///     observed to stop firing callbacks during prolonged idle on
///     Sequoia 24.3+, contrary to earlier "continuous callbacks"
///     assumption.
///   - Windows WASAPI loopback: silent = no callbacks (always was).
const AUDIO_RECEIVE_TIMEOUT_SECS: u64 = 8;

/// Grace period after stream start before treating timeouts as fatal.
/// ScreenCaptureKit may take a moment to begin delivering callbacks.
const STREAM_STARTUP_GRACE_SECS: u64 = 10;

/// Maximum tolerated duration of zero-fill input buffers before declaring
/// the stream functionally dead.
///
/// Bug class this catches: macOS CoreAudio (and similar HALs on other
/// platforms) can deliver zero-filled buffers to a non-priority client
/// when another app exclusively claims an input device. Most reproducible
/// with Bluetooth mics — e.g. AirPods during a videoconference call: the
/// AudioUnit render callback keeps firing on the expected schedule, so
/// the existing AUDIO_RECEIVE_TIMEOUT_SECS watchdog stays happy, but the
/// buffer contents are exact zeros — no thermal noise, no ADC quantization
/// noise, no signal at all.
///
/// Real microphones never produce sustained exact-zero output; the
/// preamp + ADC noise floor is always above SILENT_BUFFER_PEAK_THRESHOLD.
/// 30 s is conservative enough to absorb any legitimate transient (a
/// short software-mute, a buffering hiccup) while still recovering well
/// before a typical lost-audio incident becomes minutes long.
///
/// Recovery path is identical to AUDIO_RECEIVE_TIMEOUT_SECS: tear down,
/// let device_monitor rebuild a fresh stream.
const INPUT_SILENT_BUFFER_TIMEOUT_SECS: u64 = 30;

/// Threshold below which a buffer is treated as functionally silent.
/// CoreAudio zero-fill produces exact 0.0; any real input source — even
/// a muted-by-hand AirPods mic — sits well above this floor.
const SILENT_BUFFER_PEAK_THRESHOLD: f32 = 1e-6;
const RECORDER_OUTPUT_CHANNELS: u16 = 1;

/// Why a recording session's OS audio stream stopped delivering usable data.
///
/// Carried as the `anyhow` cause (not just a message) so higher layers — e.g.
/// the per-device VPIO runtime-fallback policy in `DeviceManager` — can react to
/// the *kind* of death by `downcast_ref` instead of matching message text. The
/// `Display` output is byte-for-byte the previous string so logs and any
/// existing log-greps are unchanged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamDeath {
    /// No data callbacks at all for `secs` — the OS stream is dead. Covers a
    /// CoreAudio/VPIO stall and a VPIO stream that was created ("AEC
    /// initialized") but never delivered a single sample.
    ReceiveTimeout { secs: u64 },
    /// Callbacks kept firing but delivered only exact-zero buffers for `secs` —
    /// suspected hijack by another process holding the device. NOT a VPIO fault
    /// (HAL would be zero-filled too), so it must not trigger VPIO fallback.
    ZeroFill { device: String, secs: u64 },
}

impl std::fmt::Display for StreamDeath {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StreamDeath::ReceiveTimeout { secs } => write!(
                f,
                "Audio stream timeout - no data received for {secs}s (stream dead)"
            ),
            StreamDeath::ZeroFill { device, secs } => write!(
                f,
                "Audio stream zero-fill — no usable data from {device} for {secs}s \
                 (suspected device hijack by another process)"
            ),
        }
    }
}

impl std::error::Error for StreamDeath {}

#[inline]
fn is_silent_buffer(chunk: &[f32]) -> bool {
    !chunk.is_empty() && chunk.iter().all(|s| s.abs() < SILENT_BUFFER_PEAK_THRESHOLD)
}

#[cfg(target_os = "windows")]
fn zero_fill_reconnect_enabled_for_platform() -> bool {
    // WASAPI input devices, especially built-in Intel/Realtek microphone
    // arrays, can emit exact-zero buffers during ordinary quiet periods.
    // Treating that as fatal causes reconnect churn and creates avoidable
    // capture gaps. A real dead Windows stream is still caught by the
    // receive-timeout path when callbacks stop arriving.
    false
}

#[cfg(not(target_os = "windows"))]
fn zero_fill_reconnect_enabled_for_platform() -> bool {
    true
}

fn should_reconnect_after_silent_input(
    device_type: &DeviceType,
    stream_elapsed: Duration,
    last_non_zero_elapsed: Duration,
) -> bool {
    if *device_type != DeviceType::Input {
        return false;
    }

    if stream_elapsed.as_secs() < STREAM_STARTUP_GRACE_SECS {
        return false;
    }

    if last_non_zero_elapsed.as_secs() < INPUT_SILENT_BUFFER_TIMEOUT_SECS {
        return false;
    }

    zero_fill_reconnect_enabled_for_platform()
}

fn meeting_frame_from_recorder_output(
    samples: Vec<f32>,
    audio_stream: &AudioStream,
    captured_at_unix_ms: u64,
) -> MeetingAudioFrame {
    MeetingAudioFrame::new(
        Arc::new(samples),
        &audio_stream.device,
        audio_stream.device_config.sample_rate().0,
        RECORDER_OUTPUT_CHANNELS,
        captured_at_unix_ms,
    )
}

/// Recording always uses 30s segments. Both batch and realtime modes record identically.
/// The batch vs realtime distinction is in the processing layer (manager.rs):
/// - Realtime: transcribe immediately after each segment
/// - Batch: persist to disk, defer transcription until meeting ends
pub async fn run_record_and_transcribe(
    audio_stream: Arc<AudioStream>,
    duration: Duration,
    whisper_sender: Arc<crossbeam::channel::Sender<AudioInput>>,
    is_running: Arc<AtomicBool>,
    metrics: Arc<AudioPipelineMetrics>,
    live_audio_tap: Option<MeetingAudioTap>,
    device_manager: Option<Arc<crate::device::device_manager::DeviceManager>>,
    screenpipe_aec_enabled: bool,
) -> Result<()> {
    let device_name = audio_stream.device.to_string();
    let is_input = audio_stream.device.device_type == DeviceType::Input;

    if is_input && screenpipe_aec_enabled {
        // Microphone Always-On AEC / NS / AGC Stage
        let mut receiver = audio_stream.subscribe().await;
        let mic_sample_rate = audio_stream.device_config.sample_rate().0;

        let mut mic_resampler = StreamResampler::new(mic_sample_rate, 16000)?;
        let mut aec_processor = SonoraAecProcessor::new();

        let mut speaker_receiver: Option<broadcast::Receiver<Vec<f32>>> = None;
        let mut speaker_resampler: Option<StreamResampler> = None;

        let mut mic_sample_counter: u64 = 0;
        let mut speaker_sample_counter: u64 = 0;

        let mic_start_time = now_epoch_millis();
        let mut speaker_start_time: Option<u64> = None;

        const TARGET_SAMPLE_RATE: u32 = 16000;
        const OVERLAP_SECONDS: usize = 2;
        let overlap_samples = OVERLAP_SECONDS * TARGET_SAMPLE_RATE as usize;

        info!(
            "AEC: Starting always-on software audio cleaning (AEC3 + NS + AGC2) for mic {} at 16kHz",
            device_name
        );

        let audio_samples_len = TARGET_SAMPLE_RATE as usize * duration.as_secs() as usize;
        let max_samples = audio_samples_len + overlap_samples;
        let mut collected_audio = Vec::new();
        let mut segment_start_time = now_epoch_secs();
        let mut last_diagnostics_time = Instant::now();
        let mut _last_non_zero_at: Option<Instant> = None;
        let mut _sck_watchdog = crate::core::sck_output_watchdog::SckOutputWatchdog::default();

        let mut was_paused_for_lock = false;

        while is_running.load(Ordering::Relaxed)
            && !audio_stream.is_disconnected.load(Ordering::Relaxed)
        {
            // Skip recording while the screen is locked
            if screenpipe_config::should_pause_audio_for_lock() {
                if !was_paused_for_lock {
                    info!("screen locked, pausing audio recording for {}", device_name);
                    was_paused_for_lock = true;
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            }

            if was_paused_for_lock {
                info!(
                    "screen unlocked — rebuilding stream for {} (avoids zombie-callback state)",
                    device_name
                );
                return Err(anyhow!(
                    "stream rebuild required after screen unlock for {} (recovery is automatic)",
                    device_name
                ));
            }

            // Dynamic subscription to default speaker stream
            if speaker_receiver.is_none() {
                if let Some(ref dm) = device_manager {
                    if let Ok(default_output) = crate::core::device::default_output_device().await {
                        if let Some(stream) = dm.stream(&default_output) {
                            speaker_receiver = Some(stream.subscribe().await);
                            let speaker_rate = stream.device_config.sample_rate().0;
                            speaker_resampler = Some(StreamResampler::new(speaker_rate, 16000)?);
                            speaker_start_time = Some(now_epoch_millis());
                            info!(
                                "AEC: Dynamically subscribed to speaker stream: {} ({} Hz) for reference",
                                default_output, speaker_rate
                            );
                        }
                    }
                }
            }

            while collected_audio.len() < max_samples && is_running.load(Ordering::Relaxed) {
                tokio::select! {
                    // Receive mic chunk
                    mic_res = receiver.recv() => {
                        match mic_res {
                            Ok(chunk) => {
                                metrics.update_audio_levels(&device_name, &chunk);
                                if !chunk.is_empty() && chunk.iter().any(|&x| x.abs() >= SILENT_BUFFER_PEAK_THRESHOLD) {
                                    _last_non_zero_at = Some(Instant::now());
                                    update_device_capture_time(&device_name);
                                }

                                // Hardware-clock aligned capture timestamp
                                let ts = mic_start_time + ((mic_sample_counter as f64 * 1000.0) / mic_sample_rate as f64) as u64;
                                let chunk_len = chunk.len();

                                match mic_resampler.process(&chunk) {
                                    Ok(resampled) => {
                                        aec_processor.push_mic(&resampled, ts);
                                    }
                                    Err(e) => {
                                        error!("AEC: Mic resampling error: {:?}", e);
                                    }
                                }
                                mic_sample_counter += chunk_len as u64;
                            }
                            Err(broadcast::error::RecvError::Lagged(n)) => {
                                metrics.record_chunks_lagged(n);
                                debug!("AEC: Mic channel lagged by {} messages", n);
                            }
                            Err(e) => {
                                error!("AEC: Error receiving mic data: {}", e);
                                return Err(anyhow!("Mic stream error: {}", e));
                            }
                        }
                    }
                    // Receive speaker chunk (if subscribed)
                    Some(speaker_res) = async {
                        if let Some(ref mut rx) = speaker_receiver {
                            rx.recv().await.ok()
                        } else {
                            None
                        }
                    } => {
                        let speaker_rate = speaker_resampler.as_ref().unwrap().from_sample_rate();
                        let start_ts = speaker_start_time.unwrap_or(mic_start_time);
                        let ts = start_ts + ((speaker_sample_counter as f64 * 1000.0) / speaker_rate as f64) as u64;
                        let chunk_len = speaker_res.len();

                        if let Some(ref mut resampler) = speaker_resampler {
                            match resampler.process(&speaker_res) {
                                Ok(resampled) => {
                                    aec_processor.push_speaker(&resampled, ts);
                                }
                                Err(e) => {
                                    error!("AEC: Speaker resampling error: {:?}", e);
                                }
                            }
                        }
                        speaker_sample_counter += chunk_len as u64;
                    }
                    // Timeout to prevent hanging when silent
                    _ = tokio::time::sleep(Duration::from_millis(50)) => {}
                }

                // Pull processed frames from AEC processor
                let processed = aec_processor.process();
                for (cleaned_mic, _speaker_frame, timestamp_ms) in processed {
                    collected_audio.extend_from_slice(&cleaned_mic);

                    // Send to live meeting streaming if active
                    if let Some(ref tap) = live_audio_tap {
                        if tap.is_active() && !cleaned_mic.is_empty() {
                            let frame = MeetingAudioFrame::new(
                                Arc::new(cleaned_mic),
                                &audio_stream.device,
                                16000,
                                1,
                                timestamp_ms,
                            );
                            tap.send(frame);
                        }
                    }
                }

                // Periodically log diagnostics (every 10 seconds)
                if last_diagnostics_time.elapsed() >= Duration::from_secs(10) {
                    let diag = aec_processor.diagnostics();
                    info!(
                        "AEC Diagnostics: drift={:.1}ms, mic_buf={:.1}ms, speaker_buf={:.1}ms, bypass={}, processed={}, aligned={}, bypass_frames={}, speaker_underflow={}, dropped={}",
                        diag.drift_ms,
                        diag.mic_buffer_depth_ms,
                        diag.speaker_buffer_depth_ms,
                        diag.bypass_active,
                        diag.processed_frames,
                        diag.aligned_frames,
                        diag.bypass_frames,
                        diag.speaker_underflow_frames,
                        diag.dropped_frames
                    );
                    last_diagnostics_time = Instant::now();
                }
            }

            flush_audio(
                &mut collected_audio,
                overlap_samples,
                segment_start_time,
                &audio_stream,
                &whisper_sender,
                &device_name,
                &metrics,
                true, // aec_active = true (16kHz)
            )
            .await?;
            segment_start_time = now_epoch_secs();
        }

        // Flush remaining audio on exit
        if let Err(e) = flush_audio(
            &mut collected_audio,
            0,
            segment_start_time,
            &audio_stream,
            &whisper_sender,
            &device_name,
            &metrics,
            true, // aec_active = true
        )
        .await
        {
            warn!("AEC: Final mic flush failed for {}: {}", device_name, e);
        }

        if audio_stream.is_disconnected.load(Ordering::Relaxed) {
            info!("AEC: Stopped recording for {} (disconnected)", device_name);
            Err(anyhow::anyhow!("device {} disconnected", device_name))
        } else {
            info!("AEC: Stopped recording for {}", device_name);
            Ok(())
        }
    } else {
        // Raw recorder path. Used for output streams and for input streams when
        // Screenpipe software AEC is off because an OS AEC backend was selected.
        let mut receiver = audio_stream.subscribe().await;
        let sample_rate = audio_stream.device_config.sample_rate().0 as usize;

        const OVERLAP_SECONDS: usize = 2;
        let overlap_samples = OVERLAP_SECONDS * sample_rate;

        let mut source_buffer = SourceBuffer::new(device_name.as_str(), sample_rate as u32);

        info!(
            "starting continuous recording for {} ({} / {}s segments)",
            device_name,
            source_buffer.device_kind().label(),
            duration.as_secs()
        );
        let audio_samples_len = sample_rate * duration.as_secs() as usize;
        let max_samples = audio_samples_len + overlap_samples;
        let mut collected_audio = Vec::new();
        let mut segment_start_time = now_epoch_secs();
        let stream_start = Instant::now();
        let mut last_non_zero_at: Option<Instant> = None;
        let mut sck_watchdog = crate::core::sck_output_watchdog::SckOutputWatchdog::default();
        let mut segment_count: u64 = 0;

        let mut was_paused_for_lock = false;

        while is_running.load(Ordering::Relaxed)
            && !audio_stream.is_disconnected.load(Ordering::Relaxed)
        {
            if screenpipe_config::should_pause_audio_for_lock() {
                if !was_paused_for_lock {
                    info!("screen locked, pausing audio recording for {}", device_name);
                    was_paused_for_lock = true;
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            }

            if was_paused_for_lock {
                info!(
                    "screen unlocked — rebuilding stream for {} (avoids zombie-callback state)",
                    device_name
                );
                return Err(anyhow!(
                    "stream rebuild required after screen unlock for {} (recovery is automatic)",
                    device_name
                ));
            }

            while collected_audio.len() < max_samples && is_running.load(Ordering::Relaxed) {
                let received = match recv_audio_chunk(
                    &mut receiver,
                    &audio_stream,
                    &device_name,
                    &metrics,
                    &stream_start,
                    &mut last_non_zero_at,
                    &mut sck_watchdog,
                )
                .await
                {
                    Ok(received) => received,
                    // A deliberate stop (piggyback suspension, pause, shutdown)
                    // can land while we're parked in recv: the input
                    // recv-timeout then reads as a stream death and, if
                    // propagated, discards everything collected this segment —
                    // up to a full chunk of already-captured real audio. The
                    // stream is being torn down either way, so break out and
                    // let the flushes below persist what we have.
                    Err(_) if !is_running.load(Ordering::Relaxed) => break,
                    Err(e) => return Err(e),
                };
                match received {
                    Some(chunk) => {
                        source_buffer.push(chunk);
                        let drained = source_buffer.drain_all();
                        if let Some(tap) = live_audio_tap.as_ref() {
                            if tap.is_active() && !drained.is_empty() {
                                let frame = meeting_frame_from_recorder_output(
                                    drained.clone(),
                                    &audio_stream,
                                    now_epoch_millis(),
                                );
                                tap.send(frame);
                            }
                        }
                        collected_audio.extend(drained);
                    }
                    None => continue,
                }
            }

            segment_count += 1;
            if segment_count.is_multiple_of(10) {
                source_buffer.log_stats();
            }

            flush_audio(
                &mut collected_audio,
                overlap_samples,
                segment_start_time,
                &audio_stream,
                &whisper_sender,
                &device_name,
                &metrics,
                false, // aec_active = false
            )
            .await?;
            segment_start_time = now_epoch_secs();
        }

        if let Err(e) = flush_audio(
            &mut collected_audio,
            0,
            segment_start_time,
            &audio_stream,
            &whisper_sender,
            &device_name,
            &metrics,
            false,
        )
        .await
        {
            warn!("final flush failed for {}: {}", device_name, e);
        }

        if audio_stream.is_disconnected.load(Ordering::Relaxed) {
            info!("stopped recording for {} (disconnected)", device_name);
            Err(anyhow::anyhow!("device {} disconnected", device_name))
        } else {
            info!("stopped recording for {}", device_name);
            Ok(())
        }
    }
}

async fn recv_audio_chunk(
    receiver: &mut broadcast::Receiver<Vec<f32>>,
    audio_stream: &Arc<AudioStream>,
    device_name: &str,
    metrics: &Arc<AudioPipelineMetrics>,
    stream_start: &Instant,
    last_non_zero_at: &mut Option<Instant>,
    sck_watchdog: &mut crate::core::sck_output_watchdog::SckOutputWatchdog,
) -> Result<Option<Vec<f32>>> {
    let recv_result = tokio::time::timeout(
        Duration::from_secs(AUDIO_RECEIVE_TIMEOUT_SECS),
        receiver.recv(),
    )
    .await;

    match recv_result {
        Ok(Ok(chunk)) => {
            metrics.update_audio_levels(device_name, &chunk);

            if !is_silent_buffer(&chunk) {
                *last_non_zero_at = Some(Instant::now());
                // Only tick "device is delivering data" on real audio so
                // the UI / health endpoint cannot show green during a
                // zero-fill hijack.
                update_device_capture_time(device_name);
                // While System Audio is actually flowing, snapshot the display
                // topology so a later silence can be classified as dead-anchor
                // vs nothing-playing (#3901).
                note_output_topology_if_flowing(audio_stream, sck_watchdog);
                return Ok(Some(chunk));
            }

            // Silent buffer. Only declare the stream hijacked if we had
            // confirmed real audio earlier — i.e. the stream WAS healthy
            // and went silent. Input devices only; output devices
            // legitimately go silent when nothing is playing.
            if let Some(last_seen) = *last_non_zero_at {
                if should_reconnect_after_silent_input(
                    &audio_stream.device.device_type,
                    stream_start.elapsed(),
                    last_seen.elapsed(),
                ) {
                    warn!(
                        "no usable audio from {} for {}s — only zero-fill buffers \
                         (likely OS device hijack by another app), triggering reconnect",
                        device_name, INPUT_SILENT_BUFFER_TIMEOUT_SECS
                    );
                    metrics.record_stream_timeout();
                    audio_stream.is_disconnected.store(true, Ordering::Relaxed);
                    return Err(anyhow!(StreamDeath::ZeroFill {
                        device: device_name.to_string(),
                        secs: INPUT_SILENT_BUFFER_TIMEOUT_SECS,
                    }));
                }
            }

            // Pass the silent buffer through; downstream VAD will drop it.
            // Keeping it in the pipeline preserves segment timing alignment
            // (every recv represents real OS frames, even if empty).
            Ok(Some(chunk))
        }
        Ok(Err(broadcast::error::RecvError::Lagged(n))) => {
            // The recorder fell behind the capture broadcast and the OS frames
            // in between are gone — record the count so this silent loss is
            // visible in /health and analytics instead of only a debug log.
            metrics.record_chunks_lagged(n);
            debug!(
                "audio channel lagged by {} messages for {}, continuing",
                n, device_name
            );
            Ok(None)
        }
        Ok(Err(e)) => {
            error!("error receiving audio data: {}", e);
            Err(anyhow!("Audio stream error: {}", e))
        }
        Err(_timeout) => {
            // During startup grace period, tolerate timeouts while the OS
            // stream initializes (ScreenCaptureKit may take a moment).
            if stream_start.elapsed().as_secs()
                < STREAM_STARTUP_GRACE_SECS + AUDIO_RECEIVE_TIMEOUT_SECS
            {
                debug!(
                    "no audio from {} for {}s during startup grace, continuing",
                    device_name, AUDIO_RECEIVE_TIMEOUT_SECS
                );
                return Ok(None);
            }

            // Output silence is backend-specific — benign idle vs a dead anchor
            // display (see `classify_output_recv_timeout`). An input that times
            // out has simply stopped delivering data and is dead.
            if audio_stream.device.device_type == DeviceType::Output {
                classify_output_recv_timeout(
                    audio_stream,
                    device_name,
                    metrics,
                    stream_start,
                    *last_non_zero_at,
                    sck_watchdog,
                )
            } else {
                fail_stream_dead(audio_stream, device_name, metrics)
            }
        }
    }
}

/// On a non-silent OUTPUT buffer, snapshot the macOS display topology so a later
/// silence can be told apart from a dead anchor display (#3901).
///
/// No-op except on macOS SCK-backed output streams: the CoreAudio Process Tap is
/// anchored to the default output *device* (not a display) and has its own
/// silence watchdog, and no other platform uses the display-topology signal.
#[inline]
fn note_output_topology_if_flowing(
    audio_stream: &Arc<AudioStream>,
    sck_watchdog: &mut crate::core::sck_output_watchdog::SckOutputWatchdog,
) {
    #[cfg(target_os = "macos")]
    if audio_stream.device.device_type == DeviceType::Output && audio_stream.is_sck_backed {
        sck_watchdog.note_real_audio();
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (audio_stream, sck_watchdog);
}

/// A recv-timeout on a stream that should always be delivering data — any input,
/// or a Linux output — means the OS stream genuinely stopped. Mark it
/// disconnected so `device_monitor` rebuilds it, and return the fatal `Err`.
fn fail_stream_dead(
    audio_stream: &Arc<AudioStream>,
    device_name: &str,
    metrics: &Arc<AudioPipelineMetrics>,
) -> Result<Option<Vec<f32>>> {
    warn!(
        "no audio received from {} for {}s - stream dead, triggering reconnect",
        device_name, AUDIO_RECEIVE_TIMEOUT_SECS
    );
    metrics.record_stream_timeout();
    audio_stream.is_disconnected.store(true, Ordering::Relaxed);
    // Typed cause so the VPIO runtime-fallback policy can recognize this death
    // by `downcast_ref` rather than message text. Display is unchanged.
    Err(anyhow!(StreamDeath::ReceiveTimeout {
        secs: AUDIO_RECEIVE_TIMEOUT_SECS,
    }))
}

/// Classify a recv-timeout on an OUTPUT device as benign idle (`Ok(None)`) or a
/// real stream death (`Err`).
///
/// Output silence is normally non-fatal ("nothing playing"): Windows WASAPI
/// loopback and the macOS CoreAudio tap simply stop firing callbacks while idle.
/// The macOS SCK path is the exception — a stream whose anchor display was
/// invalidated (lid close in clamshell, monitor unplug) ALSO goes silent forever
/// with no cpal error, so it gets a topology watchdog ([`super::sck_output_watchdog`])
/// that rebuilds ONLY when a previously-usable display has left the usable set.
/// Pure idle leaves the set unchanged and stays non-fatal — preserving the
/// reverted output recv-timeout behavior (commit `0f287761d`). Linux output has
/// no idle-silent backend, so a sustained timeout there is a death, like an input.
#[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
fn classify_output_recv_timeout(
    audio_stream: &Arc<AudioStream>,
    device_name: &str,
    metrics: &Arc<AudioPipelineMetrics>,
    stream_start: &Instant,
    last_non_zero_at: Option<Instant>,
    sck_watchdog: &mut crate::core::sck_output_watchdog::SckOutputWatchdog,
) -> Result<Option<Vec<f32>>> {
    #[cfg(target_os = "macos")]
    {
        // Process Tap backend: not display-anchored, has its own watchdog.
        if !audio_stream.is_sck_backed {
            debug!(
                "no audio from tap-backed output device {} for {}s (nothing playing), continuing",
                device_name, AUDIO_RECEIVE_TIMEOUT_SECS
            );
            return Ok(None);
        }
        match sck_watchdog.check_dead(stream_start.elapsed(), last_non_zero_at) {
            Some((healthy, current)) => {
                warn!(
                    "System Audio (output) {} dead — usable displays degraded {:?} -> {:?}, \
                     re-anchoring via device_monitor",
                    device_name, healthy, current
                );
                metrics.record_stream_timeout();
                audio_stream.is_disconnected.store(true, Ordering::Relaxed);
                Err(anyhow!(
                    "SCK System Audio stream dead — display invalidation (#3901)"
                ))
            }
            None => {
                debug!(
                    "no audio from output device {} for {}s, display topology unchanged \
                     (nothing playing), continuing",
                    device_name, AUDIO_RECEIVE_TIMEOUT_SECS
                );
                Ok(None)
            }
        }
    }

    // Windows WASAPI loopback: silent = no callbacks; non-fatal. device_monitor
    // still detects genuine device removal via the OS device list.
    #[cfg(target_os = "windows")]
    {
        debug!(
            "no audio from output device {} for {}s (nothing playing), continuing",
            device_name, AUDIO_RECEIVE_TIMEOUT_SECS
        );
        Ok(None)
    }

    // Linux output has no idle-silent backend: a sustained timeout is a death.
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        fail_stream_dead(audio_stream, device_name, metrics)
    }
}

fn now_epoch_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("Time went backwards")
        .as_secs()
}

fn now_epoch_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("Time went backwards")
        .as_millis() as u64
}

/// Send the collected audio to the Whisper channel and keep the overlap tail.
/// Clears `collected_audio` down to the overlap on success.
async fn flush_audio(
    collected_audio: &mut Vec<f32>,
    overlap_samples: usize,
    capture_timestamp: u64,
    audio_stream: &Arc<AudioStream>,
    whisper_sender: &Arc<crossbeam::channel::Sender<AudioInput>>,
    device_name: &str,
    metrics: &Arc<AudioPipelineMetrics>,
    aec_active: bool,
) -> Result<()> {
    if collected_audio.is_empty() {
        return Ok(());
    }

    debug!("sending audio segment to audio model");

    // Split off the overlap tail *before* sending to avoid cloning the entire buffer.
    // The send gets everything except the tail; collected_audio retains only the overlap.
    let overlap_tail = if collected_audio.len() > overlap_samples {
        collected_audio.split_off(collected_audio.len() - overlap_samples)
    } else {
        collected_audio.clone()
    };
    let send_data = std::mem::replace(collected_audio, overlap_tail);

    let sample_rate = if aec_active {
        16000
    } else {
        audio_stream.device_config.sample_rate().0
    };

    match whisper_sender.send_timeout(
        AudioInput {
            data: Arc::new(send_data),
            device: audio_stream.device.clone(),
            sample_rate,
            channels: RECORDER_OUTPUT_CHANNELS,
            capture_timestamp,
        },
        Duration::from_secs(30),
    ) {
        Ok(_) => {
            debug!("sent audio segment to audio model");
            metrics.record_chunk_sent();
        }
        Err(e) => {
            if e.is_disconnected() {
                error!("whisper channel disconnected, restarting recording process");
                return Err(anyhow!("Whisper channel disconnected"));
            } else if e.is_timeout() {
                metrics.record_channel_full();
                warn!(
                    "whisper channel still full after 30s, dropping audio segment for {}",
                    device_name
                );
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::device::AudioDevice;

    #[test]
    fn live_tap_marks_recorder_mono_output_as_mono() {
        let device = Arc::new(AudioDevice::new(
            "Windows Mic Array".to_string(),
            DeviceType::Input,
        ));
        let (audio_stream, _tx) = AudioStream::from_sender_for_test(device, 48_000, 4);
        let samples = vec![0.1, -0.2, 0.3, -0.4];

        let frame = meeting_frame_from_recorder_output(samples.clone(), &audio_stream, 1234);

        assert_eq!(frame.channels, RECORDER_OUTPUT_CHANNELS);
        assert_eq!(frame.channels, 1);
        assert_eq!(frame.sample_rate, 48_000);
        assert_eq!(frame.samples.as_ref(), &samples);
    }

    #[test]
    fn stream_death_display_is_byte_for_byte_backcompat() {
        // These exact strings appear in logs and may be grepped; the typed
        // error must reproduce them verbatim.
        assert_eq!(
            StreamDeath::ReceiveTimeout {
                secs: AUDIO_RECEIVE_TIMEOUT_SECS
            }
            .to_string(),
            "Audio stream timeout - no data received for 8s (stream dead)"
        );
        assert_eq!(
            StreamDeath::ZeroFill {
                device: "MacBook Pro Microphone (input)".to_string(),
                secs: INPUT_SILENT_BUFFER_TIMEOUT_SECS,
            }
            .to_string(),
            "Audio stream zero-fill — no usable data from MacBook Pro Microphone (input) \
             for 30s (suspected device hijack by another process)"
        );
    }

    #[test]
    fn stream_death_survives_downcast_through_anyhow_context() {
        // The VPIO-fallback classifier in the manager downcasts through the
        // cause chain; prove the typed cause survives a `.context()` wrap.
        let err = anyhow!(StreamDeath::ReceiveTimeout { secs: 8 }).context("rebuilding device");
        let found = err.chain().any(|c| {
            matches!(
                c.downcast_ref::<StreamDeath>(),
                Some(StreamDeath::ReceiveTimeout { .. })
            )
        });
        assert!(
            found,
            "ReceiveTimeout must remain downcastable after context wrapping"
        );
    }

    #[test]
    fn output_silent_buffers_do_not_trigger_input_reconnect_watchdog() {
        assert!(!should_reconnect_after_silent_input(
            &DeviceType::Output,
            Duration::from_secs(STREAM_STARTUP_GRACE_SECS + 1),
            Duration::from_secs(INPUT_SILENT_BUFFER_TIMEOUT_SECS + 1)
        ));
    }

    #[test]
    fn startup_grace_blocks_silent_input_reconnect_watchdog() {
        assert!(!should_reconnect_after_silent_input(
            &DeviceType::Input,
            Duration::from_secs(STREAM_STARTUP_GRACE_SECS - 1),
            Duration::from_secs(INPUT_SILENT_BUFFER_TIMEOUT_SECS + 1)
        ));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_sustained_zero_fill_is_treated_as_silence_not_disconnect() {
        assert!(!should_reconnect_after_silent_input(
            &DeviceType::Input,
            Duration::from_secs(STREAM_STARTUP_GRACE_SECS + 1),
            Duration::from_secs(INPUT_SILENT_BUFFER_TIMEOUT_SECS + 1)
        ));
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn non_windows_sustained_zero_fill_still_triggers_reconnect() {
        assert!(should_reconnect_after_silent_input(
            &DeviceType::Input,
            Duration::from_secs(STREAM_STARTUP_GRACE_SECS + 1),
            Duration::from_secs(INPUT_SILENT_BUFFER_TIMEOUT_SECS + 1)
        ));
    }

    #[cfg(target_os = "windows")]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn windows_live_meeting_audio_tap_e2e_uses_background_recorder_shape() {
        let sample_rate = 16_000_u32;
        let chunk_samples = 320_usize;
        let device = Arc::new(AudioDevice::new(
            "Windows Mic Array (Simulated)".to_string(),
            DeviceType::Input,
        ));
        let (audio_stream, tx) = AudioStream::from_sender_for_test(device, sample_rate, 4);
        let audio_stream = Arc::new(audio_stream);
        let (meeting_tx, _) = broadcast::channel(512);
        let meeting_tap = MeetingAudioTap::new(meeting_tx, Arc::new(AtomicBool::new(false)));
        meeting_tap.set_active(true);
        meeting_tap.set_background_suppressed(true);
        let mut live_rx = meeting_tap.subscribe();

        let (whisper_tx, whisper_rx) = crossbeam::channel::bounded::<AudioInput>(4);
        let is_running = Arc::new(AtomicBool::new(true));
        let metrics = Arc::new(AudioPipelineMetrics::new());

        let pipeline = tokio::spawn({
            let audio_stream = audio_stream.clone();
            let whisper_tx = Arc::new(whisper_tx);
            let is_running = is_running.clone();
            let metrics = metrics.clone();
            let meeting_tap = meeting_tap.clone();
            async move {
                run_record_and_transcribe(
                    audio_stream,
                    Duration::from_secs(1),
                    whisper_tx,
                    is_running,
                    metrics,
                    Some(meeting_tap),
                    None,
                    false,
                )
                .await
            }
        });

        tokio::time::sleep(Duration::from_millis(50)).await;
        for chunk_index in 0..170 {
            let chunk = (0..chunk_samples)
                .map(|sample_index| {
                    let n = chunk_index * chunk_samples + sample_index;
                    ((n as f32 / sample_rate as f32) * 440.0 * std::f32::consts::TAU).sin() * 0.2
                })
                .collect::<Vec<f32>>();
            tx.send(chunk).expect("send simulated recorder chunk");
        }

        let live_frame = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                match live_rx.recv().await {
                    Ok(frame) => break frame,
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(error) => panic!("live frame: {error}"),
                }
            }
        })
        .await
        .expect("live frame timeout");
        assert_eq!(live_frame.channels, 1);
        assert_eq!(live_frame.sample_rate, sample_rate);
        assert!(!live_frame.samples.is_empty());
        assert!(meeting_tap.background_suppressed());

        let whisper_rx_for_assert = whisper_rx.clone();
        let audio_input = tokio::task::spawn_blocking(move || {
            whisper_rx_for_assert.recv_timeout(Duration::from_secs(2))
        })
        .await
        .expect("background receiver task")
        .expect("background audio segment");
        assert_eq!(audio_input.channels, 1);
        assert_eq!(audio_input.sample_rate, sample_rate);
        assert!(!audio_input.data.is_empty());

        is_running.store(false, Ordering::Relaxed);
        tx.send(vec![0.1; chunk_samples]).ok();
        let pipeline_result = tokio::time::timeout(Duration::from_secs(5), pipeline)
            .await
            .expect("pipeline shutdown timeout")
            .expect("pipeline task");
        pipeline_result.expect("pipeline result");
    }

    #[cfg(target_os = "windows")]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn windows_recorder_e2e_keeps_running_after_zero_fill_input() {
        let sample_rate = 16_000_u32;
        let chunk_samples = 320_usize;
        let device = Arc::new(AudioDevice::new(
            "Microphone Array (Intel Smart Sound Technology for Digital Microphones)".to_string(),
            DeviceType::Input,
        ));
        let (audio_stream, tx) = AudioStream::from_sender_for_test(device, sample_rate, 2);
        let audio_stream = Arc::new(audio_stream);
        let (whisper_tx, whisper_rx) = crossbeam::channel::bounded::<AudioInput>(8);
        let is_running = Arc::new(AtomicBool::new(true));
        let metrics = Arc::new(AudioPipelineMetrics::new());

        let pipeline = tokio::spawn({
            let audio_stream = audio_stream.clone();
            let whisper_tx = Arc::new(whisper_tx);
            let is_running = is_running.clone();
            let metrics = metrics.clone();
            async move {
                run_record_and_transcribe(
                    audio_stream,
                    Duration::from_secs(1),
                    whisper_tx,
                    is_running,
                    metrics,
                    None,
                    None,
                    false,
                )
                .await
            }
        });

        tokio::time::sleep(Duration::from_millis(50)).await;
        for chunk_index in 0..170 {
            let chunk = (0..chunk_samples)
                .map(|sample_index| {
                    let n = chunk_index * chunk_samples + sample_index;
                    ((n as f32 / sample_rate as f32) * 440.0 * std::f32::consts::TAU).sin() * 0.2
                })
                .collect::<Vec<f32>>();
            tx.send(chunk).expect("send simulated speech chunk");
        }

        let speech_segment = tokio::task::spawn_blocking({
            let whisper_rx = whisper_rx.clone();
            move || whisper_rx.recv_timeout(Duration::from_secs(2))
        })
        .await
        .expect("speech receiver task")
        .expect("speech segment");
        assert_eq!(speech_segment.channels, 1);
        assert_eq!(speech_segment.sample_rate, sample_rate);
        assert!(!speech_segment.data.is_empty());

        for _ in 0..400 {
            tx.send(vec![0.0; chunk_samples])
                .expect("send simulated zero-fill chunk");
        }

        let mut saw_zero_fill_in_segment = false;
        for _ in 0..5 {
            let segment = tokio::task::spawn_blocking({
                let whisper_rx = whisper_rx.clone();
                move || whisper_rx.recv_timeout(Duration::from_secs(2))
            })
            .await
            .expect("zero-fill receiver task")
            .expect("zero-fill segment");
            assert_eq!(segment.channels, 1);
            assert_eq!(segment.sample_rate, sample_rate);
            saw_zero_fill_in_segment |= segment
                .data
                .iter()
                .any(|sample| sample.abs() < SILENT_BUFFER_PEAK_THRESHOLD);
            if saw_zero_fill_in_segment {
                break;
            }
        }
        assert!(saw_zero_fill_in_segment);
        assert!(!audio_stream.is_disconnected());
        assert_eq!(metrics.stream_timeouts.load(Ordering::Relaxed), 0);

        is_running.store(false, Ordering::Relaxed);
        tx.send(vec![0.1; chunk_samples]).ok();
        let pipeline_result = tokio::time::timeout(Duration::from_secs(5), pipeline)
            .await
            .expect("pipeline shutdown timeout")
            .expect("pipeline task");
        pipeline_result.expect("pipeline result");
    }
}
