// Proactive watchdog for audio recovery
// Sleeps 20h then calls the provided restart logic with logging
use std::time::Duration;
use tokio::time::sleep;
use tracing::{info, error};

/// Spawn a background task that waits 20h, then calls `restart_fn` to restart audio.
pub fn spawn_audio_watchdog<F>(restart_fn: F)
where
    F: Fn() -> anyhow::Result<()> + Send + Sync + 'static,
{
    tokio::spawn(async move {
        let mut attempt = 0u32;
        loop {
            sleep(Duration::from_secs(20 * 3600)).await;
            info!("[audio watchdog] proactive restart attempt {}", attempt);
            match restart_fn() {
                Ok(()) => {
                    info!("[audio watchdog] restart succeeded");
                    attempt = 0;
                }
                Err(err) => {
                    error!(error=%err, "[audio watchdog] restart failed");
                    attempt = attempt.saturating_add(1);
                    let backoff = 2u64.saturating_pow(attempt.min(5));
                    sleep(Duration::from_secs(backoff)).await;
                }
            }
        }
    });
}