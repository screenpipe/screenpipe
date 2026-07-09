use crate::core::{
    device::{list_audio_devices, AudioDevice},
    stream::AudioStream,
};
use crate::device::vpio_health::{FailureOutcome, VpioHealthTracker};
use anyhow::{anyhow, Result};
use dashmap::DashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tracing::{debug, info, warn};

pub struct DeviceManager {
    streams: Arc<DashMap<AudioDevice, Arc<AudioStream>>>,
    states: Arc<DashMap<AudioDevice, Arc<AtomicBool>>>,
    /// When true, System Audio (output) uses the CoreAudio Process Tap path
    /// on macOS 14.4+ instead of ScreenCaptureKit. Propagated to
    /// AudioStream::from_device at device-start time. Has no effect on
    /// macOS <14.4 or non-macOS — falls back to SCK there.
    use_coreaudio_tap: AtomicBool,
    /// When true, Windows WASAPI input streams request endpoint AEC.
    windows_input_aec: AtomicBool,
    /// When true, the default macOS microphone uses VoiceProcessingIO (AEC).
    macos_input_vpio: AtomicBool,
    /// Per-device VPIO runtime-failure policy. A device whose VPIO stream
    /// repeatedly dies at runtime is demoted to the HAL input path for this
    /// session so audio keeps flowing instead of looping on a dead stream.
    vpio_health: VpioHealthTracker,
}

impl DeviceManager {
    pub async fn new(
        use_coreaudio_tap: bool,
        windows_input_aec: bool,
        macos_input_vpio: bool,
    ) -> Result<Self> {
        let streams = Arc::new(DashMap::new());
        let states = Arc::new(DashMap::new());

        Ok(Self {
            streams,
            states,
            use_coreaudio_tap: AtomicBool::new(use_coreaudio_tap),
            windows_input_aec: AtomicBool::new(windows_input_aec),
            macos_input_vpio: AtomicBool::new(macos_input_vpio),
            vpio_health: VpioHealthTracker::new(),
        })
    }

    pub fn configure_backend_flags(
        &self,
        use_coreaudio_tap: bool,
        windows_input_aec: bool,
        macos_input_vpio: bool,
    ) {
        self.use_coreaudio_tap
            .store(use_coreaudio_tap, Ordering::Relaxed);
        self.windows_input_aec
            .store(windows_input_aec, Ordering::Relaxed);
        // Only a genuine VPIO setting flip re-arms demoted devices. This method
        // runs on every options apply, not just on change, so clearing
        // unconditionally would forget runtime demotions and drop a broken
        // device straight back into the dead-stream loop.
        let vpio_changed = self
            .macos_input_vpio
            .swap(macos_input_vpio, Ordering::Relaxed)
            != macos_input_vpio;
        if vpio_changed {
            self.vpio_health.clear();
        }
    }

    /// Effective VoiceProcessingIO flag for a device: the global setting AND not
    /// runtime-demoted to HAL after repeated dead-stream deaths.
    fn effective_macos_input_vpio(&self, device: &AudioDevice) -> bool {
        self.macos_input_vpio.load(Ordering::Relaxed) && !self.vpio_health.is_demoted(device)
    }

    /// Record a runtime stream-death for a device that was using VPIO. Returns
    /// `true` if this death just demoted the device to the HAL path (so the
    /// caller logs it once). No-op when VPIO is globally disabled or the device
    /// is already demoted.
    pub fn note_vpio_runtime_failure(&self, device: &AudioDevice) -> bool {
        if !self.macos_input_vpio.load(Ordering::Relaxed) {
            return false;
        }

        match self.vpio_health.record_failure(device) {
            FailureOutcome::Demoted { consecutive } => {
                warn!(
                    device = %device,
                    failures = consecutive,
                    "macOS VoiceProcessingIO produced a dead stream {consecutive} times in a row \
                     (created but delivered no audio); disabling VPIO/AEC for this device for the \
                     rest of this session and falling back to the plain CoreAudio (HAL) input path \
                     so audio recording recovers"
                );
                true
            }
            FailureOutcome::Counted { .. } | FailureOutcome::AlreadyDemoted => false,
        }
    }

    pub async fn devices(&self) -> Vec<AudioDevice> {
        list_audio_devices().await.unwrap_or_default()
    }

    pub async fn start_device(&self, device: &AudioDevice) -> Result<()> {
        self.start_device_inner(device, None).await
    }

    /// Start a device whose stream is backed by the per-process meeting tap
    /// (`spawn_process_tap_capture_for_pids`) for `tap_pids`. Only meaningful
    /// for the Meeting Tap virtual output device; other devices ignore the pids
    /// in `AudioStream::from_device`.
    pub async fn start_device_with_tap_pids(
        &self,
        device: &AudioDevice,
        tap_pids: Vec<i32>,
    ) -> Result<()> {
        self.start_device_inner(device, Some(tap_pids)).await
    }

