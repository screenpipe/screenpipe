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

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

/// The caller must withhold the screenshot on error; accessibility collection
/// can continue under its independent filters. `excluded_ids` is used only by
/// the existing non-pattern path (e.g. URL/incognito policies).
pub async fn capture_monitor_image_filtered(
    monitor: &SafeMonitor,
    filters: &WindowFilters,
    sources: ExclusionSources,
    excluded_ids: &[u32],
    fresh: bool,
) -> anyhow::Result<(DynamicImage, Duration)> {
    if !filters.has_window_patterns() {
        return crate::utils::capture_monitor_image_with_freshness(monitor, excluded_ids, fresh)
            .await;
    }
    let start = Instant::now();
    #[cfg(target_os = "macos")]
    let image = macos::capture_filtered(monitor, filters, sources, fresh).await?;
    #[cfg(target_os = "linux")]
    let image = linux::capture_filtered(monitor, filters, sources, fresh).await?;
    #[cfg(target_os = "windows")]
    let image = windows::capture_filtered(monitor, filters, sources, fresh).await?;
    Ok((image, start.elapsed()))
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
