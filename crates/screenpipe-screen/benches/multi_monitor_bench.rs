//! Multi-monitor performance benchmarks for vision pipeline optimization.
//!
//! Run with: cargo bench -p screenpipe-screen --bench multi_monitor_bench
//!
//! Simulates realistic multi-monitor setups (including ultrawides) to measure:
//! 1. Hash computation: full-res vs downscaled
//! 2. Frame comparison: fixed 640x360 vs proportional downscale
//! 3. Full pipeline cost per capture cycle across N monitors
//! 4. Memory allocation patterns
//!
//! No physical monitors needed — uses synthetic images at real resolutions.

use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};
use image::imageops::FilterType;
use image::{DynamicImage, Rgb, RgbImage};
use screenpipe_screen::frame_comparison::{
    compare_histogram, FrameComparer, FrameComparisonConfig,
};
use std::hash::{DefaultHasher, Hash, Hasher};

// ============================================================
// Realistic monitor configurations
// ============================================================

struct MonitorConfig {
    name: &'static str,
    width: u32,
    height: u32,
}

const MONITORS: &[MonitorConfig] = &[
    MonitorConfig {
        name: "1080p",
        width: 1920,
        height: 1080,
    },
    MonitorConfig {
        name: "1440p",
        width: 2560,
        height: 1440,
    },
    MonitorConfig {
        name: "4K",
        width: 3840,
        height: 2160,
    },
    MonitorConfig {
        name: "ultrawide_49",
        width: 5120,
        height: 1440,
    },
    MonitorConfig {
        name: "superwide_38",
        width: 3840,
        height: 1440,
    },
];

// Realistic multi-monitor setups
const SETUP_STANDARD: &[usize] = &[0, 0]; // 2x 1080p
const SETUP_POWER: &[usize] = &[3, 4, 1]; // 49" ultrawide + 38" superwide + 1440p
const SETUP_TRADER: &[usize] = &[3, 3, 1]; // 2x 49" ultrawide + 1440p

// ============================================================
// Image generators (realistic screen content)
// ============================================================

/// Screen with code/text — high detail, small changes matter
fn create_code_screen(width: u32, height: u32, seed: u8) -> DynamicImage {
    let img = RgbImage::from_fn(width, height, |x, y| {
        let line_h = 18;
        let line_idx = y / line_h;
        let is_text_line = line_idx % 2 == 0;
        let indent = ((line_idx.wrapping_mul(7)) % 8) * 20;

        if is_text_line && x > indent {
            let char_w = 9;
            let char_idx = (x - indent) / char_w;
            // Vary character pattern with seed
            let pattern = (char_idx.wrapping_add(seed as u32).wrapping_mul(31)) % 5;
            match pattern {
                0 => Rgb([50, 150, 50]),   // green (string)
                1 => Rgb([150, 100, 50]),  // orange (keyword)
                2 => Rgb([200, 200, 200]), // light gray (text)
                3 => Rgb([30, 30, 30]),    // dark (punctuation)
                _ => Rgb([40, 40, 46]),    // background
            }
        } else {
            Rgb([40, 40, 46]) // Dark editor background
        }
    });
    DynamicImage::ImageRgb8(img)
}

/// Screen with a chart — mostly static, occasional tick changes
fn create_chart_screen(width: u32, height: u32, seed: u8) -> DynamicImage {
    let img = RgbImage::from_fn(width, height, |x, y| {
        let h = height as f32;
        let w = width as f32;
        let xf = x as f32 / w;
        let yf = y as f32 / h;

        // Chart line (sine wave with seed offset)
        let chart_y = 0.5 + 0.3 * ((xf * 20.0 + seed as f32 * 0.1).sin());
        let dist = (yf - chart_y).abs();

        if dist < 0.005 {
            Rgb([0, 200, 100]) // Green line
        } else if yf > 0.85 {
            // Bottom axis area
            Rgb([60, 60, 70])
        } else {
            Rgb([20, 20, 30]) // Dark chart background
        }
    });
    DynamicImage::ImageRgb8(img)
}

