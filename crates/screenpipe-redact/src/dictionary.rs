// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Zero-ML tenant custom dictionaries.
//!
//! An enterprise tenant sometimes needs specific literal values redacted that
//! no generic detector will ever learn: an internal project codename, a
//! customer's private account label, a legacy system hostname. Regex cannot
//! express "whatever the admin typed", and a model cannot be retrained per
//! tenant. [`TenantDictionary`] is the bounded, deterministic hook for that:
//! pure literal byte matching, **no model inference, no OCR, no network**.
//!
//! Design constraints (the reconciliation worker, not the capture hot path):
//! - Opt-in. An empty dictionary allocates nothing and scans nothing.
//! - Bounded. Entry count, entry length and matches-per-input are capped so a
//!   hostile or accidental config cannot turn a text frame into a CPU sink.
//! - Byte-offset safe. Case-insensitive matching uses ASCII-only lowercasing,
//!   which preserves both byte length and UTF-8 char boundaries, so returned
//!   [`RedactedSpan`] offsets always index the original input exactly. The
//!   deliberate trade-off: non-ASCII case variants (`NAÏVE` vs `naïve`) are
//!   **not** folded; entries containing non-ASCII letters need exact casing.
//!   Unicode case folding can change byte length and would break the offset
//!   guarantee, so it is intentionally out of scope for this hook.
//! - Policy-independent. Dictionary spans are [`SpanLabel::Secret`] (the
//!   always-on safety class) with the [`TENANT_DICTIONARY_SUBTYPE`] sub-type,
//!   so an explicit tenant requirement is never silently dropped by a label
//!   toggle or a narrower preset.
//!
//! The dictionary is **text-side only**. The image path is zero-OCR by design;
//! literal text inside pixels cannot be matched without either OCR or a model,
//! both of which this module deliberately avoids.

use serde::{Deserialize, Serialize};
use std::fmt;

use crate::span::{RedactedSpan, SpanLabel};

/// Maximum number of entries accepted by [`TenantDictionary::try_from_entries`].
pub const MAX_DICTIONARY_ENTRIES: usize = 4096;
/// Maximum byte length of one dictionary entry.
pub const MAX_ENTRY_BYTES: usize = 256;
/// Maximum number of spans one input can produce from the dictionary.
pub const MAX_MATCHES_PER_INPUT: usize = 512;
/// Sub-type tag attached to every dictionary span, for audit logs.
pub const TENANT_DICTIONARY_SUBTYPE: &str = "tenant_dictionary";

/// Validation failures for tenant-provided dictionary entries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DictionaryError {
    TooManyEntries { limit: usize },
    EntryTooLong { limit: usize },
    EmptyEntry,
    ControlCharacter,
}

impl fmt::Display for DictionaryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooManyEntries { limit } => {
                write!(f, "tenant dictionary exceeds {limit} entries")
            }
            Self::EntryTooLong { limit } => {
                write!(f, "tenant dictionary entry exceeds {limit} bytes")
            }
            Self::EmptyEntry => write!(f, "tenant dictionary entry is empty"),
            Self::ControlCharacter => {
                write!(f, "tenant dictionary entry contains a control character")
            }
        }
    }
}

impl std::error::Error for DictionaryError {}

/// One literal to redact. `case_sensitive` defaults to `false`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DictionaryEntry {
    /// Verbatim literal. Compared as a substring, never as a regex.
    pub value: String,
    /// When false (default), matching is ASCII case-insensitive.
    #[serde(default)]
    pub case_sensitive: bool,
}

impl DictionaryEntry {
    pub fn new(value: impl Into<String>, case_sensitive: bool) -> Self {
        Self {
            value: value.into(),
            case_sensitive,
        }
    }
}

/// A bounded set of tenant literals. Empty by default; constructing one is
/// cheap and `find_spans` on an empty dictionary returns immediately.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TenantDictionary {
    #[serde(default)]
    entries: Vec<DictionaryEntry>,
}

