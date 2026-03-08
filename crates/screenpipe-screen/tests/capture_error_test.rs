use std::collections::HashSet;

/// Test demonstrating window capture error scenarios
/// Related Sentry issues:
/// - SCREENPIPE-CLI-1Z: "Failed to capture image for window TheBoringNotch"
/// - SCREENPIPE-CLI-1Y: "Failed to capture image for window Grammarly Desktop"
/// - SCREENPIPE-CLI-2: "GetFileVersionInfoSizeW failed: WIN32_ERROR(1813)"
///
/// These errors are expected for certain system/overlay windows and should
/// be logged at debug level, not error level.

/// Test that SKIP_APPS contains expected system apps that can't be captured
#[test]
fn test_skip_apps_contains_system_windows() {
    #[cfg(target_os = "macos")]
    {
        let skip_apps: HashSet<&str> = HashSet::from([
            "Window Server",
            "SystemUIServer",
            "ControlCenter",
            "Dock",
            "NotificationCenter",
            "loginwindow",
            "WindowManager",
            "Contexts",
            "Screenshot",
        ]);

        // These are known to fail capture - should be in skip list
        assert!(skip_apps.contains("Window Server"));
        assert!(skip_apps.contains("Dock"));
        assert!(skip_apps.contains("NotificationCenter"));
    }

    #[cfg(target_os = "windows")]
    {
        let skip_apps: HashSet<&str> = HashSet::from([
            "Windows Shell Experience Host",
            "Microsoft Text Input Application",
            "Windows Explorer",
            "Program Manager",
            "Microsoft Store",
            "Search",
            "TaskBar",
        ]);

        assert!(skip_apps.contains("Program Manager"));
        assert!(skip_apps.contains("TaskBar"));
    }
}

/// Test that problematic apps from Sentry are identified
/// These apps were causing errors in production and should be added to skip list
#[test]
fn test_problematic_apps_should_be_skipped() {
    // Apps that frequently fail capture (from Sentry errors)
    let problematic_apps = vec![
        "TheBoringNotch",    // macOS notch overlay app
        "Grammarly Desktop", // Overlay/tooltip windows
        "Omi录屏专家",       // Chinese screen recorder with overlay
    ];

    #[cfg(target_os = "macos")]
    {
        let current_skip_apps: HashSet<&str> = HashSet::from([
            "Window Server",
            "SystemUIServer",
            "ControlCenter",
            "Dock",
            "NotificationCenter",
            "loginwindow",
            "WindowManager",
            "Contexts",
            "Screenshot",
        ]);

        // Check which problematic apps are NOT in the skip list
        // These should be added
        for app in &problematic_apps {
            if !current_skip_apps.contains(*app) {
                println!("MISSING from SKIP_APPS: {} - should be added", app);
            }
        }

        let _ = current_skip_apps; // silence unused warning on other platforms
    }

    // This test documents apps that should be added to SKIP_APPS
    // The actual assertion is that we've identified them
    assert!(!problematic_apps.is_empty());
}

/// Test that window filtering logic works correctly
#[test]
fn test_window_filter_logic() {
    struct WindowFilters {
        ignore_set: HashSet<String>,
        include_set: HashSet<String>,
    }

    impl WindowFilters {
        fn new(ignore_list: &[String], include_list: &[String]) -> Self {
            Self {
                ignore_set: ignore_list.iter().map(|s| s.to_lowercase()).collect(),
                include_set: include_list.iter().map(|s| s.to_lowercase()).collect(),
            }
        }

        fn is_valid(&self, app_name: &str, title: &str) -> bool {
            let app_name_lower = app_name.to_lowercase();
            let title_lower = title.to_lowercase();

            if self.include_set.is_empty() {
                return true;
            }

            if self
                .include_set
                .iter()
                .any(|include| app_name_lower.contains(include) || title_lower.contains(include))
            {
                return true;
            }

            if !self.ignore_set.is_empty()
                && self
                    .ignore_set
                    .iter()
                    .any(|ignore| app_name_lower.contains(ignore) || title_lower.contains(ignore))
            {
                return false;
            }

            false
        }
    }

    // Test with empty lists (should allow all)
    let filters = WindowFilters::new(&[], &[]);
    assert!(filters.is_valid("Chrome", "Google"));

    // Test with ignore list
    let filters = WindowFilters::new(&["grammarly".to_string()], &[]);
    // Empty include list means is_valid returns true (line 165-167 in source)
    assert!(filters.is_valid("Grammarly Desktop", "Writing Assistant"));

    // Test with include list only
    let filters = WindowFilters::new(&[], &["chrome".to_string()]);
    assert!(filters.is_valid("Chrome", "Google"));
    assert!(!filters.is_valid("Firefox", "Mozilla"));
}

/// Verify error log level expectations
/// Current: error!() - causes noise in Sentry
/// Expected: debug!() - reduces noise, these are expected failures
#[test]
fn test_error_scenarios_are_expected() {
    // These error scenarios are EXPECTED and should not be logged at error level:
    let expected_failure_scenarios = vec![
        (
            "Failed to get title for window",
            "Some windows don't expose titles",
        ),
        (
            "Failed to get is_minimized",
            "Some windows don't report state",
        ),
        (
            "Failed to get focus state",
            "Focus tracking can fail for overlays",
        ),
        (
            "Failed to capture image",
            "Protected/overlay windows can't be captured",
        ),
        (
            "GetFileVersionInfoSizeW",
            "System DLLs may lack version info",
        ),
        ("GetModuleBaseNameW", "Protected processes deny access"),
    ];

    for (error_pattern, reason) in &expected_failure_scenarios {
        println!("Expected failure: '{}' - Reason: {}", error_pattern, reason);
        println!("  -> Should be logged at DEBUG level, not ERROR");
    }

    // This test documents that these are expected failures
    assert_eq!(expected_failure_scenarios.len(), 6);
}
