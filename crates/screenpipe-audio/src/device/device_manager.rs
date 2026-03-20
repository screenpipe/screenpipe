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
use tracing::info;

pub struct DeviceManager {
    streams: Arc<DashMap<AudioDevice, Arc<AudioStream>>>,
    states: Arc<DashMap<AudioDevice, Arc<AtomicBool>>>,
}

impl DeviceManager {
    pub async fn new() -> Result<Self> {
        let streams = Arc::new(DashMap::new());
        let states = Arc::new(DashMap::new());

        Ok(Self { streams, states })
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
        let stream =
            match AudioStream::from_device(Arc::new(device.clone()), is_running.clone()).await {
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

    pub async fn stop_device(&self, device: &AudioDevice) -> Result<()> {
        if !self.is_running(device) {
            return Err(anyhow!("Device {} already stopped", device));
        }

        info!("Stopping device: {device}");

        if let Some(is_running) = self.states.get(device) {
            is_running.store(false, Ordering::Relaxed)
        }

        if let Some(p) = self.streams.get(device) {
            let _ = tokio::time::timeout(std::time::Duration::from_secs(5), p.value().stop()).await;
        }

        self.streams.remove(device);

        Ok(())
    }

    pub fn is_running_mut(&self, device: &AudioDevice) -> Option<Arc<AtomicBool>> {
        self.states.get(device).map(|s| s.value().clone())
    }
}
