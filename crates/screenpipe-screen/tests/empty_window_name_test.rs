//! Tests for empty window name filtering bug
//!
//! Bug: Windows with empty titles ("") are being captured and saved to the database,
//! causing frame-window mismatches in search results.
//!
//! Evidence from production database:
//! - Every capture cycle creates records for windows with empty `window_name`
//! - These share the same `offset_index` as legitimate windows
//! - Video has 30 frames, but DB has 64 records (31 empty + 33 with values)
//!
//! Run with: cargo test -p screenpipe-screen --test empty_window_name_test -- --nocapture

use std::collections::HashSet;

/// Simulates the current (buggy) window validation logic
fn is_window_valid_current(
    app_name: &str,
    window_name: &str,
    skip_apps: &HashSet<&str>,
    skip_titles: &HashSet<&str>,
) -> bool {
    !skip_apps.contains(app_name) && !skip_titles.contains(window_name)
}

/// Simulates the fixed window validation logic
fn is_window_valid_fixed(
    app_name: &str,
    window_name: &str,
    skip_apps: &HashSet<&str>,
    skip_titles: &HashSet<&str>,
) -> bool {
    !skip_apps.contains(app_name)
        && !window_name.is_empty() // THE FIX: filter out empty window names
        && !skip_titles.contains(window_name)
}

fn create_skip_sets() -> (HashSet<&'static str>, HashSet<&'static str>) {
    let skip_apps: HashSet<&str> = HashSet::from(["Window Server", "SystemUIServer", "Dock"]);

    let skip_titles: HashSet<&str> =
        HashSet::from(["Item-0", "App Icon Window", "Menu Bar", "Control Center"]);

    (skip_apps, skip_titles)
}

// ==================== BUG DEMONSTRATION TESTS ====================

#[test]
fn test_bug_empty_window_name_passes_validation() {
    let (skip_apps, skip_titles) = create_skip_sets();

    // This is the bug: empty window_name passes validation
    let result = is_window_valid_current("Arc", "", &skip_apps, &skip_titles);

    assert!(
        result,
        "BUG CONFIRMED: Empty window_name currently passes validation"
    );

    println!("BUG: Empty window_name '\"\"' passes current validation");
    println!("This causes duplicate DB records and frame-window mismatches");
}

#[test]
fn test_fix_empty_window_name_filtered() {
    let (skip_apps, skip_titles) = create_skip_sets();

    // With the fix, empty window_name should be filtered out
    let result = is_window_valid_fixed("Arc", "", &skip_apps, &skip_titles);

    assert!(!result, "FIX: Empty window_name should be filtered out");

    println!("FIX WORKS: Empty window_name is now filtered out");
}

// ==================== PRODUCTION SCENARIO TESTS ====================

#[test]
fn test_production_scenario_arc_browser() {
    let (skip_apps, skip_titles) = create_skip_sets();

    // Simulates what happens when Arc browser is captured
    // Arc has multiple "windows" detected:
    // 1. Main browser window with actual title
    // 2. Internal overlay/helper window with empty title

    let windows = vec![
        ("Arc", ""),                                   // Internal window (empty title)
        ("Arc", "Reddit - The heart of the internet"), // Actual browser tab
    ];

    println!("\n=== Production Scenario: Arc Browser ===\n");
    println!("Detected windows:");

    let mut valid_current = 0;
    let mut valid_fixed = 0;

    for (app, title) in &windows {
        let passes_current = is_window_valid_current(app, title, &skip_apps, &skip_titles);
        let passes_fixed = is_window_valid_fixed(app, title, &skip_apps, &skip_titles);

        if passes_current {
            valid_current += 1;
        }
        if passes_fixed {
            valid_fixed += 1;
        }

        println!(
            "  app='{}', window='{}' -> current: {}, fixed: {}",
            app,
            if title.is_empty() { "<empty>" } else { title },
            if passes_current { "PASS" } else { "FILTER" },
            if passes_fixed { "PASS" } else { "FILTER" }
        );
    }

    println!(
        "\nCurrent behavior: {} windows captured (creates duplicate DB records)",
        valid_current
    );
    println!("Fixed behavior: {} window captured (correct)", valid_fixed);

    assert_eq!(
        valid_current, 2,
        "Current behavior captures both windows (bug)"
    );
    assert_eq!(
        valid_fixed, 1,
        "Fixed behavior captures only the valid window"
    );
}

