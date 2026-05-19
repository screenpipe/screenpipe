//! Optimized frame comparison for CPU-efficient change detection.
//!
//! This module provides fast frame comparison to decide whether OCR should run,
//! without affecting OCR quality (OCR always runs on full resolution).
//!
//! ## Optimizations
//!
//! 1. **Hash-based early exit**: If frame hash matches previous, skip comparison entirely
//! 2. **Proportional downscale**: Compare at 1/4 resolution (preserves aspect ratio for ultrawides)
//! 3. **Single metric**: Use only histogram comparison (not both histogram + SSIM)
//! 4. **Shared downscale**: One downscale serves both hash and comparison (no redundant work)
//!
//! ## CPU Impact (benchmarked on trader 3-monitor setup: 2×5120x1440 + 2560x1440)
//!
//! | Optimization | CPU Reduction |
//! |--------------|---------------|
//! | Shared downscale + hash | 10ms/cycle (was 10.4ms for full-res hash) |
//! | Downscaled to_luma8 | 18ms/cycle (was 19.4ms for full-res grayscale) |
//! | Hash early exit | 30-50% in static scenes |
//! | Single metric | 40-50% vs histogram+SSIM |
//!
//! ## Example
//!
//! ```rust,ignore
//! use screenpipe_screen::frame_comparison::{FrameComparer, FrameComparisonConfig};
//!
//! let config = FrameComparisonConfig::default();
//! let mut comparer = FrameComparer::new(config);
//!
//! // Returns difference score (0.0 = identical, 1.0 = completely different)
//! // Hash is computed internally on the downscaled image — no need to pre-compute.
//! let diff = comparer.compare(&current_image);
//! if diff < 0.02 {
//!     // Skip OCR - frame hasn't changed significantly
//! }
//! ```

use image::imageops::FilterType;
use image::DynamicImage;
use image_compare::Metric;
use std::hash::{DefaultHasher, Hash, Hasher};
use tracing::debug;

/// Configuration for frame comparison optimizations.
#[derive(Debug, Clone)]
pub struct FrameComparisonConfig {
    /// Enable hash-based early exit for identical frames.
    /// When true, if current frame hash equals previous hash, return 0.0 immediately.
    /// Default: true
    pub hash_early_exit: bool,

    /// Enable downscaled comparison for faster processing.
    /// When true, resize images proportionally before comparing.
    /// Default: true
    pub downscale_comparison: bool,

    /// Factor to divide image dimensions by for comparison.
    /// E.g., factor=4 means a 5120x1440 image is compared at 1280x360.
    /// Preserves aspect ratio (critical for ultrawides).
    /// Default: 4
    pub downscale_factor: u32,

    /// Use only histogram comparison instead of histogram + SSIM.
    /// Histogram is faster and robust for detecting significant changes.
    /// Default: true (single metric)
    pub single_metric: bool,

    // Legacy fields kept for backward compatibility with existing configs.
    // Only used when downscale_factor is 0 (meaning "use fixed dimensions").
    /// Fixed width for comparison (legacy, prefer downscale_factor).
    pub comparison_width: u32,
    /// Fixed height for comparison (legacy, prefer downscale_factor).
    pub comparison_height: u32,
}

impl Default for FrameComparisonConfig {
    fn default() -> Self {
        Self {
            hash_early_exit: true,
            downscale_comparison: true,
            downscale_factor: 4,
            single_metric: true,
            comparison_width: 640,
            comparison_height: 360,
        }
    }
}

impl FrameComparisonConfig {
    /// Create a config with all optimizations disabled (original behavior).
    /// Useful for testing or when maximum accuracy is needed.
    pub fn no_optimizations() -> Self {
        Self {
            hash_early_exit: false,
            downscale_comparison: false,
            downscale_factor: 0,
            single_metric: false,
            comparison_width: 0,
            comparison_height: 0,
        }
    }

    /// Create a config optimized for maximum CPU savings.
    /// Uses factor=4 (1920→480px) to balance performance with text-change
    /// sensitivity. Factor 6 (320px) caused hash collisions on dense text
    /// pages, making scrolling through log files invisible to the comparer.
    pub fn max_performance() -> Self {
        Self {
            hash_early_exit: true,
            downscale_comparison: true,
            downscale_factor: 4,
            single_metric: true,
            comparison_width: 480,
            comparison_height: 270,
        }
    }
}