impl TenantDictionary {
    /// Empty dictionary (no-op).
    pub fn empty() -> Self {
        Self::default()
    }

    /// Build from plain string values, all case-insensitive. Invalid entries
    /// are skipped rather than failing the whole config, so a single bad row
    /// in a tenant's settings cannot disable redaction entirely.
    pub fn from_values(values: &[String]) -> Self {
        let entries: Vec<DictionaryEntry> = values
            .iter()
            .filter_map(|v| normalize_entry(v, false).ok())
            .collect();
        Self::from_entries_truncated(entries)
    }

    /// Strict builder. Trims, drops empty values, de-duplicates, and rejects
    /// over-long, control-character and over-count entries.
    pub fn try_from_entries(entries: Vec<DictionaryEntry>) -> Result<Self, DictionaryError> {
        let mut out: Vec<DictionaryEntry> = Vec::with_capacity(entries.len());
        for entry in entries {
            let normalized = normalize_entry(&entry.value, entry.case_sensitive)?;
            if !out.contains(&normalized) {
                out.push(normalized);
            }
        }
        if out.len() > MAX_DICTIONARY_ENTRIES {
            return Err(DictionaryError::TooManyEntries {
                limit: MAX_DICTIONARY_ENTRIES,
            });
        }
        Ok(Self { entries: out })
    }

    fn from_entries_truncated(mut entries: Vec<DictionaryEntry>) -> Self {
        entries.sort_by(|a, b| (&a.value, a.case_sensitive).cmp(&(&b.value, b.case_sensitive)));
        entries.dedup();
        entries.truncate(MAX_DICTIONARY_ENTRIES);
        Self { entries }
    }

