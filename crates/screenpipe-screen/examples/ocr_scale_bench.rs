// OCR quality vs downscale factor — measures how much Apple Vision OCR
// degrades when capture width is capped via sck-rs's new capture_image_scaled.
//
// Method: capture once at native resolution, then synthetically downscale
// in-memory (bilinear, closest to GPU resize) to a range of target widths,
// OCR each, compare against the native OCR text as the baseline.
//
// Why synthetic resize and not multiple SCK captures: the screen changes
// between captures, so per-capture differences would conflate temporal
// noise with downscale impact. In-memory resize isolates the variable.
// As a sanity check we also do one SCK-scaled capture and compare it
// against the same-width synthetic resize.
//
// macOS only — relies on sck-rs (ScreenCaptureKit) and Apple Vision OCR.
//
// Run with:
//   cargo run --release --example ocr_scale_bench -p screenpipe-screen

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("ocr_scale_bench is macOS-only (uses sck-rs and Apple Vision)");
}

#[cfg(target_os = "macos")]
fn main() {
    macos::run()
}

#[cfg(target_os = "macos")]
mod macos {
    use image::imageops::FilterType;
    use image::DynamicImage;
    use sck_rs::Monitor;
    use screenpipe_core::Language;
    use screenpipe_screen::apple::perform_ocr_apple;
    use std::collections::HashSet;
    use std::time::Instant;

    fn normalize_words(text: &str) -> HashSet<String> {
        text.split_whitespace()
            .map(|w| {
                w.to_lowercase()
                    .trim_matches(|c: char| !c.is_alphanumeric())
                    .to_string()
            })
            .filter(|w| w.len() >= 3)
            .collect()
    }

    fn report(
        label: &str,
        baseline_text: &str,
        baseline_words: &HashSet<String>,
        text: &str,
        conf: Option<f64>,
    ) {
        let words = normalize_words(text);
        let intersection: usize = baseline_words.intersection(&words).count();
        let recall = if !baseline_words.is_empty() {
            100.0 * intersection as f64 / baseline_words.len() as f64
        } else {
            0.0
        };
        // Lost words = baseline - downscaled. Sample first few for spot-checking.
        let lost: Vec<&String> = baseline_words.difference(&words).take(10).collect();
        let edit = strsim::levenshtein(baseline_text, text);
        let ced = 100.0 * edit as f64 / baseline_text.len().max(1) as f64;
        println!(
            "  {:14}  len={:6}  uniq_words={:5}  recall={:5.1}%  CER≈{:4.1}%  conf={:?}",
            label,
            text.len(),
            words.len(),
            recall,
            ced,
            conf.map(|c| (c * 100.0).round() / 100.0)
        );
        if !lost.is_empty() && recall < 99.0 {
            let sample: Vec<String> = lost.iter().take(8).map(|s| (*s).clone()).collect();
            println!("                    lost-words sample: {:?}", sample);
        }
    }

    pub fn run() {
        let monitors = Monitor::all().expect("Monitor::all (grant Screen Recording)");
        let monitor = monitors
            .into_iter()
            .find(|m| m.is_primary())
            .expect("no primary monitor");
        let native_w = monitor.raw_width();
        let native_h = monitor.raw_height();
        println!(
            "monitor: {} ({}x{} native)\n",
            monitor.name(),
            native_w,
            native_h
        );

        std::fs::create_dir_all("/tmp/ocr-bench").ok();

        // --- 1. Native capture + OCR baseline ---
        let t = Instant::now();
        let native_rgba = monitor.capture_image().expect("native capture");
        let native_cap = t.elapsed();
        let native_img = DynamicImage::ImageRgba8(native_rgba);

        let t = Instant::now();
        let (native_text, _json, native_conf) =
            perform_ocr_apple(&native_img, &[Language::English]);
        let native_ocr = t.elapsed();
        let baseline_words = normalize_words(&native_text);
        std::fs::write("/tmp/ocr-bench/native.txt", &native_text).ok();

        println!(
            "baseline (native {}x{}): cap={:?} ocr={:?} text_len={} uniq_words={}",
            native_img.width(),
            native_img.height(),
            native_cap,
            native_ocr,
            native_text.len(),
            baseline_words.len()
        );
        println!();
        let _ = native_conf;

        // --- 2. Synthetic downscale comparisons ---
        println!("synthetic downscale (bilinear in-memory, isolates the downscale variable):");
        let widths = [1920u32, 1280, 960, 768, 480];
        for &max_w in &widths {
            if max_w >= native_w {
                println!(
                    "  {:14}  (skipped: native already <= {})",
                    format!("{}px", max_w),
                    max_w
                );
                continue;
            }
            // Preserve aspect; height derived from ratio.
            let target_h = ((max_w as u64 * native_h as u64) / native_w as u64) as u32;
            let scaled = native_img.resize_exact(max_w, target_h, FilterType::Triangle);
            let t = Instant::now();
            let (text, _json, conf) = perform_ocr_apple(&scaled, &[Language::English]);
            let ocr_ms = t.elapsed();
            let label = format!("{}px ({}ms)", max_w, ocr_ms.as_millis());
            report(&label, &native_text, &baseline_words, &text, conf);
            std::fs::write(format!("/tmp/ocr-bench/synthetic_{}.txt", max_w), &text).ok();
        }

        // --- 3. SCK-scaled sanity check (validates synthetic proxy) ---
        println!("\nSCK-scaled capture (validates synthetic resize as a proxy):");
        let cap = 1280u32;
        if cap >= native_w {
            println!("  {}px: skipped (native already <= cap)", cap);
        } else {
            std::thread::sleep(std::time::Duration::from_millis(200));
            let t = Instant::now();
            let sck_rgba = monitor.capture_image_scaled(cap).expect("scaled capture");
            let cap_dur = t.elapsed();
            let sck_img = DynamicImage::ImageRgba8(sck_rgba);
            let t = Instant::now();
            let (text, _json, conf) = perform_ocr_apple(&sck_img, &[Language::English]);
            let ocr_ms = t.elapsed();
            let label = format!(
                "sck_{}px ({}x{}) cap={}ms ocr={}ms",
                cap,
                sck_img.width(),
                sck_img.height(),
                cap_dur.as_millis(),
                ocr_ms.as_millis()
            );
            report(&label, &native_text, &baseline_words, &text, conf);
            std::fs::write(format!("/tmp/ocr-bench/sck_{}.txt", cap), &text).ok();
        }

        println!("\noutput texts saved in /tmp/ocr-bench/ for spot-checking.");
    }
}
