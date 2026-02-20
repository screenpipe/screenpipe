use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::{Duration, Instant},
};

use anyhow::Result;
use tokio::{sync::Mutex, task::JoinHandle, time::sleep};
use tracing::{debug, error, info, warn};

use crate::{
    core::device::{default_input_device, default_output_device, parse_audio_device, DeviceType},
    device::device_manager::DeviceManager,
};

use super::{AudioManager, AudioManagerStatus};

lazy_static::lazy_static! {
  pub static ref DEVICE_MONITOR: Mutex<Option<JoinHandle<()>>> = Mutex::new(None);
}

/// Track the last known system default devices to detect changes
struct SystemDefaultTracker {
    last_input: Option<String>,
    last_output: Option<String>,
}

impl SystemDefaultTracker {
    fn new() -> Self {
        Self {
            last_input: None,
            last_output: None,
        }
    }

    /// Check if system default input device has changed
    fn check_input_changed(&mut self) -> Option<String> {
        let current = default_input_device().ok().map(|d| d.to_string());
        if current != self.last_input {
            let changed = current.clone();
            self.last_input = current;
            changed
        } else {
            None
        }
    }

    /// Check if system default output device has changed
    async fn check_output_changed(&mut self) -> Option<String> {
        let current = default_output_device().await.ok().map(|d| d.to_string());
        if current != self.last_output {
            let changed = current.clone();
            self.last_output = current;
            changed
        } else {
            None
        }
    }
}