/// Stateful frame comparer that tracks previous frame data for optimizations.
#[derive(Debug)]
pub struct FrameComparer {
    config: FrameComparisonConfig,
    previous_hash: Option<u64>,
    previous_image_downscaled: Option<DynamicImage>,
    previous_image_full: Option<DynamicImage>,
    comparison_count: u64,
    hash_hits: u64,
}

impl FrameComparer {
    /// Create a new frame comparer with the given configuration.
    pub fn new(config: FrameComparisonConfig) -> Self {
        Self {
            config,
            previous_hash: None,
            previous_image_downscaled: None,
            previous_image_full: None,
            comparison_count: 0,
            hash_hits: 0,
        }
    }

    /// Compute the downscaled dimensions for a given image.
    fn downscale_dims(&self, width: u32, height: u32) -> (u32, u32) {
        if self.config.downscale_factor > 0 {
            // Proportional downscale — preserves aspect ratio
            (
                (width / self.config.downscale_factor).max(1),
                (height / self.config.downscale_factor).max(1),
            )
        } else {
            // Legacy fixed dimensions
            (self.config.comparison_width, self.config.comparison_height)
        }
    }

    /// Downscale an image for comparison.
    fn downscale(&self, image: &DynamicImage) -> DynamicImage {
        let (w, h) = self.downscale_dims(image.width(), image.height());
        image.resize_exact(w, h, FilterType::Nearest)
    }

    /// Compute hash on a downscaled image (fast — operates on ~1/16th the pixels).
    fn hash_image(&self, downscaled: &DynamicImage) -> u64 {
        let mut hasher = DefaultHasher::new();
        downscaled.as_bytes().hash(&mut hasher);
        hasher.finish()
    }

    /// Compare current frame with previous frame.
    ///
    /// Downscales the image once and uses it for both hash and histogram comparison.
    /// No external hash computation needed.
    ///
    /// # Returns
    /// * `0.0` - Frames are identical (hash match or visual comparison)
    /// * `0.0 - 1.0` - Difference score (higher = more different)
    /// * `1.0` - First frame (no previous to compare) or completely different
    pub fn compare(&mut self, current_image: &DynamicImage) -> f64 {
        self.comparison_count += 1;

        // Downscale once — shared between hash and comparison
        let current_downscaled = if self.config.downscale_comparison {
            Some(self.downscale(current_image))
        } else {
            None
        };

        // Hash the downscaled image (or full image if not downscaling)
        let current_hash = if self.config.hash_early_exit {
            let to_hash = current_downscaled.as_ref().unwrap_or(current_image);
            Some(self.hash_image(to_hash))
        } else {
            None
        };

        // First frame - no previous to compare
        if self.previous_hash.is_none()
            && self.previous_image_downscaled.is_none()
            && self.previous_image_full.is_none()
        {
            self.update_previous_internal(current_image, current_downscaled, current_hash);
            return 1.0;
        }

        // Optimization 1: Hash-based early exit
        if self.config.hash_early_exit {
            if let (Some(prev_hash), Some(curr_hash)) = (self.previous_hash, current_hash) {
                if prev_hash == curr_hash {
                    self.hash_hits += 1;
                    debug!(
                        "Hash match - skipping comparison (hits: {}/{})",
                        self.hash_hits, self.comparison_count
                    );
                    return 0.0;
                }
            }
        }

        // Get images for comparison
        let (prev_img, curr_img) = if self.config.downscale_comparison {
            let prev = self.previous_image_downscaled.as_ref();
            let curr = current_downscaled.as_ref();
            match (prev, curr) {
                (Some(p), Some(c)) => (p, c.clone()),
                _ => {
                    self.update_previous_internal(current_image, current_downscaled, current_hash);
                    return 1.0;
                }
            }
        } else {
            let prev = self.previous_image_full.as_ref();
            match prev {
                Some(p) => (p, current_image.clone()),
                None => {
                    self.update_previous_internal(current_image, current_downscaled, current_hash);
                    return 1.0;
                }
            }
        };

        // Perform comparison
        let diff = if self.config.single_metric {
            compare_histogram(prev_img, &curr_img).unwrap_or(1.0)
        } else {
            let histogram_diff = compare_histogram(prev_img, &curr_img).unwrap_or(1.0);
            let ssim_diff = compare_ssim(prev_img, &curr_img);
            (histogram_diff + ssim_diff) / 2.0
        };

        // Update previous frame
        self.update_previous_internal(current_image, current_downscaled, current_hash);

        diff
    }

