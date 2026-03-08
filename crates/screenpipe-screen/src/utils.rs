use crate::capture_screenshot_by_window::{
    capture_all_visible_windows, CapturedWindow, WindowFilters,
};
use crate::custom_ocr::CustomOcrConfig;
use crate::monitor::SafeMonitor;
use image::DynamicImage;
use image_compare::{Algorithm, Metric, Similarity};
use screenpipe_db::CustomOcrConfig as DBCustomOcrConfig;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::time::{Duration, Instant};
use tracing::{debug, warn};

#[derive(Clone, Debug, Default)]
pub enum OcrEngine {
    Unstructured,
    #[default]
    Tesseract,
    WindowsNative,
    AppleNative,
    Custom(CustomOcrConfig),
}

impl From<OcrEngine> for screenpipe_db::OcrEngine {
    fn from(val: OcrEngine) -> Self {
        match val {
            OcrEngine::Unstructured => screenpipe_db::OcrEngine::Unstructured,
            OcrEngine::Tesseract => screenpipe_db::OcrEngine::Tesseract,
            OcrEngine::WindowsNative => screenpipe_db::OcrEngine::WindowsNative,
            OcrEngine::AppleNative => screenpipe_db::OcrEngine::AppleNative,
            OcrEngine::Custom(config) => {
                screenpipe_db::OcrEngine::Custom(DBCustomOcrConfig::from(config))
            }
        }
    }
}

impl From<screenpipe_db::OcrEngine> for OcrEngine {
    fn from(engine: screenpipe_db::OcrEngine) -> Self {
        match engine {
            screenpipe_db::OcrEngine::Unstructured => OcrEngine::Unstructured,
            screenpipe_db::OcrEngine::Tesseract => OcrEngine::Tesseract,
            screenpipe_db::OcrEngine::WindowsNative => OcrEngine::WindowsNative,
            screenpipe_db::OcrEngine::AppleNative => OcrEngine::AppleNative,
            screenpipe_db::OcrEngine::Custom(config) => OcrEngine::Custom(config.into()),
        }
    }
}

impl OcrEngine {
    pub fn platform_default() -> Self {
        #[cfg(target_os = "macos")]
        {
            Self::AppleNative
        }
        #[cfg(target_os = "windows")]
        {
            Self::WindowsNative
        }
        #[cfg(target_os = "linux")]
        {
            Self::Tesseract
        }
    }
}

impl std::str::FromStr for OcrEngine {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "tesseract" => Ok(Self::Tesseract),
            "windows-native" => Ok(Self::WindowsNative),
            "unstructured" => Ok(Self::Unstructured),
            "apple-native" => Ok(Self::AppleNative),
            _ => Ok(Self::platform_default()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ocr_engine_from_str_tesseract() {
        assert!(matches!(
            "tesseract".parse::<OcrEngine>().unwrap(),
            OcrEngine::Tesseract
        ));
    }

    #[test]
    fn ocr_engine_from_str_windows_native() {
        assert!(matches!(
            "windows-native".parse::<OcrEngine>().unwrap(),
            OcrEngine::WindowsNative
        ));
    }

    #[test]
    fn ocr_engine_from_str_unstructured() {
        assert!(matches!(
            "unstructured".parse::<OcrEngine>().unwrap(),
            OcrEngine::Unstructured
        ));
    }

    #[test]
    fn ocr_engine_from_str_apple_native() {
        assert!(matches!(
            "apple-native".parse::<OcrEngine>().unwrap(),
            OcrEngine::AppleNative
        ));
    }

    #[test]
    fn ocr_engine_from_str_unknown_returns_platform_default() {
        let engine = "something-else".parse::<OcrEngine>().unwrap();
        // platform_default varies by OS, just ensure it doesn't error
        let default = OcrEngine::platform_default();
        assert_eq!(
            std::mem::discriminant(&engine),
            std::mem::discriminant(&default)
        );
    }
}

pub fn calculate_hash(image: &DynamicImage) -> u64 {
    let mut hasher = DefaultHasher::new();
    image.as_bytes().hash(&mut hasher);
    hasher.finish()
}

pub fn compare_images_histogram(
    image1: &DynamicImage,
    image2: &DynamicImage,
) -> anyhow::Result<f64> {
    let image_one = image1.to_luma8();
    let mut image_two = image2.to_luma8();
    // Resize to match if dimensions differ (e.g. monitor resolution change)
    if image_one.dimensions() != image_two.dimensions() {
        image_two = image::imageops::resize(
            &image_two,
            image_one.width(),
            image_one.height(),
            image::imageops::FilterType::Nearest,
        );
    }
    image_compare::gray_similarity_histogram(Metric::Hellinger, &image_one, &image_two)
        .map_err(|e| anyhow::anyhow!("Failed to compare images: {}", e))
}

pub fn compare_images_ssim(image1: &DynamicImage, image2: &DynamicImage) -> f64 {
    let image_one = image1.to_luma8();
    let mut image_two = image2.to_luma8();
    // Resize to match if dimensions differ (e.g. monitor resolution change)
    if image_one.dimensions() != image_two.dimensions() {
        image_two = image::imageops::resize(
            &image_two,
            image_one.width(),
            image_one.height(),
            image::imageops::FilterType::Nearest,
        );
    }
    let result: Similarity =
        image_compare::gray_similarity_structure(&Algorithm::MSSIMSimple, &image_one, &image_two)
            .expect("images should have matching dimensions after resize");
    result.score
}

/// Capture only the monitor screenshot (no window capture, no hash).
/// Window capture is deferred until after frame comparison to avoid
/// expensive work on frames that will be skipped.
pub async fn capture_monitor_image(
    monitor: &SafeMonitor,
) -> Result<(DynamicImage, Duration), anyhow::Error> {
    let capture_start = Instant::now();
    let image = monitor.capture_image().await.map_err(|e| {
        debug!("failed to capture monitor image: {}", e);
        anyhow::anyhow!("monitor capture failed: {}", e)
    })?;
    let capture_duration = capture_start.elapsed();
    Ok((image, capture_duration))
}

/// Capture all visible windows on a monitor (called only when frame changed).
pub async fn capture_windows(
    monitor: &SafeMonitor,
    window_filters: &WindowFilters,
    capture_unfocused_windows: bool,
) -> Vec<CapturedWindow> {
    match capture_all_visible_windows(monitor, window_filters, capture_unfocused_windows).await {
        Ok(images) => images,
        Err(e) => {
            warn!(
                "Failed to capture window images: {}. Continuing with empty result.",
                e
            );
            Vec::new()
        }
    }
}

pub async fn capture_screenshot(
    monitor: &SafeMonitor,
    window_filters: &WindowFilters,
    capture_unfocused_windows: bool,
) -> Result<(DynamicImage, Vec<CapturedWindow>, u64, Duration), anyhow::Error> {
    let capture_start = Instant::now();
    let image = monitor.capture_image().await.map_err(|e| {
        debug!("failed to capture monitor image: {}", e);
        anyhow::anyhow!("monitor capture failed")
    })?;
    let image_hash = calculate_hash(&image);
    let capture_duration = capture_start.elapsed();

    let window_images =
        match capture_all_visible_windows(monitor, window_filters, capture_unfocused_windows).await
        {
            Ok(images) => images,
            Err(e) => {
                warn!(
                    "Failed to capture window images: {}. Continuing with empty result.",
                    e
                );
                Vec::new()
            }
        };

    Ok((image, window_images, image_hash, capture_duration))
}
