// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Step 5 (V5): Bounded, deterministic cross-frame temporal consistency and
//! Schmitt-trigger hysteresis for image PII redaction (`TemporalRedactionTracker`).
//!
//! ## Problem
//!
//! Stateless per-frame redaction (`t` has zero memory of `t-1`) suffers from
//! single-frame PII flicker leaks: at Frame `t-1` (`score = 0.88`), RF-DETR +
//! V4 role fusion masks `"Marcus Chen"` or `"sk_live_..."`, then 2 seconds
//! later at Frame `t` a slight scroll, cursor/tooltip overlap, or JPEG chroma
//! subsampling shifts a glyph so the proposal dips to `0.22` (below
//! `policy.min_score = 0.50`), leaking the PII for one frame before `t+1`
//! masks it again.
//!
//! ## Safety Invariants (Zero Ghost Masks, Zero Negative-Screen FP Drift)
//!
//! 1. **Never hallucinate boxes out of thin air:** A frame is NEVER masked by
//!    blindly copying a prior bounding box onto empty/changed UI. The detector
//!    must still emit a real sub-threshold proposal (`score >= 0.18`) of the
//!    **exact same [`SpanLabel`]** at a geometrically compatible location.
//! 2. **Zero negative-screen FP:** On any negative screen (`0` confirmed
//!    tracklets), zero tracklets exist, so zero sub-threshold candidates can
//!    ever be promoted — single-frame precision and `0/200` negative-screen
//!    false positives remain 100% bit-identical.
//! 3. **Strict window isolation & TTL:** Tracklets are keyed by
//!    `(device_scope, app_name, window_name)` (hashed so raw window-title PII
//!    is never retained in RAM), require non-empty `app_name` and
//!    `window_name`, enforce symmetric `|ts_a - ts_b| <= 15s` across both
//!    oldest-first (`ASC`) and newest-first (`DESC`) batch traversals, and
//!    decay after at most `2` consecutive unconfirmed rescues or `1` miss.
//! 4. **O(1) `< 16 KB` RAM budget:** Capped at `16` LRU window contexts × `64`
//!    compact 15-byte tracklets (`<= 16,320` bytes worst-case total footprint).

use std::time::Duration;

use sha2::{Digest, Sha256};

use crate::a11y_context::AxNode;
use crate::image::{ImageRedactionPolicy, ImageRegion};
use crate::role_fusion::iou_xywh;
use crate::SpanLabel;

/// Default maximum number of window contexts retained via LRU.
pub const DEFAULT_MAX_WINDOW_CONTEXTS: usize = 16;
/// Default maximum number of active tracklets per window context.
pub const DEFAULT_MAX_TRACKLETS_PER_WINDOW: usize = 64;
/// Hard symmetric TTL (`|ts_a - ts_b| <= 15s`) for cross-frame tracklet carry.
pub const DEFAULT_MAX_TRACKLET_GAP: Duration = Duration::from_secs(15);
/// Schmitt-trigger lower continuation floor (`0.18`).
pub const DEFAULT_LOW_CONTINUE_SCORE: f32 = 0.18;
/// Maximum consecutive temporal rescues without a fresh `>= min_score`
/// re-confirmation (`<= 2` frames decay guarantee).
pub const DEFAULT_MAX_CONSECUTIVE_RESCUES: u8 = 2;
/// Multiplicative decay applied to `seed_score` when promoting (`max(min_score, seed * 0.85)`).
pub const DEFAULT_RESCUE_DECAY_FACTOR: f32 = 0.85;

const STATIONARY_MIN_IOU: f32 = 0.50;
const STATIONARY_DIM_TOL: f32 = 0.20;
const SCROLL_MAX_DX_PX: f32 = 4.0;
const SCROLL_MAX_DY_FRAC: f32 = 0.35;
const SCROLL_WIDTH_TOL: f32 = 0.12;
const SCROLL_HEIGHT_TOL: f32 = 0.15;
const EPS: f32 = 1e-4;

/// Maximum span (ms) around a `WindowContext::epoch_base_ms` before splitting
/// or rebasing (`1_000_000_000 ms` ≈ `11.57 days`, well inside `i32::MAX`).
const CONTEXT_ERA_SPAN_MS: i64 = 1_000_000_000;
const CONTEXT_REBASE_THRESHOLD_MS: i64 = 500_000_000;

/// Configuration for [`TemporalRedactionTracker`].
#[derive(Debug, Clone)]
pub struct TemporalTrackerConfig {
    /// Maximum distinct `(device_scope, app_name, window_name)` contexts (LRU).
    pub max_window_contexts: usize,
    /// Maximum confirmed tracklets retained per window context (LRU).
    pub max_tracklets_per_window: usize,
    /// Hard symmetric time-gap ceiling (`|ts_a - ts_b| <= max_tracklet_gap`).
    pub max_tracklet_gap: Duration,
    /// Schmitt-trigger continuation floor (`0.18` by default).
    pub low_continue_score: f32,
    /// Optional explicit seed floor override above `policy.min_score`.
    /// When `None`, `policy.min_score` seeds/refreshes confirmed tracklets.
    pub min_seed_score: Option<f32>,
    /// Maximum consecutive rescues without a fresh `>= min_score` confirmation.
    pub max_consecutive_rescues: u8,
}

impl Default for TemporalTrackerConfig {
    fn default() -> Self {
        Self {
            max_window_contexts: DEFAULT_MAX_WINDOW_CONTEXTS,
            max_tracklets_per_window: DEFAULT_MAX_TRACKLETS_PER_WINDOW,
            max_tracklet_gap: DEFAULT_MAX_TRACKLET_GAP,
            low_continue_score: DEFAULT_LOW_CONTINUE_SCORE,
            min_seed_score: None,
            max_consecutive_rescues: DEFAULT_MAX_CONSECUTIVE_RESCUES,
        }
    }
}

/// Per-frame metadata supplied to [`TemporalRedactionTracker::reconcile`].
#[derive(Debug, Clone, Copy)]
pub struct TemporalFrameContext<'a> {
    /// Monitor or capture device identifier (e.g. `frames.device_name`).
    pub device_scope: &'a str,
    /// Application name (`frames.app_name`). Must be present and non-empty.
    pub app_name: Option<&'a str>,
    /// Window title (`frames.window_name`). Must be present and non-empty.
    pub window_name: Option<&'a str>,
    /// Frame timestamp in Unix epoch milliseconds.
    pub timestamp_ms: Option<i64>,
    /// Pixel dimensions `(width, height)` of the frame image.
    pub image_dims: (u32, u32),
    /// Optional strictly text-free accessibility nodes for structural chrome veto.
    pub ax_nodes: Option<&'a [AxNode]>,
}

/// Telemetry counters from a single [`TemporalRedactionTracker::reconcile`] call.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TemporalReconcileStats {
    /// Confirmed detections (`>= seed_floor`) that seeded or refreshed a tracklet.
    pub seeded_or_refreshed: usize,
    /// Sub-threshold candidates promoted via stationary IoU + dimension match.
    pub rescued_stationary: usize,
    /// Sub-threshold candidates promoted via pure vertical-scroll match.
    pub rescued_scroll: usize,
    /// Candidates blocked from seeding or promotion by structural chrome veto.
    pub vetoed_chrome: usize,
}

