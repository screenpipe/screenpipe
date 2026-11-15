// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Cross-platform execution-provider (EP) parity receipts (Phase 4).
//!
//! The shipped `rfdetr_v54` ONNX is a single cross-platform `W16A32` graph.
//! At runtime it is dispatched to one of three providers depending on the
//! build target:
//!
//! | target / feature | EP | session setup in `adapters::rfdetr` |
//! |---|---|---|
//! | macOS `onnx-coreml` | CoreML `MLProgram` (`CPUAndGPU`) | `with_execution_providers([CoreML, CPU])` |
//! | Windows `onnx-directml` | DirectML (`device_id 0`) | `with_execution_providers([DirectML, CPU])` |
//! | Linux / default `onnx-cpu` | CPU (no arena) | `with_execution_providers([CPU])` |
//!
//! A single machine cannot build all three EPs at once (the providers are
//! platform SDKs), so parity is proved by **portable receipts**: each
//! platform runs `examples/rfdetr_ep_parity.rs` on the *same* probe frame,
//! emitting a small JSON receipt. [`compare_all`] then checks the receipts
//! pairwise and requires that detections agree within a tolerance — fp16
//! weight rounding and per-EP kernel math produce small bbox/score drift,
//! so exact equality is neither expected nor required.
//!
//! This module is deliberately **featureless** (pure Rust + serde): the
//! comparator and its unit tests compile and run on every platform with a
//! plain `cargo test -p screenpipe-redact`, so the parity contract itself is
//! validated even on a machine with no ONNX Runtime, no model and no GPU.
//! Only the receipt *emitter* needs `onnx-cpu`.
//!
//! Receipts are **text-free**: they contain label names, integer bboxes and
//! quantized scores only — never pixels, OCR text or model internals.

use serde::{Deserialize, Serialize};

/// Receipt schema version. Bump when the field set changes so receipts from
/// different builds are never silently compared.
pub const SCHEMA_VERSION: u32 = 1;

/// Minimum per-direction recall for a pair of EPs to count as "in parity".
/// Set below 1.0 to allow the small number of borderline boxes that can flip
/// around the score floor under different EP kernel math.
pub const MIN_PARITY_RECALL: f32 = 0.90;

/// A detection is "the same" across EPs when the label matches, box IoU is
/// at least this, and the quantized score is within [`SCORE_Q_TOL`].
pub const IOU_MIN: f32 = 0.70;
pub const SCORE_Q_TOL: i32 = 15; // 0.15 in score, quantized to /100

/// Which EP a receipt was produced under, derived from the crate's compile
/// time features. `none` is the featureless build (unit tests only).
pub fn active_ep() -> &'static str {
    if cfg!(feature = "onnx-coreml") {
        "coreml"
    } else if cfg!(feature = "onnx-directml") {
        "directml"
    } else if cfg!(feature = "onnx-cpu") {
        "cpu"
    } else {
        "none"
    }
}

/// One detection, in a canonical text-free form. `label` is the
/// `SpanLabel` wire name (snake_case); `score_q` is `round(score * 100)`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RegionRecord {
    pub label: String,
    pub bbox: [u32; 4],
    pub score_q: i32,
}

impl RegionRecord {
    pub fn new(label: impl Into<String>, bbox: [u32; 4], score: f32) -> Self {
        Self {
            label: label.into(),
            bbox,
            score_q: (score * 100.0).round() as i32,
        }
    }
}

/// A portable per-EP parity receipt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ParityReceipt {
    pub schema: u32,
    pub ep: String,
    /// SHA-256 of the exact ONNX file loaded (text-free hex).
    pub model_sha256: String,
    /// SHA-256 of the exact probe frame bytes (text-free hex).
    pub probe_sha256: String,
    /// Region count is stored redundantly so a truncated file is detectable
    /// even before parsing every record.
    pub region_count: usize,
    pub regions: Vec<RegionRecord>,
}

impl ParityReceipt {
    /// Build a canonical receipt: regions sorted into a stable order so two
    /// runs with the same detections serialize byte-for-byte identically.
    pub fn new(
        ep: impl Into<String>,
        model_sha256: String,
        probe_sha256: String,
        mut regions: Vec<RegionRecord>,
    ) -> Self {
        regions.sort_by(|a, b| {
            (a.bbox, &a.label, a.score_q).cmp(&(b.bbox, &b.label, b.score_q))
        });
        let region_count = regions.len();
        Self {
            schema: SCHEMA_VERSION,
            ep: ep.into(),
            model_sha256,
            probe_sha256,
            region_count,
            regions,
        }
    }

    /// `region_count` must agree with the parsed vector (guards a truncated
    /// or hand-edited receipt).
    pub fn is_well_formed(&self) -> bool {
        self.region_count == self.regions.len()
    }
}

