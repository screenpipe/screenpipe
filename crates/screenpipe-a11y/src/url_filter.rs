//! Domain-level URL blocking shared by the vision capture path
//! (`screenpipe-screen`'s `WindowFilters`) and the a11y tree walker.
//! Lives here because the dependency direction is screen → a11y: an ignored
//! URL must produce neither frames nor accessibility snapshots.

use url::Url;

/// Check if a URL should be filtered out for privacy.
///
/// Uses domain-level matching to avoid false positives (e.g. "chase" won't
/// match "purchase.com"). Patterns are matched case-insensitively against
/// the URL's host:
///
/// 1. Exact match: `host == pattern`
/// 2. Subdomain: host ends with `.{pattern}`
/// 3. No-TLD pattern: `chase` matches `chase.com` / `www.chase.net` / …
///
/// Returns `true` if the URL is blocked (should be skipped).
pub fn is_url_blocked(url: &str, blocked_patterns: &[String]) -> bool {
    if blocked_patterns.is_empty() {
        return false;
    }

    // Normalize so bare hosts ("wellsfargo.com") parse too.
    let url_to_parse = if !url.starts_with("http://") && !url.starts_with("https://") {
        format!("https://{}", url)
    } else {
        url.to_string()
    };

    if let Ok(parsed) = Url::parse(&url_to_parse) {
        if let Some(host) = parsed.host_str() {
            let host_lower = host.to_lowercase();
            return blocked_patterns
                .iter()
                .any(|blocked| host_matches_pattern(&host_lower, &blocked.to_lowercase()));
        }
    }

    // Fallback to simple contains check if URL parsing fails.
    // Less precise, but ensures we don't miss obvious matches.
    let url_lower = url.to_lowercase();
    blocked_patterns
        .iter()
        .any(|blocked| url_lower.contains(&blocked.to_lowercase()))
}

/// Domain-boundary match of one lowercased host against one lowercased pattern.
fn host_matches_pattern(host_lower: &str, blocked: &str) -> bool {
    // Exact match
    if host_lower == blocked {
        return true;
    }

    // Subdomain match: host ends with ".blocked"
    if host_lower.ends_with(&format!(".{}", blocked)) {
        return true;
    }

    // For patterns without a TLD (e.g. "chase" instead of "chase.com"),
    // match the pattern against any domain label. This covers every TLD
    // (chase.com, chase.co.uk, chase.io, …) without hardcoding a list,
    // while still respecting domain boundaries: "purchase.com" splits to
    // ["purchase", "com"], so "chase" never matches it.
    if !blocked.contains('.') {
        return host_lower.split('.').any(|label| label == blocked);
    }

    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blocked(patterns: &[&str]) -> Vec<String> {
        patterns.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn test_empty_list_blocks_nothing() {
        assert!(!is_url_blocked("https://wellsfargo.com", &[]));
    }

    #[test]
    fn test_exact_domain_match() {
        let b = blocked(&["wellsfargo.com"]);
        assert!(is_url_blocked("https://wellsfargo.com", &b));
        assert!(is_url_blocked("https://wellsfargo.com/login", &b));
        assert!(is_url_blocked("https://www.wellsfargo.com", &b));
        assert!(is_url_blocked("https://online.wellsfargo.com/account", &b));
    }

    #[test]
    fn test_case_insensitive() {
        let b = blocked(&["WellsFargo.com"]);
        assert!(is_url_blocked("https://WELLSFARGO.COM", &b));
        assert!(is_url_blocked("https://wellsfargo.com/Login", &b));
    }

    #[test]
    fn test_no_false_positive_on_substring() {
        let b = blocked(&["chase.com"]);
        assert!(is_url_blocked("https://chase.com", &b));
        assert!(is_url_blocked("https://www.chase.com/login", &b));
        assert!(!is_url_blocked("https://purchase.com", &b));
        assert!(!is_url_blocked("https://showcase.example.com", &b));
    }

    #[test]
    fn test_partial_domain_pattern_matches_any_tld() {
        let b = blocked(&["chase"]);
        assert!(is_url_blocked("https://chase.com", &b));
        assert!(is_url_blocked("https://www.chase.com", &b));
        assert!(is_url_blocked("https://chase.bank", &b));
        // TLDs not in the old hardcoded list still match (no TLD allowlist).
        assert!(is_url_blocked("https://chase.co.uk", &b));
        assert!(is_url_blocked("https://chase.io", &b));
        assert!(is_url_blocked("https://online.chase.de/account", &b));
        // Domain boundaries are still respected — no substring false positives.
        assert!(!is_url_blocked("https://purchase.com", &b));
        assert!(!is_url_blocked("https://purchase.co.uk", &b));
        assert!(!is_url_blocked("https://showcase.example.com", &b));
    }

    #[test]
    fn test_without_protocol() {
        let b = blocked(&["wellsfargo.com"]);
        assert!(is_url_blocked("wellsfargo.com", &b));
        assert!(is_url_blocked("www.wellsfargo.com/account", &b));
    }

    #[test]
    fn test_multiple_patterns() {
        let b = blocked(&["wellsfargo.com", "chase.com", "bankofamerica.com"]);
        assert!(is_url_blocked("https://chase.com/login", &b));
        assert!(is_url_blocked("https://www.bankofamerica.com", &b));
        assert!(!is_url_blocked("https://google.com", &b));
    }
}
