// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Named redaction policy presets.
//!
//! The low-level [`TextRedactionPolicy`] and [`ImageRedactionPolicy`] are
//! label/threshold structs; callers previously had to assemble them by hand
//! from `piiRedactionLabels`. That made "give me the strict enterprise
//! configuration" impossible to express as one reviewed, testable value.
//! [`RedactionPreset`] is that value:
//!
//! | | [`RedactionPreset::Default`] | [`RedactionPreset::EnterpriseStrict`] |
//! |---|---|---|
//! | Text classes | `Secret` only | every [`SpanLabel`] + every known sub-type |
//! | Image classes | `Secret` only | all 12 RF-DETR detector classes |
//! | Image score floor | `0.50` | `0.30` (higher recall) |
//! | Over-redaction | minimal | deliberately higher |
//!
//! `Default` is **exactly** the current shipped behavior (secrets-only at
//! `0.50`). It exists so "no preset configured" and "preset=default" are
//! provably identical; see the regression test below. `EnterpriseStrict` is
//! opt-in and should only be enabled after measuring overmask on the sealed
//! ship-gate: catching every PII class also masks ordinary proper nouns,
//! dates and amounts, which costs timeline searchability. It is a policy,
//! not a new model — runtime stays 100% local, zero-OCR, single ONNX.
//!
//! Tenant-provided literal values are handled separately by
//! [`crate::TenantDictionary`], which is deliberately **preset-independent**:
//! an explicit customer requirement must not disappear when a tenant flips
//! from strict back to default.

use serde::{Deserialize, Serialize};

use crate::image::ImageRedactionPolicy;
use crate::span::{SpanLabel, TextRedactionPolicy, KNOWN_SUBTYPES};

/// All 12 classes emitted by the RF-DETR image detector. Mirrors the
/// `onnx-cpu`-gated `adapters::rfdetr::CLASSES`; the feature-gated lockstep
/// test below asserts the two stay identical, while featureless builds
/// (default `cargo test -p screenpipe-redact`) still compile.
const DETECTOR_CLASSES: [SpanLabel; 12] = [
    SpanLabel::Person,
    SpanLabel::Email,
    SpanLabel::Phone,
    SpanLabel::Address,
    SpanLabel::Url,
    SpanLabel::Company,
    SpanLabel::Repo,
    SpanLabel::Handle,
    SpanLabel::Channel,
    SpanLabel::Id,
    SpanLabel::Date,
    SpanLabel::Secret,
];

/// Phase 4 deterministic visual-PII classes. These are emitted by
/// `image::visual_pii` (QR finder patterns, a11y avatars, OS face provider),
/// **not** by the 12-class RF-DETR head, so they are kept out of
/// [`DETECTOR_CLASSES`] — that constant is assert-locked to
/// `adapters::rfdetr::CLASSES` in the feature-gated test below. Enterprise
/// Strict admits them so a visual detection is never dropped by the policy
/// filter; [`RedactionPreset::Default`] remains secrets-only.
const VISUAL_CLASSES: [SpanLabel; 3] = [
    SpanLabel::QrCode,
    SpanLabel::Avatar,
    SpanLabel::Face,
];

/// Image score floor for [`RedactionPreset::EnterpriseStrict`]. Matches the
/// `@0.30` column of the canonical sealed ship-gate scorecard so the preset
/// can be evaluated against an existing, comparable number.
pub const ENTERPRISE_STRICT_MIN_SCORE: f32 = 0.30;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RedactionPreset {
    /// Shipped behavior: secrets only, `0.50` score floor.
    #[default]
    Default,
    /// All PII classes, all sub-types, `0.30` score floor.
    EnterpriseStrict,
}

impl RedactionPreset {
    /// Forgiving wire-name parse: case-insensitive, `-`/`_` equivalent,
    /// with `strict` as a short alias. Unknown names return `None` so
    /// callers can fall back to [`Self::Default`] instead of silently
    /// enabling a stricter policy.
    pub fn from_wire(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().replace('-', "_").as_str() {
            "default" => Some(Self::Default),
            "enterprise_strict" | "strict" => Some(Self::EnterpriseStrict),
            _ => None,
        }
    }

