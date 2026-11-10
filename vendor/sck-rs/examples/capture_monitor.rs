//! Example: Capture monitors/displays

use sck_rs::Monitor;

fn main() {
    tracing_subscriber::fmt::init();

    println!("Fetching monitors...\n");

    match Monitor::all() {
        Ok(monitors) => {
            println!("Found {} monitor(s):\n", monitors.len());

            for monitor in &monitors {
                let id = monitor.id();
                let name = monitor.name();
                let width = monitor.width().unwrap_or(0);
                let height = monitor.height().unwrap_or(0);
                let x = monitor.x();
                let y = monitor.y();
                let primary = if monitor.is_primary() {
                    " (Primary)"
                } else {
                    ""
                };

                println!(
                    "[{}] {}{} - {}x{} at ({}, {})",
                    id, name, primary, width, height, x, y
                );
            }

            println!("\nCapturing monitors...\n");

            for monitor in monitors {
                let id = monitor.id();
                let name = monitor.name().to_string();

                println!("Capturing: {}", name);

                match monitor.capture_image() {
                    Ok(image) => {
                        let filename = format!("monitor_{}.png", id);
                        match image.save(&filename) {
                            Ok(_) => println!("  Saved to: {}", filename),
                            Err(e) => println!("  Failed to save: {}", e),
                        }
                    }
                    Err(e) => {
                        println!("  Capture failed: {}", e);
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
