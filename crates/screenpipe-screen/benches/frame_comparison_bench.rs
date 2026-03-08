//! Benchmarks for frame comparison optimizations.
//!
//! Run with: cargo bench -p screenpipe-screen --bench frame_comparison_bench
//!
//! This benchmark compares:
//! 1. Original approach: Full resolution histogram + SSIM
//! 2. Optimized approach: Hash early exit + downscaled + histogram only

use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion};
use image::{DynamicImage, Rgb, RgbImage};
use screenpipe_screen::frame_comparison::{
    calculate_image_hash, compare_histogram, compare_ssim, FrameComparer, FrameComparisonConfig,
};

/// Create a realistic screen-like image with text patterns
fn create_screen_image(width: u32, height: u32, seed: u8) -> DynamicImage {
    let img = RgbImage::from_fn(width, height, |x, y| {
        // Create horizontal "text lines"
        let line_height = 20;
        let is_text_line = (y / line_height) % 2 == 0;

        if is_text_line {
            // Simulate text with varying intensity
            let char_width = 10;
            let is_char = ((x.wrapping_add(seed as u32)) / char_width) % 3 != 0;
            if is_char {
                Rgb([30, 30, 30]) // Dark text
            } else {
                Rgb([255, 255, 255]) // White background
            }
        } else {
            Rgb([255, 255, 255]) // White background between lines
        }
    });
    DynamicImage::ImageRgb8(img)
}

/// Original comparison approach (full resolution, histogram + SSIM)
fn compare_original(image1: &DynamicImage, image2: &DynamicImage) -> f64 {
    let histogram_diff = compare_histogram(image1, image2).unwrap_or(1.0);
    let ssim_diff = compare_ssim(image1, image2);
    (histogram_diff + ssim_diff) / 2.0
}

/// Optimized comparison with hash early exit
fn compare_with_hash_check(
    image1: &DynamicImage,
    hash1: u64,
    image2: &DynamicImage,
    hash2: u64,
) -> f64 {
    // Hash early exit
    if hash1 == hash2 {
        return 0.0;
    }
    compare_histogram(image1, image2).unwrap_or(1.0)
}

fn bench_frame_comparison(c: &mut Criterion) {
    let mut group = c.benchmark_group("frame_comparison");

    // Test with different resolutions
    let resolutions = [(1920, 1080), (2560, 1440), (3840, 2160)];

    for (width, height) in resolutions {
        let resolution_name = format!("{}x{}", width, height);

        // Create test images
        let image1 = create_screen_image(width, height, 0);
        let image2_identical = create_screen_image(width, height, 0);
        let image2_different = create_screen_image(width, height, 50);

        let hash1 = calculate_image_hash(&image1);
        let hash2_identical = calculate_image_hash(&image2_identical);
        let hash2_different = calculate_image_hash(&image2_different);

        // Benchmark: Original approach (identical frames)
        group.bench_with_input(
            BenchmarkId::new("original_identical", &resolution_name),
            &(&image1, &image2_identical),
            |b, (img1, img2)| {
                b.iter(|| compare_original(black_box(img1), black_box(img2)));
            },
        );

        // Benchmark: Optimized with hash (identical frames - should be instant)
        group.bench_with_input(
            BenchmarkId::new("optimized_hash_identical", &resolution_name),
            &(&image1, hash1, &image2_identical, hash2_identical),
            |b, (img1, h1, img2, h2)| {
                b.iter(|| compare_with_hash_check(black_box(img1), *h1, black_box(img2), *h2));
            },
        );

        // Benchmark: Original approach (different frames)
        group.bench_with_input(
            BenchmarkId::new("original_different", &resolution_name),
            &(&image1, &image2_different),
            |b, (img1, img2)| {
                b.iter(|| compare_original(black_box(img1), black_box(img2)));
            },
        );

        // Benchmark: Optimized with hash (different frames)
        group.bench_with_input(
            BenchmarkId::new("optimized_hash_different", &resolution_name),
            &(&image1, hash1, &image2_different, hash2_different),
            |b, (img1, h1, img2, h2)| {
                b.iter(|| compare_with_hash_check(black_box(img1), *h1, black_box(img2), *h2));
            },
        );

        // Benchmark: Full FrameComparer (realistic usage)
        group.bench_with_input(
            BenchmarkId::new("frame_comparer_realistic", &resolution_name),
            &(&image1, &image2_identical, &image2_different),
            |b, (img1, img2_same, img2_diff)| {
                b.iter(|| {
                    let mut comparer = FrameComparer::new(FrameComparisonConfig::default());
                    // Simulate: first frame, identical frame, different frame
                    comparer.compare(black_box(img1));
                    comparer.compare(black_box(img2_same)); // Should hash-hit
                    comparer.compare(black_box(img2_diff)); // Should compare
                });
            },
        );
    }

    group.finish();
}

