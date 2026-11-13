// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Window policies must constrain the source of pixels, not just frame metadata.
//! A negative list resolved before capture cannot cover windows created later.
//! Filtered captures therefore include only freshly verified window surfaces,
//! and never fall back to an unfiltered monitor capture.

use crate::capture_screenshot_by_window::{ExclusionSources, WindowFilters};
use crate::monitor::SafeMonitor;
use image::DynamicImage;
use std::time::{Duration, Instant};

#[cfg(any(target_os = "macos", target_os = "linux", test))]
mod scene;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub(crate) mod stream;
#[cfg(target_os = "windows")]
mod windows;

/// The caller must withhold the screenshot on error; accessibility collection
/// can continue under its independent filters. `excluded_ids` additionally
/// constrains source selection for URL/incognito policies.
pub async fn capture_monitor_image_filtered(
    monitor: &SafeMonitor,
    filters: &WindowFilters,
    sources: ExclusionSources,
    excluded_ids: &[u32],
    fresh: bool,
) -> anyhow::Result<(DynamicImage, Duration)> {
    let frame =
        capture_monitor_frame_filtered(monitor, filters, sources, excluded_ids, fresh).await?;
    Ok((frame.image, frame.duration))
}

/// Native observation time travels with the selected pixels; callers must not
/// timestamp a cached image as though it was acquired when the request returned.
#[derive(Clone)]
pub struct CapturedFrame {
    pub image: DynamicImage,
    pub captured_at: chrono::DateTime<chrono::Utc>,
    pub duration: Duration,
    /// False for legacy/return-time fallback; never advertise it as native PTS.
    pub native_timestamp: bool,
}

#[derive(Clone)]
struct CapturedPixels {
    image: DynamicImage,
    captured_at: chrono::DateTime<chrono::Utc>,
    native_timestamp: bool,
}

pub fn uses_positive_selection(filters: &WindowFilters) -> bool {
    #[cfg(target_os = "macos")]
    if cidre::api::macos_available("14.0") {
        return true;
    }
    filters.has_window_patterns()
}

/// Share the existing screenshot producer with visual-change detection. These
/// pixels are a diff preview only, never authorization to save a screenshot.
#[cfg(target_os = "macos")]
pub async fn cached_monitor_preview(id: u32) -> anyhow::Result<Option<DynamicImage>> {
    macos::cached_preview(id).await
}

pub async fn capture_monitor_frame_filtered(
    monitor: &SafeMonitor,
    filters: &WindowFilters,
    sources: ExclusionSources,
    excluded_ids: &[u32],
    fresh: bool,
) -> anyhow::Result<CapturedFrame> {
    let start = Instant::now();
    // macOS 14+ uses the same positive-selection stream with or without window
    // patterns. Keep the older OS and other platforms' existing native paths.
    if !uses_positive_selection(filters) {
        let (image, duration) =
            crate::utils::capture_monitor_image_with_freshness(monitor, excluded_ids, fresh)
                .await?;
        return Ok(CapturedFrame {
            image,
            captured_at: chrono::Utc::now(),
            duration,
            native_timestamp: false,
        });
    }
    #[cfg(target_os = "macos")]
    let pixels = macos::capture_filtered(monitor, filters, sources, excluded_ids, fresh).await;
    #[cfg(target_os = "linux")]
    let image = linux::capture_filtered(monitor, filters, sources, fresh).await;
    #[cfg(target_os = "windows")]
    let image = windows::capture_filtered(monitor, filters, sources, fresh).await;
    #[cfg(not(target_os = "macos"))]
    let pixels = image.map(|image| CapturedPixels {
        image,
        captured_at: chrono::Utc::now(),
        native_timestamp: false,
    });
    let pixels = report_filtered_capture(monitor.id(), pixels)?;
    Ok(CapturedFrame {
        image: pixels.image,
        captured_at: pixels.captured_at,
        duration: start.elapsed(),
        native_timestamp: pixels.native_timestamp,
    })
}

