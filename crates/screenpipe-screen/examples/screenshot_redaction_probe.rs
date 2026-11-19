// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Native acceptance/soak probe. Run only on an isolated synthetic desktop.
//! OUT MODE MONITOR FRAMES INTERVAL_MS [FPS]; MODE=exclude/include/none/empty/policy-cycle.
//! INTERVAL_MS schedules request starts; slow runs still finish every request.
//! Windows `cadence` mode uses the configured FPS instead of INTERVAL_MS and
//! checks that each slot yields a fresh, useful, redacted frame on one stream.
use screenpipe_screen::{
    capture_screenshot_by_window::{ExclusionSources, WindowFilters},
    monitor::{get_default_monitor, get_monitor_by_id},
    screenshot_privacy::capture_monitor_frame_filtered,
};
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .try_init()
        .ok();
    let args: Vec<String> = std::env::args().collect();
    let out = PathBuf::from(args.get(1).expect("output directory"));
    std::fs::create_dir_all(&out)?;
    let mode = args.get(2).map(String::as_str).unwrap_or("exclude");
    let id: u32 = args.get(3).map(|s| s.parse()).transpose()?.unwrap_or(0);
    let count: u32 = args.get(4).map(|s| s.parse()).transpose()?.unwrap_or(10);
    let interval: u64 = args.get(5).map(|s| s.parse()).transpose()?.unwrap_or(100);
    #[cfg(target_os = "windows")]
    let cadence = mode == "cadence";
    #[cfg(target_os = "windows")]
    if cadence {
        anyhow::ensure!(count > 1, "cadence mode requires multiple samples");
    }
    if let Some(cap) = args.get(6) {
        #[cfg(target_os = "macos")]
        screenpipe_screen::monitor::set_sck_capture_max_width(cap.parse()?);
        #[cfg(target_os = "windows")]
        screenpipe_screen::screenshot_rate::set(cap.parse()?)?;
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        anyhow::bail!("MAX_WIDTH is unsupported on this platform: {cap}");
    }
    if let Some(fps) = args.get(7) {
        screenpipe_screen::screenshot_rate::set(fps.parse()?)?;
    }
    #[cfg(target_os = "windows")]
    let (target_fps, period) = {
        let fps = screenpipe_screen::screenshot_rate::current();
        let period = if cadence {
            Duration::from_secs_f64(1.0 / f64::from(fps))
        } else {
            Duration::from_millis(interval)
        };
        (fps, period)
    };
    #[cfg(not(target_os = "windows"))]
    let period = Duration::from_millis(interval);
    let monitor = if id == 0 {
        get_default_monitor().await
    } else {
        get_monitor_by_id(id).await
    }
    .ok_or_else(|| anyhow::anyhow!("missing monitor"))?;
    #[cfg(target_os = "macos")]
    let _source = screenpipe_screen::screenshot_privacy::own_cached_source(monitor.id());
    let filters = match mode {
        "exclude" | "policy-cycle" => WindowFilters::new(&["::PrivacyBlocked".into()], &[], &[]),
        #[cfg(target_os = "windows")]
        "cadence" => WindowFilters::new(&["::PrivacyBlocked".into()], &[], &[]),
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
        "title-churn" => WindowFilters::new(&["whatsapp".into(), "zee5".into()], &[], &[]),
        _ => anyhow::bail!("unknown mode: {mode}"),
    };
    let writer =
        screenpipe_screen::snapshot_writer::SnapshotWriter::new(out.join("snapshots"), 90, 0);
    #[cfg(target_os = "windows")]
    let mut previous_frame = if cadence {
        let warmup = capture_monitor_frame_filtered(
            &monitor,
            &filters,
            ExclusionSources::default(),
            &[],
            true,
        )
        .await?;
        Some((
            warmup.session_id,
            warmup.sequence,
            warmup.system_relative_time,
        ))
    } else {
        None
    };
    let start = Instant::now();
    let mut saved = 0;
    let mut rejected = 0;
    let mut leaked = 0;
    let mut usable = 0;
    let (mut useful_in_first_allowed_phase, mut useful_in_recovery_phase) = (0, 0);
    let (mut first_allowed_denominator, mut recovery_denominator) = (0, 0);
    let mut fully_excluded_frames = 0;
    #[cfg(target_os = "windows")]
    let mut cadence_violations = 0u32;
    #[cfg(target_os = "windows")]
    let mut missed_deadlines = 0u32;
    let mut next_capture = tokio::time::Instant::now();
    for index in 0..count {
        tokio::time::sleep_until(next_capture).await;
        next_capture += period;
        let requested_at = chrono::Utc::now();
        // Exercise configuration changes within one source lifetime, including
        // fully black output, without restarting the whole-display stream.
        let cycle_filters = (mode == "policy-cycle").then(|| match (index / 5) % 3 {
            0 => WindowFilters::new(&["::PrivacyBlocked".into()], &[], &[]),
            1 => WindowFilters::new(&[], &["::NoSuchWindow".into()], &[]),
            _ => WindowFilters::new(
                &["::PrivacyBlocked".into()],
                &["::PrivacyAllowed".into()],
                &[],
            ),
        });
        match capture_monitor_frame_filtered(
            &monitor,
            cycle_filters.as_ref().unwrap_or(&filters),
            ExclusionSources::default(),
            &[],
            true,
        )
        .await
        {
            Ok(frame) => {
                let cache_age_ms = (requested_at - frame.captured_at)
                    .num_microseconds()
                    .map(|age| age as f64 / 1000.0);
                let time = frame.duration;
                let system_relative_time = frame.system_relative_time;
                let native_sequence = frame.sequence;
                let session_id = frame.session_id;
                #[cfg(target_os = "windows")]
                if let Some(previous) = &mut previous_frame {
                    if session_id.is_none()
                        || previous.0 != session_id
                        || !matches!((previous.1, native_sequence), (Some(last), Some(current)) if current > last)
                        || !matches!((previous.2, system_relative_time), (Some(last), Some(current)) if current > last)
                    {
                        cadence_violations += 1;
                    }
                    *previous = (session_id, native_sequence, system_relative_time);
                }
                let image = frame.image;
                let write_start = Instant::now();
                let path = writer.write(&image, frame.captured_at, monitor.id())?;
                let write_ms = write_start.elapsed().as_secs_f64() * 1000.0;
                #[cfg(target_os = "windows")]
                if cadence && tokio::time::Instant::now() > next_capture {
                    missed_deadlines += 1;
                }
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
                if allowed > 0 && stored_allowed > 0 {
                    usable += 1;
                }
                #[cfg(target_os = "windows")]
                if mode == "policy-cycle" {
                    match (index / 5) % 3 {
                        0 => {
                            first_allowed_denominator += 1;
                            if allowed > 0 && stored_allowed > 0 {
                                useful_in_first_allowed_phase += 1;
                            }
                        }
                        1 => {
                            if rgb.pixels().all(|pixel| pixel.0 == [0, 0, 0]) {
                                fully_excluded_frames += 1;
                            }
                        }
                        _ => {
                            recovery_denominator += 1;
                            if allowed > 0 && stored_allowed > 0 {
                                useful_in_recovery_phase += 1;
                            }
                        }
                    }
                }
                let partial_alpha = rgb.pixels().filter(partial_alpha_marker).count();
                if forbidden > 0 || stored_forbidden > 0 {
                    leaked += 1;
                }
                if saved < 2 {
                    image.save(out.join(format!("frame-{index}.png")))?;
                }
                println!(
                    "{}",
                    serde_json::json!({"index":index,"saved":true,"path":path,"width":image.width(),"height":image.height(),"capture_ms":time.as_secs_f64()*1000.0,"requested_at":requested_at,"captured_at":frame.captured_at,"native_timestamp":frame.native_timestamp,"session_id":session_id,"system_relative_time":system_relative_time,"native_sequence":native_sequence,"cache_age_ms":cache_age_ms,"write_ms":write_ms,"read_ms":read_ms,"forbidden_pixels":forbidden,"stored_forbidden_pixels":stored_forbidden,"allowed_pixels":allowed,"stored_allowed_pixels":stored_allowed,"partial_alpha_pixels":partial_alpha})
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
    }
    #[cfg(target_os = "windows")]
    let elapsed = start.elapsed();
    #[cfg(target_os = "macos")]
    screenpipe_screen::stream_invalidation::invalidate_streams();
    println!(
        "{}",
        serde_json::json!({"summary":true,"scheduled":count,"captured_and_stored":saved,"saved":saved,"rejected":rejected,"usable":usable,"leaked":leaked,"elapsed_ms":start.elapsed().as_millis(),"useful_first_allowed":useful_in_first_allowed_phase,"first_allowed_denominator":first_allowed_denominator,"fully_excluded_frames":fully_excluded_frames,"useful_recovery":useful_in_recovery_phase,"recovery_denominator":recovery_denominator})
    );
    anyhow::ensure!(saved > 0, "no screenshots stored");
    #[cfg(target_os = "windows")]
    if cadence {
        let budget = period * count;
        anyhow::ensure!(
            saved == count
                && usable == count
                && leaked == 0
                && cadence_violations == 0
                && missed_deadlines == 0
                && elapsed <= budget,
            "{target_fps} fps verification failed: {saved}/{count} stored, {usable}/{count} useful, {leaked} leaked, {cadence_violations} repeated/missing/changed source frames, {missed_deadlines} missed deadlines, elapsed {elapsed:?}, budget {budget:?}"
        );
    }
    #[cfg(target_os = "windows")]
    if mode == "policy-cycle" {
        anyhow::ensure!(
            rejected == 0,
            "{rejected}/{count} samples rejected during policy churn"
        );
        anyhow::ensure!(
            first_allowed_denominator > 0
                && useful_in_first_allowed_phase == first_allowed_denominator,
            "first allowed phase had {useful_in_first_allowed_phase}/{first_allowed_denominator} useful frames"
        );
        anyhow::ensure!(
            fully_excluded_frames > 0,
            "fully excluded phase produced no verified black frame"
        );
        anyhow::ensure!(
            recovery_denominator > 0 && useful_in_recovery_phase == recovery_denominator,
            "recovery allowed phase had {useful_in_recovery_phase}/{recovery_denominator} useful frames"
        );
    }
    #[cfg(target_os = "windows")]
    if matches!(mode, "exclude" | "include") {
        anyhow::ensure!(
            usable == count,
            "only {usable}/{count} scheduled frames contained useful allowed output"
        );
    }
    anyhow::ensure!(
        !matches!(
            mode,
            "exclude" | "include" | "empty" | "blank" | "title-churn" | "policy-cycle"
        ) || leaked == 0,
        "excluded marker persisted in {leaked} frames"
    );
    Ok(())
}