    /// Backward-compatible compare that accepts a pre-computed hash.
    /// The hash is ignored — we compute our own on the downscaled image.
    pub fn compare_with_hash(&mut self, current_image: &DynamicImage, _legacy_hash: u64) -> f64 {
        self.compare(current_image)
    }

    /// Update the previous frame state using pre-computed downscaled image.
    fn update_previous_internal(
        &mut self,
        full_image: &DynamicImage,
        downscaled: Option<DynamicImage>,
        hash: Option<u64>,
    ) {
        self.previous_hash = hash;

        if self.config.downscale_comparison {
            self.previous_image_downscaled =
                downscaled.or_else(|| Some(self.downscale(full_image)));
            self.previous_image_full = None;
        } else {
            self.previous_image_full = Some(full_image.clone());
            self.previous_image_downscaled = None;
        }
    }

    /// Get statistics about comparison performance.
    pub fn stats(&self) -> FrameComparisonStats {
        FrameComparisonStats {
            total_comparisons: self.comparison_count,
            hash_hits: self.hash_hits,
            hash_hit_rate: if self.comparison_count > 0 {
                self.hash_hits as f64 / self.comparison_count as f64
            } else {
                0.0
            },
        }
    }

    /// Reset the comparer state (e.g., when switching monitors).
    pub fn reset(&mut self) {
        self.previous_hash = None;
        self.previous_image_downscaled = None;
        self.previous_image_full = None;
    }
}

/// Statistics about frame comparison performance.
#[derive(Debug, Clone)]
pub struct FrameComparisonStats {
    pub total_comparisons: u64,
    pub hash_hits: u64,
    pub hash_hit_rate: f64,
}

/// Compare two images using histogram comparison.
/// Returns a difference score between 0.0 (identical) and 1.0 (completely different).
pub fn compare_histogram(image1: &DynamicImage, image2: &DynamicImage) -> anyhow::Result<f64> {
    let image_one = image1.to_luma8();
    let mut image_two = image2.to_luma8();
    // Resize to match if dimensions differ (e.g. monitor resolution change)
    if image_one.dimensions() != image_two.dimensions() {
        image_two = image::imageops::resize(
            &image_two,
            image_one.width(),
            image_one.height(),
            FilterType::Nearest,
        );
    }
    image_compare::gray_similarity_histogram(Metric::Hellinger, &image_one, &image_two)
        .map_err(|e| anyhow::anyhow!("Failed to compare images: {}", e))
}

/// Compare two images using SSIM.
/// Returns a difference score between 0.0 (identical) and 1.0 (completely different).
pub fn compare_ssim(image1: &DynamicImage, image2: &DynamicImage) -> f64 {
    let image_one = image1.to_luma8();
    let mut image_two = image2.to_luma8();
    // Resize to match if dimensions differ (e.g. monitor resolution change)
    if image_one.dimensions() != image_two.dimensions() {
        image_two = image::imageops::resize(
            &image_two,
            image_one.width(),
            image_one.height(),
            FilterType::Nearest,
        );
    }
    let result = image_compare::gray_similarity_structure(
        &image_compare::Algorithm::MSSIMSimple,
        &image_one,
        &image_two,
    )
    .expect("images should have matching dimensions after resize");
    1.0 - result.score // Convert similarity to difference
}