pub async fn start_device_monitor(
    audio_manager: Arc<AudioManager>,
    device_manager: Arc<DeviceManager>,
) -> Result<()> {
    stop_device_monitor().await?;

    *DEVICE_MONITOR.lock().await = Some(tokio::spawn(async move {
        let mut disconnected_devices: HashSet<String> = HashSet::new();
        let mut default_tracker = SystemDefaultTracker::new();

        // Track devices that repeatedly fail to start so we don't spam errors
        // every 2 seconds. After a failure, back off for increasing durations.
        let mut failed_devices: HashMap<String, (u32, Instant)> = HashMap::new();
        const MAX_FAIL_BACKOFF_SECS: u64 = 300; // cap at 5 minutes

        // Initialize tracker with current defaults
        let _ = default_tracker.check_input_changed();
        let _ = default_tracker.check_output_changed().await;

        loop {
            if audio_manager.status().await == AudioManagerStatus::Running {
                let currently_available_devices = device_manager.devices().await;
                let enabled_devices = audio_manager.enabled_devices().await;

                // Handle "Follow System Default" mode
                if audio_manager.use_system_default_audio().await {
                    // Check if system default input changed
                    if let Some(new_default_input) = default_tracker.check_input_changed() {
                        info!("system default input changed to: {}", new_default_input);

                        // Stop all current input devices
                        for device_name in enabled_devices.iter() {
                            if let Ok(device) = parse_audio_device(device_name) {
                                if device.device_type == DeviceType::Input {
                                    let _ = audio_manager.stop_device(device_name).await;
                                }
                            }
                        }

                        // Start the new default input device
                        if let Ok(new_device) = parse_audio_device(&new_default_input) {
                            match audio_manager.start_device(&new_device).await {
                                Ok(()) => info!(
                                    "switched to new system default input: {}",
                                    new_default_input
                                ),
                                Err(e) => error!(
                                    "failed to start new default input {}: {}",
                                    new_default_input, e
                                ),
                            }
                        }
                    }

                    // Check if system default output changed
                    if let Some(new_default_output) = default_tracker.check_output_changed().await {
                        info!("system default output changed to: {}", new_default_output);

                        // Stop all current output devices
                        for device_name in audio_manager.enabled_devices().await.iter() {
                            if let Ok(device) = parse_audio_device(device_name) {
                                if device.device_type == DeviceType::Output {
                                    let _ = audio_manager.stop_device(device_name).await;
                                }
                            }
                        }

                        // Start the new default output device (reset cooldown on change)
                        if let Ok(new_device) = parse_audio_device(&new_default_output) {
                            failed_devices.remove(&new_default_output);
                            match audio_manager.start_device(&new_device).await {
                                Ok(()) => {
                                    info!(
                                        "switched to new system default output: {}",
                                        new_default_output
                                    );
                                }
                                Err(e) => {
                                    let count = failed_devices
                                        .entry(new_default_output.clone())
                                        .or_insert((0, Instant::now()));
                                    count.0 += 1;
                                    count.1 = Instant::now();
                                    error!(
                                        "failed to start new default output {}: {} (will back off)",
                                        new_default_output, e
                                    );
                                }
                            }
                        }
                    }

                    // Ensure an output device is actually running.
                    // Handles the case where ScreenCaptureKit wasn't ready at startup.
                    {
                        let current_enabled = audio_manager.enabled_devices().await;
                        let has_output = current_enabled.iter().any(|name| {
                            parse_audio_device(name)
                                .map(|d| d.device_type == DeviceType::Output)
                                .unwrap_or(false)
                        });

                        if !has_output {
                            if let Ok(default_output) = default_output_device().await {
                                let device_name = default_output.to_string();

                                // Skip if this device is in cooldown from previous failures
                                let should_skip = if let Some((fails, last_fail)) =
                                    failed_devices.get(&device_name)
                                {
                                    let backoff = Duration::from_secs(
                                        (2u64.pow((*fails).min(8))).min(MAX_FAIL_BACKOFF_SECS),
                                    );
                                    last_fail.elapsed() < backoff
                                } else {
                                    false
                                };

                                if !should_skip {
                                    info!(
                                        "no output device running, starting default: {}",
                                        device_name
                                    );
                                    match audio_manager.start_device(&default_output).await {
                                        Ok(()) => {
                                            failed_devices.remove(&device_name);
                                            default_tracker.last_output =
                                                Some(device_name.clone());
                                            info!(
                                                "started missing output device: {}",
                                                device_name
                                            );
                                        }
                                        Err(e) => {
                                            let count = failed_devices
                                                .entry(device_name.clone())
                                                .or_insert((0, Instant::now()));
                                            count.0 += 1;
                                            count.1 = Instant::now();
                                            let backoff_secs = (2u64.pow(count.0.min(8)))
                                                .min(MAX_FAIL_BACKOFF_SECS);
                                            warn!(
                                                "could not start output device {} ({} failures, next retry in {}s): {}",
                                                device_name, count.0, backoff_secs, e
                                            );
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                // Check for stale recording handles (tasks that have finished/crashed)
                // This handles cases where audio stream was hijacked by another app
                let stale_devices = audio_manager.check_stale_recording_handles().await;
                for device_name in stale_devices {
                    debug!(
                        "detected stale recording handle for {}, cleaning up for restart",
                        device_name
                    );
                    let _ = audio_manager.cleanup_stale_device(&device_name).await;
                    disconnected_devices.insert(device_name);
                }

                for device_name in disconnected_devices.clone() {
                    let device = match parse_audio_device(&device_name) {
                        Ok(device) => device,
                        Err(e) => {
                            error!("Device name {} invalid: {}", device_name, e);
                            continue;
                        }
                    };

                    // In system default mode, try to restart with current default instead
                    if audio_manager.use_system_default_audio().await {
                        let current_default = match device.device_type {
                            DeviceType::Input => default_input_device().ok(),
                            DeviceType::Output => default_output_device().await.ok(),
                        };

                        if let Some(default_device) = current_default {
                            if audio_manager.start_device(&default_device).await.is_ok() {
                                info!("restarted with system default device: {}", default_device);
                                disconnected_devices.remove(&device_name);
                                continue;
                            }
                        }
                    }

                    if audio_manager.start_device(&device).await.is_ok() {
                        info!("successfully restarted device {}", device_name);
                        disconnected_devices.remove(&device_name);
                    }
                }

                for device_name in enabled_devices.iter() {
                    let device = match parse_audio_device(device_name) {
                        Ok(device) => device,
                        Err(e) => {
                            error!("Device name {} invalid: {}", device_name, e);
                            continue;
                        }
                    };

                    if device_manager.is_running(&device)
                        && !currently_available_devices.contains(&device)
                    {
                        info!("Device {device_name} disconnected");

                        let _ = audio_manager.stop_device(device_name).await;
                        disconnected_devices.insert(device_name.clone());
                    } else {
                        if audio_manager.status().await != AudioManagerStatus::Running {
                            break;
                        }

                        if !audio_manager.enabled_devices().await.contains(device_name) {
                            continue;
                        }

                        match audio_manager.start_device(&device).await {
                            Ok(()) => {
                                //
                            }
                            Err(e) => {
                                let e_str = e.to_string();
                                if e_str.contains("already running") || e_str.contains("not found")
                                {
                                    continue;
                                }
                                error!("device check error: {e}");
                            }
                        }
                    }
                }
            }
            sleep(Duration::from_secs(2)).await;
        }
    }));
    Ok(())
}

pub async fn stop_device_monitor() -> Result<()> {
    if let Some(handle) = DEVICE_MONITOR.lock().await.take() {
        handle.abort();
    }

    Ok(())
}
