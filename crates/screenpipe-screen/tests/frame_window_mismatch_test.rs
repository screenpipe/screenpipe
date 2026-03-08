//! Test to reproduce the frame-window mismatch issue
//!
//! The bug: Multiple database records (one per window) are created per capture cycle,
//! but only ONE video frame is written per capture cycle.
//!
//! This causes offset_index in DB to be out of sync with actual video frame index.
//!
//! Run with: cargo test -p screenpipe-screen --test frame_window_mismatch_test -- --nocapture

use std::collections::HashMap;

/// Simulates the video file - one frame per capture cycle
struct MockVideoFile {
    frames: Vec<String>, // Each frame is the full-screen content at capture time
}

impl MockVideoFile {
    fn new() -> Self {
        Self { frames: Vec::new() }
    }

    fn write_frame(&mut self, content: &str) {
        self.frames.push(content.to_string());
    }

    fn extract_frame(&self, offset_index: usize) -> Option<&str> {
        self.frames.get(offset_index).map(|s| s.as_str())
    }

    fn frame_count(&self) -> usize {
        self.frames.len()
    }
}

/// Simulates a database frame record
#[derive(Debug, Clone)]
struct DbFrameRecord {
    frame_id: i64,
    offset_index: i64,
    app_name: String,
    window_name: String,
    ocr_text: String,
}

/// Simulates the database - stores frame records
struct MockDatabase {
    frames: Vec<DbFrameRecord>,
    next_frame_id: i64,
}

impl MockDatabase {
    fn new() -> Self {
        Self {
            frames: Vec::new(),
            next_frame_id: 1,
        }
    }

    /// Current buggy behavior: calculates offset_index based on total frame count
    fn insert_frame_buggy(&mut self, app_name: &str, window_name: &str, ocr_text: &str) -> i64 {
        let offset_index = self.frames.len() as i64; // BUG: This should track VIDEO frames, not DB records
        let frame_id = self.next_frame_id;
        self.next_frame_id += 1;

        self.frames.push(DbFrameRecord {
            frame_id,
            offset_index,
            app_name: app_name.to_string(),
            window_name: window_name.to_string(),
            ocr_text: ocr_text.to_string(),
        });

        frame_id
    }

    fn get_frame(&self, frame_id: i64) -> Option<&DbFrameRecord> {
        self.frames.iter().find(|f| f.frame_id == frame_id)
    }
}

/// Simulates a capture cycle with multiple windows
struct CaptureResult {
    /// The full-screen composite image (written to video)
    full_screen_content: String,
    /// Individual window results (each creates a DB record)
    windows: Vec<WindowResult>,
}

struct WindowResult {
    app_name: String,
    window_name: String,
    ocr_text: String,
}

/// Simulates the CURRENT buggy capture and storage flow
fn process_capture_cycle_buggy(
    capture: &CaptureResult,
    video: &mut MockVideoFile,
    db: &mut MockDatabase,
) -> Vec<i64> {
    // Video gets ONE frame per capture cycle
    video.write_frame(&capture.full_screen_content);

    // Database gets MULTIPLE records per capture cycle (one per window)
    // This is the bug - offset_index will be out of sync!
    let mut frame_ids = Vec::new();
    for window in &capture.windows {
        let frame_id =
            db.insert_frame_buggy(&window.app_name, &window.window_name, &window.ocr_text);
        frame_ids.push(frame_id);
    }

    frame_ids
}