fn report_filtered_capture<T>(monitor_id: u32, result: anyhow::Result<T>) -> anyhow::Result<T> {
    if let Err(error) = &result {
        // Normal support bundles include INFO/WARN, not DEBUG. Keep the native
        // cause and pixel outcome without logging window names or titles.
        tracing::warn!(
            monitor_id,
            error = %error,
            screenshot_outcome = "withheld",
            accessibility_outcome = "independent",
            "window-filtered screenshot withheld"
        );
    }
    result
}

pub(super) fn window_allowed(
    filters: &WindowFilters,
    detector: Option<&dyn screenpipe_a11y::incognito::IncognitoDetector>,
    app: &str,
    title: &str,
    pid: i32,
) -> bool {
    !app.is_empty()
        && filters.is_valid(app, title)
        && !filters.is_title_suggesting_blocked_url(title)
        && !detector.is_some_and(|d| d.is_incognito(app, pid, title))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn withheld_screenshot_cause_is_visible_at_normal_support_log_level() {
        let logs = tempfile::tempdir().unwrap();
        let path = logs.path().join("screenpipe.log");
        let subscriber = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::INFO)
            .with_ansi(false)
            .without_time()
            .with_target(false)
            .with_writer(std::sync::Mutex::new(std::fs::File::create(&path).unwrap()))
            .finish();
        let guard = tracing::subscriber::set_default(subscriber);
        let cause = "window privacy policy changed during capture";
        let error =
            report_filtered_capture::<DynamicImage>(2, Err(anyhow::anyhow!(cause))).unwrap_err();
        assert_eq!(error.to_string(), cause);
        // A rejected frame must not prevent the next independently verified one.
        report_filtered_capture(2, Ok(DynamicImage::new_rgba8(2, 2))).unwrap();
        drop(guard);
        let emitted = std::fs::read_to_string(path).unwrap();
        assert!(emitted.contains(cause));
        assert!(emitted.contains("monitor_id=2"));
        assert!(emitted.contains("screenshot_outcome=\"withheld\""));
        assert!(emitted.contains("accessibility_outcome=\"independent\""));
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/filtered-capture-diagnostic.txt");
        std::fs::write(fixture, format!("// screenpipe — AI that knows everything you\'ve seen, said, or heard\n// https://screenpipe.com\n\n{emitted}")).unwrap();
    }

    #[test]
    fn include_scopes_pixels_to_the_matching_window() {
        let filters = WindowFilters::new(&[], &["Editor".into(), "Editor::Project".into()], &[]);
        assert!(filters.has_window_patterns());
        assert!(window_allowed(&filters, None, "Editor", "Project", 1));
        assert!(!window_allowed(&filters, None, "Editor", "Private", 1));
        assert!(!window_allowed(&filters, None, "Browser", "Project", 2));
        assert!(!window_allowed(&filters, None, "", "Project", 1));
    }

    #[test]
    fn exclusion_wins_when_an_app_is_included() {
        let filters = WindowFilters::new(&["::Secret".into()], &["Editor".into()], &[]);
        assert!(window_allowed(&filters, None, "Editor", "Project", 1));
        assert!(!window_allowed(&filters, None, "Editor", "Secret", 1));
    }

    #[test]
    fn unrelated_url_only_policy_does_not_enable_window_capture() {
        assert!(!WindowFilters::new(&[], &[], &[]).has_window_patterns());
        assert!(!WindowFilters::new(&[], &[], &["private.example".into()]).has_window_patterns());
        assert!(WindowFilters::new(&["::Secret".into()], &[], &[]).has_window_patterns());
    }

    #[test]
    fn incognito_is_not_reintroduced_by_including_the_browser() {
        struct Detector;
        impl screenpipe_a11y::incognito::IncognitoDetector for Detector {
            fn is_incognito(&self, _app: &str, _pid: i32, title: &str) -> bool {
                title.contains("Private")
            }
        }
        let filters = WindowFilters::new(&[], &["Browser".into()], &[]);
        assert!(!window_allowed(
            &filters,
            Some(&Detector),
            "Browser",
            "Private",
            1
        ));
        assert!(window_allowed(
            &filters,
            Some(&Detector),
            "Browser",
            "Public",
            1
        ));
    }
}
