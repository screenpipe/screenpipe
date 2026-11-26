// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Record batching and cursor math shared by account and workspace uploads.

/// Split JSONL into request-sized chunks on record boundaries. Concatenating the
/// returned chunks always reproduces `body` byte-for-byte; no record is
/// truncated or discarded. A single record larger than the target is returned
/// in its own chunk so the caller can apply its destination’s upload policy.
pub fn split_jsonl_requests(body: Vec<u8>, target_bytes: usize) -> Vec<Vec<u8>> {
    if body.is_empty() {
        return Vec::new();
    }
    if target_bytes == 0 || body.len() <= target_bytes {
        return vec![body];
    }

    let mut chunks = Vec::new();
    let mut current = Vec::with_capacity(target_bytes);
    for line in body.split_inclusive(|byte| *byte == b'\n') {
        if !current.is_empty() && current.len() + line.len() > target_bytes {
            chunks.push(std::mem::replace(
                &mut current,
                Vec::with_capacity(target_bytes),
            ));
        }
        current.extend_from_slice(line);
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

/// Advance a timestamp-ordered stream after its rows are acknowledged. The
/// offset tracks rows consumed at the final timestamp across page boundaries.
pub fn advance_timestamp_boundary<T>(
    cursor_ts: &mut Option<String>,
    boundary_offset: &mut u32,
    rows: &[T],
    timestamp: impl Fn(&T) -> &str,
) {
    let Some(last) = rows.last() else {
        return;
    };
    let latest_ts = timestamp(last);
    let rows_at_latest = rows
        .iter()
        .rev()
        .take_while(|row| timestamp(row) == latest_ts)
        .count() as u32;

    if cursor_ts.as_deref() == Some(latest_ts) {
        *boundary_offset = boundary_offset.saturating_add(rows_at_latest);
    } else {
        *cursor_ts = Some(latest_ts.to_string());
        *boundary_offset = rows_at_latest;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_chunks_keep_every_byte_and_leave_oversized_records_intact() {
        let body = b"aaa\nbb\nlong-record\nx".to_vec();
        let chunks = split_jsonl_requests(body.clone(), 7);

        assert_eq!(
            chunks,
            vec![
                b"aaa\nbb\n".to_vec(),
                b"long-record\n".to_vec(),
                b"x".to_vec()
            ]
        );
        assert_eq!(chunks.concat(), body);
        assert_eq!(split_jsonl_requests(body.clone(), 0), vec![body]);
        assert!(split_jsonl_requests(Vec::new(), 7).is_empty());
    }

    #[test]
    fn checkpoint_counts_equal_timestamps_across_pages_and_resets_on_new_time() {
        let mut timestamp = None;
        let mut offset = 0;

        advance_timestamp_boundary(&mut timestamp, &mut offset, &["a", "b", "b"], |row| row);
        assert_eq!((timestamp.as_deref(), offset), (Some("b"), 2));

        advance_timestamp_boundary(&mut timestamp, &mut offset, &["b", "b"], |row| row);
        assert_eq!((timestamp.as_deref(), offset), (Some("b"), 4));

        advance_timestamp_boundary(&mut timestamp, &mut offset, &[] as &[&str], |row| row);
        assert_eq!((timestamp.as_deref(), offset), (Some("b"), 4));

        advance_timestamp_boundary(&mut timestamp, &mut offset, &["b", "c"], |row| row);
        assert_eq!((timestamp.as_deref(), offset), (Some("c"), 1));
    }
}