#[test]
fn test_bug_frame_window_mismatch() {
    println!("\n=== Testing frame-window mismatch bug ===\n");

    let mut video = MockVideoFile::new();
    let mut db = MockDatabase::new();

    // Capture cycle 1: User has WezTerm and Arc visible
    let capture1 = CaptureResult {
        full_screen_content: "Screen showing: WezTerm terminal with code, Arc browser with GitHub"
            .to_string(),
        windows: vec![
            WindowResult {
                app_name: "WezTerm".to_string(),
                window_name: "~/code".to_string(),
                ocr_text: "fn main() { println!(\"Hello\"); }".to_string(),
            },
            WindowResult {
                app_name: "Arc".to_string(),
                window_name: "GitHub - screenpipe".to_string(),
                ocr_text: "screenpipe repository README".to_string(),
            },
        ],
    };

    println!("Capture cycle 1: WezTerm + Arc visible");
    let frame_ids_1 = process_capture_cycle_buggy(&capture1, &mut video, &mut db);
    println!("  Video frames written: {}", video.frame_count());
    println!(
        "  DB records created: {} (frame_ids: {:?})",
        frame_ids_1.len(),
        frame_ids_1
    );

    // Capture cycle 2: User switches to Finder
    let capture2 = CaptureResult {
        full_screen_content: "Screen showing: Finder window with Documents folder".to_string(),
        windows: vec![WindowResult {
            app_name: "Finder".to_string(),
            window_name: "Documents".to_string(),
            ocr_text: "Desktop Documents Downloads".to_string(),
        }],
    };

    println!("\nCapture cycle 2: Finder visible");
    let frame_ids_2 = process_capture_cycle_buggy(&capture2, &mut video, &mut db);
    println!("  Video frames written: {}", video.frame_count());
    println!(
        "  DB records created: {} (frame_ids: {:?})",
        frame_ids_2.len(),
        frame_ids_2
    );

    // Capture cycle 3: User has Safari open
    let capture3 = CaptureResult {
        full_screen_content: "Screen showing: Safari with Google Maps".to_string(),
        windows: vec![WindowResult {
            app_name: "Safari".to_string(),
            window_name: "Google Maps".to_string(),
            ocr_text: "San Francisco CA directions".to_string(),
        }],
    };

    println!("\nCapture cycle 3: Safari visible");
    let frame_ids_3 = process_capture_cycle_buggy(&capture3, &mut video, &mut db);
    println!("  Video frames written: {}", video.frame_count());
    println!(
        "  DB records created: {} (frame_ids: {:?})",
        frame_ids_3.len(),
        frame_ids_3
    );

    // Now let's see the mismatch
    println!("\n=== Checking for mismatches ===\n");
    println!("Total video frames: {}", video.frame_count());
    println!("Total DB records: {}", db.frames.len());

    let mut mismatches = 0;

    for record in &db.frames {
        let video_frame = video.extract_frame(record.offset_index as usize);
        let matches = video_frame
            .map(|content| content.contains(&record.app_name))
            .unwrap_or(false);

        println!(
            "Frame ID {}: app='{}', offset_index={}, video_frame_exists={}, content_matches={}",
            record.frame_id,
            record.app_name,
            record.offset_index,
            video_frame.is_some(),
            matches
        );

        if let Some(content) = video_frame {
            if !matches {
                println!(
                    "  MISMATCH! DB says '{}' but video shows: '{}'",
                    record.app_name, content
                );
                mismatches += 1;
            }
        } else {
            println!(
                "  MISMATCH! No video frame at offset {}",
                record.offset_index
            );
            mismatches += 1;
        }
    }

    println!("\n=== Summary ===");
    println!("Video frames: {}", video.frame_count());
    println!("DB records: {}", db.frames.len());
    println!("Mismatches: {}", mismatches);

    // The bug: More DB records than video frames causes offset_index misalignment
    assert!(
        db.frames.len() > video.frame_count(),
        "Bug prerequisite: more DB records than video frames"
    );

    assert!(
        mismatches > 0,
        "\n\nBUG NOT REPRODUCED! Expected mismatches due to offset_index desync.\n\
         The issue is: {} DB records vs {} video frames.\n\
         DB offset_index is based on DB record count, not video frame count.\n",
        db.frames.len(),
        video.frame_count()
    );

    println!("\nBUG REPRODUCED: {} mismatches found!", mismatches);
    println!("Root cause: offset_index in DB is calculated from DB record count,");
    println!("            but video frames are written once per capture cycle.");
}

#[test]
fn test_fix_one_db_record_per_capture_cycle() {
    println!("\n=== Testing fix: One DB record per capture cycle ===\n");

    let mut video = MockVideoFile::new();
    let mut db_records: Vec<(i64, i64, Vec<WindowResult>)> = Vec::new(); // (frame_id, offset_index, windows)
    let mut next_frame_id = 1i64;

    // Helper to process capture with fix
    let mut process_capture_fixed = |capture: &CaptureResult| {
        // Video gets ONE frame
        video.write_frame(&capture.full_screen_content);
        let offset_index = (video.frame_count() - 1) as i64; // Correct: based on video frame count

        // DB gets ONE record that references all windows
        let frame_id = next_frame_id;
        next_frame_id += 1;
        db_records.push((frame_id, offset_index, capture.windows.clone()));

        frame_id
    };

    // Same captures as before
    let capture1 = CaptureResult {
        full_screen_content: "Screen: WezTerm + Arc".to_string(),
        windows: vec![
            WindowResult {
                app_name: "WezTerm".to_string(),
                window_name: "code".to_string(),
                ocr_text: "code".to_string(),
            },
            WindowResult {
                app_name: "Arc".to_string(),
                window_name: "GitHub".to_string(),
                ocr_text: "github".to_string(),
            },
        ],
    };

    let capture2 = CaptureResult {
        full_screen_content: "Screen: Finder".to_string(),
        windows: vec![WindowResult {
            app_name: "Finder".to_string(),
            window_name: "Documents".to_string(),
            ocr_text: "docs".to_string(),
        }],
    };

    process_capture_fixed(&capture1);
    process_capture_fixed(&capture2);

    println!("Video frames: {}", video.frame_count());
    println!("DB records: {}", db_records.len());

    // With fix: video frames == DB records
    assert_eq!(
        video.frame_count(),
        db_records.len(),
        "With fix: video frame count should equal DB record count"
    );

    // Verify all offsets are valid
    for (frame_id, offset_index, _windows) in &db_records {
        let video_frame = video.extract_frame(*offset_index as usize);
        assert!(
            video_frame.is_some(),
            "Frame {} with offset {} should have a valid video frame",
            frame_id,
            offset_index
        );
    }

    println!("\nFIX WORKS: Video frames and DB records are in sync!");
}

