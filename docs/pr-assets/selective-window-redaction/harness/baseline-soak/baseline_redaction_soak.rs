// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Native acceptance/soak probe. Run only on an isolated synthetic desktop.
//! OUT MODE MONITOR FRAMES INTERVAL_MS [MAX_WIDTH]; MODE=exclude/include/none/empty.
use screenpipe_screen::{
    capture_screenshot_by_window::{ExclusionSources, WindowFilters},
    monitor::{get_default_monitor, get_monitor_by_id},
};
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};


use image::DynamicImage;
use screenpipe_screen::monitor::SafeMonitor;
mod monitor {
    pub use screenpipe_screen::monitor::*;
    pub fn sck_capture_max_width() -> u32 { 0 }
}
#[cfg(target_os = "macos")]
#[path = "native_soak_support/baseline_macos.rs"]
mod baseline;
#[cfg(target_os = "linux")]
#[path = "native_soak_support/baseline_linux.rs"]
mod baseline;
fn window_allowed(filters: &WindowFilters, detector: Option<&dyn screenpipe_a11y::incognito::IncognitoDetector>, app: &str, title: &str, pid: i32) -> bool {
    !app.is_empty() && filters.is_valid(app, title) && !filters.is_title_suggesting_blocked_url(title) && !detector.is_some_and(|d| d.is_incognito(app, pid, title))
}
async fn capture_monitor_image_filtered(monitor: &SafeMonitor, filters: &WindowFilters, sources: ExclusionSources, excluded: &[u32], fresh: bool) -> anyhow::Result<(DynamicImage, Duration)> {
    if !filters.has_window_patterns() { return screenpipe_screen::screenshot_privacy::capture_monitor_image_filtered(monitor, filters, sources, excluded, fresh).await; }
    let start = Instant::now();
    Ok((baseline::capture_filtered(monitor, filters, sources, fresh).await?, start.elapsed()))
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let out = PathBuf::from(args.get(1).expect("output directory"));
    std::fs::create_dir_all(&out)?;
    let mode = args.get(2).map(String::as_str).unwrap_or("exclude");
    let id: u32 = args.get(3).map(|s| s.parse()).transpose()?.unwrap_or(0);
    let count: u32 = args.get(4).map(|s| s.parse()).transpose()?.unwrap_or(10);
    let interval: u64 = args.get(5).map(|s| s.parse()).transpose()?.unwrap_or(100);
    #[cfg(target_os = "macos")]
    if let Some(cap) = args.get(6) {
        screenpipe_screen::monitor::set_sck_capture_max_width(cap.parse()?);
    }
    let monitor = if id == 0 {
        get_default_monitor().await
    } else {
        get_monitor_by_id(id).await
    }
    .ok_or_else(|| anyhow::anyhow!("missing monitor"))?;
    let filters = match mode {
        "none" => WindowFilters::new(&[], &[], &[]),
        "include" => WindowFilters::new(
            &["::PrivacyBlocked".into()],
            &["::PrivacyAllowed".into()],
            &[],
        ),
        "empty" => WindowFilters::new(&[], &["::NoSuchWindow".into()], &[]),
        "nomatch" => WindowFilters::new(&["::NeverPresentWindow".into()], &[], &[]),
        _ => WindowFilters::new(&["::PrivacyBlocked".into()], &[], &[]),
    };
    let writer =
        screenpipe_screen::snapshot_writer::SnapshotWriter::new(out.join("snapshots"), 90, 0);
    let start = Instant::now();
    let mut saved = 0;
    let mut rejected = 0;
    let mut leaked = 0;
    for index in 0..count {
        match capture_monitor_image_filtered(
            &monitor,
            &filters,
            ExclusionSources::default(),
            &[],
            true,
        )
        .await
        {
            Ok((image, time)) => {
                let path = writer.write(&image, chrono::Utc::now(), monitor.id())?;
                let stored = image::open(&path)?.to_rgb8();
                let rgb = image.to_rgb8();
                let marker = |p: &&image::Rgb<u8>| p[0] > 200 && p[1] < 60 && p[2] > 200;
                let forbidden = rgb.pixels().filter(marker).count();
                let stored_forbidden = stored.pixels().filter(marker).count();
                if forbidden > 0 || stored_forbidden > 0 {
                    leaked += 1;
                }
                if saved < 2 {
                    image.save(out.join(format!("frame-{index}.png")))?;
                }
                println!(
                    "{}",
                    serde_json::json!({"index":index,"saved":true,"path":path,"width":image.width(),"height":image.height(),"capture_ms":time.as_secs_f64()*1000.0,"forbidden_pixels":forbidden,"stored_forbidden_pixels":stored_forbidden})
                );
                saved += 1;
            }
            Err(error) => {
                rejected += 1;
                println!(
                    "{}",
                    serde_json::json!({"index":index,"saved":false,"error":error.to_string()})
                );
            }
        }
        if interval > 0 {
            tokio::time::sleep(Duration::from_millis(interval)).await;
        }
    }
    println!(
        "{}",
        serde_json::json!({"summary":true,"saved":saved,"rejected":rejected,"leaked":leaked,"elapsed_ms":start.elapsed().as_millis()})
    );
    anyhow::ensure!(saved > 0, "no screenshots stored");
    anyhow::ensure!(
        matches!(mode, "none" | "nomatch") || leaked == 0,
        "excluded marker persisted in {leaked} frames"
    );
    Ok(())
}
