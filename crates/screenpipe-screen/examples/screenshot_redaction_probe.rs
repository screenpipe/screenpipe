// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Native acceptance/soak probe. Run only on an isolated synthetic desktop.
//! OUT MODE MONITOR FRAMES INTERVAL_MS [MAX_WIDTH]; MODE=exclude/include/none/empty.
use screenpipe_screen::{
    capture_screenshot_by_window::{ExclusionSources, WindowFilters},
    monitor::{get_default_monitor, get_monitor_by_id},
    screenshot_privacy::capture_monitor_image_filtered,
};
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let out = PathBuf::from(args.get(1).expect("output directory"));
    std::fs::create_dir_all(&out)?;
    let mode = args.get(2).map(String::as_str).unwrap_or("exclude");
    let id: u32 = args.get(3).map(|s| s.parse()).transpose()?.unwrap_or(0);
    let count: u32 = args.get(4).map(|s| s.parse()).transpose()?.unwrap_or(10);
    let interval: u64 = args.get(5).map(|s| s.parse()).transpose()?.unwrap_or(100);
    if let Some(cap) = args.get(6) {
        #[cfg(target_os = "macos")]
        screenpipe_screen::monitor::set_sck_capture_max_width(cap.parse()?);
        #[cfg(not(target_os = "macos"))]
        anyhow::bail!("MAX_WIDTH is unsupported on this platform: {cap}");
    }
    let monitor = if id == 0 {
        get_default_monitor().await
    } else {
        get_monitor_by_id(id).await
    }
    .ok_or_else(|| anyhow::anyhow!("missing monitor"))?;
    let filters = match mode {
        "exclude" => WindowFilters::new(&["::PrivacyBlocked".into()], &[], &[]),
        "none" => WindowFilters::new(&[], &[], &[]),
        "include" => WindowFilters::new(
            &["::PrivacyBlocked".into()],
            &["::PrivacyAllowed".into()],
            &[],
        ),
        "includeapp" => WindowFilters::new(&[], &["windows_privacy_fixture".into()], &[]),
        "blank" => WindowFilters::new(
            &["::PrivacyBlocked".into()],
            &["windows_privacy_fixture".into()],
            &[],
        ),
        "shell-exclude" => WindowFilters::new(&["Windows Explorer".into()], &[], &[]),
        "empty" => WindowFilters::new(&[], &["::NoSuchWindow".into()], &[]),
        "nomatch" => WindowFilters::new(&["::NeverPresentWindow".into()], &[], &[]),
        _ => anyhow::bail!("unknown mode: {mode}"),
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
                let write_start = Instant::now();
                let path = writer.write(&image, chrono::Utc::now(), monitor.id())?;
                let write_ms = write_start.elapsed().as_secs_f64() * 1000.0;
                let read_start = Instant::now();
                let stored = image::open(&path)?.to_rgb8();
                let read_ms = read_start.elapsed().as_secs_f64() * 1000.0;
                let rgb = image.to_rgb8();
                let marker = |p: &&image::Rgb<u8>| p[0] > 200 && p[1] < 60 && p[2] > 200;
                let allowed_marker = |p: &&image::Rgb<u8>| p[0] < 30 && p[1] > 220 && p[2] > 220;
                let partial_alpha_marker = |p: &&image::Rgb<u8>| {
                    p[0] < 30 && (90..=170).contains(&p[1]) && (90..=170).contains(&p[2])
                };
                let forbidden = rgb.pixels().filter(marker).count();
                let stored_forbidden = stored.pixels().filter(marker).count();
                let allowed = rgb.pixels().filter(allowed_marker).count();
                let stored_allowed = stored.pixels().filter(allowed_marker).count();
                let partial_alpha = rgb.pixels().filter(partial_alpha_marker).count();
                if forbidden > 0 || stored_forbidden > 0 {
                    leaked += 1;
                }
                if saved < 2 {
                    image.save(out.join(format!("frame-{index}.png")))?;
                }
                println!(
                    "{}",
                    serde_json::json!({"index":index,"saved":true,"path":path,"width":image.width(),"height":image.height(),"capture_ms":time.as_secs_f64()*1000.0,"write_ms":write_ms,"read_ms":read_ms,"forbidden_pixels":forbidden,"stored_forbidden_pixels":stored_forbidden,"allowed_pixels":allowed,"stored_allowed_pixels":stored_allowed,"partial_alpha_pixels":partial_alpha})
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
        !matches!(mode, "exclude" | "include" | "empty" | "blank") || leaked == 0,
        "excluded marker persisted in {leaked} frames"
    );
    Ok(())
}