    async fn start_device_inner(
        &self,
        device: &AudioDevice,
        tap_pids: Option<Vec<i32>>,
    ) -> Result<()> {
        // The meeting tap is a virtual device synthesized from pids
        // (spawn_process_tap_capture_for_pids); it is deliberately never in
        // list_audio_devices(), so skip the availability check on the tap path.
        // Every other device must still be a real, currently-listed device.
        if tap_pids.is_none() && !self.devices().await.contains(device) {
            return Err(anyhow!("device {device} not found"));
        }

        if self.is_running(device) {
            return Err(anyhow!("Device {} already running.", device));
        }

        let is_running = Arc::new(AtomicBool::new(false));
        let stream = match AudioStream::from_device(
            Arc::new(device.clone()),
            is_running.clone(),
            self.use_coreaudio_tap.load(Ordering::Relaxed),
            self.windows_input_aec.load(Ordering::Relaxed),
            self.effective_macos_input_vpio(device),
            tap_pids,
        )
        .await
        {
            Ok(stream) => stream,
            Err(e) => {
                return Err(e);
            }
        };

        info!("starting recording for device: {}", device);

        self.streams.insert(device.clone(), Arc::new(stream));
        self.states.insert(device.clone(), is_running);

        Ok(())
    }

    pub fn stream(&self, device: &AudioDevice) -> Option<Arc<AudioStream>> {
        self.streams.get(device).map(|s| s.value().clone())
    }

    pub fn is_running(&self, device: &AudioDevice) -> bool {
        self.states
            .get(device)
            .map(|s| s.load(Ordering::Relaxed))
            .unwrap_or(false)
    }

    pub async fn stop_all_devices(&self) -> Result<()> {
        for pair in self.states.iter() {
            let device = pair.key();
            let _ = self.stop_device(device).await;
        }

        self.states.clear();
        self.streams.clear();

        Ok(())
    }

    /// Stop a device and tear down its stream. **Idempotent**: a device that is
    /// already marked not-running STILL drives stream teardown
    /// (`AudioStream::stop` + removal from the map).
    ///
    /// Previously this early-returned `Err` on the already-stopped path, which
    /// skipped teardown entirely. For the CoreAudio process-tap path that left
    /// `is_disconnected` unflipped, so the tap-owning blocking thread looped
    /// forever and the tap was orphaned — wedging `coreaudiod` system-wide
    /// (#3942). The recovery monitor and `stop_device_recording` both mark a
    /// device not-running *before* asking it to stop, hitting exactly that path,
    /// so teardown must not depend on the running flag still being set.
    pub async fn stop_device(&self, device: &AudioDevice) -> Result<()> {
        if self.is_running(device) {
            info!("Stopping device: {device}");
        } else {
            debug!(
                "stop_device({device}): already marked stopped — running teardown idempotently \
                 so the stream (and any CoreAudio tap) is released, not orphaned"
            );
        }

        if let Some(is_running) = self.states.get(device) {
            is_running.store(false, Ordering::Relaxed)
        }

        if let Some(p) = self.streams.get(device) {
            let _ = p.value().stop().await;
        }

        self.streams.remove(device);

        Ok(())
    }