impl TemporalReconcileStats {
    /// Total sub-threshold candidates promoted on this frame.
    pub fn total_rescued(self) -> usize {
        self.rescued_stationary + self.rescued_scroll
    }
}

/// Compact 15-byte (`align = 1`) tracklet record.
///
/// `16` window contexts × `64` tracklets × `15` bytes = `15,360` bytes,
/// keeping worst-case heap + struct footprint strictly under `16 KB` (`16,384` B).
#[derive(Debug, Clone, Copy)]
struct CompactTracklet {
    bbox_le: [[u8; 2]; 4],
    rel_ms_le: [u8; 4],
    seed_score_bp_le: [u8; 2],
    /// Bits `0..4`: `SpanLabel` index (`0..=13`), bits `4..7`: `consecutive_rescues`
    /// (`0..=7`), bit `7`: `missed` flag.
    label_and_counts: u8,
}

const _: () = assert!(std::mem::size_of::<CompactTracklet>() == 15);
const _: () = assert!(std::mem::align_of::<CompactTracklet>() == 1);

impl CompactTracklet {
    fn new(bbox: [u32; 4], label: SpanLabel, seed_score: f32, base_ms: i64, ts_ms: i64) -> Self {
        let mut t = Self {
            bbox_le: [[0; 2]; 4],
            rel_ms_le: [0; 4],
            seed_score_bp_le: [0; 2],
            label_and_counts: encode_label(label) & 0x0F,
        };
        t.set_bbox(bbox);
        t.set_seed_score(seed_score);
        t.set_last_seen_ms(base_ms, ts_ms);
        t
    }

    fn bbox(self) -> [u32; 4] {
        [
            u16::from_le_bytes(self.bbox_le[0]) as u32,
            u16::from_le_bytes(self.bbox_le[1]) as u32,
            u16::from_le_bytes(self.bbox_le[2]) as u32,
            u16::from_le_bytes(self.bbox_le[3]) as u32,
        ]
    }

    fn set_bbox(&mut self, bbox: [u32; 4]) {
        for (slot, val) in self.bbox_le.iter_mut().zip(bbox) {
            *slot = (val.min(u16::MAX as u32) as u16).to_le_bytes();
        }
    }

    fn last_seen_ms(self, base_ms: i64) -> i64 {
        let rel = i32::from_le_bytes(self.rel_ms_le) as i64;
        base_ms.saturating_add(rel)
    }

    fn set_last_seen_ms(&mut self, base_ms: i64, ts_ms: i64) {
        let diff = ts_ms
            .saturating_sub(base_ms)
            .clamp(i32::MIN as i64, i32::MAX as i64) as i32;
        self.rel_ms_le = diff.to_le_bytes();
    }

    fn seed_score(self) -> f32 {
        let bp = u16::from_le_bytes(self.seed_score_bp_le);
        (bp as f32) / 10_000.0
    }

    fn set_seed_score(&mut self, score: f32) {
        let bp = (score.clamp(0.0, 1.0) * 10_000.0).round() as u16;
        self.seed_score_bp_le = bp.to_le_bytes();
    }

    fn label(self) -> SpanLabel {
        decode_label(self.label_and_counts & 0x0F)
    }

    fn consecutive_rescues(self) -> u8 {
        (self.label_and_counts >> 4) & 0x07
    }

    fn has_missed(self) -> bool {
        (self.label_and_counts >> 7) != 0
    }

    fn set_counts(&mut self, rescues: u8, missed: bool) {
        let lbl = self.label_and_counts & 0x0F;
        let r = rescues.min(7) << 4;
        let m = if missed { 0x80 } else { 0 };
        self.label_and_counts = lbl | r | m;
    }
}

fn encode_label(label: SpanLabel) -> u8 {
    match label {
        SpanLabel::Person => 0,
        SpanLabel::Email => 1,
        SpanLabel::Phone => 2,
        SpanLabel::Address => 3,
        SpanLabel::Url => 4,
        SpanLabel::Company => 5,
        SpanLabel::Repo => 6,
        SpanLabel::Handle => 7,
        SpanLabel::Channel => 8,
        SpanLabel::Id => 9,
        SpanLabel::Date => 10,
        SpanLabel::Secret => 11,
        SpanLabel::Sensitive => 12,
        SpanLabel::DollarAmount => 13,
    }
}

fn decode_label(code: u8) -> SpanLabel {
    match code {
        0 => SpanLabel::Person,
        1 => SpanLabel::Email,
        2 => SpanLabel::Phone,
        3 => SpanLabel::Address,
        4 => SpanLabel::Url,
        5 => SpanLabel::Company,
        6 => SpanLabel::Repo,
        7 => SpanLabel::Handle,
        8 => SpanLabel::Channel,
        9 => SpanLabel::Id,
        10 => SpanLabel::Date,
        11 => SpanLabel::Secret,
        12 => SpanLabel::Sensitive,
        _ => SpanLabel::DollarAmount,
    }
}

#[derive(Debug, Clone)]
struct WindowContext {
    scope_hash: [u8; 16],
    epoch_base_ms: i64,
    last_access_tick: u64,
    /// Ordered LRU (front) -> MRU (back), bounded to `max_tracklets_per_window`.
    tracklets: Vec<CompactTracklet>,
}

impl WindowContext {
    fn rebase(&mut self, new_base_ms: i64) {
        let old_base = self.epoch_base_ms;
        self.tracklets.retain_mut(|t| {
            let abs_ts = t.last_seen_ms(old_base);
            if (abs_ts - new_base_ms).abs() > CONTEXT_ERA_SPAN_MS {
                return false;
            }
            t.set_last_seen_ms(new_base_ms, abs_ts);
            true
        });
        self.epoch_base_ms = new_base_ms;
    }
}

/// Bounded, deterministic cross-frame entity & tracklet hysteresis tracker.
#[derive(Debug, Clone)]
pub struct TemporalRedactionTracker {
    cfg: TemporalTrackerConfig,
    tick: u64,
    contexts: Vec<WindowContext>,
}

impl Default for TemporalRedactionTracker {
    fn default() -> Self {
        Self::new(TemporalTrackerConfig::default())
    }
}

impl TemporalRedactionTracker {
    pub fn new(mut cfg: TemporalTrackerConfig) -> Self {
        cfg.max_window_contexts = cfg.max_window_contexts.max(1);
        cfg.max_tracklets_per_window = cfg.max_tracklets_per_window.max(1);
        cfg.max_consecutive_rescues = cfg.max_consecutive_rescues.min(7);
        let cap = cfg.max_window_contexts;
        Self {
            cfg,
            tick: 0,
            contexts: Vec::with_capacity(cap),
        }
    }

