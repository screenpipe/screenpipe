// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Native pixel regression probe. Run on an isolated synthetic desktop only.
use screenpipe_screen::{
    capture_screenshot_by_window::{get_excluded_sck_window_ids, ExclusionSources, WindowFilters},
    monitor::{get_default_monitor, get_monitor_by_id},
    screenshot_privacy::capture_monitor_image_filtered,
};
use std::{path::PathBuf, time::Duration};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let out = PathBuf::from(args.get(1).expect("output directory"));
    std::fs::create_dir_all(&out)?;
    let id: u32 = args.get(2).map(|s| s.parse()).transpose()?.unwrap_or(0);
    let monitor = if id == 0 {
        get_default_monitor().await
    } else {
        get_monitor_by_id(id).await
    }
    .ok_or_else(|| anyhow::anyhow!("missing monitor"))?;
    let mode = args.get(3).map(String::as_str).unwrap_or("include");
    let filters = match mode {
        "exclude" => WindowFilters::new(&["::PrivacyBlocked".to_string()], &[], &[]),
        "none" => WindowFilters::new(&[], &[], &[]),
        "empty" => WindowFilters::new(&[], &["::NoSuchWindow".to_string()], &[]),
        _ => WindowFilters::new(&[], &["::PrivacyAllowed".to_string()], &[]),
    };
    let sources = ExclusionSources::default();
    let baseline = args.get(4).is_some_and(|v| v == "baseline");
    #[cfg(target_os = "macos")]
    if let Some(width) = args.get(5) {
        screenpipe_screen::monitor::set_sck_capture_max_width(width.parse()?);
    }
    let writer =
        screenpipe_screen::snapshot_writer::SnapshotWriter::new(out.join("snapshots"), 90, 0);
    let mut leaks = 0;
    let mut useful = 0;
    for n in 0..10 {
        let excluded = get_excluded_sck_window_ids(&filters, sources);
        // Same boundary as do_capture: resolve, settle focus, capture.
        std::fs::write(out.join("resolved"), n.to_string())?;
        tokio::time::sleep(Duration::from_millis(750)).await;
        let (image, capture_time) = if baseline {
            screenpipe_screen::utils::capture_monitor_image_with_freshness(
                &monitor, &excluded, true,
            )
            .await?
        } else {
            capture_monitor_image_filtered(&monitor, &filters, sources, &excluded, true).await?
        };
        // Inspect the actual durable JPEG too, not merely an in-memory buffer.
        let saved = writer.write(&image, chrono::Utc::now(), monitor.id())?;
        let stored = image::open(saved)?.to_rgb8();
        let stored_forbidden = stored
            .pixels()
            .filter(|p| p[0] > 200 && p[1] < 60 && p[2] > 200)
            .count();
        let stored_allowed = stored
            .pixels()
            .filter(|p| p[0] < 60 && p[1] > 200 && p[2] > 200)
            .count();
        let rgb = image.to_rgb8();
        let forbidden = rgb
            .pixels()
            .filter(|p| p[0] > 200 && p[1] < 60 && p[2] > 200)
            .count();
        let allowed = rgb
            .pixels()
            .filter(|p| p[0] < 60 && p[1] > 200 && p[2] > 200)
            .count();
        if forbidden > 0 || stored_forbidden > 0 {
            leaks += 1;
        }
        if allowed > 100 && stored_allowed > 100 {
            useful += 1;
        }
        image.save(out.join(format!("frame-{n}.png")))?;
        println!("{{\"frame\":{n},\"forbidden_pixels\":{forbidden},\"allowed_pixels\":{allowed},\"stored_forbidden_pixels\":{stored_forbidden},\"stored_allowed_pixels\":{stored_allowed},\"capture_ms\":{}}}", capture_time.as_millis());
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    println!("{{\"leaked_frames\":{leaks},\"useful_frames\":{useful}}}");
    anyhow::ensure!(
        useful == 10,
        "fixture invalid: no allowed content captured and stored"
    );
    anyhow::ensure!(
        mode == "none" || leaks == 0,
        "excluded window pixels persisted in {leaks} frames"
    );
    Ok(())
}