fn bench_individual_operations(c: &mut Criterion) {
    let mut group = c.benchmark_group("individual_operations");

    let image = create_screen_image(1920, 1080, 0);

    // Benchmark: Hash calculation
    group.bench_function("hash_calculation_1080p", |b| {
        b.iter(|| calculate_image_hash(black_box(&image)));
    });

    // Benchmark: Histogram comparison (full resolution)
    let image2 = create_screen_image(1920, 1080, 10);
    group.bench_function("histogram_full_1080p", |b| {
        b.iter(|| compare_histogram(black_box(&image), black_box(&image2)));
    });

    // Benchmark: SSIM comparison (full resolution)
    group.bench_function("ssim_full_1080p", |b| {
        b.iter(|| compare_ssim(black_box(&image), black_box(&image2)));
    });

    // Benchmark: Histogram comparison (downscaled)
    let small1 = image.resize_exact(640, 360, image::imageops::FilterType::Nearest);
    let small2 = image2.resize_exact(640, 360, image::imageops::FilterType::Nearest);
    group.bench_function("histogram_downscaled_360p", |b| {
        b.iter(|| compare_histogram(black_box(&small1), black_box(&small2)));
    });

    // Benchmark: Resize operation
    group.bench_function("resize_1080p_to_360p", |b| {
        b.iter(|| {
            image.resize_exact(640, 360, image::imageops::FilterType::Nearest);
        });
    });

    group.finish();
}

fn bench_static_vs_active_scenario(c: &mut Criterion) {
    let mut group = c.benchmark_group("scenario_simulation");

    // Simulate 10 frames in each scenario
    let num_frames = 10;

    // Static scenario: All frames identical (typical idle desktop)
    let static_frames: Vec<_> = (0..num_frames)
        .map(|_| create_screen_image(1920, 1080, 0))
        .collect();

    // Active scenario: Every other frame is different (typing/scrolling)
    let active_frames: Vec<_> = (0..num_frames)
        .map(|i| create_screen_image(1920, 1080, if i % 2 == 0 { 0 } else { 50 }))
        .collect();

    // Original approach - static scenario
    group.bench_function("original_static_10frames", |b| {
        b.iter(|| {
            let mut prev: Option<&DynamicImage> = None;
            for frame in &static_frames {
                if let Some(p) = prev {
                    compare_original(black_box(p), black_box(frame));
                }
                prev = Some(frame);
            }
        });
    });

    // Optimized approach - static scenario
    group.bench_function("optimized_static_10frames", |b| {
        b.iter(|| {
            let mut comparer = FrameComparer::new(FrameComparisonConfig::default());
            for frame in &static_frames {
                comparer.compare(black_box(frame));
            }
        });
    });

    // Original approach - active scenario
    group.bench_function("original_active_10frames", |b| {
        b.iter(|| {
            let mut prev: Option<&DynamicImage> = None;
            for frame in &active_frames {
                if let Some(p) = prev {
                    compare_original(black_box(p), black_box(frame));
                }
                prev = Some(frame);
            }
        });
    });

    // Optimized approach - active scenario
    group.bench_function("optimized_active_10frames", |b| {
        b.iter(|| {
            let mut comparer = FrameComparer::new(FrameComparisonConfig::default());
            for frame in &active_frames {
                comparer.compare(black_box(frame));
            }
        });
    });

    group.finish();
}

criterion_group!(
    benches,
    bench_frame_comparison,
    bench_individual_operations,
    bench_static_vs_active_scenario
);
criterion_main!(benches);