    pub fn is_running_mut(&self, device: &AudioDevice) -> Option<Arc<AtomicBool>> {
        self.states.get(device).map(|s| s.value().clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::device::DeviceType;
    use crate::core::stream::AudioStream;

    /// #3942 orphan vector: `stop_device` used to early-`Err` when the device
    /// was already marked not-running, skipping stream teardown. For a CoreAudio
    /// process-tap stream that left `is_disconnected` unflipped, so the
    /// tap-owning thread looped forever and the tap was orphaned. Teardown must
    /// run regardless of the running flag.
    #[tokio::test]
    async fn stop_device_drives_teardown_even_when_already_marked_stopped() {
        let dm = DeviceManager::new(true, false, false).await.unwrap();
        let device = AudioDevice::new(
            "ScreenpipeProcessTap (input)".to_string(),
            DeviceType::Input,
        );

        let (stream, _tx) = AudioStream::from_sender_for_test(Arc::new(device.clone()), 48_000, 1);
        let stream = Arc::new(stream);

        // Present but ALREADY marked not-running (the recovery-monitor /
        // stop_device_recording state that previously bypassed teardown).
        dm.states
            .insert(device.clone(), Arc::new(AtomicBool::new(false)));
        dm.streams.insert(device.clone(), stream.clone());

        let res = dm.stop_device(&device).await;

        assert!(
            res.is_ok(),
            "stop_device must be Ok (idempotent), got {res:?}"
        );
        assert!(
            stream.is_disconnected(),
            "teardown must flip is_disconnected so the tap thread can exit"
        );
        assert!(
            dm.streams.get(&device).is_none(),
            "the stream must be removed from the manager"
        );
    }

    fn mic() -> AudioDevice {
        AudioDevice::new(
            "MacBook Pro Microphone (input)".to_string(),
            DeviceType::Input,
        )
    }

    /// Drive deaths until the device demotes; returns how many it took. Bounded
    /// so a policy regression fails the test instead of hanging.
    fn drive_until_demoted(dm: &DeviceManager, device: &AudioDevice) -> u32 {
        for n in 1..=10 {
            if dm.note_vpio_runtime_failure(device) {
                return n;
            }
            assert!(
                dm.effective_macos_input_vpio(device),
                "device must keep VPIO until it is actually demoted"
            );
        }
        panic!("device never demoted within the bound");
    }

    /// VPIO runtime fallback: repeated dead-stream deaths flip the effective
    /// VPIO flag off so the recovery restart rebuilds the device on the HAL path.
    #[tokio::test]
    async fn vpio_runtime_failures_demote_device_to_hal() {
        let dm = DeviceManager::new(false, false, true).await.unwrap();
        let device = mic();

        assert!(
            dm.effective_macos_input_vpio(&device),
            "VPIO should start enabled for the device"
        );

        drive_until_demoted(&dm, &device);
        assert!(
            !dm.effective_macos_input_vpio(&device),
            "after demotion the device must build with VPIO disabled (HAL path)"
        );

        // Further deaths are a no-op (already demoted, nothing new to log).
        assert!(!dm.note_vpio_runtime_failure(&device));
    }

    /// When VPIO is globally disabled, runtime-failure accounting is inert and
    /// the effective flag stays off — no spurious demotion bookkeeping.
    #[tokio::test]
    async fn vpio_runtime_failures_noop_when_vpio_disabled() {
        let dm = DeviceManager::new(false, false, false).await.unwrap();
        let device = mic();

        assert!(!dm.effective_macos_input_vpio(&device));
        for _ in 0..6 {
            assert!(
                !dm.note_vpio_runtime_failure(&device),
                "no demotion should be reported when VPIO is globally off"
            );
        }
        assert!(!dm.effective_macos_input_vpio(&device));
    }

    /// `configure_backend_flags` runs on every options apply. It must only
    /// re-arm a demoted device when the VPIO setting actually flips — re-applying
    /// the same value must NOT forget a demotion (else the device drops straight
    /// back into the dead-stream loop).
    #[tokio::test]
    async fn configure_backend_flags_clears_demotion_only_on_vpio_flip() {
        let dm = DeviceManager::new(false, false, true).await.unwrap();
        let device = mic();
        drive_until_demoted(&dm, &device);
        assert!(!dm.effective_macos_input_vpio(&device));

        // Re-apply identical flags (a no-change options sync): demotion sticks.
        dm.configure_backend_flags(false, false, true);
        assert!(
            !dm.effective_macos_input_vpio(&device),
            "re-applying the same VPIO value must not re-arm a demoted device"
        );
        // An unrelated flag changing also must not clear the demotion.
        dm.configure_backend_flags(true, true, true);
        assert!(
            !dm.effective_macos_input_vpio(&device),
            "changing other backend flags must not re-arm a demoted device"
        );

        // Actually flipping VPIO off then on re-arms it (fresh user intent).
        dm.configure_backend_flags(true, true, false);
        dm.configure_backend_flags(true, true, true);
        assert!(
            dm.effective_macos_input_vpio(&device),
            "toggling the VPIO setting must clear runtime demotions"
        );
    }

    /// Regression guard: the normal running path still tears down and clears the
    /// running flag.
    #[tokio::test]
    async fn stop_device_tears_down_running_device() {
        let dm = DeviceManager::new(true, false, false).await.unwrap();
        let device = AudioDevice::new("Test (input)".to_string(), DeviceType::Input);
        let (stream, _tx) = AudioStream::from_sender_for_test(Arc::new(device.clone()), 48_000, 1);
        let stream = Arc::new(stream);
        dm.states
            .insert(device.clone(), Arc::new(AtomicBool::new(true)));
        dm.streams.insert(device.clone(), stream.clone());

        assert!(dm.stop_device(&device).await.is_ok());
        assert!(stream.is_disconnected());
        assert!(dm.streams.get(&device).is_none());
        assert!(!dm.is_running(&device), "running flag must be cleared");
    }
}