    pub fn config(&self) -> &TemporalTrackerConfig {
        &self.cfg
    }

    /// Clear all window contexts and tracklets.
    pub fn clear(&mut self) {
        self.contexts.clear();
    }

    /// Active window context count (`<= max_window_contexts`).
    pub fn active_window_count(&self) -> usize {
        self.contexts.len()
    }

    /// Total active tracklets across all window contexts.
    pub fn active_tracklet_count(&self) -> usize {
        self.contexts.iter().map(|c| c.tracklets.len()).sum()
    }

    /// Total in-memory footprint (struct + heap allocations) in bytes.
    pub fn memory_usage_bytes(&self) -> usize {
        let ctx_heap = self.contexts.capacity() * std::mem::size_of::<WindowContext>();
        let track_heap: usize = self
            .contexts
            .iter()
            .map(|c| c.tracklets.capacity() * std::mem::size_of::<CompactTracklet>())
            .sum();
        std::mem::size_of::<Self>() + ctx_heap + track_heap
    }

    /// Reconcile a frame's detector candidates against recent confirmed tracklets
    /// in the same `(device_scope, app_name, window_name)` context.
    ///
    /// Non-promoted candidates keep their original `score < policy.min_score` so
    /// downstream [`crate::image::frame_redactor::redact_frame`] drops them
    /// identically to single-frame mode.
    pub fn reconcile(
        &mut self,
        ctx: TemporalFrameContext<'_>,
        candidates: &[ImageRegion],
        policy: &ImageRedactionPolicy,
    ) -> (Vec<ImageRegion>, TemporalReconcileStats) {
        let mut stats = TemporalReconcileStats::default();
        let mut out = candidates.to_vec();

        let Some(app) = ctx.app_name.map(str::trim).filter(|s| !s.is_empty()) else {
            return (out, stats);
        };
        let Some(win) = ctx.window_name.map(str::trim).filter(|s| !s.is_empty()) else {
            return (out, stats);
        };
        let Some(ts_ms) = ctx.timestamp_ms else {
            return (out, stats);
        };

        let (img_w, img_h) = ctx.image_dims;
        let seed_floor = policy.min_score.max(self.cfg.min_seed_score.unwrap_or(0.0));
        let low_floor = self.cfg.low_continue_score;
        let max_gap_ms = self.cfg.max_tracklet_gap.as_millis().min(u64::MAX as u128) as u64;
        let scope_hash = hash_window_scope(ctx.device_scope.trim(), app, win);

        self.tick = self.tick.wrapping_add(1);
        let current_tick = self.tick;

        let existing_idx = self.contexts.iter().position(|c| {
            c.scope_hash == scope_hash && (ts_ms - c.epoch_base_ms).abs() <= CONTEXT_ERA_SPAN_MS
        });

        let has_potential_seed = out
            .iter()
            .any(|r| policy.allow.contains(&r.label) && r.score >= seed_floor);

        let ctx_idx = match existing_idx {
            Some(idx) => {
                self.contexts[idx].last_access_tick = current_tick;
                if (ts_ms - self.contexts[idx].epoch_base_ms).abs() > CONTEXT_REBASE_THRESHOLD_MS {
                    self.contexts[idx].rebase(ts_ms);
                }
                idx
            }
            None => {
                if !has_potential_seed {
                    // Clean/negative screen in an unseen window: zero tracklets exist,
                    // so nothing can promote and we avoid evicting active windows.
                    return (out, stats);
                }
                self.insert_window_context(scope_hash, ts_ms, current_tick)
            }
        };

        let base_ms = self.contexts[ctx_idx].epoch_base_ms;
        let num_existing = self.contexts[ctx_idx].tracklets.len();
        let mut claimed = vec![false; num_existing];
        let mut refreshed_mru: Vec<CompactTracklet> = Vec::new();
        let mut new_seeds: Vec<CompactTracklet> = Vec::new();

        // Pass 1: Confirmed detections (`score >= seed_floor`) seed or refresh tracklets.
        let mut confirmed_indices: Vec<usize> = (0..out.len())
            .filter(|&i| policy.allow.contains(&out[i].label) && out[i].score >= seed_floor)
            .collect();
        confirmed_indices.sort_by(|&a, &b| {
            out[b]
                .score
                .total_cmp(&out[a].score)
                .then_with(|| a.cmp(&b))
        });

        for i in confirmed_indices {
            let cand = out[i];
            if cand.bbox[2] == 0 || cand.bbox[3] == 0 {
                continue;
            }
            if is_in_structural_chrome(cand.bbox, ctx.ax_nodes, img_w, img_h) {
                stats.vetoed_chrome += 1;
                continue;
            }
            if let Some((t_idx, _is_scroll)) = find_best_tracklet_match(
                &self.contexts[ctx_idx].tracklets,
                &claimed,
                base_ms,
                ts_ms,
                max_gap_ms,
                cand,
                img_h,
                false,
                self.cfg.max_consecutive_rescues,
            ) {
                claimed[t_idx] = true;
                let mut updated = self.contexts[ctx_idx].tracklets[t_idx];
                updated.set_bbox(cand.bbox);
                updated.set_seed_score(cand.score);
                updated.set_last_seen_ms(base_ms, ts_ms);
                updated.set_counts(0, false);
                refreshed_mru.push(updated);
            } else {
                new_seeds.push(CompactTracklet::new(
                    cand.bbox, cand.label, cand.score, base_ms, ts_ms,
                ));
            }
            stats.seeded_or_refreshed += 1;
        }

        // Pass 2: Sub-threshold candidates (`low_floor <= score < seed_floor`)
        // promote ONLY when matched 1-to-1 to an unclaimed, un-missed, un-expired
        // tracklet of the exact same SpanLabel within the rescue cap.
        if num_existing > 0 && low_floor < seed_floor {
            let mut sub_indices: Vec<usize> = (0..out.len())
                .filter(|&i| {
                    policy.allow.contains(&out[i].label)
                        && out[i].score >= low_floor
                        && out[i].score < seed_floor
                })
                .collect();
            sub_indices.sort_by(|&a, &b| {
                out[b]
                    .score
                    .total_cmp(&out[a].score)
                    .then_with(|| a.cmp(&b))
            });

            for i in sub_indices {
                let cand = out[i];
                if cand.bbox[2] == 0 || cand.bbox[3] == 0 {
                    continue;
                }
                // Skip if already covered by a confirmed/promoted region of the same label.
                let already_covered = out.iter().enumerate().any(|(j, other)| {
                    j != i
                        && other.label == cand.label
                        && other.score >= policy.min_score
                        && iou_xywh(cand.bbox, other.bbox) >= STATIONARY_MIN_IOU
                });
                if already_covered {
                    continue;
                }
                if is_in_structural_chrome(cand.bbox, ctx.ax_nodes, img_w, img_h) {
                    stats.vetoed_chrome += 1;
                    continue;
                }

                if let Some((t_idx, is_scroll)) = find_best_tracklet_match(
                    &self.contexts[ctx_idx].tracklets,
                    &claimed,
                    base_ms,
                    ts_ms,
                    max_gap_ms,
                    cand,
                    img_h,
                    true,
                    self.cfg.max_consecutive_rescues,
                ) {
                    claimed[t_idx] = true;
                    let prev = self.contexts[ctx_idx].tracklets[t_idx];
                    let raw_promoted = policy
                        .min_score
                        .max(prev.seed_score() * DEFAULT_RESCUE_DECAY_FACTOR)
                        .min(0.999);
                    let rounded = (raw_promoted * 10_000.0).round() / 10_000.0;
                    out[i].score = rounded.max(policy.min_score);

                    let mut updated = prev;
                    updated.set_bbox(cand.bbox);
                    updated.set_last_seen_ms(base_ms, ts_ms);
                    updated.set_counts(prev.consecutive_rescues().saturating_add(1), false);
                    refreshed_mru.push(updated);

                    if is_scroll {
                        stats.rescued_scroll += 1;
                    } else {
                        stats.rescued_stationary += 1;
                    }
                }
            }
        }

        // Pass 3: Unclaimed tracklets within `|dt| <= max_gap_ms` missed on this
        // frame (`consecutive_misses > 0`), so they are retired immediately.
        // Tracklets outside `max_gap_ms` (e.g. an alternating ASC/DESC cursor in
        // another 15s slice of the same window) remain at the LRU front unless
        // evicted by `max_tracklets_per_window`.
        let max_per_win = self.cfg.max_tracklets_per_window;
        let old_tracklets = std::mem::take(&mut self.contexts[ctx_idx].tracklets);
        let mut retained_other_slice: Vec<CompactTracklet> = Vec::new();
        for (idx, t) in old_tracklets.into_iter().enumerate() {
            if claimed[idx] || t.has_missed() {
                continue;
            }
            let dt_ms = ts_ms.abs_diff(t.last_seen_ms(base_ms));
            if dt_ms > max_gap_ms {
                retained_other_slice.push(t);
            }
        }

        let total_candidates = retained_other_slice.len() + refreshed_mru.len() + new_seeds.len();
        let drop_from_front = total_candidates.saturating_sub(max_per_win);
        let mut rebuilt = Vec::new();
        let cap_needed = total_candidates.min(max_per_win);
        if cap_needed > 0 {
            rebuilt.reserve_exact(cap_needed.next_power_of_two().min(max_per_win));
            for t in retained_other_slice
                .into_iter()
                .chain(refreshed_mru)
                .chain(new_seeds)
                .skip(drop_from_front)
            {
                rebuilt.push(t);
            }
        }

        if rebuilt.is_empty() {
            self.contexts.swap_remove(ctx_idx);
        } else {
            self.contexts[ctx_idx].tracklets = rebuilt;
        }

        (out, stats)
    }