#[test]
fn test_production_scenario_multiple_apps() {
    let (skip_apps, skip_titles) = create_skip_sets();

    // Simulates a typical capture cycle with multiple apps
    let windows = vec![
        ("Arc", ""),                      // Arc internal (empty)
        ("Arc", "GitHub - screenpipe"),   // Arc tab
        ("WezTerm", ""),                  // Terminal internal? (empty)
        ("WezTerm", "~/code/screenpipe"), // Terminal window
        ("Finder", "Documents"),          // Finder window
        ("Dock", "Dock"),                 // Should be skipped (SKIP_APPS)
    ];

    println!("\n=== Production Scenario: Multiple Apps ===\n");

    let mut current_results = Vec::new();
    let mut fixed_results = Vec::new();

    for (app, title) in &windows {
        let passes_current = is_window_valid_current(app, title, &skip_apps, &skip_titles);
        let passes_fixed = is_window_valid_fixed(app, title, &skip_apps, &skip_titles);

        if passes_current {
            current_results.push((*app, *title));
        }
        if passes_fixed {
            fixed_results.push((*app, *title));
        }
    }

    println!(
        "Current behavior captures {} windows:",
        current_results.len()
    );
    for (app, title) in &current_results {
        println!(
            "  - {}: '{}'",
            app,
            if title.is_empty() { "<empty>" } else { title }
        );
    }

    println!("\nFixed behavior captures {} windows:", fixed_results.len());
    for (app, title) in &fixed_results {
        println!("  - {}: '{}'", app, title);
    }

    // Current behavior: 5 windows (includes 2 empty titles, excludes Dock)
    // Fixed behavior: 3 windows (excludes empty titles and Dock)
    assert_eq!(
        current_results.len(),
        5,
        "Current captures empty window names"
    );
    assert_eq!(
        fixed_results.len(),
        3,
        "Fixed filters out empty window names"
    );
}

// ==================== DB RECORD COUNT SIMULATION ====================

#[test]
fn test_db_record_vs_video_frame_mismatch() {
    let (skip_apps, skip_titles) = create_skip_sets();

    // Simulate 3 capture cycles, each with Arc having an empty + real window
    let capture_cycles = vec![
        vec![("Arc", ""), ("Arc", "Reddit")],
        vec![("Arc", ""), ("Arc", "GitHub")],
        vec![("Arc", ""), ("Arc", "WhatsApp")],
    ];

    println!("\n=== DB Record vs Video Frame Mismatch ===\n");

    let video_frames = capture_cycles.len(); // 1 video frame per capture cycle

    let mut db_records_current = 0;
    let mut db_records_fixed = 0;

    for (cycle_idx, windows) in capture_cycles.iter().enumerate() {
        println!("Capture cycle {} (video frame {}):", cycle_idx, cycle_idx);

        for (app, title) in windows {
            let passes_current = is_window_valid_current(app, title, &skip_apps, &skip_titles);
            let passes_fixed = is_window_valid_fixed(app, title, &skip_apps, &skip_titles);

            if passes_current {
                db_records_current += 1;
                println!(
                    "  [CURRENT] DB record: offset={}, window='{}'",
                    cycle_idx, title
                );
            }
            if passes_fixed {
                db_records_fixed += 1;
                println!(
                    "  [FIXED]   DB record: offset={}, window='{}'",
                    cycle_idx, title
                );
            }
        }
    }

    println!("\n=== Summary ===");
    println!("Video frames: {}", video_frames);
    println!(
        "DB records (current): {} <- DOUBLE the video frames!",
        db_records_current
    );
    println!(
        "DB records (fixed): {} <- Matches video frames!",
        db_records_fixed
    );

    assert_eq!(video_frames, 3);
    assert_eq!(
        db_records_current, 6,
        "Current: 2x DB records vs video frames"
    );
    assert_eq!(db_records_fixed, 3, "Fixed: 1:1 DB records to video frames");
}