/// Mostly static screen (spotify, chat idle)
fn create_static_screen(width: u32, height: u32, _seed: u8) -> DynamicImage {
    let img = RgbImage::from_fn(width, height, |_x, y| {
        if y < 60 {
            Rgb([30, 30, 30]) // Title bar
        } else if y > height - 80 {
            Rgb([40, 40, 40]) // Bottom bar
        } else {
            Rgb([25, 25, 25]) // Main content area (dark theme)
        }
    });
    DynamicImage::ImageRgb8(img)
}

// ============================================================
// Benchmark: Hash computation at different resolutions
// ============================================================

fn bench_hash_full_vs_downscaled(c: &mut Criterion) {
    let mut group = c.benchmark_group("hash_computation");
    group.sample_size(50);

    for mon in MONITORS {
        let image = create_code_screen(mon.width, mon.height, 0);
        let bytes = (mon.width * mon.height * 3) as u64;
        group.throughput(Throughput::Bytes(bytes));

        // Current: hash full resolution
        group.bench_with_input(BenchmarkId::new("full_res", mon.name), &image, |b, img| {
            b.iter(|| {
                let mut hasher = DefaultHasher::new();
                black_box(img).as_bytes().hash(&mut hasher);
                hasher.finish()
            });
        });

        // Proposed: hash after downscale (factor /4)
        let quarter_w = (mon.width / 4).max(1);
        let quarter_h = (mon.height / 4).max(1);
        let downscaled = image.resize_exact(quarter_w, quarter_h, FilterType::Nearest);
        group.bench_with_input(
            BenchmarkId::new("downscaled_proportional", mon.name),
            &downscaled,
            |b, img| {
                b.iter(|| {
                    let mut hasher = DefaultHasher::new();
                    black_box(img).as_bytes().hash(&mut hasher);
                    hasher.finish()
                });
            },
        );

        // Include the downscale cost
        group.bench_with_input(
            BenchmarkId::new("downscale_then_hash", mon.name),
            &image,
            |b, img| {
                b.iter(|| {
                    let small = img.resize_exact(quarter_w, quarter_h, FilterType::Nearest);
                    let mut hasher = DefaultHasher::new();
                    small.as_bytes().hash(&mut hasher);
                    hasher.finish()
                });
            },
        );
    }

    group.finish();
}

// ============================================================
// Benchmark: Fixed vs proportional downscale comparison
// ============================================================

fn bench_downscale_strategies(c: &mut Criterion) {
    let mut group = c.benchmark_group("downscale_strategy");
    group.sample_size(30);

    for mon in MONITORS {
        let image1 = create_code_screen(mon.width, mon.height, 0);
        let image2 = create_code_screen(mon.width, mon.height, 1); // tiny change

        // Current: fixed 640x360 (distorts ultrawides)
        group.bench_with_input(
            BenchmarkId::new("fixed_640x360", mon.name),
            &(&image1, &image2),
            |b, (img1, img2)| {
                b.iter(|| {
                    let s1 = img1.resize_exact(640, 360, FilterType::Nearest);
                    let s2 = img2.resize_exact(640, 360, FilterType::Nearest);
                    compare_histogram(black_box(&s1), black_box(&s2)).unwrap_or(1.0)
                });
            },
        );

        // Proposed: proportional /4
        let pw = (mon.width / 4).max(1);
        let ph = (mon.height / 4).max(1);
        group.bench_with_input(
            BenchmarkId::new("proportional_div4", mon.name),
            &(&image1, &image2),
            |b, (img1, img2)| {
                b.iter(|| {
                    let s1 = img1.resize_exact(pw, ph, FilterType::Nearest);
                    let s2 = img2.resize_exact(pw, ph, FilterType::Nearest);
                    compare_histogram(black_box(&s1), black_box(&s2)).unwrap_or(1.0)
                });
            },
        );

        // Proposed: proportional /6 (more aggressive)
        let pw6 = (mon.width / 6).max(1);
        let ph6 = (mon.height / 6).max(1);
        group.bench_with_input(
            BenchmarkId::new("proportional_div6", mon.name),
            &(&image1, &image2),
            |b, (img1, img2)| {
                b.iter(|| {
                    let s1 = img1.resize_exact(pw6, ph6, FilterType::Nearest);
                    let s2 = img2.resize_exact(pw6, ph6, FilterType::Nearest);
                    compare_histogram(black_box(&s1), black_box(&s2)).unwrap_or(1.0)
                });
            },
        );
    }

    group.finish();
}

