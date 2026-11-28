// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

/// Returns (start_idx_s1, start_idx_s2, match_length) for the longest common word substring.
/// This allows callers to properly handle overlap removal by skipping past the matched portion.
pub fn longest_common_word_substring(s1: &str, s2: &str) -> Option<(usize, usize, usize)> {
    let s1 = s1.to_lowercase();
    let s2 = s2.to_lowercase();

    let s1 = s1.replace(|c| char::is_ascii_punctuation(&c), "");
    let s2 = s2.replace(|c| char::is_ascii_punctuation(&c), "");

    let s1_words: Vec<&str> = s1.split_whitespace().collect();
    let s2_words: Vec<&str> = s2.split_whitespace().collect();

    let s1_len = s1_words.len();
    let s2_len = s2_words.len();

    // Table to store lengths of longest common suffixes of word substrings
    let mut dp = vec![vec![0; s2_len + 1]; s1_len + 1];

    let mut max_len = 0;
    let mut max_index_s1 = None; // Store the starting word index of the longest substring in s1
    let mut max_index_s2 = None; // Store the starting word index of the longest substring in s2

    for i in 1..=s1_len {
        for j in 1..=s2_len {
            if s1_words[i - 1] == s2_words[j - 1] {
                dp[i][j] = dp[i - 1][j - 1] + 1;
                if dp[i][j] > max_len {
                    max_len = dp[i][j];
                    max_index_s1 = Some(i - max_len); // The start index of the match in s1
                    max_index_s2 = Some(j - max_len); // The start index of the match in s2
                }
            }
        }
    }

    match (max_index_s1, max_index_s2) {
        (Some(idx1), Some(idx2)) if max_len > 0 => Some((idx1, idx2, max_len)),
        _ => None,
    }
}

fn normalize_loop_token(token: &str) -> String {
    token
        .trim_matches(|c: char| c.is_ascii_punctuation())
        .to_lowercase()
}

/// Collapse consecutive n-gram repetition loops produced by local ASR decoders
/// (e.g. Parakeet CPU emitting "a little bit of a little bit of ..." 12+ times).
///
/// Conservative thresholds avoid touching natural speech disfluencies:
/// - phrase loops (`n` in `2..=8`): collapsed when repeated `>= 4` times in a row
/// - single-word loops (`n == 1`): collapsed when repeated `>= 6` times in a row
///
/// Keeps one copy of the repeated phrase, preserves any legitimate speech before
/// and after the loop, and strips a truncated partial copy if the loop ran to the
/// end of the audio chunk. Returns the original string untouched when no loop is
/// detected.
pub fn collapse_ngram_loops(text: &str) -> String {
    const MAX_NGRAM: usize = 8;
    const MIN_PHRASE_REPEATS: usize = 4;
    const MIN_UNIGRAM_REPEATS: usize = 6;

    let tokens: Vec<&str> = text.split_whitespace().collect();
    if tokens.len() < MIN_UNIGRAM_REPEATS {
        return text.to_string();
    }

    let norm: Vec<String> = tokens.iter().map(|t| normalize_loop_token(t)).collect();
    let mut out: Vec<&str> = Vec::with_capacity(tokens.len());
    let mut collapsed_any = false;
    let mut i = 0;

    while i < tokens.len() {
        let mut matched: Option<(usize, usize)> = None;

        for n in 1..=MAX_NGRAM {
            let min_repeats = if n == 1 {
                MIN_UNIGRAM_REPEATS
            } else {
                MIN_PHRASE_REPEATS
            };
            if i + n * min_repeats > tokens.len() {
                continue;
            }
            if norm[i..i + n].iter().all(|w| w.is_empty()) {
                continue;
            }
            let mut repeats = 1;
            while i + (repeats + 1) * n <= tokens.len()
                && norm[i + repeats * n..i + (repeats + 1) * n] == norm[i..i + n]
            {
                repeats += 1;
            }
            if repeats >= min_repeats {
                matched = Some((n, repeats));
                break;
            }
        }

        if let Some((n, repeats)) = matched {
            collapsed_any = true;
            out.extend_from_slice(&tokens[i..i + n]);
            let mut next = i + repeats * n;

            // If the decoder hit the chunk boundary mid-loop (e.g. "... a little bit of a littl"),
            // strip the partial trailing repetition when it runs all the way to the end.
            let mut partial = 0;
            while partial < n && next + partial < tokens.len() {
                let candidate = &norm[next + partial];
                let expected = &norm[i + partial];
                if candidate == expected {
                    partial += 1;
                } else if next + partial + 1 == tokens.len()
                    && !candidate.is_empty()
                    && expected.starts_with(candidate.as_str())
                {
                    partial += 1;
                    break;
                } else {
                    break;
                }
            }
            if partial > 0 && next + partial == tokens.len() {
                next += partial;
            }

            i = next;
        } else {
            out.push(tokens[i]);
            i += 1;
        }
    }

    if collapsed_any {
        out.join(" ")
    } else {
        text.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collapses_parakeet_phrase_loop_and_truncated_tail() {
        let looped = "That sounds like a little bit of a little bit of a little bit of a little bit of a little bit of a littl";
        assert_eq!(
            collapse_ngram_loops(looped),
            "That sounds like a little bit of"
        );
    }

    #[test]
    fn collapses_mid_transcript_loop_and_keeps_following_speech() {
        let looped = "So at Stripe, it is kind of like kind of like kind of like kind of like kind of like we ship fast.";
        assert_eq!(
            collapse_ngram_loops(looped),
            "So at Stripe, it is kind of like we ship fast."
        );
    }

    #[test]
    fn collapses_punctuation_variants_in_loop() {
        let looped = "and then, and then. and then, and then! and then.";
        assert_eq!(collapse_ngram_loops(looped), "and then,");
    }

    #[test]
    fn collapses_unigram_loop_at_six_or_more() {
        let looped = "uh yeah yeah yeah yeah yeah yeah yeah okay";
        assert_eq!(collapse_ngram_loops(looped), "uh yeah okay");
    }

    #[test]
    fn preserves_natural_short_repetitions_and_formatting() {
        let natural = "  yeah. yeah. No no no — repeated phrase repeated phrase  ";
        assert_eq!(collapse_ngram_loops(natural), natural);

        let three_times = "go go go right now";
        assert_eq!(collapse_ngram_loops(three_times), three_times);

        let three_phrases = "very good very good very good";
        assert_eq!(collapse_ngram_loops(three_phrases), three_phrases);
    }

    #[test]
    fn preserves_legitimate_speech_starting_with_loop_word_after_mid_loop() {
        let input = "we need to go to go to go to go to the store";
        assert_eq!(collapse_ngram_loops(input), "we need to go to the store");
    }
}