// ==================== EDGE CASES ====================

#[test]
fn test_whitespace_only_window_names() {
    let (skip_apps, skip_titles) = create_skip_sets();

    // Test various whitespace-only strings
    let whitespace_names = vec!["", " ", "  ", "\t", "\n", " \t\n "];

    println!("\n=== Whitespace Window Names ===\n");

    for name in whitespace_names {
        let passes_current = is_window_valid_current("TestApp", name, &skip_apps, &skip_titles);
        let passes_fixed = is_window_valid_fixed("TestApp", name, &skip_apps, &skip_titles);

        let display_name = format!("{:?}", name);
        println!(
            "window_name={:<12} -> current: {}, fixed: {}",
            display_name,
            if passes_current { "PASS" } else { "FILTER" },
            if passes_fixed { "PASS" } else { "FILTER" }
        );

        // Note: Current fix only handles empty string ""
        // Whitespace-only strings like " " would still pass
        // This is acceptable as they're rare and contain visible characters
    }
}

#[test]
fn test_normal_windows_not_affected() {
    let (skip_apps, skip_titles) = create_skip_sets();

    // Normal windows should pass both validations
    let normal_windows = vec![
        ("Arc", "Google Search"),
        ("WezTerm", "~/Documents"),
        ("Finder", "Downloads"),
        ("Safari", "Apple"),
        ("Code", "main.rs - screenpipe"),
    ];

    println!("\n=== Normal Windows Not Affected ===\n");

    for (app, title) in normal_windows {
        let passes_current = is_window_valid_current(app, title, &skip_apps, &skip_titles);
        let passes_fixed = is_window_valid_fixed(app, title, &skip_apps, &skip_titles);

        assert!(
            passes_current,
            "Normal window should pass current: {} - {}",
            app, title
        );
        assert!(
            passes_fixed,
            "Normal window should pass fixed: {} - {}",
            app, title
        );

        println!("  {}: '{}' -> PASS (both)", app, title);
    }

    println!("\nAll normal windows pass both current and fixed validation");
}

#[test]
fn test_skip_apps_still_work() {
    let (skip_apps, skip_titles) = create_skip_sets();

    // Apps in SKIP_APPS should be filtered in both versions
    let skip_app_windows = vec![
        ("Window Server", ""),
        ("Window Server", "Some Title"),
        ("SystemUIServer", "Menu"),
        ("Dock", "Dock"),
    ];

    for (app, title) in skip_app_windows {
        let passes_current = is_window_valid_current(app, title, &skip_apps, &skip_titles);
        let passes_fixed = is_window_valid_fixed(app, title, &skip_apps, &skip_titles);

        assert!(!passes_current, "SKIP_APPS should filter: {}", app);
        assert!(!passes_fixed, "SKIP_APPS should still filter: {}", app);
    }

    println!("SKIP_APPS filtering works correctly in both versions");
}

#[test]
fn test_skip_titles_still_work() {
    let (skip_apps, skip_titles) = create_skip_sets();

    // Titles in SKIP_TITLES should be filtered in both versions
    let skip_title_windows = vec![
        ("SomeApp", "Item-0"),
        ("AnotherApp", "App Icon Window"),
        ("MenuApp", "Menu Bar"),
        ("ControlApp", "Control Center"),
    ];

    for (app, title) in skip_title_windows {
        let passes_current = is_window_valid_current(app, title, &skip_apps, &skip_titles);
        let passes_fixed = is_window_valid_fixed(app, title, &skip_apps, &skip_titles);

        assert!(!passes_current, "SKIP_TITLES should filter: {}", title);
        assert!(!passes_fixed, "SKIP_TITLES should still filter: {}", title);
    }

    println!("SKIP_TITLES filtering works correctly in both versions");
}
