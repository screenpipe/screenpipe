// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Phase 4 deterministic visual-PII detectors.
//!
//! The 12-class RF-DETR head (`adapters::rfdetr::CLASSES`) reads *text* PII.
//! Three PII categories are purely **visual** and cannot be recovered from
//! text: a human face, a profile avatar, and a QR / 2D barcode whose payload
//! may be a vCard, a signed URL or a token. This module adds those three
//! [`crate::SpanLabel`]s with detectors that are:
//!
//! - **100% local and zero-OCR** — no network, no text extraction, no second
//!   neural network. QR regions come from pixel finder patterns; avatar
//!   regions come from the *already-captured* OS accessibility tree; face
//!   regions come from an optional OS-backed provider hook.
//! - **Cross-platform** — pure Rust + `image` + `serde_json`, nothing that
//!   requires CoreML / DirectML / a GPU. Same code on macOS, Windows, Linux.
//! - **Opt-in** — [`VisualPiiConfig::default()`] enables nothing, so the
//!   shipped dogfood behavior is bit-for-bit unchanged unless a caller opts
//!   in. See `docs/VISION.md` ("Stability over features", "Respect the
//!   user's machine").
//!
//! Deliberately **not** in scope here: decoding QR payloads (we only mask the
//! symbol), and an ML face detector (would add a second model and a labeled
//! training round). [`FaceRegionProvider`] is the reviewed extension point
//! for an OS detector such as macOS Vision's `VNDetectFaceRectangles`; the
//! default provider emits zero regions rather than guessing, so this phase
//! cannot introduce face false positives.

use std::collections::BTreeMap;

use image::RgbImage;
use serde_json::Value;

use crate::image::ImageRegion;
use crate::SpanLabel;

/// Deterministic detections are treated as certain. The image policy's
/// `min_score` (`0.50` default / `0.30` strict) therefore always admits them.
const DETECTED_SCORE: f32 = 1.0;

/// Dark/light threshold for QR finder patterns. QR symbols are black modules
/// on a light quiet zone by spec, so a fixed threshold is sufficient and
/// avoids a per-frame histogram allocation.
const QR_DARK_THRESHOLD: u8 = 128;

/// Bounds on a plausible QR module size (pixels per module). Screenshots
/// rarely carry QR symbols smaller than 2 px/module or larger than 64.
const QR_MIN_MODULE: f32 = 2.0;
const QR_MAX_MODULE: f32 = 64.0;

/// Work ceilings so an opt-in detector can never become a hot-path problem.
const MAX_A11Y_DEPTH: usize = 32;
const MAX_A11Y_NODES: usize = 4096;
const MAX_FINDERS: usize = 64;

/// Opt-in switchboard for the visual-PII detectors.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VisualPiiConfig {
    /// Detect QR / 2D barcode symbols from pixel finder patterns.
    pub detect_qr: bool,
    /// Detect profile avatars from the accessibility tree (requires
    /// `a11y_json` at the call site).
    pub detect_avatars: bool,
    /// Emit [`SpanLabel::Face`] regions from the supplied
    /// [`FaceRegionProvider`]. No-op when no provider is supplied.
    pub detect_faces: bool,
}

impl Default for VisualPiiConfig {
    /// Shipped behavior: all visual detectors off.
    fn default() -> Self {
        Self { detect_qr: false, detect_avatars: false, detect_faces: false }
    }
}

impl VisualPiiConfig {
    /// All deterministic detectors on. This is the opt-in profile a strict
    /// tenant would choose; it is *not* wired into
    /// [`crate::RedactionPreset::Default`].
    pub fn enterprise() -> Self {
        Self { detect_qr: true, detect_avatars: true, detect_faces: true }
    }

    /// Cheap short-circuit so callers can skip the whole scan.
    pub fn enabled(&self) -> bool {
        self.detect_qr || self.detect_avatars || self.detect_faces
    }
}

/// OS-backed face-detector hook.
///
/// Phase 4 lands the label, the policy plumbing and this reviewed trait. A
/// platform adapter (macOS Vision, Windows Hello-class detectors, or a future
/// labeled ML round) implements `face_regions`. The default implementation
/// returns an empty vector: no fake detector, no skin-tone heuristics, no
/// false positives.
pub trait FaceRegionProvider: Send + Sync {
    /// Return face bounding boxes `[x, y, w, h]` in original-image pixels.
    fn face_regions(&self, _rgb: &RgbImage) -> Vec<[u32; 4]> {
        Vec::new()
    }
}

/// Default provider: emits zero regions. Used when the host has no OS face
/// detector wired up, which is the case on all three platforms today.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoopFaceRegionProvider;