/// Result of comparing one ordered pair of EPs (`a` -> `b`).
#[derive(Debug, Clone)]
pub struct PairResult {
    pub a: String,
    pub b: String,
    /// Fraction of `a`'s regions that found a matching region in `b`.
    pub recall: f32,
    pub matched: usize,
    pub total_a: usize,
    pub total_b: usize,
}

/// Full comparison of a set of receipts.
#[derive(Debug, Clone)]
pub struct ParityReport {
    /// All receipts agree on schema, model hash and probe hash.
    pub consistent_inputs: bool,
    /// At least two distinct EPs were supplied.
    pub distinct_eps: bool,
    pub pairs: Vec<PairResult>,
    pub notes: Vec<String>,
    pub threshold: f32,
}

impl ParityReport {
    /// Overall parity verdict.
    pub fn ok(&self) -> bool {
        self.consistent_inputs
            && self.distinct_eps
            && self.pairs.iter().all(|p| p.recall >= self.threshold)
    }

    /// Text-free ASCII table for PR bodies and terminal output.
    pub fn render(&self) -> String {
        let mut s = String::new();
        s.push_str("EP parity report (recall = matched / source regions)\n");
        s.push_str("+------------------+------------------+--------+-----------+---------+\n");
        s.push_str("| source EP        | target EP        | recall | matched   | total   |\n");
        s.push_str("+------------------+------------------+--------+-----------+---------+\n");
        for p in &self.pairs {
            s.push_str(&format!(
                "| {:<16} | {:<16} | {:>6.2} | {:>3}/{:<5} | {:>7} |\n",
                p.a, p.b, p.recall, p.matched, p.total_a, p.total_b
            ));
        }
        s.push_str("+------------------+------------------+--------+-----------+---------+\n");
        s.push_str(&format!(
            "inputs_consistent={} distinct_eps={} threshold={:.2} VERDICT={}\n",
            self.consistent_inputs,
            self.distinct_eps,
            self.threshold,
            if self.ok() { "PARITY" } else { "MISMATCH" }
        ));
        for n in &self.notes {
            s.push_str(&format!("note: {n}\n"));
        }
        s
    }
}

/// IoU of two `[x, y, w, h]` integer boxes.
fn iou(a: [u32; 4], b: [u32; 4]) -> f32 {
    let ax2 = a[0].saturating_add(a[2]);
    let ay2 = a[1].saturating_add(a[3]);
    let bx2 = b[0].saturating_add(b[2]);
    let by2 = b[1].saturating_add(b[3]);
    let ix = ax2.min(bx2).saturating_sub(a[0].max(b[0]));
    let iy = ay2.min(by2).saturating_sub(a[1].max(b[1]));
    let inter = (ix as f32) * (iy as f32);
    let uni = (a[2] as f32) * (a[3] as f32) + (b[2] as f32) * (b[3] as f32) - inter;
    if uni <= 0.0 {
        0.0
    } else {
        (inter / uni).clamp(0.0, 1.0)
    }
}

fn matches(a: &RegionRecord, b: &RegionRecord) -> bool {
    a.label == b.label
        && (a.score_q - b.score_q).abs() <= SCORE_Q_TOL
        && iou(a.bbox, b.bbox) >= IOU_MIN
}

fn directional_recall(a: &ParityReceipt, b: &ParityReceipt) -> PairResult {
    let matched = a
        .regions
        .iter()
        .filter(|ra| b.regions.iter().any(|rb| matches(ra, rb)))
        .count();
    let total_a = a.regions.len();
    let recall = if total_a == 0 {
        // Empty detections are trivially in parity; callers should still pass
        // a representative probe frame (the emitter documents this).
        1.0
    } else {
        matched as f32 / total_a as f32
    };
    PairResult {
        a: a.ep.clone(),
        b: b.ep.clone(),
        recall,
        matched,
        total_a,
        total_b: b.regions.len(),
    }
}

