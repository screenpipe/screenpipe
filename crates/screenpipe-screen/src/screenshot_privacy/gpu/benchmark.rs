// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use super::super::scene::{paint_black, Rect};
use crate::snapshot_writer::SnapshotWriter;
use anyhow::{ensure, Result};
use image::{imageops::FilterType, DynamicImage};
use serde_json::json;
use std::{
    path::Path,
    thread,
    time::{Duration, Instant},
};

const INPUT: (u32, u32) = (2560, 1440);
const OUTPUT: (u32, u32) = (1920, 1080);
const TARGET: u32 = 20;
const JPEG_QUALITY: u8 = 80;
const VARIANTS: u32 = 4;

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use cidre::{arc, cf, cv};

    pub(super) type Fixture = arc::R<cv::PixelBuf>;
    pub(super) struct Native(super::super::metal::Metal);

    impl Native {
        pub(super) fn new() -> Result<Self> {
            Ok(Self(super::super::metal::Metal::new()?))
        }
        pub(super) fn adapter(&self) -> Result<String> {
            Ok(self.0.adapter())
        }

        pub(super) fn fixture(&self, data: &[u8]) -> Result<Fixture> {
            let surface = cf::Dictionary::new();
            let attrs = cf::Dictionary::with_keys_values(
                &[
                    cv::pixel_buffer::keys::io_surf_props(),
                    cv::pixel_buffer::keys::metal_compatibility(),
                ],
                &[&*surface, cf::Boolean::value_true()],
            )
            .unwrap();
            let mut buf = cv::PixelBuf::new(
                INPUT.0 as usize,
                INPUT.1 as usize,
                cv::PixelFormat::_32_BGRA,
                Some(&attrs),
            )
            .map_err(|e| anyhow::anyhow!("fixture buffer: {e:?}"))?;
            let stride = buf.bytes_per_row();
            let flags = cv::pixel_buffer::LockFlags::DEFAULT;
            unsafe { buf.lock_base_addr(flags) }
                .result()
                .map_err(|e| anyhow::anyhow!("fixture buffer lock: {e:?}"))?;
            let row = INPUT.0 as usize * 4;
            unsafe {
                let ptr = buf.base_address().cast_mut().cast::<u8>();
                for (y, pixels) in data.chunks_exact(row).enumerate() {
                    std::ptr::copy_nonoverlapping(pixels.as_ptr(), ptr.add(y * stride), row);
                }
            }
            unsafe { buf.unlock_lock_base_addr(flags) }
                .result()
                .map_err(|e| anyhow::anyhow!("fixture buffer unlock: {e:?}"))?;
            Ok(buf)
        }

        pub(super) fn cpu(&self, fixture: &Fixture) -> Result<DynamicImage> {
            let mut fixture = fixture.clone();
            let source = super::super::super::macos::rgba(&mut fixture)?.into_rgba8();
            let mut opaque =
                image::RgbaImage::from_pixel(INPUT.0, INPUT.1, image::Rgba([0, 0, 0, 255]));
            super::super::super::scene::overlay_premultiplied(&mut opaque, &source, 0, 0, None);
            Ok(DynamicImage::ImageRgba8(opaque))
        }

        pub(super) fn gpu(
            &mut self,
            fixture: &Fixture,
            masks: Option<&[Rect]>,
            size: (u32, u32),
            slot: usize,
        ) -> Result<DynamicImage> {
            super::super::metal::objc_pool(|| self.0.render(fixture, masks, size, slot))
        }
    }

    pub(super) fn cpu_time() -> Result<Duration> {
        let mut r = std::mem::MaybeUninit::<libc::rusage>::uninit();
        ensure!(
            unsafe { libc::getrusage(libc::RUSAGE_SELF, r.as_mut_ptr()) } == 0,
            "getrusage failed"
        );
        let r = unsafe { r.assume_init() };
        let duration = |t: libc::timeval| {
            Duration::from_secs(t.tv_sec as u64) + Duration::from_micros(t.tv_usec as u64)
        };
        Ok(duration(r.ru_utime) + duration(r.ru_stime))
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::*;
    pub(super) use crate::wgc_capture::gpu_d3d11::Synthetic;
    pub(super) type Fixture = windows::Win32::Graphics::Direct3D11::ID3D11Texture2D;

    pub(super) struct Native(Synthetic);
    impl Native {
        pub(super) fn new() -> Result<Self> {
            Ok(Self(Synthetic::new(INPUT)?))
        }
    }
    impl std::ops::Deref for Native {
        type Target = Synthetic;
        fn deref(&self) -> &Synthetic {
            &self.0
        }
    }
    impl std::ops::DerefMut for Native {
        fn deref_mut(&mut self) -> &mut Synthetic {
            &mut self.0
        }
    }

    pub(super) fn cpu_time() -> Result<Duration> {
        use windows::Win32::Foundation::FILETIME;
        use windows::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};
        let (mut creation, mut exit, mut kernel, mut user) = (
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
        );
        unsafe {
            GetProcessTimes(
                GetCurrentProcess(),
                &mut creation,
                &mut exit,
                &mut kernel,
                &mut user,
            )?
        };
        let duration = |t: FILETIME| {
            Duration::from_nanos(
                ((u64::from(t.dwHighDateTime) << 32) | u64::from(t.dwLowDateTime)) * 100,
            )
        };
        Ok(duration(kernel) + duration(user))
    }
}

