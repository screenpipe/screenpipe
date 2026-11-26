// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Read-only offline cross-modal evaluation driver (V5 Step 1).
//!
//! Combines precomputed image-detector JSONL predictions (`sealed_p1_v108b_w16.jsonl`)
//! with local `Pipeline` (`RegexRedactor` + `v50_distilled6l` ONNX) over
//! `<root>/ocr/<frame_id>.json`, projecting redacted placeholders into pixel
//! `ImageRegion`s via `redact_ocr_text_json` + `extract_ocr_cross_modal_regions`
//! + `merge_image_regions`.
//!
//! Strictly text-free output: never logs or writes raw strings from `<root>/ocr/`.

use std::collections::BTreeMap;
use std::fs::OpenOptions;
use std::io::Write;
use std::os::unix::io::AsRawFd;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use screenpipe_redact::adapters::onnx::{OnnxConfig, OnnxRedactor};
use screenpipe_redact::{
    extract_ocr_cross_modal_regions, merge_image_regions, redact_ocr_text_json, ImageRegion,
    Pipeline, PipelineConfig, Redactor, TextRedactionPolicy,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

const EVAL_LABELS: &[&str] = &[
    "person",
    "email",
    "phone",
    "address",
    "url",
    "company",
    "repo",
    "handle",
    "channel",
    "id",
    "date",
    "secret",
    "sensitive",
];

#[derive(Debug, Deserialize)]
struct BasePredRow {
    id: String,
    ms: f64,
    #[serde(default = "default_ok")]
    status: String,
    regions: Vec<ImageRegion>,
}

fn default_ok() -> String {
    "ok".to_string()
}

#[derive(Debug, Serialize)]
struct OutPredRow {
    id: String,
    status: String,
    ms: f64,
    text_ms: f64,
    regions: Vec<ImageRegion>,
}

fn reconstruct_full_text_from_ocr(ocr_blob: &str) -> Result<String, serde_json::Error> {
    let items: Vec<Value> = serde_json::from_str(ocr_blob)?;
    let mut full = String::new();
    let mut prev_line: Option<i64> = None;
    for item in &items {
        let Some(obj) = item.as_object() else {
            continue;
        };
        let Some(text) = obj.get("text").and_then(Value::as_str) else {
            continue;
        };
        if text.is_empty() {
            continue;
        }
        let curr_line = obj.get("line").and_then(Value::as_i64);
        if let Some(pl) = prev_line {
            if curr_line == Some(pl) {
                full.push(' ');
            } else {
                full.push('\n');
            }
        } else if !full.is_empty() {
            full.push(' ');
        }
        full.push_str(text);
        prev_line = curr_line;
    }
    Ok(full)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut root = PathBuf::from("/Users/louis/pii-eval-sealed/realscreen-v1");
    let mut base_pred =
        PathBuf::from("/Users/louis/pii-v4-flywheel/receipts/sealed_p1_v108b_w16.jsonl");
    let mut out_pred = PathBuf::from(
        "/private/var/folders/60/qqt5zhl1313ckdx0b1twy7_c0000gn/T/opencode/step1_crossmodal_preds.jsonl",
    );
    let mut model_dir = OnnxConfig::default_model_dir();
    let mut lock_path = PathBuf::from(
        "/private/var/folders/60/qqt5zhl1313ckdx0b1twy7_c0000gn/T/opencode/ort_dev_eval.lock",
    );

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--root" => root = PathBuf::from(args.next().ok_or("missing --root value")?),
            "--base-pred" => {
                base_pred = PathBuf::from(args.next().ok_or("missing --base-pred value")?)
            }
            "--out-pred" => {
                out_pred = PathBuf::from(args.next().ok_or("missing --out-pred value")?)
            }
            "--model-dir" => {
                model_dir = PathBuf::from(args.next().ok_or("missing --model-dir value")?)
            }
            "--lock-file" => {
                lock_path = PathBuf::from(args.next().ok_or("missing --lock-file value")?)
            }
            other => return Err(format!("unknown argument: {other}").into()),
        }
    }

    if let Some(parent) = lock_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let lock_file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(&lock_path)?;
    let rc = unsafe { libc::flock(lock_file.as_raw_fd(), libc::LOCK_EX) };
    if rc != 0 {
        return Err(format!("flock failed on {}", lock_path.display()).into());
    }

    let onnx = OnnxRedactor::load(OnnxConfig {
        model_dir,
        ..Default::default()
    })?;
    let label_vec: Vec<String> = EVAL_LABELS.iter().map(|s| (*s).to_string()).collect();
    let pipeline = Pipeline::regex_then_ai(
        Arc::new(onnx),
        PipelineConfig {
            policy: TextRedactionPolicy::from_labels(&label_vec),
            ..Default::default()
        },
    );

    let base_lines = std::fs::read_to_string(&base_pred)?;
    if let Some(parent) = out_pred.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut out_file = std::fs::File::create(&out_pred)?;

    let mut frame_count = 0usize;
    let mut projected_by_label: BTreeMap<String, usize> = BTreeMap::new();
    let mut text_times_ms: Vec<f64> = Vec::new();

    for line in base_lines.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let base_row: BasePredRow = serde_json::from_str(line)?;
        let img_path = root.join("images").join(format!("{}.jpg", base_row.id));
        let ocr_path = root.join("ocr").join(format!("{}.json", base_row.id));
        let (width, height) = image::image_dimensions(&img_path)?;
        let ocr_raw = std::fs::read_to_string(&ocr_path)?;
        let full_text = reconstruct_full_text_from_ocr(&ocr_raw)?;

        let t0 = Instant::now();
        let mut combined = base_row.regions;
        if !full_text.is_empty() {
            if let Some((_, map)) = pipeline.redact_with_map(&full_text).await? {
                if let Some(scrubbed_ocr) = redact_ocr_text_json(&ocr_raw, &map)? {
                    let cross_regions =
                        extract_ocr_cross_modal_regions(&scrubbed_ocr, width, height);
                    for r in &cross_regions {
                        let key = serde_json::to_value(r.label)?
                            .as_str()
                            .unwrap_or("unknown")
                            .to_string();
                        *projected_by_label.entry(key).or_insert(0) += 1;
                    }
                    merge_image_regions(&mut combined, cross_regions);
                }
            }
        }
        let text_ms = (t0.elapsed().as_secs_f64() * 1000.0 * 10.0).round() / 10.0;
        text_times_ms.push(text_ms);

        let out_row = OutPredRow {
            id: base_row.id,
            status: base_row.status,
            ms: ((base_row.ms + text_ms) * 10.0).round() / 10.0,
            text_ms,
            regions: combined,
        };
        writeln!(out_file, "{}", serde_json::to_string(&out_row)?)?;
        frame_count += 1;
    }

    text_times_ms.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let p50 = text_times_ms
        .get(text_times_ms.len() / 2)
        .copied()
        .unwrap_or(0.0);
    let p95 = text_times_ms
        .get((text_times_ms.len() * 95) / 100)
        .copied()
        .unwrap_or(0.0);

    let summary = serde_json::json!({
        "frames_processed": frame_count,
        "text_projection_p50_ms": p50,
        "text_projection_p95_ms": p95,
        "projected_regions_by_label": projected_by_label,
    });
    println!("{}", serde_json::to_string_pretty(&summary)?);
    drop(lock_file);
    Ok(())
}
