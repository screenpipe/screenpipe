// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Evidence produced by the operation that processed a captured field.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub type FieldRedactions = BTreeMap<String, RedactionEvidence>;

/// Capture carries evidence in fixed slots; no allocation or I/O is added to
/// frame capture and native event callbacks. The writer serializes it later.
#[derive(Debug, Clone, Copy)]
#[repr(usize)]
pub enum CaptureField {
    FullText,
    AccessibilityText,
    TextJson,
    TextContent,
    ElementValue,
    ElementAncestors,
    Transcription,
}
impl CaptureField {
    const ALL: [Self; 7] = [
        Self::FullText,
        Self::AccessibilityText,
        Self::TextJson,
        Self::TextContent,
        Self::ElementValue,
        Self::ElementAncestors,
        Self::Transcription,
    ];
    fn name(self) -> &'static str {
        match self {
            Self::FullText => "full_text",
            Self::AccessibilityText => "accessibility_text",
            Self::TextJson => "text_json",
            Self::TextContent => "text_content",
            Self::ElementValue => "element_value",
            Self::ElementAncestors => "element_ancestors",
            Self::Transcription => "transcription",
        }
    }
}
#[derive(Clone, Default)]
pub struct CaptureRedactions {
    slots: [Option<RedactionEvidence>; CaptureField::ALL.len()],
    // Move the already allocated source into the writer only long enough to
    // derive exact leaf outcomes. Never serialize or log this raw value.
    ocr_source: Option<String>,
}
impl std::fmt::Debug for CaptureRedactions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CaptureRedactions")
            .field("slots", &self.slots)
            .finish_non_exhaustive()
    }
}
impl CaptureRedactions {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn insert(&mut self, field: CaptureField, evidence: RedactionEvidence) {
        self.slots[field as usize] = Some(evidence);
    }
    pub fn get(&self, field: CaptureField) -> Option<&RedactionEvidence> {
        self.slots[field as usize].as_ref()
    }
    pub fn observe(&mut self, field: CaptureField, evidence: RedactionEvidence) {
        if let Some(previous) = self.slots[field as usize].as_mut() {
            previous.merge(&evidence);
        } else {
            self.insert(field, evidence);
        }
    }
    pub fn extend(&mut self, other: Self) {
        for (field, value) in CaptureField::ALL.into_iter().zip(other.slots) {
            if let Some(evidence) = value {
                self.observe(field, evidence);
            }
        }
    }
    pub fn set_ocr_source(&mut self, source: String) {
        self.ocr_source = Some(source);
    }
    pub fn ocr_source(&self) -> Option<&str> {
        self.ocr_source.as_deref()
    }
    pub fn fields(&self) -> FieldRedactions {
        CaptureField::ALL
            .into_iter()
            .zip(&self.slots)
            .filter_map(|(field, value)| value.clone().map(|e| (field.name().into(), e)))
            .collect()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RedactionMethod {
    InlineRegex,
    AsyncRegex,
    AsyncModel,
    AsyncRegexFallback,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RedactionResult {
    Replaced,
    NoMatch,
    Skipped,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RedactionEvidence {
    /// False for skipped leaves and degraded fallback; processed alone is not
    /// proof that the complete stored field was covered.
    pub complete: bool,
    pub processed_at: i64,
    pub method: RedactionMethod,
    pub pseudonymized: bool,
    pub result: RedactionResult,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cause: Option<String>,
}

impl RedactionEvidence {
    pub fn new(method: RedactionMethod, pseudonymized: bool, changed: bool) -> Self {
        Self {
            complete: true,
            processed_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs() as i64,
            method,
            pseudonymized: pseudonymized && changed,
            result: if changed {
                RedactionResult::Replaced
            } else {
                RedactionResult::NoMatch
            },
            cause: None,
        }
    }

    /// Aggregate structured leaves without losing a fallback or replacement.
    pub fn merge(&mut self, other: &Self) {
        self.complete &= other.complete;
        self.processed_at = self.processed_at.max(other.processed_at);
        self.pseudonymized |= other.pseudonymized;
        if other.result == RedactionResult::Replaced {
            self.result = other.result;
        }
        if other.method == RedactionMethod::AsyncRegexFallback
            || self.method == RedactionMethod::AsyncRegex
        {
            self.method = other.method;
        }
        if other.cause.is_some() {
            self.cause = other.cause.clone();
        }
    }
}

pub const PSEUDONYM_TOKEN_BYTES: usize = 6;

/// Recognize only the complete wire shape. This preserves prior pseudonyms;
/// recognizing a placeholder never grants privacy completion or release.
pub fn is_pseudonym(value: &str) -> bool {
    let Some(body) = value.strip_prefix('[').and_then(|s| s.strip_suffix(']')) else {
        return false;
    };
    let Some((label, suffix)) = body.rsplit_once('_') else {
        return false;
    };
    !label.is_empty()
        && label.bytes().all(|b| b.is_ascii_uppercase() || b == b'_')
        && suffix.len() == PSEUDONYM_TOKEN_BYTES * 2
        && suffix
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// An operational observation, not a claim about current customer recovery.
/// Contains no captured value, model response, key, or recording path.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RedactionFailure {
    pub observed_at: i64,
    pub kind: String,
    pub record_id: i64,
    pub field: Option<String>,
    pub method: RedactionMethod,
    pub result: RedactionResult,
    pub retryable: bool,
    pub cause: String,
}