/// Compare every ordered pair of receipts. Ordered (both directions) so a
/// provider that under-reports boxes is caught just as well as one that
/// over-reports.
pub fn compare_all(receipts: &[ParityReceipt]) -> ParityReport {
    let mut notes = Vec::new();
    if receipts.len() < 2 {
        notes.push("need at least 2 receipts to compare".to_string());
    }
    for r in receipts {
        if r.schema != SCHEMA_VERSION {
            notes.push(format!("{}: schema {} != {}", r.ep, r.schema, SCHEMA_VERSION));
        }
        if !r.is_well_formed() {
            notes.push(format!(
                "{}: region_count {} != parsed {}",
                r.ep,
                r.region_count,
                r.regions.len()
            ));
        }
    }
    let first = receipts.first();
    let consistent_inputs = receipts.iter().all(|r| {
        first.map(|f| {
            r.schema == f.schema
                && r.model_sha256 == f.model_sha256
                && r.probe_sha256 == f.probe_sha256
        }) == Some(true)
    }) && receipts.iter().all(|r| r.is_well_formed());
    if !consistent_inputs && receipts.len() >= 2 {
        notes.push("model/probe hash or schema mismatch across receipts".to_string());
    }

    let eps: Vec<&str> = receipts.iter().map(|r| r.ep.as_str()).collect();
    let mut uniq = eps.clone();
    uniq.sort();
    uniq.dedup();
    let distinct_eps = uniq.len() >= 2;
    if receipts.len() >= 2 && !distinct_eps {
        notes.push("all receipts are from the same EP".to_string());
    }

    let mut pairs = Vec::new();
    for (i, a) in receipts.iter().enumerate() {
        for (j, b) in receipts.iter().enumerate() {
            if i != j {
                pairs.push(directional_recall(a, b));
            }
        }
    }
    ParityReport {
        consistent_inputs,
        distinct_eps,
        pairs,
        notes,
        threshold: MIN_PARITY_RECALL,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHA: &str = "c2b645b9f4084aebb503805722e53c8de0c023e67b77b69e46a7ce9de014522a";

    fn base_regions() -> Vec<RegionRecord> {
        vec![
            RegionRecord::new("secret", [10, 20, 100, 30], 0.83),
            RegionRecord::new("email", [200, 40, 160, 28], 0.51),
            RegionRecord::new("person", [10, 300, 90, 26], 0.67),
        ]
    }

    fn receipt(ep: &str, regions: Vec<RegionRecord>) -> ParityReceipt {
        ParityReceipt::new(ep, SHA.to_string(), "probe".repeat(4), regions)
    }

    #[test]
    fn identical_receipts_are_in_parity_across_three_eps() {
        let receipts = vec![
            receipt("cpu", base_regions()),
            receipt("coreml", base_regions()),
            receipt("directml", base_regions()),
        ];
        let report = compare_all(&receipts);
        assert!(report.consistent_inputs);
        assert!(report.distinct_eps);
        assert_eq!(report.pairs.len(), 6); // 3 x 2 ordered pairs
        assert!(report.pairs.iter().all(|p| (p.recall - 1.0).abs() < 1e-6));
        assert!(report.ok(), "{}", report.render());
    }

    #[test]
    fn canonical_order_is_independent_of_input_order() {
        let mut rev = base_regions();
        rev.reverse();
        let a = receipt("cpu", base_regions());
        let b = receipt("coreml", rev);
        assert_eq!(a.regions, b.regions, "receipts must canonicalize order");
    }

    #[test]
    fn tolerates_small_fp16_box_and_score_drift() {
        // CoreML/DirectML kernels shift a bbox by ~1 px and a score by ~0.1.
        let drifted = vec![
            RegionRecord::new("secret", [11, 20, 100, 30], 0.90), // +1 x, +0.07 score
            RegionRecord::new("email", [200, 41, 160, 28], 0.55),
            RegionRecord::new("person", [10, 300, 90, 26], 0.67),
        ];
        let receipts = vec![receipt("cpu", base_regions()), receipt("coreml", drifted)];
        let report = compare_all(&receipts);
        assert!(report.ok(), "expected parity under small drift\n{}", report.render());
    }

    #[test]
    fn divergent_ep_fails_parity() {
        // DirectML drops one box and invents a wrong-label box.
        let diverged = vec![
            RegionRecord::new("secret", [10, 20, 100, 30], 0.83),
            RegionRecord::new("phone", [200, 40, 160, 28], 0.51), // wrong label
        ];
        let receipts = vec![receipt("cpu", base_regions()), receipt("directml", diverged)];
        let report = compare_all(&receipts);
        assert!(!report.ok(), "divergence must be detected\n{}", report.render());
        // cpu -> directml recall should be 1/3.
        let cpu_to_dml = report
            .pairs
            .iter()
            .find(|p| p.a == "cpu" && p.b == "directml")
            .unwrap();
        assert!((cpu_to_dml.recall - 1.0 / 3.0).abs() < 1e-6);
    }

    #[test]
    fn mismatched_model_hash_is_rejected() {
        let mut bad = receipt("coreml", base_regions());
        bad.model_sha256 = "deadbeef".repeat(8);
        let receipts = vec![receipt("cpu", base_regions()), bad];
        let report = compare_all(&receipts);
        assert!(!report.consistent_inputs);
        assert!(!report.ok());
    }

    #[test]
    fn truncated_receipt_is_rejected() {
        let mut bad = receipt("coreml", base_regions());
        bad.region_count = 99; // does not match parsed regions
        let receipts = vec![receipt("cpu", base_regions()), bad];
        let report = compare_all(&receipts);
        assert!(!report.ok());
        assert!(report.notes.iter().any(|n| n.contains("region_count")));
    }

    #[test]
    fn active_ep_is_one_of_the_known_providers() {
        assert!(["coreml", "directml", "cpu", "none"].contains(&active_ep()));
    }
}
