//! Text normalization and query expansion for improved FTS search.
//!
//! This module provides query-side improvements to full-text search recall
//! without requiring database migrations. It expands search queries to catch
//! compound words that OCR may have concatenated.

use once_cell::sync::Lazy;
use regex::Regex;

// Pre-compiled regexes for minimal overhead
static CAMEL_CASE: Lazy<Regex> = Lazy::new(|| Regex::new(r"([a-z])([A-Z])").unwrap());
static NUM_TO_LETTER: Lazy<Regex> = Lazy::new(|| Regex::new(r"([0-9])([a-zA-Z])").unwrap());
static LETTER_TO_NUM: Lazy<Regex> = Lazy::new(|| Regex::new(r"([a-zA-Z])([0-9])").unwrap());

/// Split compound words on camelCase and number boundaries.
///
/// Used internally for query expansion.
#[inline]
fn split_compound(text: &str) -> String {
    // Fast path: if no uppercase letters or digits, skip processing
    if !text
        .bytes()
        .any(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
    {
        return text.to_string();
    }

    let result = CAMEL_CASE.replace_all(text, "$1 $2");
    let result = NUM_TO_LETTER.replace_all(&result, "$1 $2");
    let result = LETTER_TO_NUM.replace_all(&result, "$1 $2");
    result.into_owned()
}

/// Sanitize a query string for safe use in FTS5 MATCH expressions.
///
/// Wraps each whitespace-delimited token in double quotes so that
/// special characters (dots, parens, colons, etc.) are treated as
/// literal text rather than FTS5 operators.
///
/// # Example
/// ```
/// use screenpipe_db::text_normalizer::sanitize_fts5_query;
///
/// assert_eq!(sanitize_fts5_query("100.100.0.42"), r#""100.100.0.42""#);
/// assert_eq!(sanitize_fts5_query("hello world"), r#""hello" "world""#);
/// ```
pub fn sanitize_fts5_query(query: &str) -> String {
    query
        .split_whitespace()
        .filter_map(|token| {
            let cleaned = token.replace('"', "");
            if cleaned.is_empty() {
                return None;
            }
            Some(format!("\"{}\"", cleaned))
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Expand a search query to improve recall on compound words.
///
/// Takes a user query and returns an expanded FTS5 query that searches for:
/// 1. The original term (with prefix matching)
/// 2. Split parts of compound words (with prefix matching)
///
/// All tokens are quoted to safely handle special characters (dots, parens, etc.)
/// in FTS5.
///
/// This catches cases where OCR concatenated words like "ActivityPerformance"
/// when the user searches for "activity" or "performance".
///
/// # Example
/// ```
/// use screenpipe_db::text_normalizer::expand_search_query;
///
/// // Single word - quoted with prefix matching
/// assert_eq!(expand_search_query("test"), r#""test"*"#);
///
/// // Compound word - expands to catch parts
/// assert_eq!(expand_search_query("proStart"), r#"("proStart"* OR "pro"* OR "Start"*)"#);
/// ```
pub fn expand_search_query(query: &str) -> String {
    let query = query.trim();
    if query.is_empty() {
        return String::new();
    }

    // Process each word in the query
    let expanded_terms: Vec<String> = query
        .split_whitespace()
        .flat_map(|word| {
            let cleaned = word.replace('"', "");
            let split = split_compound(&cleaned);
            let parts: Vec<&str> = split.split_whitespace().collect();

            if parts.len() > 1 {
                // Word was split - include original and parts with prefix matching
                let mut terms = vec![format!("\"{}\"*", cleaned)];
                for part in parts {
                    if part.len() >= 2 {
                        // Only add parts with 2+ chars to avoid noise
                        terms.push(format!("\"{}\"*", part));
                    }
                }
                terms
            } else {
                // No split needed - just add quoted prefix matching
                vec![format!("\"{}\"*", cleaned)]
            }
        })
        .collect();

    if expanded_terms.len() == 1 {
        expanded_terms[0].clone()
    } else {
        format!("({})", expanded_terms.join(" OR "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_split_compound_camel_case() {
        assert_eq!(split_compound("camelCase"), "camel Case");
        assert_eq!(split_compound("CamelCase"), "Camel Case");
        assert_eq!(
            split_compound("ActivityPerformance"),
            "Activity Performance"
        );
    }

    #[test]
    fn test_split_compound_numbers() {
        assert_eq!(split_compound("test123"), "test 123");
        assert_eq!(split_compound("123test"), "123 test");
        assert_eq!(split_compound("test123word"), "test 123 word");
    }

    #[test]
    fn test_split_compound_no_change() {
        assert_eq!(split_compound("hello"), "hello");
        assert_eq!(split_compound("hello world"), "hello world");
    }

    #[test]
    fn test_sanitize_fts5_simple() {
        assert_eq!(sanitize_fts5_query("hello"), r#""hello""#);
        assert_eq!(sanitize_fts5_query("hello world"), r#""hello" "world""#);
    }

    #[test]
    fn test_sanitize_fts5_dots() {
        assert_eq!(sanitize_fts5_query("100.100.0.42"), r#""100.100.0.42""#);
    }

    #[test]
    fn test_sanitize_fts5_special_chars() {
        assert_eq!(sanitize_fts5_query("foo(bar)"), r#""foo(bar)""#);
        assert_eq!(sanitize_fts5_query("C++"), r#""C++""#);
    }

    #[test]
    fn test_sanitize_fts5_strips_quotes() {
        assert_eq!(
            sanitize_fts5_query(r#"he said "hello""#),
            r#""he" "said" "hello""#
        );
    }

    #[test]
    fn test_sanitize_fts5_empty() {
        assert_eq!(sanitize_fts5_query(""), "");
        assert_eq!(sanitize_fts5_query("   "), "");
    }

    #[test]
    fn test_expand_simple_query() {
        assert_eq!(expand_search_query("test"), r#""test"*"#);
        assert_eq!(expand_search_query("hello"), r#""hello"*"#);
    }

    #[test]
    fn test_expand_compound_query() {
        assert_eq!(
            expand_search_query("proStart"),
            r#"("proStart"* OR "pro"* OR "Start"*)"#
        );
        assert_eq!(
            expand_search_query("ActivityPerformance"),
            r#"("ActivityPerformance"* OR "Activity"* OR "Performance"*)"#
        );
    }

    #[test]
    fn test_expand_number_boundary() {
        assert_eq!(
            expand_search_query("test123"),
            r#"("test123"* OR "test"* OR "123"*)"#
        );
    }

    #[test]
    fn test_expand_multi_word_query() {
        // Each word gets expanded independently
        assert_eq!(
            expand_search_query("hello world"),
            r#"("hello"* OR "world"*)"#
        );
    }

    #[test]
    fn test_expand_empty_query() {
        assert_eq!(expand_search_query(""), "");
        assert_eq!(expand_search_query("   "), "");
    }

    #[test]
    fn test_expand_filters_short_parts() {
        // Single char parts should be filtered out
        assert_eq!(expand_search_query("iPhone"), r#"("iPhone"* OR "Phone"*)"#);
    }

    #[test]
    fn test_expand_preserves_lowercase() {
        assert_eq!(expand_search_query("simple"), r#""simple"*"#);
    }

    #[test]
    fn test_expand_dots_in_query() {
        // IP addresses and dotted identifiers should be safely quoted
        assert_eq!(expand_search_query("100.100.0.42"), r#""100.100.0.42"*"#);
    }
}
