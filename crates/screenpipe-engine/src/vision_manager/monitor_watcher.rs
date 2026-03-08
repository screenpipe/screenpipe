//! Monitor Watcher - Polls for monitor connect/disconnect events

use once_cell::sync::Lazy;
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tracing::{debug, error, info, warn};

use screenpipe_screen::monitor::{list_monitors_detailed, MonitorListError};

use super::manager::{VisionManager, VisionManagerStatus};

static MONITOR_WATCHER: Lazy<Mutex<Option<JoinHandle<()>>>> = Lazy::new(|| Mutex::new(None));

/// Start the monitor watcher that polls for monitor changes
pub async fn start_monitor_watcher(vision_manager: Arc<VisionManager>) -> anyhow::Result<()> {
    // Stop existing watcher if any
    stop_monitor_watcher().await?;

    info!("Starting monitor watcher (polling every 5 seconds)");

    let handle = tokio::spawn(async move {
        // Track monitors that were disconnected (for reconnection detection)
        let mut known_monitors: HashSet<u32> = HashSet::new();
        // Track permission state to avoid log spam
        let mut permission_denied_logged = false;

        // Initialize with current monitors
        match list_monitors_detailed().await {
            Ok(monitors) => {
                for monitor in &monitors {
                    known_monitors.insert(monitor.id());
                }
                permission_denied_logged = false;
            }
            Err(MonitorListError::PermissionDenied) => {
                error!("Screen recording permission denied. Vision capture is disabled. Grant access in System Settings > Privacy & Security > Screen Recording");
                permission_denied_logged = true;
            }
            Err(e) => {
                warn!("Failed to list monitors on startup: {}", e);
            }
        }

        loop {
            // Only poll when running
            if vision_manager.status().await != VisionManagerStatus::Running {
                tokio::time::sleep(Duration::from_secs(5)).await;
                continue;
            }

            // Get currently connected monitors with detailed error info
            let current_monitors = match list_monitors_detailed().await {
                Ok(monitors) => {
                    if permission_denied_logged {
                        info!("Screen recording permission granted! Starting vision capture.");
                        permission_denied_logged = false;
                    }
                    monitors
                }
                Err(MonitorListError::PermissionDenied) => {
                    if !permission_denied_logged {
                        error!("Screen recording permission denied. Vision capture is disabled. Grant access in System Settings > Privacy & Security > Screen Recording");
                        permission_denied_logged = true;
                    }
                    // Back off to 30s when permission is denied instead of 2s
                    tokio::time::sleep(Duration::from_secs(30)).await;
                    continue;
                }
                Err(MonitorListError::NoMonitorsFound) => {
                    debug!("No monitors found, will retry");
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    continue;
                }
                Err(e) => {
                    warn!("Failed to list monitors: {}", e);
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    continue;
                }
            };
            let current_ids: HashSet<u32> = current_monitors.iter().map(|m| m.id()).collect();

            // Get currently recording monitors
            let active_ids: HashSet<u32> =
                vision_manager.active_monitors().await.into_iter().collect();

            // Detect newly connected monitors (filtered by user selection)
            for monitor in &current_monitors {
                let monitor_id = monitor.id();
                if !active_ids.contains(&monitor_id) {
                    if !vision_manager.is_monitor_allowed(monitor) {
                        debug!(
                            "Skipping monitor {} ({}) — not in allowed list",
                            monitor_id,
                            monitor.stable_id()
                        );
                        continue;
                    }

                    if known_monitors.contains(&monitor_id) {
                        info!("Monitor {} reconnected, resuming recording", monitor_id);
                    } else {
                        info!("New monitor {} detected, starting recording", monitor_id);
                        known_monitors.insert(monitor_id);
                    }

                    if let Err(e) = vision_manager.start_monitor(monitor_id).await {
                        warn!(
                            "Failed to start recording on monitor {}: {:?}",
                            monitor_id, e
                        );
                    }
                }
            }

            // Detect disconnected monitors
            for monitor_id in &active_ids {
                if !current_ids.contains(monitor_id) {
                    info!("Monitor {} disconnected, stopping recording", monitor_id);
                    if let Err(e) = vision_manager.stop_monitor(*monitor_id).await {
                        warn!(
                            "Failed to stop recording on monitor {}: {:?}",
                            monitor_id, e
                        );
                    }
                }
            }

            // Poll every 5 seconds — monitor connect/disconnect is not latency-sensitive
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    });

    *MONITOR_WATCHER.lock().await = Some(handle);

    Ok(())
}

/// Stop the monitor watcher
pub async fn stop_monitor_watcher() -> anyhow::Result<()> {
    if let Some(handle) = MONITOR_WATCHER.lock().await.take() {
        debug!("Stopping monitor watcher");
        handle.abort();
    }
    Ok(())
}
