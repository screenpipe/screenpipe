// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Windows probe for audiodg.exe handle growth caused by audio inventory
//! refreshes (GitHub #7700). Calls the real `list_audio_devices()` every 2 s,
//! the device monitor's cadence, and prints one JSON line per minute with the
//! audiodg.exe handle count.
//!
//! Usage:
//!   cargo run -p screenpipe-audio --example inventory_handle_probe -- <minutes>

#[cfg(not(target_os = "windows"))]
fn main() {
    eprintln!("inventory_handle_probe is Windows-only.");
}

#[cfg(target_os = "windows")]
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    use screenpipe_audio::core::device::list_audio_devices;
    use std::time::{Duration, Instant};

    let minutes: u64 = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(30);
    let start = Instant::now();
    let mut next_sample = start;
    let mut calls = 0u64;
    let mut devices = 0usize;
    while start.elapsed() < Duration::from_secs(minutes * 60) {
        if Instant::now() >= next_sample {
            println!(
                "{{\"elapsed_s\":{},\"audiodg_handles\":{},\"inventory_calls\":{},\"devices\":{}}}",
                start.elapsed().as_secs(),
                audiodg_handles().map_or("null".to_string(), |n| n.to_string()),
                calls,
                devices
            );
            next_sample += Duration::from_secs(60);
        }
        devices = list_audio_devices().await.map(|d| d.len()).unwrap_or(0);
        calls += 1;
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    println!(
        "{{\"elapsed_s\":{},\"audiodg_handles\":{},\"inventory_calls\":{},\"devices\":{},\"done\":true}}",
        start.elapsed().as_secs(),
        audiodg_handles().map_or("null".to_string(), |n| n.to_string()),
        calls,
        devices
    );
    Ok(())
}

#[cfg(target_os = "windows")]
fn audiodg_handles() -> Option<u64> {
    let out = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "(Get-Process audiodg -ErrorAction SilentlyContinue | Measure-Object HandleCount -Sum).Sum",
        ])
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}
