//! Example: Capture a specific window
//!
//! Note: Window capture may not work for all windows. System windows and some
//! special window types may fail to capture. For those cases, consider using
//! monitor capture instead.

use sck_rs::Window;
use std::env;

fn main() {
    tracing_subscriber::fmt::init();

    let args: Vec<String> = env::args().collect();

    // Get window by title substring or capture first valid window
    let filter = args.get(1);

    println!("Fetching windows...");

    match Window::all() {
        Ok(windows) => {
            // Filter for windows that are more likely to be capturable
            // (have a title or app name, are on screen, and are not too small)
            let capturable_windows: Vec<_> = windows
                .into_iter()
                .filter(|w| {
                    let title = w.title().unwrap_or_default();
                    let app = w.app_name().unwrap_or_default();
                    let on_screen = w.is_on_screen();
                    let width = w.width().unwrap_or(0);
                    let height = w.height().unwrap_or(0);

                    // Filter criteria:
                    // - Has either a title or app name
                    // - Is on screen (not minimized)
                    // - Has reasonable dimensions
                    (!title.is_empty() || !app.is_empty())
                        && on_screen
                        && width >= 100
                        && height >= 100
                })
                .collect();

            let windows_to_capture: Vec<_> = if let Some(filter) = filter {
                capturable_windows
                    .into_iter()
                    .filter(|w| {
                        let title = w.title().unwrap_or_default().to_lowercase();
                        let app = w.app_name().unwrap_or_default().to_lowercase();
                        let filter_lower = filter.to_lowercase();
                        title.contains(&filter_lower) || app.contains(&filter_lower)
                    })
                    .collect()
            } else {
                // Just take the first 2 capturable windows
                capturable_windows.into_iter().take(2).collect()
            };

            if windows_to_capture.is_empty() {
                println!("No matching capturable windows found");
                println!("\nTip: Try running with an app name, e.g.: cargo run --example capture_window -- Safari");
                return;
            }

            println!("Capturing {} window(s)...\n", windows_to_capture.len());

            for window in windows_to_capture {
                let id = window.id().unwrap_or(0);
                let app = window.app_name().unwrap_or_default();
                let title = window.title().unwrap_or_default();

                println!("Capturing: {} - \"{}\" (id: {})", app, title, id);

                match window.capture_image() {
                    Ok(image) => {
                        let filename = format!("window_{}.png", id);
                        match image.save(&filename) {
                            Ok(_) => println!("  Saved to: {}", filename),
                            Err(e) => println!("  Failed to save: {}", e),
                        }
                    }
                    Err(e) => {
                        println!("  Capture failed: {}", e);
                        println!("  Note: Some windows cannot be captured. Try a different window or use monitor capture.");
                    }
                }
                println!();
            }
        }
        Err(e) => {
            eprintln!("Error: {}", e);
            eprintln!("\nMake sure screen recording permission is granted.");
        }
    }
}