fn bounds(i: u32) -> Rect {
    Rect {
        x: 180 + i64::from(i) * 67,
        y: 260 + i64::from(i) * 23,
        width: 640,
        height: 420,
    }
}

fn source(rect: Rect) -> Vec<u8> {
    let mut bgra = Vec::with_capacity((INPUT.0 * INPUT.1 * 4) as usize);
    for y in 0..INPUT.1 {
        for x in 0..INPUT.0 {
            if rect.intersects(Rect {
                x: x.into(),
                y: y.into(),
                width: 1,
                height: 1,
            }) {
                bgra.extend([0, 0, 255, 255]);
            } else {
                // Allowed pixels have zero red. Any surviving red in raw
                // output, even at a resize boundary, came from the marker.
                bgra.extend([32 + ((x / 8) % 71) as u8, 64 + ((y / 9) % 83) as u8, 0, 255]);
            }
        }
    }
    bgra
}

fn plan(index: u32, moving: bool) -> (u32, Option<[Rect; 2]>) {
    let i = if moving { index % VARIANTS } else { 0 };
    let mask = if moving && index % 7 == 6 {
        bounds((i + VARIANTS - 1) % VARIANTS)
    } else {
        bounds(i)
    };
    (
        i,
        (index % 13 != 12).then_some([
            mask,
            Rect {
                x: -9,
                y: -3,
                width: 36,
                height: 53,
            },
        ]),
    )
}

fn render(
    native: &mut platform::Native,
    fixture: &platform::Fixture,
    masks: Option<&[Rect]>,
    gpu: bool,
    selected: bool,
) -> Result<(DynamicImage, Option<DynamicImage>)> {
    if gpu {
        let full = native.gpu(fixture, masks, INPUT, 0)?;
        let resized = selected
            .then(|| native.gpu(fixture, masks, OUTPUT, 1))
            .transpose()?;
        return Ok((full, resized));
    }
    let mut full = native.cpu(fixture)?.into_rgba8();
    if let Some(masks) = masks {
        for rect in masks {
            paint_black(&mut full, *rect);
        }
    } else {
        paint_black(
            &mut full,
            Rect {
                x: 0,
                y: 0,
                width: INPUT.0,
                height: INPUT.1,
            },
        );
    }
    let full = DynamicImage::ImageRgba8(full);
    let resized = selected.then(|| full.resize(OUTPUT.0, u32::MAX, FilterType::Triangle));
    Ok((full, resized))
}