// ============================================================
// Benchmark: Accuracy — does downscaling miss real changes?
// ============================================================

fn bench_detection_accuracy(c: &mut Criterion) {
    let mut group = c.benchmark_group("detection_accuracy");
    group.sample_size(10);

    // Test: can each strategy detect a single-character change on an ultrawide?
    let mon = &MONITORS[3]; // 5120x1440 ultrawide

    let base = create_code_screen(mon.width, mon.height, 0);
    // Create images with progressively larger changes
    let changes: Vec<(&str, DynamicImage)> = vec![
        ("identical", create_code_screen(mon.width, mon.height, 0)),
        ("tiny_change", create_code_screen(mon.width, mon.height, 1)),
        (
            "small_change",
            create_code_screen(mon.width, mon.height, 10),
        ),
        (
            "large_change",
            create_code_screen(mon.width, mon.height, 128),
        ),
        (
            "different_content",
            create_chart_screen(mon.width, mon.height, 0),
        ),
    ];

    for (change_name, changed) in &changes {
        // Full resolution comparison (ground truth)
        let full_diff = compare_histogram(&base, changed).unwrap_or(1.0);

        // Fixed 640x360
        let s1_fixed = base.resize_exact(640, 360, FilterType::Nearest);
        let s2_fixed = changed.resize_exact(640, 360, FilterType::Nearest);
        let fixed_diff = compare_histogram(&s1_fixed, &s2_fixed).unwrap_or(1.0);

        // Proportional /4
        let pw = mon.width / 4;
        let ph = mon.height / 4;
        let s1_prop = base.resize_exact(pw, ph, FilterType::Nearest);
        let s2_prop = changed.resize_exact(pw, ph, FilterType::Nearest);
        let prop_diff = compare_histogram(&s1_prop, &s2_prop).unwrap_or(1.0);

        // Proportional /6
        let pw6 = mon.width / 6;
        let ph6 = mon.height / 6;
        let s1_p6 = base.resize_exact(pw6, ph6, FilterType::Nearest);
        let s2_p6 = changed.resize_exact(pw6, ph6, FilterType::Nearest);
        let prop6_diff = compare_histogram(&s1_p6, &s2_p6).unwrap_or(1.0);

        // Just print results (criterion will capture timing, we log accuracy)
        group.bench_with_input(
            BenchmarkId::new("accuracy_report", *change_name),
            &(),
            |b, _| {
                b.iter(|| {
                    // This bench exists to print the accuracy data
                    println!(
                        "  {}: full={:.6} fixed640={:.6} prop/4={:.6} prop/6={:.6}",
                        change_name, full_diff, fixed_diff, prop_diff, prop6_diff
                    );
                });
            },
        );
    }

    group.finish();
}

// ============================================================
// Benchmark: Full pipeline simulation (N monitors, M frames)
// ============================================================

