use crate::core::{
    device::{list_audio_devices, AudioDevice},
    stream::AudioStream,
};
use anyhow::{anyhow, Result};
use dashmap::DashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tracing::{debug, info};

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
        self.macos_input_vpio
            .store(macos_input_vpio, Ordering::Relaxed);
    }

    pub async fn devices(&self) -> Vec<AudioDevice> {
        list_audio_devices().await.unwrap_or_default()
    }

    pub async fn start_device(&self, device: &AudioDevice) -> Result<()> {
        if !self.devices().await.contains(device) {
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
            self.macos_input_vpio.load(Ordering::Relaxed),
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
