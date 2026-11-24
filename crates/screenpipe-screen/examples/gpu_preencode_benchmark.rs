// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Benchmark completed raw output from the regular screenshot privacy path.

#[cfg(any(target_os = "macos", target_os = "windows"))]
mod bench {
    use anyhow::{ensure, Context, Result};
    use chrono::Utc;
    use image::{imageops::FilterType, GenericImageView};
    use screenpipe_screen::{
        capture_screenshot_by_window::{ExclusionSources, WindowFilters},
        monitor::{get_default_monitor, get_monitor_by_id},
        screenshot_privacy::{
            benchmark_gpu_preencode_matched, benchmark_process_cpu_time,
            capture_monitor_frame_for_snapshot, screenshot_benchmark_counters,
        },
    };
    use serde_json::json;
    use std::time::Duration;
    use tokio::time::Instant;

    const FPS: u32 = 20;
    const WARMUP: u32 = FPS * 6;
    const PHASE: u32 = FPS * 10;
    const WIDTH: u32 = 640;

    pub async fn run() -> Result<()> {
        tracing_subscriber::fmt()
            .with_writer(std::io::stderr)
            .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
            .try_init()
            .ok();
        let mut args: Vec<_> = std::env::args().skip(1).collect();
        let require_hardware = args.first().is_some_and(|arg| arg == "--require-hardware");
        if require_hardware {
            args.remove(0);
        }
        let gpu = args.first().is_none_or(|arg| arg != "--cpu");
        if !gpu {
            args.remove(0);
        }
        ensure!(
            !require_hardware || (cfg!(target_os = "windows") && gpu),
            "--require-hardware requires the Windows Streaming GPU path"
        );
        if args == ["matched"] {
            return benchmark_gpu_preencode_matched();
        }
        ensure!(
            args.len() == 3 || (cfg!(target_os = "windows") && args.len() == 4),
            "usage: gpu_preencode_benchmark matched | [--cpu | --require-hardware] MONITOR_ID START_UNIX_MS TELEMETRY_JSON [WGC_FPS]"
        );
        let id = args[0].parse::<u32>()?;
        #[cfg(target_os = "windows")]
        if require_hardware {
            use windows::Win32::UI::HiDpi::{
                AreDpiAwarenessContextsEqual, GetThreadDpiAwarenessContext,
                SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
            };
            let context = DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2;
            unsafe {
                if !AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(), context).as_bool()
                {
                    SetProcessDpiAwarenessContext(context)
                        .context("setting benchmark display coordinates to physical pixels")?;
                }
            }
        }
        // Vary the WGC producer hint while preserving the fixed 20 Hz
        // consumer schedule. This benchmark process has no recording writer.
        let native_fps = args
            .get(3)
            .map(|fps| fps.parse::<u32>())
            .transpose()?
            .unwrap_or(FPS);
        screenpipe_screen::screenshot_rate::set(native_fps)?;
        #[cfg(target_os = "windows")]
        let native_fps = screenpipe_screen::wgc_capture::configure_benchmark_native_rate(
            native_fps,
            args.get(3).is_some(),
        );
        #[cfg(target_os = "macos")]
        screenpipe_screen::monitor::set_sck_capture_max_width(0);
        let monitor = if id == 0 {
            ensure!(
                cfg!(target_os = "windows"),
                "macOS requires the isolated fixture display ID"
            );
            get_default_monitor().await
        } else {
            get_monitor_by_id(id).await
        }
        .context("fixture display unavailable")?;
        #[cfg(target_os = "macos")]
        ensure!(
            monitor.id() != cidre::cg::DirectDisplayId::main().0,
            "refusing to sample the main Mac display"
        );
        let info = monitor.get_info();
        ensure!(
            require_hardware || (info.width, info.height) == (1024, 768),
            "expected 1024x768 synthetic input, got {}x{}",
            info.width,
            info.height
        );
        ensure!(
            info.width > 0 && info.height > 0,
            "fixture display has no dimensions"
        );
        let output_width = WIDTH.min(info.width);
        let ratio = f64::from(output_width) / f64::from(info.width);
        let output_height = (f64::from(info.height) * ratio).round().max(1.0) as u32;
        #[cfg(target_os = "macos")]
        let _lease = screenpipe_screen::screenshot_privacy::own_cached_source(monitor.id());
        let filters =
            WindowFilters::new(&["::PrivacyBlocked".into()], &[], &[]).with_streaming_mode(true);
        let filters = if gpu {
            filters
        } else {
            filters.with_benchmark_cpu_masks()
        };
        ensure!(filters.streaming_mode(), "tracker mode unavailable");
        let period = Duration::from_secs(1) / FPS;
        let (start_us, readiness_ms) = if args[1] == "ready" {
            let began = Instant::now();
            let mut progress = tokio::time::interval(Duration::from_secs(1));
            loop {
                let capture = capture_monitor_frame_for_snapshot(
                    &monitor,
                    &filters,
                    ExclusionSources::default(),
                    &[],
                    false,
                    output_width,
                );
                tokio::pin!(capture);
                let frame = loop {
                    tokio::select! {
                        result = &mut capture => break result?,
                        _ = progress.tick() => {
                            eprintln!("waiting for fixture pixels {}", json!(screenshot_benchmark_counters(&monitor)));
                        }
                    }
                };
                let native_output = &frame.image;
                if (!gpu || frame.snapshot_image.is_some())
                    && native_output.as_rgba8().is_some_and(|pixels| {
                        let [r, g, b, _] = pixels.get_pixel(100, 100).0;
                        r < 60 && g > 150 && b > 150
                    })
                {
                    break (
                        Utc::now().timestamp_micros() + 1_000_000,
                        Some(began.elapsed().as_secs_f64() * 1000.0),
                    );
                }
                tokio::time::sleep(period).await;
            }
        } else {
            (args[1].parse::<i64>()? * 1000, None)
        };
        if readiness_ms.is_some() {
            std::fs::write(format!("{}.ready", args[2]), (start_us / 1000).to_string())?;
        }
        let delay = start_us - Utc::now().timestamp_micros();
        ensure!(delay > 0, "setup exceeded fixture lead time");
        let anchor = Instant::now() + Duration::from_micros(delay as u64);
        let mut rows = Vec::with_capacity((WARMUP + 2 * PHASE) as usize);
        let mut phase_cpu = Vec::new();
        let mut flow = Vec::new();
        #[cfg(target_os = "windows")]
        let mut adapters: Vec<String> = Vec::new();
        #[cfg(not(target_os = "windows"))]
        let adapters: Vec<String> = Vec::new();
        let mut last_native_key = None;
        for slot in 0..WARMUP + 2 * PHASE {
            let scheduled = anchor + period * slot;
            tokio::time::sleep_until(scheduled).await;
            if slot == WARMUP || slot == WARMUP + PHASE {
                phase_cpu.push(benchmark_process_cpu_time()?.as_secs_f64());
                flow.push(screenshot_benchmark_counters(&monitor));
                #[cfg(target_os = "windows")]
                if require_hardware {
                    let (name, software) = monitor.benchmark_active_wgc_adapter()?;
                    ensure!(!software, "the active WGC adapter is software: {name}");
                    adapters.push(name);
                }
            }
            let request = Instant::now();
            if request >= scheduled + period {
                rows.push(json!({"slot": slot, "status": "missed_slot"}));
                continue;
            }
            let frame = match capture_monitor_frame_for_snapshot(
                &monitor,
                &filters,
                ExclusionSources::default(),
                &[],
                false,
                output_width,
            )
            .await
            {
                Ok(frame) => frame,
                Err(error) => {
                    rows.push(json!({"slot": slot, "status": "capture_error", "error": format!("{error:#}")}));
                    continue;
                }
            };
            let capture_ms = request.elapsed().as_secs_f64() * 1000.0;
            let capture_us = frame.captured_at.timestamp_micros();
            let native_key = frame
                .system_relative_time
                .or_else(|| frame.sequence.and_then(|s| i64::try_from(s).ok()))
                .or_else(|| frame.native_timestamp.then_some(capture_us));
            let status = match native_key {
                None => "unknown_native_timestamp",
                Some(key) if last_native_key.is_some_and(|previous| key <= previous) => "repeated",
                Some(key) => {
                    last_native_key = Some(key);
                    "distinct"
                }
            };
            let gpu_resized = frame.snapshot_image.is_some();
            let input = frame.image.dimensions();
            ensure!(
                !require_hardware || input == (info.width, info.height),
                "WGC frame dimensions {input:?} differ from monitor metadata {}x{} at slot {slot}",
                info.width,
                info.height
            );
            ensure!(
                !require_hardware || slot < WARMUP || gpu_resized,
                "the Windows hardware path produced no GPU resize for {input:?} at slot {slot}"
            );
            let ready = frame
                .snapshot_image
                .unwrap_or_else(|| {
                    if require_hardware {
                        frame
                            .image
                            .resize_exact(output_width, output_height, FilterType::Triangle)
                    } else {
                        frame
                            .image
                            .resize(output_width, output_height, FilterType::Triangle)
                    }
                })
                .into_rgba8();
            std::hint::black_box(&ready);
            let complete = Instant::now();
            ensure!(
                ready.dimensions() == (output_width, output_height),
                "frame {input:?} at slot {slot} produced {:?} with gpu_resized={gpu_resized}, expected {output_width}x{output_height}",
                ready.dimensions()
            );
            // Qualitative fixture checks run after the timing stop. The matched
            // replay checks every pixel and GPU/CPU parity separately.
            let (mut cyan, mut magenta, mut nonblack) = (0u32, 0u32, 0u32);
            for y in (8..output_height).step_by(8) {
                for x in (8..output_width).step_by(8) {
                    let [r, g, b, _] = ready.get_pixel(x, y).0;
                    cyan += u32::from(r < 60 && g > 150 && b > 150);
                    magenta += u32::from(r > 150 && g < 90 && b > 150);
                    nonblack += u32::from(r != 0 || g != 0 || b != 0);
                }
            }
            rows.push(json!({
                "slot": slot, "status": status, "capture_us": capture_us, "native_key": native_key,
                "capture_ms": capture_ms, "ready_ms": (complete - request).as_secs_f64() * 1000.0,
                "slot_latency_ms": (complete - scheduled).as_secs_f64() * 1000.0,
                "gpu_resized": gpu_resized, "cyan_samples": cyan, "magenta_samples": magenta,
                "nonblack_samples": nonblack
            }));
        }
        tokio::time::sleep_until(anchor + period * (WARMUP + 2 * PHASE)).await;
        phase_cpu.push(benchmark_process_cpu_time()?.as_secs_f64());
        flow.push(screenshot_benchmark_counters(&monitor));
        #[cfg(target_os = "windows")]
        if require_hardware {
            let (name, software) = monitor.benchmark_active_wgc_adapter()?;
            ensure!(!software, "the active WGC adapter is software: {name}");
            adapters.push(name);
        }
        let result = json!({
            "gpu": gpu, "fps": FPS, "native_fps": native_fps, "input": [info.width, info.height], "output":[output_width, output_height],
            "warmup_slots": WARMUP, "phase_slots": PHASE, "phase_cpu": phase_cpu,
            "readiness_ms":readiness_ms, "flow":flow, "hardware_adapters": adapters, "rows": rows
        });
        std::fs::write(&args[2], serde_json::to_vec(&result)?)?;
        #[cfg(target_os = "macos")]
        screenpipe_screen::stream_invalidation::invalidate_streams();
        Ok(())
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    bench::run().await
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn main() -> anyhow::Result<()> {
    anyhow::bail!("requires native macOS or Windows capture")
}