    /// Canonical wire name (`default` / `enterprise_strict`).
    pub fn wire(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::EnterpriseStrict => "enterprise_strict",
        }
    }

    /// Text-side policy for this preset.
    pub fn text_policy(self) -> TextRedactionPolicy {
        match self {
            Self::Default => TextRedactionPolicy::default(),
            Self::EnterpriseStrict => TextRedactionPolicy {
                allow: SpanLabel::ALL.to_vec(),
                allow_subtypes: KNOWN_SUBTYPES
                    .iter()
                    .map(|subtype| (*subtype).to_owned())
                    .collect(),
            },
        }
    }

    /// Image-side policy for this preset.
    pub fn image_policy(self) -> ImageRedactionPolicy {
        match self {
            Self::Default => ImageRedactionPolicy::default(),
            Self::EnterpriseStrict => {
                // RF-DETR text-PII classes plus the Phase 4 deterministic
                // visual classes. `VisualPiiConfig` itself stays opt-in, so
                // listing them here only prevents the policy filter from
                // dropping a visual region if a tenant enables the detector.
                let mut allow = DETECTOR_CLASSES.to_vec();
                allow.extend_from_slice(&VISUAL_CLASSES);
                ImageRedactionPolicy {
                    allow,
                    min_score: ENTERPRISE_STRICT_MIN_SCORE,
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_the_unchanged_shipped_behavior() {
        assert_eq!(RedactionPreset::Default, RedactionPreset::default());
        let text = RedactionPreset::Default.text_policy();
        assert_eq!(text.allow, TextRedactionPolicy::default().allow);
        assert!(text.allow_subtypes.is_empty());
        let image = RedactionPreset::Default.image_policy();
        assert_eq!(image.allow, ImageRedactionPolicy::default().allow);
        assert_eq!(image.min_score, ImageRedactionPolicy::default().min_score);
    }

    #[test]
    fn strict_covers_every_text_label_and_subtype() {
        let text = RedactionPreset::EnterpriseStrict.text_policy();
        for label in SpanLabel::ALL {
            assert!(text.allows(label, None), "missing {label:?}");
        }
        assert_eq!(text.allow_subtypes.len(), KNOWN_SUBTYPES.len());
        for subtype in KNOWN_SUBTYPES {
            assert!(
                text.allows(SpanLabel::Id, Some(subtype)),
                "missing subtype {subtype}"
            );
        }
    }

    #[test]
    fn strict_covers_all_detector_classes_and_lowers_the_floor() {
        let image = RedactionPreset::EnterpriseStrict.image_policy();
        assert_eq!(image.allow.len(), DETECTOR_CLASSES.len() + VISUAL_CLASSES.len());
        for class in DETECTOR_CLASSES {
            assert!(image.allow.contains(&class), "missing {class:?}");
        }
        assert!(image.min_score < ImageRedactionPolicy::default().min_score);
        assert_eq!(image.min_score, ENTERPRISE_STRICT_MIN_SCORE);
    }

    #[test]
    fn strict_admits_the_phase4_visual_classes() {
        let image = RedactionPreset::EnterpriseStrict.image_policy();
        for class in VISUAL_CLASSES {
            assert!(image.allow.contains(&class), "missing visual class {class:?}");
        }
        // Default must NOT admit them: opt-in stays opt-in.
        let default = RedactionPreset::Default.image_policy();
        for class in VISUAL_CLASSES {
            assert!(!default.allow.contains(&class), "default leaked visual class {class:?}");
        }
    }

    #[test]
    fn from_wire_is_forgiving_and_fails_closed() {
        assert_eq!(
            RedactionPreset::from_wire("default"),
            Some(RedactionPreset::Default)
        );
        assert_eq!(
            RedactionPreset::from_wire(" Enterprise-Strict "),
            Some(RedactionPreset::EnterpriseStrict)
        );
        assert_eq!(
            RedactionPreset::from_wire("STRICT"),
            Some(RedactionPreset::EnterpriseStrict)
        );
        assert_eq!(
            RedactionPreset::from_wire("enterprise-strict"),
            Some(RedactionPreset::EnterpriseStrict)
        );
        assert_eq!(RedactionPreset::from_wire("banana"), None);
        assert_eq!(RedactionPreset::from_wire(""), None);
    }

    #[test]
    fn wire_round_trips() {
        for preset in [RedactionPreset::Default, RedactionPreset::EnterpriseStrict] {
            assert_eq!(RedactionPreset::from_wire(preset.wire()), Some(preset));
        }
    }

    #[cfg(feature = "onnx-cpu")]
    #[test]
    fn strict_image_classes_match_the_detector() {
        assert_eq!(DETECTOR_CLASSES, crate::adapters::rfdetr::CLASSES);
    }

    #[test]
    fn serde_uses_stable_snake_case_names() {
        assert_eq!(
            serde_json::to_string(&RedactionPreset::EnterpriseStrict).unwrap(),
            "\"enterprise_strict\""
        );
        let parsed: RedactionPreset = serde_json::from_str("\"default\"").unwrap();
        assert_eq!(parsed, RedactionPreset::Default);
    }
}