impl FaceRegionProvider for NoopFaceRegionProvider {}

/// Detect visual PII in one RGB frame.
///
/// `a11y_json` is the *already-captured* OS accessibility tree for this
/// frame (same blob the text worker consumes); `None` simply disables avatar
/// detection. `faces` is the optional OS face provider. Returns regions in
/// original-image pixel space, ready to merge with the RF-DETR regions via
/// [`crate::a11y_context::merge_image_regions`] before `redact_frame`.
pub fn detect_visual_pii(
    rgb: &RgbImage,
    a11y_json: Option<&str>,
    faces: Option<&dyn FaceRegionProvider>,
    cfg: &VisualPiiConfig,
) -> Vec<ImageRegion> {
    if !cfg.enabled() {
        return Vec::new();
    }
    let (w, h) = rgb.dimensions();
    let mut out = Vec::new();

    if cfg.detect_qr {
        for bbox in qr_regions(rgb) {
            out.push(ImageRegion { bbox, label: SpanLabel::QrCode, score: DETECTED_SCORE });
        }
    }
    if cfg.detect_avatars {
        out.extend(avatar_regions(a11y_json, w, h));
    }
    if cfg.detect_faces {
        if let Some(provider) = faces {
            for bbox in provider.face_regions(rgb) {
                out.push(ImageRegion { bbox, label: SpanLabel::Face, score: DETECTED_SCORE });
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// QR finder-pattern detection
// ---------------------------------------------------------------------------

#[inline]
fn is_dark(rgb: &RgbImage, x: u32, y: u32) -> bool {
    let p: [u8; 3] = rgb.get_pixel(x, y).0;
    // Rec.601 integer luma, no float conversion and no allocation.
    let luma = ((p[0] as u32 * 77 + p[1] as u32 * 150 + p[2] as u32 * 29) >> 8) as u8;
    luma < QR_DARK_THRESHOLD
}

/// A QR symbol carries three 7x7 finder patterns. A horizontal scan through
/// the centre of one sees the run lengths `1:1:3:1:1`
/// (dark, light, dark, light, dark). We collect those hits, cluster them into
/// finder centres, then require three centres with a consistent module size
/// arranged in an "L" (top-left, top-right, bottom-left) before emitting a
/// box. Requiring the full triad keeps ordinary UI chrome from firing.
fn qr_regions(rgb: &RgbImage) -> Vec<[u32; 4]> {
    let (w, h) = rgb.dimensions();
    if w < 21 || h < 21 {
        return Vec::new();
    }

    // (x_centre, y, module_size) for every 1:1:3:1:1 row hit.
    let mut hits: Vec<(f32, f32, f32)> = Vec::new();
    for y in 0..h {
        // Build run-length encoding of this scanline: (is_dark, len, start_x).
        let mut runs: Vec<(bool, u32, u32)> = Vec::new();
        let mut x = 0u32;
        while x < w {
            let d = is_dark(rgb, x, y);
            let mut len = 1u32;
            while x + len < w && is_dark(rgb, x + len, y) == d {
                len += 1;
            }
            runs.push((d, len, x));
            x += len;
        }
        if runs.len() < 5 {
            continue;
        }
        for i in 0..=runs.len() - 5 {
            let r = &runs[i..i + 5];
            // Finder centre is dark, with light rings either side.
            if !(r[0].0 && !r[1].0 && r[2].0 && !r[3].0 && r[4].0) {
                continue;
            }
            let total: u32 = r.iter().map(|(_, len, _)| *len).sum();
            let m = total as f32 / 7.0;
            if m < QR_MIN_MODULE || m > QR_MAX_MODULE {
                continue;
            }
            let expected = [m, m, 3.0 * m, m, m];
            let ratio_ok = r.iter().zip(expected).all(|((_, len, _), e)| {
                (*len as f32 - e).abs() <= 0.5 * e + 1.0
            });
            if !ratio_ok {
                continue;
            }
            let cx = r[2].2 as f32 + r[2].1 as f32 / 2.0;
            hits.push((cx, y as f32, m));
        }
    }
    if hits.len() < 3 {
        return Vec::new();
    }

    // Cluster hits: a finder produces a near-vertical line of hits across
    // ~7*m rows at one x. Bucket by coarse x, then split on y gaps.
    let mut buckets: BTreeMap<i32, Vec<(f32, f32, f32)>> = BTreeMap::new();
    for hit in hits {
        buckets.entry((hit.0 / 4.0).round() as i32).or_default().push(hit);
    }
    let mut finders: Vec<(f32, f32, f32)> = Vec::new(); // (cx, cy, m)
    for (_, mut v) in buckets {
        v.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
        let mut start = 0usize;
        for i in 1..=v.len() {
            // `||` short-circuits, so `v[i]` is never indexed at the end.
            let boundary = i == v.len() || v[i].1 - v[i - 1].1 > 4.0;
            if boundary {
                let seg = &v[start..i];
                if seg.len() >= 3 {
                    let n = seg.len() as f32;
                    let cx = seg.iter().map(|t| t.0).sum::<f32>() / n;
                    let cy = seg.iter().map(|t| t.1).sum::<f32>() / n;
                    let m = seg.iter().map(|t| t.2).sum::<f32>() / n;
                    // A real finder contributes a solid vertical band.
                    if n >= m * 0.5 {
                        finders.push((cx, cy, m));
                    }
                }
                start = i;
            }
        }
    }
    finders.truncate(MAX_FINDERS);
    if finders.len() < 3 {
        return Vec::new();
    }

    // Require a triad with consistent module size in an L arrangement.
    let mut out: Vec<[u32; 4]> = Vec::new();
    for a in 0..finders.len() {
        for b in a + 1..finders.len() {
            for c in b + 1..finders.len() {
                let tri = [finders[a], finders[b], finders[c]];
                let m = (tri[0].2 + tri[1].2 + tri[2].2) / 3.0;
                if tri.iter().any(|t| (t.2 - m).abs() > 0.5 * m) {
                    continue;
                }
                let tol = 3.0 * m;
                let mut found_l = false;
                for ci in 0..3 {
                    let corner = tri[ci];
                    // One peer shares the corner's column, the other shares
                    // its row; both must be a real symbol away (>= 7 modules).
                    let same_col = (0..3).any(|j| {
                        j != ci
                            && (tri[j].0 - corner.0).abs() <= tol
                            && (tri[j].1 - corner.1).abs() >= 7.0 * m
                    });
                    let same_row = (0..3).any(|j| {
                        j != ci
                            && (tri[j].1 - corner.1).abs() <= tol
                            && (tri[j].0 - corner.0).abs() >= 7.0 * m
                    });
                    if same_col && same_row {
                        found_l = true;
                        break;
                    }
                }
                if !found_l {
                    continue;
                }
                let xs = tri.iter().map(|t| t.0).collect::<Vec<_>>();
                let ys = tri.iter().map(|t| t.1).collect::<Vec<_>>();
                let min_x = xs.iter().cloned().fold(f32::INFINITY, f32::min);
                let max_x = xs.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
                let min_y = ys.iter().cloned().fold(f32::INFINITY, f32::min);
                let max_y = ys.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
                // Expand by the finder half-size (3.5 modules) plus a one-
                // module quiet zone so the whole symbol is masked.
                let pad = 4.5 * m;
                let x1 = (min_x - pad).max(0.0).floor() as u32;
                let y1 = (min_y - pad).max(0.0).floor() as u32;
                let x2 = (max_x + pad).min(w as f32).ceil() as u32;
                let y2 = (max_y + pad).min(h as f32).ceil() as u32;
                if x2 <= x1 || y2 <= y1 {
                    continue;
                }
                let bw = x2 - x1;
                let bh = y2 - y1;
                // A QR is roughly square and at least 21 modules across.
                let aspect = bw as f32 / bh as f32;
                if aspect < 0.6 || aspect > 1.6 || bw < (21.0 * m) as u32 {
                    continue;
                }
                let bbox = [x1, y1, bw, bh];
                // De-duplicate overlapping detections from extra triads.
                if out.iter().any(|e| iou(bbox, *e) >= 0.5) {
                    continue;
                }
                out.push(bbox);
            }
        }
    }
    out
}

fn iou(a: [u32; 4], b: [u32; 4]) -> f32 {
    let ix = (a[0] + a[2]).min(b[0] + b[2]).saturating_sub(a[0].max(b[0]));
    let iy = (a[1] + a[3]).min(b[1] + b[3]).saturating_sub(a[1].max(b[1]));
    let inter = (ix as u64) * (iy as u64);
    let uni = (a[2] as u64) * (a[3] as u64) + (b[2] as u64) * (b[3] as u64) - inter;
    if uni == 0 { 0.0 } else { inter as f32 / uni as f32 }
}

// ---------------------------------------------------------------------------
// a11y-backed avatar detection
// ---------------------------------------------------------------------------

fn normalized_bounds(v: &Value) -> Option<(f32, f32, f32, f32)> {
    let obj = v.as_object()?;
    let get = |primary: &str, fallback: &str| {
        obj.get(primary)
            .or_else(|| obj.get(fallback))
            .and_then(Value::as_f64)
            .map(|x| x as f32)
    };
    let b = (get("left", "x")?, get("top", "y")?,
             get("width", "w")?, get("height", "h")?);
    let finite = [b.0, b.1, b.2, b.3].into_iter().all(f32::is_finite);
    if !finite
        || b.0 < 0.0 || b.1 < 0.0 || b.2 <= 0.0 || b.3 <= 0.0
        || b.0 + b.2 > 1.001 || b.1 + b.3 > 1.001
    {
        return None;
    }
    Some(b)
}

fn looks_like_avatar(obj: &serde_json::Map<String, Value>) -> bool {
    let mut text = String::new();
    for key in ["role", "description", "label", "id", "class", "name", "title"] {
        if let Some(s) = obj.get(key).and_then(Value::as_str) {
            text.push_str(&s.to_ascii_lowercase());
            text.push(' ');
        }
    }
    if text.is_empty() {
        return false;
    }
    text.contains("avatar")
        || text.contains("profile_picture")
        || text.contains("profile-picture")
        || text.contains("profile image")
        || (text.contains("profile") && text.contains("image"))
}

fn walk_a11y(
    v: &Value,
    w: u32,
    h: u32,
    depth: usize,
    budget: &mut usize,
    out: &mut Vec<ImageRegion>,
) {
    if depth > MAX_A11Y_DEPTH || *budget == 0 {
        return;
    }
    *budget -= 1;
    match v {
        Value::Object(obj) => {
            if let Some((left, top, bw, bh)) = obj.get("bounds").and_then(normalized_bounds) {
                // Avatars are small UI elements; reject full-screen nodes so
                // a stray "avatar" label can never mask the whole frame.
                if looks_like_avatar(obj)
                    && bw <= 0.5 && bh <= 0.5
                    && bw >= 0.002 && bh >= 0.002
                {
                    const PAD: u32 = 2;
                    let x1 = ((left * w as f32).floor().max(0.0) as u32).saturating_sub(PAD);
                    let y1 = ((top * h as f32).floor().max(0.0) as u32).saturating_sub(PAD);
                    let x2 = ((left + bw) * w as f32).ceil().min(w as f32) as u32;
                    let y2 = ((top + bh) * h as f32).ceil().min(h as f32) as u32;
                    let x2 = x2.saturating_add(PAD).min(w);
                    let y2 = y2.saturating_add(PAD).min(h);
                    if x2 > x1 && y2 > y1 {
                        out.push(ImageRegion {
                            bbox: [x1, y1, x2 - x1, y2 - y1],
                            label: SpanLabel::Avatar,
                            score: DETECTED_SCORE,
                        });
                    }
                }
            }
            for child in obj.values() {
                walk_a11y(child, w, h, depth + 1, budget, out);
            }
        }
        Value::Array(arr) => {
            for child in arr {
                walk_a11y(child, w, h, depth + 1, budget, out);
            }
        }
        _ => {}
    }
}

fn avatar_regions(a11y_json: Option<&str>, w: u32, h: u32) -> Vec<ImageRegion> {
    let Some(raw) = a11y_json else { return Vec::new() };
    if w == 0 || h == 0 || raw.len() > 256 * 1024 {
        return Vec::new();
    }
    let Ok(root) = serde_json::from_str::<Value>(raw) else { return Vec::new() };
    let mut out = Vec::new();
    let mut budget = MAX_A11Y_NODES;
    walk_a11y(&root, w, h, 0, &mut budget, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgb;

    /// Draw one canonical 7x7 QR finder pattern with `m` px per module.
    fn draw_finder(img: &mut RgbImage, ox: u32, oy: u32, m: u32) {
        let pattern = [
            "1111111",
            "1000001",
            "1011101",
            "1011101",
            "1011101",
            "1000001",
            "1111111",
        ];
        for (ry, row) in pattern.iter().enumerate() {
            for (rx, ch) in row.bytes().enumerate() {
                let c = if ch == b'1' { Rgb([0, 0, 0]) } else { Rgb([255, 255, 255]) };
                for dy in 0..m {
                    for dx in 0..m {
                        img.put_pixel(ox + rx as u32 * m + dx, oy + ry as u32 * m + dy, c);
                    }
                }
            }
        }
    }

    #[test]
    fn qr_triad_is_detected_and_covers_the_symbol() {
        let m = 4u32;
        let mut img = RgbImage::from_pixel(220, 220, Rgb([255, 255, 255]));
        let span = 120u32; // centre-to-centre distance between finders
        draw_finder(&mut img, 30, 30, m);
        draw_finder(&mut img, 30 + span, 30, m);
        draw_finder(&mut img, 30, 30 + span, m);
        let regions = detect_visual_pii(&img, None, None, &VisualPiiConfig {
            detect_qr: true, ..VisualPiiConfig::default()
        });
        assert_eq!(regions.len(), 1, "expected exactly one QR region, got {regions:?}");
        assert_eq!(regions[0].label, SpanLabel::QrCode);
        assert_eq!(regions[0].score, 1.0);
        let [x, y, bw, bh] = regions[0].bbox;
        assert!(x <= 30 && y <= 30, "bbox must start at/above the top-left finder: {regions:?}");
        assert!(x + bw >= 30 + span, "bbox must reach the top-right finder: {regions:?}");
        assert!(y + bh >= 30 + span, "bbox must reach the bottom-left finder: {regions:?}");
    }

    #[test]
    fn qr_detector_does_not_fire_on_plain_ui_chrome() {
        // Solid background plus a few rectangles: no 1:1:3:1:1 finder triad.
        let mut img = RgbImage::from_pixel(320, 200, Rgb([245, 245, 245]));
        for (x, w) in [(20u32, 80u32), (120, 60), (220, 40)] {
            for yy in 40..80 {
                for xx in x..x + w {
                    img.put_pixel(xx, yy, Rgb([30, 30, 30]));
                }
            }
        }
        let regions = detect_visual_pii(&img, None, None, &VisualPiiConfig {
            detect_qr: true, ..VisualPiiConfig::default()
        });
        assert!(regions.is_empty(), "false positive on ordinary UI: {regions:?}");
    }

    #[test]
    fn default_config_is_a_complete_noop() {
        let m = 4u32;
        let mut img = RgbImage::from_pixel(220, 220, Rgb([255, 255, 255]));
        draw_finder(&mut img, 30, 30, m);
        draw_finder(&mut img, 150, 30, m);
        draw_finder(&mut img, 30, 150, m);
        let a11y = r#"{"role":"AXImage","description":"avatar","bounds":{"x":0.1,"y":0.1,"w":0.05,"h":0.05}}"#;
        assert!(detect_visual_pii(&img, Some(a11y), None, &VisualPiiConfig::default()).is_empty());
    }

    #[test]
    fn avatar_detected_from_a11y_tree_only_when_labelled() {
        let img = RgbImage::from_pixel(200, 100, Rgb([255, 255, 255]));
        let a11y = r#"{"children":[
            {"role":"AXImage","description":"avatar for Marcus Chen",
             "bounds":{"x":0.1,"y":0.2,"w":0.08,"h":0.08}},
            {"role":"AXStaticText","description":"ordinary label",
             "bounds":{"x":0.5,"y":0.2,"w":0.2,"h":0.05}}
        ]}"#;
        let regions = detect_visual_pii(&img, Some(a11y), None, &VisualPiiConfig {
            detect_avatars: true, ..VisualPiiConfig::default()
        });
        assert_eq!(regions.len(), 1, "only the avatar node should fire: {regions:?}");
        assert_eq!(regions[0].label, SpanLabel::Avatar);
        let [x, y, w, h] = regions[0].bbox;
        assert!(x <= 20 && y <= 20 && w >= 16 && h >= 8, "unexpected bbox {regions:?}");
    }

    struct OneFace;
    impl FaceRegionProvider for OneFace {
        fn face_regions(&self, _rgb: &RgbImage) -> Vec<[u32; 4]> {
            vec![[10, 10, 40, 40]]
        }
    }

    #[test]
    fn face_provider_hook_emits_face_label() {
        let img = RgbImage::from_pixel(100, 100, Rgb([255, 255, 255]));
        let cfg = VisualPiiConfig { detect_faces: true, ..VisualPiiConfig::default() };
        // No provider -> zero regions (no fake detector).
        assert!(detect_visual_pii(&img, None, None, &cfg).is_empty());
        // With a provider -> one Face region.
        let regions = detect_visual_pii(&img, None, Some(&OneFace), &cfg);
        assert_eq!(regions.len(), 1);
        assert_eq!(regions[0].label, SpanLabel::Face);
        assert_eq!(regions[0].bbox, [10, 10, 40, 40]);
        assert!(NoopFaceRegionProvider.face_regions(&img).is_empty());
    }

    #[test]
    fn enterprise_config_enables_every_detector() {
        let cfg = VisualPiiConfig::enterprise();
        assert!(cfg.enabled());
        assert!(cfg.detect_qr && cfg.detect_avatars && cfg.detect_faces);
        assert!(!VisualPiiConfig::default().enabled());
    }
}