fn validate(native: &mut platform::Native, fixtures: &[platform::Fixture]) -> Result<()> {
    let black = |image: &DynamicImage| {
        image
            .as_rgba8()
            .unwrap()
            .pixels()
            .all(|p| p.0 == [0, 0, 0, 255])
    };
    let exposed = |image: &DynamicImage| {
        image
            .as_rgba8()
            .unwrap()
            .pixels()
            .filter(|p| p[0] != 0)
            .count()
    };
    for (i, fixture) in fixtures.iter().enumerate() {
        for (case, masks) in [
            ("current", Some([bounds(i as u32)])),
            (
                "lagged",
                Some([bounds((i as u32 + VARIANTS - 1) % VARIANTS)]),
            ),
            ("unavailable", None),
        ] {
            let rects = masks.as_ref().map(|p| p.as_slice());
            let (cpu_full, cpu_out) = render(native, fixture, rects, false, true)?;
            let (gpu_full, gpu_out) = render(native, fixture, rects, true, true)?;
            ensure!(
                cpu_full.as_bytes() == gpu_full.as_bytes(),
                "native-size mask differs ({case}, fixture {i})"
            );
            let (cpu_out, gpu_out) = (cpu_out.unwrap(), gpu_out.unwrap());
            ensure!(
                (gpu_out.width(), gpu_out.height()) == OUTPUT,
                "GPU dimensions differ"
            );
            let max_delta = cpu_out
                .as_bytes()
                .iter()
                .zip(gpu_out.as_bytes())
                .map(|(a, b)| a.abs_diff(*b))
                .max()
                .unwrap();
            ensure!(
                max_delta <= 1,
                "triangle resize differs by {max_delta} ({case}, fixture {i})"
            );
            let (cpu_exposed, gpu_exposed) = (exposed(&cpu_out), exposed(&gpu_out));
            ensure!(
                cpu_exposed == gpu_exposed,
                "resized exposure differs ({case}, fixture {i})"
            );
            ensure!(
                (cpu_exposed > 0) == (case == "lagged"),
                "unexpected exposure ({case}, fixture {i})"
            );
            if masks.is_none() {
                ensure!(
                    black(&gpu_full) && black(&gpu_out),
                    "missing plan was not black"
                );
            }
            println!(
                "{}",
                json!({"fixture":i,"plan":case,"cpu_exposed":cpu_exposed,
                "gpu_exposed":gpu_exposed,"max_channel_delta":max_delta})
            );
        }
    }
    Ok(())
}

fn percentiles(samples: &mut [f64]) -> [f64; 2] {
    samples.sort_by(f64::total_cmp);
    [
        (samples[(samples.len() - 1) / 2] * 1000.0),
        (samples[(samples.len() * 95).div_ceil(100) - 1] * 1000.0),
    ]
}

fn measure(
    native: &mut platform::Native,
    fixtures: &[platform::Fixture],
    root: &Path,
    samples: u32,
    moving: bool,
    gpu: bool,
) -> Result<()> {
    let writer = SnapshotWriter::new(root, JPEG_QUALITY, OUTPUT.0);
    let period = Duration::from_secs(1) / TARGET;
    let (mut alone, mut selected_processing, mut persistence) =
        (Vec::new(), Vec::new(), Vec::new());
    let (mut saved, mut activity, mut idle, mut missed) = (Vec::new(), 0, 0, 0);
    let cpu_start = platform::cpu_time()?;
    let start = Instant::now();
    let mut next = start;
    for i in 0..samples {
        thread::sleep(next.saturating_duration_since(Instant::now()));
        let requested = Instant::now();
        let captured_at = chrono::Utc::now();
        let (fixture, masks) = plan(i, moving);
        let (moving_phase, slot) = (i < samples / 2, i % TARGET);
        // Inject the same activity/idle selection on both paths. All other
        // samples still run the mask and native-size readback.
        let save = if moving_phase {
            slot % (TARGET / 2) == 0
        } else {
            slot == 0
        };
        let (_, resized) = render(
            native,
            &fixtures[fixture as usize],
            masks.as_ref().map(|p| p.as_slice()),
            gpu,
            save,
        )?;
        let processing = requested.elapsed().as_secs_f64();
        if let Some(resized) = resized {
            selected_processing.push(processing);
            saved.push((
                writer.write(&resized, captured_at, 1)?,
                captured_at.timestamp_millis(),
            ));
            persistence.push(requested.elapsed().as_secs_f64());
            if moving_phase {
                activity += 1;
            } else {
                idle += 1;
            }
        } else {
            alone.push(processing);
        }
        next += period;
        if Instant::now() >= next {
            missed += 1;
            next = Instant::now();
        }
    }
    thread::sleep(next.saturating_duration_since(Instant::now()));
    let elapsed = start.elapsed();
    let cpu = platform::cpu_time()?.saturating_sub(cpu_start);
    for (path, timestamp) in saved {
        ensure!(
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with(&format!("{timestamp}_m1")),
            "JPEG path lost capture timestamp"
        );
        let jpeg = std::fs::read(&path)?;
        ensure!(
            jpeg.starts_with(&[0xff, 0xd8, 0xff]),
            "snapshot is not JPEG"
        );
        let image = image::load_from_memory_with_format(&jpeg, image::ImageFormat::Jpeg)?;
        ensure!(
            (image.width(), image.height()) == OUTPUT,
            "stored JPEG size differs"
        );
    }
    println!(
        "{}",
        json!({"path":if gpu {"gpu"} else {"cpu"}, "scene":if moving {"moving"} else {"static"},
        "samples":samples,"target_fps":TARGET,"achieved_fps":f64::from(samples)/elapsed.as_secs_f64(),
        "cpu_seconds":cpu.as_secs_f64(),"cpu_pct_single_core":cpu.as_secs_f64()/elapsed.as_secs_f64()*100.0,
        "deadline_overruns":missed,"activity_saves":activity,"idle_saves":idle,
        "native_mask_readback_median_p95_ms":percentiles(&mut alone),
        "selected_mask_resize_readback_median_p95_ms":percentiles(&mut selected_processing),
        "selected_through_jpeg_median_p95_ms":percentiles(&mut persistence)})
    );
    Ok(())
}