impl Clone for WindowResult {
    fn clone(&self) -> Self {
        WindowResult {
            app_name: self.app_name.clone(),
            window_name: self.window_name.clone(),
            ocr_text: self.ocr_text.clone(),
        }
    }
}

#[test]
fn test_fix_shared_offset_per_capture_cycle() {
    println!("\n=== Testing fix: Shared offset_index per capture cycle ===\n");
    println!("This matches the actual code fix: get offset ONCE, share across all windows.\n");

    let mut video = MockVideoFile::new();
    let mut db = MockDatabase::new();
    let mut video_frame_count = 0i64;

    // Helper to process capture with the actual fix strategy
    let mut process_capture_fixed = |capture: &CaptureResult| {
        // Video gets ONE frame per capture cycle
        video.write_frame(&capture.full_screen_content);

        // Get the offset for this capture cycle (same as video frame count before write)
        let offset_for_this_cycle = video_frame_count;
        video_frame_count += 1;

        // All windows from this capture share the SAME offset
        let mut frame_ids = Vec::new();
        for window in &capture.windows {
            let frame_id = db.next_frame_id;
            db.next_frame_id += 1;

            db.frames.push(DbFrameRecord {
                frame_id,
                offset_index: offset_for_this_cycle, // FIXED: Same offset for all windows
                app_name: window.app_name.clone(),
                window_name: window.window_name.clone(),
                ocr_text: window.ocr_text.clone(),
            });

            frame_ids.push(frame_id);
        }

        frame_ids
    };

    // Same capture scenarios
    let capture1 = CaptureResult {
        full_screen_content: "Screen: WezTerm + Arc (both visible)".to_string(),
        windows: vec![
            WindowResult {
                app_name: "WezTerm".to_string(),
                window_name: "code".to_string(),
                ocr_text: "fn main()".to_string(),
            },
            WindowResult {
                app_name: "Arc".to_string(),
                window_name: "GitHub".to_string(),
                ocr_text: "github.com".to_string(),
            },
        ],
    };

    let capture2 = CaptureResult {
        full_screen_content: "Screen: Finder only".to_string(),
        windows: vec![WindowResult {
            app_name: "Finder".to_string(),
            window_name: "Documents".to_string(),
            ocr_text: "Documents folder".to_string(),
        }],
    };

    let capture3 = CaptureResult {
        full_screen_content: "Screen: Safari with maps".to_string(),
        windows: vec![WindowResult {
            app_name: "Safari".to_string(),
            window_name: "Maps".to_string(),
            ocr_text: "Google Maps".to_string(),
        }],
    };

    println!("Capture 1 (2 windows): WezTerm + Arc");
    let ids1 = process_capture_fixed(&capture1);
    println!("  Frame IDs: {:?}, both use offset_index=0", ids1);

    println!("\nCapture 2 (1 window): Finder");
    let ids2 = process_capture_fixed(&capture2);
    println!("  Frame IDs: {:?}, uses offset_index=1", ids2);

    println!("\nCapture 3 (1 window): Safari");
    let ids3 = process_capture_fixed(&capture3);
    println!("  Frame IDs: {:?}, uses offset_index=2", ids3);

    println!("\n=== Verification ===");
    println!("Video frames: {}", video.frame_count());
    println!("DB records: {}", db.frames.len());

    let mut all_valid = true;
    for record in &db.frames {
        let video_frame = video.extract_frame(record.offset_index as usize);
        let content_valid = video_frame.is_some();
        println!(
            "Frame ID {}: app='{}', offset={} -> video frame exists: {}",
            record.frame_id, record.app_name, record.offset_index, content_valid
        );
        if !content_valid {
            all_valid = false;
        }
    }

    // Verify WezTerm and Arc both point to offset 0 (the same video frame)
    let wezterm = db.frames.iter().find(|f| f.app_name == "WezTerm").unwrap();
    let arc = db.frames.iter().find(|f| f.app_name == "Arc").unwrap();
    assert_eq!(
        wezterm.offset_index, arc.offset_index,
        "WezTerm and Arc should share the same offset (same capture cycle)"
    );
    println!(
        "\nWezTerm offset: {}, Arc offset: {} (same capture cycle = same offset)",
        wezterm.offset_index, arc.offset_index
    );

    assert!(
        all_valid,
        "All DB records should point to valid video frames"
    );
    println!("\nFIX VERIFIED: All DB records point to valid video frames!");
    println!("Multiple windows per capture cycle share the same video frame offset.");
}