    pub fn entries(&self) -> &[DictionaryEntry] {
        &self.entries
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Stable content fingerprint (FNV-1a). Used in
    /// [`crate::Pipeline::policy_identity`] so a dictionary change is visible
    /// in redaction-status evidence and cache namespaces without embedding
    /// the tenant's literal values in logs.
    pub fn fingerprint(&self) -> u64 {
        let mut normalized: Vec<String> = self
            .entries
            .iter()
            .map(|e| {
                format!(
                    "{}:{}",
                    if e.case_sensitive { "cs" } else { "ci" },
                    e.value.to_ascii_lowercase()
                )
            })
            .collect();
        normalized.sort();
        normalized.dedup();
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for value in &normalized {
            for byte in value.as_bytes() {
                hash ^= u64::from(*byte);
                hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
            }
            hash ^= 0xff;
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
        hash
    }

    /// Find non-overlapping literal matches in `text`, longest entry first.
    /// Spans are anchored to `text` byte offsets and are always
    /// [`SpanLabel::Secret`]. Never panics on non-ASCII input.
    pub fn find_spans(&self, text: &str) -> Vec<RedactedSpan> {
        if self.entries.is_empty() || text.is_empty() {
            return Vec::new();
        }

        let mut needles: Vec<(&str, bool)> = self
            .entries
            .iter()
            .filter_map(|e| {
                let value = e.value.as_str();
                if value.is_empty()
                    || value.len() > MAX_ENTRY_BYTES
                    || value.chars().any(char::is_control)
                {
                    return None;
                }
                Some((value, e.case_sensitive))
            })
            .collect();
        if needles.is_empty() {
            return Vec::new();
        }
        // Longest first so a codename and its prefix both match only once.
        needles.sort_by(|a, b| b.0.len().cmp(&a.0.len()).then_with(|| a.0.cmp(b.0)));
        needles.truncate(MAX_DICTIONARY_ENTRIES);

        // ASCII-only lowercasing preserves byte length and UTF-8 boundaries,
        // so every offset below indexes `text` directly.
        let hay_lower = text.to_ascii_lowercase();
        let mut found: Vec<(usize, usize)> = Vec::new();

        'needles: for (needle, case_sensitive) in &needles {
            let needle_lower = if *case_sensitive {
                None
            } else {
                Some(needle.to_ascii_lowercase())
            };
            let hay: &[u8] = if *case_sensitive {
                text.as_bytes()
            } else {
                hay_lower.as_bytes()
            };
            let pattern: &[u8] = match &needle_lower {
                Some(lower) => lower.as_bytes(),
                None => needle.as_bytes(),
            };
            if pattern.is_empty() || pattern.len() > hay.len() {
                continue;
            }

            let mut cursor = 0usize;
            while cursor + pattern.len() <= hay.len() {
                let Some(relative) = hay[cursor..]
                    .windows(pattern.len())
                    .position(|window| window == pattern)
                else {
                    break;
                };
                let start = cursor + relative;
                let end = start + pattern.len();
                if text.is_char_boundary(start)
                    && text.is_char_boundary(end)
                    && !found.iter().any(|&(a, b)| start < b && a < end)
                {
                    found.push((start, end));
                    if found.len() >= MAX_MATCHES_PER_INPUT {
                        break 'needles;
                    }
                }
                cursor = start + 1;
            }
        }

        found.sort_unstable_by_key(|&(start, end)| (start, end));
        found
            .into_iter()
            .map(|(start, end)| RedactedSpan {
                start,
                end,
                label: SpanLabel::Secret,
                subtype: Some(TENANT_DICTIONARY_SUBTYPE.to_owned()),
                text: text[start..end].to_owned(),
            })
            .collect()
    }
}

fn normalize_entry(value: &str, case_sensitive: bool) -> Result<DictionaryEntry, DictionaryError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(DictionaryError::EmptyEntry);
    }
    if trimmed.len() > MAX_ENTRY_BYTES {
        return Err(DictionaryError::EntryTooLong {
            limit: MAX_ENTRY_BYTES,
        });
    }
    if trimmed.chars().any(char::is_control) {
        return Err(DictionaryError::ControlCharacter);
    }
    Ok(DictionaryEntry {
        value: trimmed.to_owned(),
        case_sensitive,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dict(values: &[&str]) -> TenantDictionary {
        TenantDictionary::from_values(&values.iter().map(|v| (*v).to_owned()).collect::<Vec<_>>())
    }

    #[test]
    fn empty_dictionary_is_a_no_op() {
        let d = TenantDictionary::empty();
        assert!(d.is_empty());
        assert!(d.find_spans("any text at all").is_empty());
    }

    #[test]
    fn case_insensitive_match_preserves_original_case_in_span_text() {
        let d = dict(&["Project Falcon"]);
        let text = "notes for project FALCON today";
        let spans = d.find_spans(text);
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].text, "project FALCON");
        assert_eq!(&text[spans[0].start..spans[0].end], "project FALCON");
        assert_eq!(spans[0].label, SpanLabel::Secret);
        assert_eq!(spans[0].subtype.as_deref(), Some(TENANT_DICTIONARY_SUBTYPE));
    }

    #[test]
    fn case_sensitive_entry_does_not_match_other_casing() {
        let d =
            TenantDictionary::try_from_entries(vec![DictionaryEntry::new("Falcon", true)]).unwrap();
        assert!(d.find_spans("project falcon").is_empty());
        assert_eq!(d.find_spans("project Falcon").len(), 1);
    }

    #[test]
    fn longest_entry_wins_and_matches_never_overlap() {
        let d = dict(&["Falcon", "Project Falcon"]);
        let spans = d.find_spans("Project Falcon rolled out");
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].text, "Project Falcon");
    }

    #[test]
    fn multiple_non_overlapping_matches_are_sorted() {
        let d = dict(&["alpha", "beta"]);
        let spans = d.find_spans("alpha then beta then ALPHA");
        assert_eq!(spans.len(), 3);
        assert!(spans.windows(2).all(|w| w[0].start <= w[1].start));
        assert_eq!(spans[2].text, "ALPHA");
    }

    #[test]
    fn unicode_input_keeps_char_boundaries() {
        let d = dict(&["café", "naïve"]);
        let text = "café ☕ then naïve and café";
        let spans = d.find_spans(text);
        assert_eq!(spans.len(), 3);
        for span in &spans {
            assert!(text.is_char_boundary(span.start));
            assert!(text.is_char_boundary(span.end));
            assert_eq!(&text[span.start..span.end], span.text);
        }
    }

    #[test]
    fn non_ascii_case_variants_are_not_folded() {
        // ASCII-only folding is what keeps byte offsets exact. A tenant
        // literal containing non-ASCII letters must match casing exactly;
        // set `case_sensitive: false` (the default) still only folds A-Z.
        let d = dict(&["naïve"]);
        assert_eq!(d.find_spans("naïve").len(), 1);
        assert!(d.find_spans("NAÏVE").is_empty());
    }

    #[test]
    fn ascii_lowercase_never_shifts_offsets() {
        let d = dict(&["token"]);
        let text = "éé TOKEN éé"; // multibyte bytes before the match
        let spans = d.find_spans(text);
        assert_eq!(spans.len(), 1);
        assert_eq!(&text[spans[0].start..spans[0].end], "TOKEN");
    }

    #[test]
    fn match_count_is_capped() {
        let d = dict(&["x"]);
        let text = "x".repeat(MAX_MATCHES_PER_INPUT + 200);
        assert_eq!(d.find_spans(&text).len(), MAX_MATCHES_PER_INPUT);
    }

    #[test]
    fn validation_rejects_bad_entries() {
        assert_eq!(
            TenantDictionary::try_from_entries(vec![DictionaryEntry::new("   ", false)])
                .unwrap_err(),
            DictionaryError::EmptyEntry
        );
        assert_eq!(
            TenantDictionary::try_from_entries(vec![DictionaryEntry::new(
                "a".repeat(MAX_ENTRY_BYTES + 1),
                false
            )])
            .unwrap_err(),
            DictionaryError::EntryTooLong {
                limit: MAX_ENTRY_BYTES
            }
        );
        assert_eq!(
            TenantDictionary::try_from_entries(vec![DictionaryEntry::new("a\nb", false)])
                .unwrap_err(),
            DictionaryError::ControlCharacter
        );
        let many: Vec<_> = (0..MAX_DICTIONARY_ENTRIES + 1)
            .map(|i| DictionaryEntry::new(format!("v{i}"), false))
            .collect();
        assert_eq!(
            TenantDictionary::try_from_entries(many).unwrap_err(),
            DictionaryError::TooManyEntries {
                limit: MAX_DICTIONARY_ENTRIES
            }
        );
    }

    #[test]
    fn from_values_trims_and_dedupes_without_failing() {
        let d = TenantDictionary::from_values(&[
            "  Falcon  ".into(),
            "Falcon".into(),
            "   ".into(),
            "Beta".into(),
        ]);
        assert_eq!(d.len(), 2);
    }

    #[test]
    fn fingerprint_is_stable_and_content_sensitive() {
        let a = dict(&["alpha", "beta"]);
        let b = dict(&["beta", "alpha"]); // order-independent
        let c = dict(&["alpha", "gamma"]);
        assert_eq!(a.fingerprint(), b.fingerprint());
        assert_ne!(a.fingerprint(), c.fingerprint());
        assert_ne!(a.fingerprint(), TenantDictionary::empty().fingerprint());
    }

    #[test]
    fn deserialized_dictionary_still_bounds_invalid_rows() {
        let d: TenantDictionary =
            serde_json::from_str(r#"{"entries":[{"value":"ok"},{"value":""},{"value":"a\nb"}]}"#)
                .unwrap();
        assert_eq!(d.len(), 3); // raw rows kept, but...
        assert_eq!(d.find_spans("ok").len(), 1); // ...invalid rows are skipped at match time
        assert!(d.find_spans("a\nb").is_empty());
    }
}