pub fn run(root: &Path, samples: u32) -> Result<()> {
    ensure!(
        samples >= TARGET * 2 && samples % (TARGET * 2) == 0,
        "sample count must cover whole activity and idle seconds (multiples of {})",
        TARGET * 2
    );
    #[cfg(target_os = "macos")]
    return super::metal::objc_pool(|| run_inner(root, samples));
    #[cfg(target_os = "windows")]
    run_inner(root, samples)
}

fn run_inner(root: &Path, samples: u32) -> Result<()> {
    let mut native = platform::Native::new()?;
    println!(
        "{}",
        json!({"adapter":native.adapter()?,"input":INPUT,"output":OUTPUT,"jpeg_quality":JPEG_QUALITY})
    );
    let fixtures = (0..VARIANTS)
        .map(|i| native.fixture(&source(bounds(i))))
        .collect::<Result<Vec<_>>>()?;
    validate(&mut native, &fixtures)?;
    for (gpu, moving) in [(false, false), (true, false), (true, true), (false, true)] {
        measure(
            &mut native,
            &fixtures,
            &root.join(format!("gpu-{gpu}-moving-{moving}")),
            samples,
            moving,
            gpu,
        )?;
    }
    Ok(())
}

pub fn process_cpu_time() -> Result<Duration> {
    platform::cpu_time()
}

pub fn run_preencode_matched() -> Result<()> {
    #[cfg(target_os = "macos")]
    return super::metal::objc_pool(run_preencode_inner);
    #[cfg(target_os = "windows")]
    run_preencode_inner()
}

fn run_preencode_inner() -> Result<()> {
    // Ten seconds of 20 Hz opportunities for each configuration. A late
    // operation skips expired opportunities so it cannot inflate the FPS.
    const SAMPLES: u32 = 10 * TARGET;
    let mut native = platform::Native::new()?;
    println!(
        "{}",
        json!({"adapter": native.adapter()?, "input": INPUT, "output": OUTPUT})
    );
    let fixtures = (0..VARIANTS)
        .map(|i| native.fixture(&source(bounds(i))))
        .collect::<Result<Vec<_>>>()?;
    validate(&mut native, &fixtures)?;
    let period = Duration::from_secs(1) / TARGET;
    for (gpu, moving) in [(false, false), (true, false), (true, true), (false, true)] {
        let mut times = Vec::new();
        let mut missed = 0;
        let mut late = 0;
        let cpu_start = platform::cpu_time()?;
        let start = Instant::now();
        for slot in 0..SAMPLES {
            let scheduled = start + period * slot;
            thread::sleep(scheduled.saturating_duration_since(Instant::now()));
            let requested = Instant::now();
            if requested >= scheduled + period {
                missed += 1;
                continue;
            }
            let (fixture, masks) = plan(slot, moving);
            let output = render(
                &mut native,
                &fixtures[fixture as usize],
                masks.as_ref().map(|p| p.as_slice()),
                gpu,
                true,
            )?;
            std::hint::black_box(&output);
            times.push(requested.elapsed().as_secs_f64());
            late += u32::from(Instant::now() >= scheduled + period);
        }
        thread::sleep((start + period * SAMPLES).saturating_duration_since(Instant::now()));
        let cpu = platform::cpu_time()?.saturating_sub(cpu_start);
        ensure!(!times.is_empty(), "no pre-encoder output completed");
        println!(
            "{}",
            json!({"path": if gpu {"gpu"} else {"cpu"}, "scene": if moving {"moving"} else {"static"},
                "slots": SAMPLES, "ready": times.len(), "missed_slots": missed, "late_completions": late,
                "ready_fps": f64::from(SAMPLES - missed) / 10.0,
                "cpu_cores": cpu.as_secs_f64() / start.elapsed().as_secs_f64(),
                "ready_p50_p95_ms": percentiles(&mut times)})
        );
    }
    Ok(())
}