    fn insert_window_context(&mut self, scope_hash: [u8; 16], ts_ms: i64, tick: u64) -> usize {
        if self.contexts.len() >= self.cfg.max_window_contexts {
            let evict_idx = self
                .contexts
                .iter()
                .enumerate()
                .min_by_key(|(_, c)| {
                    (
                        if c.tracklets.is_empty() { 0u8 } else { 1u8 },
                        c.last_access_tick,
                    )
                })
                .map(|(idx, _)| idx)
                .unwrap_or(0);
            self.contexts[evict_idx] = WindowContext {
                scope_hash,
                epoch_base_ms: ts_ms,
                last_access_tick: tick,
                tracklets: Vec::new(),
            };
            evict_idx
        } else {
            let idx = self.contexts.len();
            self.contexts.push(WindowContext {
                scope_hash,
                epoch_base_ms: ts_ms,
                last_access_tick: tick,
                tracklets: Vec::new(),
            });
            idx
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn find_best_tracklet_match(
    tracklets: &[CompactTracklet],
    claimed: &[bool],
    base_ms: i64,
    ts_ms: i64,
    max_gap_ms: u64,
    cand: ImageRegion,
    img_h: u32,
    require_rescue_budget: bool,
    max_consecutive_rescues: u8,
) -> Option<(usize, bool)> {
    let mut best_stationary: Option<(usize, f32, f32)> = None;
    let mut best_scroll: Option<(usize, f32, f32)> = None;

    for (idx, t) in tracklets.iter().enumerate() {
        if claimed[idx] || t.label() != cand.label {
            continue;
        }
        if ts_ms.abs_diff(t.last_seen_ms(base_ms)) > max_gap_ms {
            continue;
        }
        if require_rescue_budget
            && (t.has_missed() || t.consecutive_rescues() >= max_consecutive_rescues)
        {
            continue;
        }

        let tb = t.bbox();
        if let Some(iou) = stationary_match_iou(cand.bbox, tb) {
            let seed_s = t.seed_score();
            let better = match best_stationary {
                None => true,
                Some((_, best_iou, best_s)) => {
                    (iou - best_iou).abs() > 1e-5 && iou > best_iou
                        || ((iou - best_iou).abs() <= 1e-5 && seed_s > best_s)
                }
            };
            if better {
                best_stationary = Some((idx, iou, seed_s));
            }
            continue;
        }

        if let Some(dy) = vertical_scroll_match_dy(cand.bbox, tb, img_h) {
            let seed_s = t.seed_score();
            let better = match best_scroll {
                None => true,
                Some((_, best_dy, best_s)) => {
                    (dy - best_dy).abs() > 1e-3 && dy < best_dy
                        || ((dy - best_dy).abs() <= 1e-3 && seed_s > best_s)
                }
            };
            if better {
                best_scroll = Some((idx, dy, seed_s));
            }
        }
    }

    if let Some((idx, _, _)) = best_stationary {
        return Some((idx, false));
    }
    if let Some((idx, _, _)) = best_scroll {
        return Some((idx, true));
    }
    None
}

fn dims_within(cand: [u32; 4], track: [u32; 4], w_tol: f32, h_tol: f32) -> bool {
    let (cw, ch) = (cand[2] as f32, cand[3] as f32);
    let (tw, th) = (track[2] as f32, track[3] as f32);
    if cw <= 0.0 || ch <= 0.0 || tw <= 0.0 || th <= 0.0 {
        return false;
    }
    (cw - tw).abs() <= w_tol * tw + EPS && (ch - th).abs() <= h_tol * th + EPS
}

fn stationary_match_iou(cand: [u32; 4], track: [u32; 4]) -> Option<f32> {
    if !dims_within(cand, track, STATIONARY_DIM_TOL, STATIONARY_DIM_TOL) {
        return None;
    }
    let iou = iou_xywh(cand, track);
    if iou + EPS >= STATIONARY_MIN_IOU {
        Some(iou)
    } else {
        None
    }
}

fn vertical_scroll_match_dy(cand: [u32; 4], track: [u32; 4], img_h: u32) -> Option<f32> {
    if img_h == 0 || !dims_within(cand, track, SCROLL_WIDTH_TOL, SCROLL_HEIGHT_TOL) {
        return None;
    }
    let (cx0, cy0, cw, ch) = (
        cand[0] as f32,
        cand[1] as f32,
        cand[2] as f32,
        cand[3] as f32,
    );
    let (tx0, ty0, tw, th) = (
        track[0] as f32,
        track[1] as f32,
        track[2] as f32,
        track[3] as f32,
    );
    let dx_left = (cx0 - tx0).abs();
    let dx_center = ((cx0 + 0.5 * cw) - (tx0 + 0.5 * tw)).abs();
    let dx = dx_left.min(dx_center);
    if dx > SCROLL_MAX_DX_PX + EPS {
        return None;
    }
    let dy = ((cy0 + 0.5 * ch) - (ty0 + 0.5 * th)).abs();
    let max_dy = SCROLL_MAX_DY_FRAC * (img_h as f32);
    if dy <= max_dy + EPS {
        Some(dy)
    } else {
        None
    }
}

/// Returns `true` when `bbox` lands inside OS accessibility structural chrome
/// (`toolbar`, `nav`, `columnheader`, or tab strip) and is NOT an explicit
/// password/credential input field.
pub fn is_in_structural_chrome(
    bbox: [u32; 4],
    ax_nodes: Option<&[AxNode]>,
    img_w: u32,
    img_h: u32,
) -> bool {
    let Some(nodes) = ax_nodes.filter(|n| !n.is_empty()) else {
        return false;
    };
    if img_w == 0 || img_h == 0 || bbox[2] == 0 || bbox[3] == 0 {
        return false;
    }

    let (fw, fh) = (img_w as f32, img_h as f32);
    let pl = ((bbox[0] as f32) / fw).clamp(0.0, 1.0);
    let pt = ((bbox[1] as f32) / fh).clamp(0.0, 1.0);
    let pw = ((bbox[2] as f32) / fw).clamp(1e-5, 1.0);
    let ph = ((bbox[3] as f32) / fh).clamp(1e-5, 1.0);
    let (pr, pb) = (pl + pw, pt + ph);
    let p_area = (pw * ph).max(1e-7);

    // Explicit password / credential-hinted leaf controls are never vetoed,
    // even if a site places a login input inside a top header bar.
    for n in nodes {
        if !(n.is_password || n.has_cred_hint) || is_broad_container_role(&n.role) {
            continue;
        }
        if let Some(b) = n.bounds {
            if coverage_fraction(pl, pt, pr, pb, p_area, b.left, b.top, b.width, b.height) >= 0.50 {
                return false;
            }
        }
    }

    for (idx, n) in nodes.iter().enumerate() {
        let Some(b) = n.bounds else {
            continue;
        };
        if b.width <= 1e-4 || b.height <= 1e-4 {
            continue;
        }
        if coverage_fraction(pl, pt, pr, pb, p_area, b.left, b.top, b.width, b.height) < 0.50 {
            continue;
        }
        if node_has_chrome_semantics(n) {
            return true;
        }
        let mut p_idx = n.parent_idx;
        let mut hops = 0usize;
        while p_idx >= 0 && (p_idx as usize) < nodes.len() && hops < 8 {
            let anc = &nodes[p_idx as usize];
            if node_has_chrome_semantics(anc) {
                return true;
            }
            if p_idx as usize == idx {
                break;
            }
            p_idx = anc.parent_idx;
            hops += 1;
        }
    }

    false
}

#[allow(clippy::too_many_arguments)]
fn coverage_fraction(
    pl: f32,
    pt: f32,
    pr: f32,
    pb: f32,
    p_area: f32,
    nl: f32,
    nt: f32,
    nw: f32,
    nh: f32,
) -> f32 {
    let iw = (pr.min(nl + nw) - pl.max(nl)).max(0.0);
    let ih = (pb.min(nt + nh) - pt.max(nt)).max(0.0);
    (iw * ih) / p_area
}

fn is_broad_container_role(role: &str) -> bool {
    matches!(
        role.trim().to_ascii_lowercase().as_str(),
        "group"
            | "axgroup"
            | "main"
            | "document"
            | "axmain"
            | "window"
            | "axwindow"
            | "pane"
            | "navigation"
            | "axnavigation"
            | "toolbar"
            | "axtoolbar"
            | "table"
            | "datagrid"
            | "axtable"
            | "row"
            | "axrow"
    )
}

fn node_has_chrome_semantics(n: &AxNode) -> bool {
    let rl = n.role.trim().to_ascii_lowercase();
    if matches!(
        rl.as_str(),
        "toolbar"
            | "axtoolbar"
            | "menubar"
            | "axmenubar"
            | "titlebar"
            | "statusbar"
            | "appbar"
            | "navigation"
            | "axnavigation"
            | "columnheader"
            | "header"
            | "headeritem"
            | "axcolumnheader"
            | "tab"
            | "tabitem"
            | "axtab"
            | "tablist"
            | "axtabgroup"
    ) {
        return true;
    }
    let lm = n.landmark.trim().to_ascii_lowercase();
    if matches!(lm.as_str(), "toolbar" | "nav") {
        return true;
    }
    if let Some(sr) = n.subrole.as_deref() {
        let sr = sr.trim().to_ascii_lowercase();
        if sr.contains("toolbar") || sr.contains("navigation") || sr.contains("banner") {
            return true;
        }
    }
    false
}

fn hash_window_scope(device_scope: &str, app_name: &str, window_name: &str) -> [u8; 16] {
    let mut hasher = Sha256::new();
    for part in [device_scope, app_name, window_name] {
        hasher.update((part.len() as u64).to_le_bytes());
        hasher.update(part.as_bytes());
    }
    let digest = hasher.finalize();
    let mut out = [0u8; 16];
    out.copy_from_slice(&digest[..16]);
    out
}

/// Parse Screenpipe's `frames.timestamp` SQLite strings (RFC 3339, SQLite
/// `YYYY-MM-DD HH:MM:SS[.fff]`, ISO date `YYYY-MM-DD`, or epoch seconds) into
/// Unix epoch milliseconds.
pub fn parse_frame_timestamp_ms(raw: &str) -> Option<i64> {
    let s = raw.trim();
    if s.is_empty() {
        return None;
    }
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
        return Some(dt.timestamp_millis());
    }
    if let Ok(ndt) = chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S%.f") {
        return Some(ndt.and_utc().timestamp_millis());
    }
    if let Ok(ndt) = chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%.f") {
        return Some(ndt.and_utc().timestamp_millis());
    }
    if let Ok(nd) = chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        return Some(nd.and_hms_opt(0, 0, 0)?.and_utc().timestamp_millis());
    }
    if let Ok(secs) = s.parse::<i64>() {
        return secs.checked_mul(1_000);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::a11y_context::extract_text_free_ax_nodes;

    fn allow_all_policy() -> ImageRedactionPolicy {
        ImageRedactionPolicy {
            allow: vec![
                SpanLabel::Secret,
                SpanLabel::Person,
                SpanLabel::Email,
                SpanLabel::Company,
                SpanLabel::Id,
            ],
            min_score: 0.50,
        }
    }

    fn frame_ctx<'a>(
        device: &'a str,
        app: Option<&'a str>,
        window: Option<&'a str>,
        ts_ms: i64,
        ax_nodes: Option<&'a [AxNode]>,
    ) -> TemporalFrameContext<'a> {
        TemporalFrameContext {
            device_scope: device,
            app_name: app,
            window_name: window,
            timestamp_ms: Some(ts_ms),
            image_dims: (1280, 800),
            ax_nodes,
        }
    }

    #[test]
    fn stationary_flicker_rescue_promotes_matching_subthreshold_box() {
        let mut tracker = TemporalRedactionTracker::default();
        let policy = allow_all_policy();

        // Frame 1 @ 0.89 -> seeds confirmed tracklet
        let (f1, s1) = tracker.reconcile(
            frame_ctx(
                "monitor_1",
                Some("Arc"),
                Some("Linear - Issues"),
                1_000_000,
                None,
            ),
            &[ImageRegion {
                bbox: [240, 320, 140, 22],
                label: SpanLabel::Person,
                score: 0.89,
            }],
            &policy,
        );
        assert_eq!(s1.seeded_or_refreshed, 1);
        assert_eq!(s1.total_rescued(), 0);
        assert_eq!(f1[0].score, 0.89);

        // Frame 2 (2s later) @ 0.24 -> stationary rescue (0.89 * 0.85 = 0.7565 >= 0.50)
        let (f2, s2) = tracker.reconcile(
            frame_ctx(
                "monitor_1",
                Some("Arc"),
                Some("Linear - Issues"),
                1_002_000,
                None,
            ),
            &[ImageRegion {
                bbox: [242, 321, 138, 22],
                label: SpanLabel::Person,
                score: 0.24,
            }],
            &policy,
        );
        assert_eq!(s2.rescued_stationary, 1);
        assert!(f2[0].score >= policy.min_score);
        assert!((f2[0].score - 0.7565).abs() < 1e-3);
    }

    #[test]
    fn vertical_scroll_rescue_promotes_pure_vertical_shift_and_blocks_horizontal_jump() {
        let mut tracker = TemporalRedactionTracker::default();
        let policy = allow_all_policy();

        // Frame 1: y=400 @ 0.91
        tracker.reconcile(
            frame_ctx("monitor_1", Some("Arc"), Some("Docs"), 10_000, None),
            &[ImageRegion {
                bbox: [300, 400, 180, 20],
                label: SpanLabel::Secret,
                score: 0.91,
            }],
            &policy,
        );

        // Frame 2: y=260 (|dy|=140 <= 0.35*800=280, |dx|=2 <= 4) @ 0.23 -> REDACTED
        let (f2, s2) = tracker.reconcile(
            frame_ctx("monitor_1", Some("Arc"), Some("Docs"), 12_000, None),
            &[ImageRegion {
                bbox: [302, 260, 176, 20],
                label: SpanLabel::Secret,
                score: 0.23,
            }],
            &policy,
        );
        assert_eq!(s2.rescued_scroll, 1);
        assert!(f2[0].score >= policy.min_score);

        // Frame 3: horizontal jump |dx|=25 px -> NOT promoted
        let (f3, s3) = tracker.reconcile(
            frame_ctx("monitor_1", Some("Arc"), Some("Docs"), 14_000, None),
            &[ImageRegion {
                bbox: [327, 200, 176, 20],
                label: SpanLabel::Secret,
                score: 0.25,
            }],
            &policy,
        );
        assert_eq!(s3.total_rescued(), 0);
        assert!(f3[0].score < policy.min_score);
    }

    #[test]
    fn decay_cap_stops_promoting_after_two_unconfirmed_rescues_or_ttl_expiry() {
        let mut tracker = TemporalRedactionTracker::default();
        let policy = allow_all_policy();
        let region = |score: f32| {
            [ImageRegion {
                bbox: [100, 150, 120, 20],
                label: SpanLabel::Secret,
                score,
            }]
        };

        // Seed at t=0s
        let (_, s0) = tracker.reconcile(
            frame_ctx("m1", Some("Code"), Some("env"), 100_000, None),
            &region(0.90),
            &policy,
        );
        assert_eq!(s0.seeded_or_refreshed, 1);

        // Rescue #1 at t=2s
        let (r1, s1) = tracker.reconcile(
            frame_ctx("m1", Some("Code"), Some("env"), 102_000, None),
            &region(0.24),
            &policy,
        );
        assert_eq!(s1.rescued_stationary, 1);
        assert!(r1[0].score >= 0.50);

        // Rescue #2 at t=4s
        let (r2, s2) = tracker.reconcile(
            frame_ctx("m1", Some("Code"), Some("env"), 104_000, None),
            &region(0.22),
            &policy,
        );
        assert_eq!(s2.rescued_stationary, 1);
        assert!(r2[0].score >= 0.50);

        // 3rd consecutive unconfirmed frame at t=6s -> decays, NOT promoted!
        let (r3, s3) = tracker.reconcile(
            frame_ctx("m1", Some("Code"), Some("env"), 106_000, None),
            &region(0.24),
            &policy,
        );
        assert_eq!(s3.total_rescued(), 0);
        assert_eq!(r3[0].score, 0.24);

        // Re-seed at t=10s, then jump >15s to t=26s -> TTL expired, NOT promoted!
        tracker.reconcile(
            frame_ctx("m1", Some("Code"), Some("env"), 110_000, None),
            &region(0.92),
            &policy,
        );
        let (r_expired, s_expired) = tracker.reconcile(
            frame_ctx("m1", Some("Code"), Some("env"), 125_001, None),
            &region(0.26),
            &policy,
        );
        assert_eq!(s_expired.total_rescued(), 0);
        assert_eq!(r_expired[0].score, 0.26);
    }

    #[test]
    fn single_miss_frame_retires_tracklet_immediately() {
        let mut tracker = TemporalRedactionTracker::default();
        let policy = allow_all_policy();

        // Frame 1: seed
        tracker.reconcile(
            frame_ctx("m1", Some("Arc"), Some("Tab A"), 50_000, None),
            &[ImageRegion {
                bbox: [200, 200, 100, 20],
                label: SpanLabel::Company,
                score: 0.88,
            }],
            &policy,
        );
        // Frame 2 (t=52s): modal closed, 0 candidates -> consecutive_misses > 0
        tracker.reconcile(
            frame_ctx("m1", Some("Arc"), Some("Tab A"), 52_000, None),
            &[],
            &policy,
        );
        // Frame 3 (t=54s): sub-threshold 0.25 at same spot -> must NOT promote
        let (f3, s3) = tracker.reconcile(
            frame_ctx("m1", Some("Arc"), Some("Tab A"), 54_000, None),
            &[ImageRegion {
                bbox: [200, 200, 100, 20],
                label: SpanLabel::Company,
                score: 0.25,
            }],
            &policy,
        );
        assert_eq!(s3.total_rescued(), 0);
        assert_eq!(f3[0].score, 0.25);
    }

    #[test]
    fn window_switch_device_switch_label_mismatch_and_negative_screens_never_ghost_mask() {
        let mut tracker = TemporalRedactionTracker::default();
        let policy = allow_all_policy();

        // 200 negative-screen frames with noisy sub-threshold candidates -> 0 promotions
        for step in 0..200 {
            let (out, st) = tracker.reconcile(
                frame_ctx(
                    "monitor_1",
                    Some("VSCode"),
                    Some("lib.rs"),
                    step * 2_000,
                    None,
                ),
                &[ImageRegion {
                    bbox: [80, 120, 140, 18],
                    label: SpanLabel::Secret,
                    score: 0.31,
                }],
                &policy,
            );
            assert_eq!(st.total_rescued(), 0);
            assert!(out.iter().all(|r| r.score < policy.min_score));
        }
        assert_eq!(tracker.active_window_count(), 0);

        // Seed in ("monitor_1", "Arc", "Customer Profile")
        tracker.reconcile(
            frame_ctx(
                "monitor_1",
                Some("Arc"),
                Some("Customer Profile"),
                500_000,
                None,
            ),
            &[ImageRegion {
                bbox: [200, 300, 130, 20],
                label: SpanLabel::Person,
                score: 0.93,
            }],
            &policy,
        );

        // Different window title -> 0 promotions
        let (diff_win, st_win) = tracker.reconcile(
            frame_ctx("monitor_1", Some("Arc"), Some("Public Docs"), 502_000, None),
            &[ImageRegion {
                bbox: [200, 300, 130, 20],
                label: SpanLabel::Person,
                score: 0.28,
            }],
            &policy,
        );
        assert_eq!(st_win.total_rescued(), 0);
        assert!(diff_win[0].score < policy.min_score);

        // Different monitor -> 0 promotions
        let (diff_mon, st_mon) = tracker.reconcile(
            frame_ctx(
                "monitor_2",
                Some("Arc"),
                Some("Customer Profile"),
                502_000,
                None,
            ),
            &[ImageRegion {
                bbox: [200, 300, 130, 20],
                label: SpanLabel::Person,
                score: 0.28,
            }],
            &policy,
        );
        assert_eq!(st_mon.total_rescued(), 0);
        assert!(diff_mon[0].score < policy.min_score);

        // Missing/empty window_name -> 0 promotions
        let (empty_win, st_empty) = tracker.reconcile(
            frame_ctx("monitor_1", Some("Arc"), Some(""), 502_000, None),
            &[ImageRegion {
                bbox: [200, 300, 130, 20],
                label: SpanLabel::Person,
                score: 0.28,
            }],
            &policy,
        );
        assert_eq!(st_empty.total_rescued(), 0);
        assert!(empty_win[0].score < policy.min_score);

        // Same window, different SpanLabel (Id vs Person) -> 0 promotions
        let (diff_lbl, st_lbl) = tracker.reconcile(
            frame_ctx(
                "monitor_1",
                Some("Arc"),
                Some("Customer Profile"),
                502_000,
                None,
            ),
            &[ImageRegion {
                bbox: [200, 300, 130, 20],
                label: SpanLabel::Id,
                score: 0.28,
            }],
            &policy,
        );
        assert_eq!(st_lbl.total_rescued(), 0);
        assert!(diff_lbl[0].score < policy.min_score);
    }

    #[test]
    fn structural_chrome_blocks_toolbar_nav_and_columnheader_seeding_and_scroll_landing() {
        let mut tracker = TemporalRedactionTracker::default();
        let policy = allow_all_policy();
        let nodes = extract_text_free_ax_nodes(
            r#"[
              {"role":"AXWindow","depth":0,"bounds":{"left":0.0,"top":0.0,"width":1.0,"height":1.0}},
              {"role":"AXToolbar","depth":1,"bounds":{"left":0.0,"top":0.0,"width":1.0,"height":0.08}},
              {"role":"AXButton","depth":2,"bounds":{"left":0.10,"top":0.02,"width":0.15,"height":0.04}},
              {"role":"AXNavigation","depth":1,"bounds":{"left":0.0,"top":0.08,"width":0.18,"height":0.92}},
              {"role":"AXTable","depth":1,"bounds":{"left":0.20,"top":0.10,"width":0.75,"height":0.85}},
              {"role":"AXColumnHeader","depth":2,"bounds":{"left":0.20,"top":0.10,"width":0.75,"height":0.05}},
              {"role":"AXCell","depth":2,"bounds":{"left":0.20,"top":0.15,"width":0.75,"height":0.80}}
            ]"#,
        );

        // 1) A candidate inside toolbar chrome must NOT seed a tracklet, while
        //    a body table cell at y=300 (0.375) DOES seed a tracklet.
        let (_, s1) = tracker.reconcile(
            frame_ctx("m1", Some("Linear"), Some("Issues"), 10_000, Some(&nodes)),
            &[
                ImageRegion {
                    bbox: [140, 20, 120, 22], // inside AXToolbar / AXButton
                    label: SpanLabel::Id,
                    score: 0.85,
                },
                ImageRegion {
                    bbox: [320, 300, 140, 20], // inside AXCell (y=300/800=0.375)
                    label: SpanLabel::Person,
                    score: 0.90,
                },
            ],
            &policy,
        );
        assert_eq!(s1.vetoed_chrome, 1);
        assert_eq!(s1.seeded_or_refreshed, 1);
        assert_eq!(tracker.active_tracklet_count(), 1);

        // 2) Next frame: scrolled upward so a sub-threshold Person candidate lands
        //    inside sticky AXColumnHeader (y=90/800=0.1125) -> VETOED, not promoted!
        let (f2, s2) = tracker.reconcile(
            frame_ctx("m1", Some("Linear"), Some("Issues"), 12_000, Some(&nodes)),
            &[ImageRegion {
                bbox: [320, 90, 140, 20], // inside AXColumnHeader (0.10..0.15 -> 80..120px)
                label: SpanLabel::Person,
                score: 0.25,
            }],
            &policy,
        );
        assert_eq!(s2.vetoed_chrome, 1);
        assert_eq!(s2.total_rescued(), 0);
        assert!(f2[0].score < policy.min_score);
    }

    #[test]
    fn newest_first_descending_timestamp_traversal_rescues_symmetrically() {
        let mut tracker = TemporalRedactionTracker::default();
        let policy = allow_all_policy();

        // Newest frame first: t=20s @ 0.91 -> t=18s @ 0.23 -> t=16s @ 0.20 -> t=14s @ 0.21 (decays)
        tracker.reconcile(
            frame_ctx("m1", Some("Slack"), Some("DM"), 20_000, None),
            &[ImageRegion {
                bbox: [400, 500, 150, 20],
                label: SpanLabel::Secret,
                score: 0.91,
            }],
            &policy,
        );
        let (f_18, s_18) = tracker.reconcile(
            frame_ctx("m1", Some("Slack"), Some("DM"), 18_000, None),
            &[ImageRegion {
                bbox: [401, 500, 148, 20],
                label: SpanLabel::Secret,
                score: 0.23,
            }],
            &policy,
        );
        assert_eq!(s_18.rescued_stationary, 1);
        assert!(f_18[0].score >= 0.50);

        let (f_16, s_16) = tracker.reconcile(
            frame_ctx("m1", Some("Slack"), Some("DM"), 16_000, None),
            &[ImageRegion {
                bbox: [401, 360, 148, 20],
                label: SpanLabel::Secret,
                score: 0.20,
            }],
            &policy,
        );
        assert_eq!(s_16.rescued_scroll, 1);
        assert!(f_16[0].score >= 0.50);

        let (f_14, s_14) = tracker.reconcile(
            frame_ctx("m1", Some("Slack"), Some("DM"), 14_000, None),
            &[ImageRegion {
                bbox: [401, 360, 148, 20],
                label: SpanLabel::Secret,
                score: 0.21,
            }],
            &policy,
        );
        assert_eq!(s_14.total_rescued(), 0);
        assert!(f_14[0].score < 0.50);
    }

    #[test]
    fn memory_footprint_stays_strictly_under_16_kb_at_full_lru_saturation() {
        let mut tracker = TemporalRedactionTracker::default();
        let policy = allow_all_policy();

        // Saturate 24 distinct windows (exceeding 16 LRU cap) × 80 boxes (exceeding 64 tracklet cap).
        for w in 0..24 {
            let win_title = format!("Window-{w}-{}", "x".repeat(512));
            let regions: Vec<ImageRegion> = (0..80)
                .map(|i| ImageRegion {
                    bbox: [(i as u32 % 10) * 110, (i as u32 / 10) * 60, 90, 20],
                    label: SpanLabel::Secret,
                    score: 0.88,
                })
                .collect();
            tracker.reconcile(
                frame_ctx(
                    "monitor_1",
                    Some("Chrome"),
                    Some(&win_title),
                    w * 1_000,
                    None,
                ),
                &regions,
                &policy,
            );
        }

        assert_eq!(tracker.active_window_count(), DEFAULT_MAX_WINDOW_CONTEXTS);
        assert_eq!(
            tracker.active_tracklet_count(),
            DEFAULT_MAX_WINDOW_CONTEXTS * DEFAULT_MAX_TRACKLETS_PER_WINDOW
        );
        let bytes = tracker.memory_usage_bytes();
        assert!(
            bytes < 16 * 1024,
            "worst-case saturated memory {bytes} B must be strictly < 16384 B (16 KB)"
        );
    }

    #[test]
    fn one_to_one_tracklet_matching_prevents_stationary_seed_from_also_promoting_scroll_noise() {
        let mut tracker = TemporalRedactionTracker::default();
        let policy = allow_all_policy();

        // Frame 1: single Secret at y=200
        tracker.reconcile(
            frame_ctx("m1", Some("Arc"), Some("Keys"), 1_000, None),
            &[ImageRegion {
                bbox: [150, 200, 160, 20],
                label: SpanLabel::Secret,
                score: 0.92,
            }],
            &policy,
        );

        // Frame 2: same Secret still stationary at y=200 (@ 0.91) PLUS a harmless
        // 0.21 blip aligned vertically at y=340. Tracklet #1 is claimed by y=200
        // in Pass 1, so y=340 MUST NOT be falsely rescued!
        let (f2, s2) = tracker.reconcile(
            frame_ctx("m1", Some("Arc"), Some("Keys"), 3_000, None),
            &[
                ImageRegion {
                    bbox: [150, 200, 160, 20],
                    label: SpanLabel::Secret,
                    score: 0.91,
                },
                ImageRegion {
                    bbox: [150, 340, 160, 20],
                    label: SpanLabel::Secret,
                    score: 0.21,
                },
            ],
            &policy,
        );
        assert_eq!(s2.seeded_or_refreshed, 1);
        assert_eq!(s2.total_rescued(), 0);
        assert_eq!(f2[0].score, 0.91);
        assert_eq!(f2[1].score, 0.21);
    }

    #[test]
    fn reconcile_microbenchmark_stays_sub_millisecond_and_rescues_flicker_streams() {
        let mut tracker = TemporalRedactionTracker::default();
        let policy = allow_all_policy();
        let nodes = extract_text_free_ax_nodes(
            r#"[
              {"role":"AXWindow","depth":0,"bounds":{"left":0.0,"top":0.0,"width":1.0,"height":1.0}},
              {"role":"AXToolbar","depth":1,"bounds":{"left":0.0,"top":0.0,"width":1.0,"height":0.06}},
              {"role":"AXMain","depth":1,"bounds":{"left":0.0,"top":0.06,"width":1.0,"height":0.94}},
              {"role":"AXCell","depth":2,"bounds":{"left":0.15,"top":0.20,"width":0.70,"height":0.60}}
            ]"#,
        );

        let mut samples_us = Vec::with_capacity(2_000);
        let mut total_rescued = 0usize;
        for step in 0..2_000i64 {
            // Every 3rd frame dips to 0.24 (flicker) with a 40px vertical scroll; others confirm at 0.88.
            let is_flicker = step % 3 == 1;
            let y = 300 + ((step % 3) as u32) * 40;
            let cands = [
                ImageRegion {
                    bbox: [320, y, 160, 22],
                    label: SpanLabel::Person,
                    score: if is_flicker { 0.24 } else { 0.88 },
                },
                ImageRegion {
                    bbox: [540, y, 210, 22],
                    label: SpanLabel::Secret,
                    score: if is_flicker { 0.21 } else { 0.91 },
                },
                ImageRegion {
                    bbox: [120, 14, 90, 20], // toolbar noise
                    label: SpanLabel::Id,
                    score: 0.26,
                },
            ];
            let t0 = std::time::Instant::now();
            let (_out, stats) = tracker.reconcile(
                TemporalFrameContext {
                    device_scope: "monitor_1",
                    app_name: Some("Arc"),
                    window_name: Some("Customer Console"),
                    timestamp_ms: Some(step * 2_000),
                    image_dims: (1920, 1080),
                    ax_nodes: Some(&nodes),
                },
                &cands,
                &policy,
            );
            samples_us.push(t0.elapsed().as_secs_f64() * 1e6);
            total_rescued += stats.total_rescued();
        }
        samples_us.sort_by(f64::total_cmp);
        let p50_us = samples_us[samples_us.len() / 2];
        let p99_us = samples_us[(samples_us.len() * 99) / 100];
        println!(
            "TEMPORAL_TRACKER_BENCH frames=2000 p50_us={p50_us:.2} p99_us={p99_us:.2} rescued={total_rescued} ram_bytes={}",
            tracker.memory_usage_bytes()
        );
        assert_eq!(total_rescued, 667 * 2);
        assert!(p50_us < 500.0, "p50 {p50_us:.2} us exceeded 500 us");
        assert!(tracker.memory_usage_bytes() < 16 * 1024);
    }
}