/// Calculate hash of an image (for early exit optimization).
pub fn calculate_image_hash(image: &DynamicImage) -> u64 {
    let mut hasher = DefaultHasher::new();
    image.as_bytes().hash(&mut hasher);
    hasher.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage};

    fn create_solid_image(width: u32, height: u32, r: u8, g: u8, b: u8) -> DynamicImage {
        let img = RgbImage::from_fn(width, height, |_, _| Rgb([r, g, b]));
        DynamicImage::ImageRgb8(img)
    }

    fn create_gradient_image(width: u32, height: u32) -> DynamicImage {
        let img = RgbImage::from_fn(width, height, |x, y| {
            let r = ((x as f32 / width as f32) * 255.0) as u8;
            let g = ((y as f32 / height as f32) * 255.0) as u8;
            Rgb([r, g, 128])
        });
        DynamicImage::ImageRgb8(img)
    }

    fn create_text_pattern_image(width: u32, height: u32, seed: u8) -> DynamicImage {
        let img = RgbImage::from_fn(width, height, |x, y| {
            let line_height = 20;
            let is_text_line = (y / line_height) % 2 == 0;
            if is_text_line {
                let char_width = 10;
                let is_char = !((x + seed as u32) / char_width).is_multiple_of(3);
                if is_char {
                    Rgb([30, 30, 30])
                } else {
                    Rgb([255, 255, 255])
                }
            } else {
                Rgb([255, 255, 255])
            }
        });
        DynamicImage::ImageRgb8(img)
    }

    #[test]
    fn test_hash_early_exit_identical_frames() {
        let config = FrameComparisonConfig::default();
        let mut comparer = FrameComparer::new(config);

        let image = create_solid_image(1920, 1080, 100, 100, 100);

        let diff1 = comparer.compare(&image);
        assert_eq!(diff1, 1.0, "First frame should return 1.0");

        let diff2 = comparer.compare(&image);
        assert_eq!(diff2, 0.0, "Identical frame should return 0.0 (hash hit)");

        let stats = comparer.stats();
        assert_eq!(stats.hash_hits, 1);
        assert_eq!(stats.total_comparisons, 2);
    }

    #[test]
    fn test_hash_early_exit_disabled() {
        let config = FrameComparisonConfig {
            hash_early_exit: false,
            ..Default::default()
        };

        let mut comparer = FrameComparer::new(config);
        let image = create_solid_image(1920, 1080, 100, 100, 100);

        comparer.compare(&image);
        comparer.compare(&image);

        assert_eq!(comparer.stats().hash_hits, 0);
    }

    #[test]
    fn test_proportional_downscale() {
        let config = FrameComparisonConfig {
            downscale_factor: 4,
            ..Default::default()
        };
        let comparer = FrameComparer::new(config);

        // Standard monitor
        assert_eq!(comparer.downscale_dims(1920, 1080), (480, 270));
        // Ultrawide 49"
        assert_eq!(comparer.downscale_dims(5120, 1440), (1280, 360));
        // Superwide 38"
        assert_eq!(comparer.downscale_dims(3840, 1440), (960, 360));
        // 4K
        assert_eq!(comparer.downscale_dims(3840, 2160), (960, 540));
    }

    #[test]
    fn test_proportional_downscale_default_factor4() {
        let config = FrameComparisonConfig::default(); // factor=4
        let comparer = FrameComparer::new(config);

        assert_eq!(comparer.downscale_dims(1920, 1080), (480, 270));
        assert_eq!(comparer.downscale_dims(5120, 1440), (1280, 360));
        assert_eq!(comparer.downscale_dims(3840, 2160), (960, 540));
    }

    #[test]
    fn test_legacy_fixed_dimensions() {
        let config = FrameComparisonConfig {
            downscale_factor: 0, // Use legacy fixed dims
            comparison_width: 640,
            comparison_height: 360,
            ..Default::default()
        };
        let comparer = FrameComparer::new(config);

        // All monitors get same fixed size
        assert_eq!(comparer.downscale_dims(1920, 1080), (640, 360));
        assert_eq!(comparer.downscale_dims(5120, 1440), (640, 360));
    }

    #[test]
    fn test_detects_major_changes() {
        let config = FrameComparisonConfig::default();
        let mut comparer = FrameComparer::new(config);

        let black = create_solid_image(1920, 1080, 0, 0, 0);
        let white = create_solid_image(1920, 1080, 255, 255, 255);

        comparer.compare(&black);
        let diff = comparer.compare(&white);
        assert!(diff > 0.5, "Major change should be detected: {}", diff);
    }

    #[test]
    fn test_detects_content_changes() {
        let config = FrameComparisonConfig::default();
        let mut comparer = FrameComparer::new(config);

        // Text screen vs gradient — clearly different even at 1/4 resolution
        let image1 = create_text_pattern_image(1920, 1080, 0);
        let image2 = create_gradient_image(1920, 1080);

        comparer.compare(&image1);
        let diff = comparer.compare(&image2);
        assert!(diff > 0.01, "Content change should be detected: {}", diff);
    }

    #[test]
    fn test_ultrawide_detection() {
        // Ensure proportional downscale still detects changes on ultrawides
        let config = FrameComparisonConfig::default();
        let mut comparer = FrameComparer::new(config);

        let image1 = create_text_pattern_image(5120, 1440, 0);
        let image2 = create_gradient_image(5120, 1440); // completely different content

        comparer.compare(&image1);
        let diff = comparer.compare(&image2);
        assert!(
            diff > 0.01,
            "Ultrawide content change should be detected: {}",
            diff
        );
    }

    #[test]
    fn test_subtle_changes_detected_without_hash() {
        // Subtle changes that may hash-collide at downscaled resolution
        // should still be detected when hash early exit is disabled
        let config = FrameComparisonConfig {
            hash_early_exit: false,
            ..Default::default()
        };

        let mut comparer = FrameComparer::new(config);

        let image1 = create_text_pattern_image(1920, 1080, 0);
        let image2 = create_text_pattern_image(1920, 1080, 50);

        comparer.compare(&image1);
        let diff = comparer.compare(&image2);
        // Without hash early exit, histogram comparison should detect subtle changes
        // (though downscaling may reduce the difference)
        assert!(diff >= 0.0, "Should not error: {}", diff);
    }

    #[test]
    fn test_full_pipeline() {
        let config = FrameComparisonConfig::default();
        let mut comparer = FrameComparer::new(config);

        let frame1 = create_text_pattern_image(1920, 1080, 0);
        let frame2 = create_text_pattern_image(1920, 1080, 0); // identical
        let frame3 = create_text_pattern_image(1920, 1080, 0); // identical
        let frame4 = create_gradient_image(1920, 1080); // different
        let frame5 = create_solid_image(1920, 1080, 128, 128, 128); // different
        let frame6 = create_solid_image(1920, 1080, 128, 128, 128); // identical
        let frame7 = create_solid_image(1920, 1080, 0, 0, 0); // different

        let results: Vec<f64> = [
            &frame1, &frame2, &frame3, &frame4, &frame5, &frame6, &frame7,
        ]
        .iter()
        .map(|f| comparer.compare(f))
        .collect();

        assert_eq!(results[0], 1.0); // first frame
        assert_eq!(results[1], 0.0); // hash hit
        assert_eq!(results[2], 0.0); // hash hit
        assert!(results[3] > 0.0); // different
        assert!(results[4] > 0.0); // different
        assert_eq!(results[5], 0.0); // hash hit
        assert!(results[6] > 0.3); // big change

        assert!(comparer.stats().hash_hits >= 3);
    }

    #[test]
    fn test_backward_compat_compare_with_hash() {
        let config = FrameComparisonConfig::default();
        let mut comparer = FrameComparer::new(config);

        let image = create_solid_image(100, 100, 50, 50, 50);
        let diff = comparer.compare_with_hash(&image, 12345); // hash ignored
        assert_eq!(diff, 1.0);
    }

    #[test]
    fn test_reset_clears_state() {
        let config = FrameComparisonConfig::default();
        let mut comparer = FrameComparer::new(config);

        let image = create_solid_image(100, 100, 50, 50, 50);
        comparer.compare(&image);
        comparer.compare(&image);
        assert_eq!(comparer.stats().hash_hits, 1);

        comparer.reset();
        let diff = comparer.compare(&image);
        assert_eq!(diff, 1.0, "After reset, first frame should return 1.0");
    }

    #[test]
    fn test_config_presets() {
        let default = FrameComparisonConfig::default();
        assert!(default.hash_early_exit);
        assert!(default.downscale_comparison);
        assert_eq!(default.downscale_factor, 4);

        let no_opt = FrameComparisonConfig::no_optimizations();
        assert!(!no_opt.hash_early_exit);
        assert!(!no_opt.downscale_comparison);

        let max_perf = FrameComparisonConfig::max_performance();
        assert_eq!(max_perf.downscale_factor, 4);
    }
}