fn bench_multi_monitor_pipeline(c: &mut Criterion) {
    let mut group = c.benchmark_group("multi_monitor_pipeline");
    group.sample_size(10);

    let setups: Vec<(&str, &[usize])> = vec![
        ("2x_1080p", SETUP_STANDARD),
        ("power_3mon", SETUP_POWER),
        ("trader_3mon", SETUP_TRADER),
    ];

    for (setup_name, monitor_indices) in &setups {
        // Pre-generate frames: 5 frames per monitor
        // Pattern: frame0 (new), frame1 (same), frame2 (same), frame3 (changed), frame4 (same)
        let frames_per_monitor: Vec<Vec<(DynamicImage, DynamicImage)>> = monitor_indices
            .iter()
            .map(|&idx| {
                let mon = &MONITORS[idx];
                vec![
                    (
                        create_code_screen(mon.width, mon.height, 0),
                        create_code_screen(mon.width, mon.height, 0),
                    ),
                    (
                        create_code_screen(mon.width, mon.height, 0),
                        create_code_screen(mon.width, mon.height, 0),
                    ),
                    (
                        create_code_screen(mon.width, mon.height, 0),
                        create_code_screen(mon.width, mon.height, 0),
                    ),
                    (
                        create_code_screen(mon.width, mon.height, 10),
                        create_code_screen(mon.width, mon.height, 10),
                    ),
                    (
                        create_code_screen(mon.width, mon.height, 10),
                        create_code_screen(mon.width, mon.height, 10),
                    ),
                ]
            })
            .collect();

        // Current approach: full-res hash + fixed 640x360 downscale
        group.bench_with_input(
            BenchmarkId::new("current", setup_name),
            &frames_per_monitor,
            |b, all_frames| {
                b.iter(|| {
                    let mut comparers: Vec<FrameComparer> = (0..all_frames.len())
                        .map(|_| FrameComparer::new(FrameComparisonConfig::default()))
                        .collect();

                    let mut total_ops = 0u64;
                    for frame_idx in 0..5 {
                        for (mon_idx, frames) in all_frames.iter().enumerate() {
                            let (ref img, _) = frames[frame_idx];
                            let _diff = comparers[mon_idx].compare(black_box(img));
                            total_ops += 1;
                        }
                    }
                    black_box(total_ops)
                });
            },
        );

        // Old approach: full-res hash + fixed 640x360 downscale + separate hash & downscale
        group.bench_with_input(
            BenchmarkId::new("old_fullres_hash_fixed_downscale", setup_name),
            &frames_per_monitor,
            |b, all_frames| {
                b.iter(|| {
                    let mut comparers: Vec<FrameComparer> = (0..all_frames.len())
                        .map(|_| {
                            FrameComparer::new(FrameComparisonConfig {
                                downscale_factor: 0, // Legacy: use fixed 640x360
                                comparison_width: 640,
                                comparison_height: 360,
                                ..Default::default()
                            })
                        })
                        .collect();

                    let mut total_ops = 0u64;
                    for frame_idx in 0..5 {
                        for (mon_idx, frames) in all_frames.iter().enumerate() {
                            let (ref img, _) = frames[frame_idx];
                            let _diff = comparers[mon_idx].compare(black_box(img));
                            total_ops += 1;
                        }
                    }
                    black_box(total_ops)
                });
            },
        );
    }

    group.finish();
}

// ============================================================
// Benchmark: Memory allocation per frame
// ============================================================

fn bench_memory_allocation(c: &mut Criterion) {
    let mut group = c.benchmark_group("memory_allocation");
    group.sample_size(20);

    for mon in MONITORS {
        let image = create_code_screen(mon.width, mon.height, 0);

        // Current: clone full image for MaxAverageFrame storage
        group.bench_with_input(
            BenchmarkId::new("clone_full", mon.name),
            &image,
            |b, img| {
                b.iter(|| {
                    let _cloned = black_box(img).clone();
                });
            },
        );

        // Current: to_luma8 for histogram (allocates grayscale copy)
        group.bench_with_input(
            BenchmarkId::new("to_luma8_full", mon.name),
            &image,
            |b, img| {
                b.iter(|| {
                    let _gray = black_box(img).to_luma8();
                });
            },
        );

        // Proposed: to_luma8 on downscaled
        let pw = (mon.width / 4).max(1);
        let ph = (mon.height / 4).max(1);
        let small = image.resize_exact(pw, ph, FilterType::Nearest);
        group.bench_with_input(
            BenchmarkId::new("to_luma8_downscaled", mon.name),
            &small,
            |b, img| {
                b.iter(|| {
                    let _gray = black_box(img).to_luma8();
                });
            },
        );
    }

    group.finish();
}

criterion_group!(
    benches,
    bench_hash_full_vs_downscaled,
    bench_downscale_strategies,
    bench_detection_accuracy,
    bench_multi_monitor_pipeline,
    bench_memory_allocation,
);
criterion_main!(benches);
