// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Spoken phrase detection over newly persisted transcripts. No model calls,
//! recorder changes, or capture-thread work. Reuses the watcher's durable cursor
//! and completion/retry protocol; detection runs on its 30-second poll.

use super::{DetectedItem, SourceCtx, SourceTrigger};

pub(super) const MAX_PHRASES: usize = 32;
pub(super) const MAX_PHRASE_CHARS: usize = 256;
/// SQL bounds returned text as well as rows. No scan/match on the capture thread.
const MAX_TRANSCRIPT_CHARS: usize = 16_384;
/// Bound event-bus payloads too; remaining rows stay behind the cursor.
const MAX_BATCH_BYTES: usize = 64 * 1024;

pub(super) fn valid_source(src: &SourceTrigger) -> bool {
    if src.kind != "phrase" && !src.kind.is_empty() {
        return false;
    }
    if !matches!(
        src.filter.get("device").map(String::as_str),
        None | Some("input" | "all")
    ) {
        return false;
    }
    let Some(value) = src.filter.get("phrases") else {
        return false;
    };
    if value.len() > MAX_PHRASES * MAX_PHRASE_CHARS * 4 {
        return false;
    }
    let lines: Vec<_> = value
        .lines()
        .filter(|p| !p.trim().is_empty())
        .take(MAX_PHRASES + 1)
        .collect();
    !lines.is_empty()
        && lines.len() <= MAX_PHRASES
        && lines
            .iter()
            .all(|p| p.chars().count() <= MAX_PHRASE_CHARS && p.chars().any(char::is_alphanumeric))
}

fn words(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_lowercase)
        .collect()
}

fn phrases(src: &SourceTrigger) -> Vec<String> {
    src.filter
        .get("phrases")
        .into_iter()
        .flat_map(|value| value.lines())
        .map(words)
        .filter(|phrase| !phrase.is_empty())
        .map(|phrase| format!(" {} ", phrase.join(" ")))
        .collect()
}

pub(super) fn matching_items(src: &SourceTrigger, items: Vec<DetectedItem>) -> Vec<DetectedItem> {
    if !valid_source(src) {
        return Vec::new();
    }
    let phrases = phrases(src);
    let all_audio = src.filter.get("device").map(String::as_str) == Some("all");
    items
        .into_iter()
        .filter(|item| {
            if !all_audio && item.is_input != Some(true) {
                return false;
            }
            // Boundary padding preserves whole-word matching. str::contains
            // uses Rust's substring search instead of quadratic token windows
            // on repeated-word transcripts and long overlapping phrases.
            let text = format!(" {} ", words(&item.preview).join(" "));
            phrases.iter().any(|phrase| text.contains(phrase.as_str()))
        })
        .collect()
}

/// Never turn a truncated final word (e.g. "jobber") into a matching "job".
fn bounded_preview(text: &str) -> String {
    let mut chars = text.chars();
    let mut preview: String = chars.by_ref().take(MAX_TRANSCRIPT_CHARS).collect();
    if chars.next().is_some_and(char::is_alphanumeric)
        && preview
            .chars()
            .next_back()
            .is_some_and(char::is_alphanumeric)
    {
        let end = preview.rfind(|c: char| !c.is_alphanumeric()).unwrap_or(0);
        preview.truncate(end);
    }
    preview
}

pub(super) async fn fetch(
    ctx: &SourceCtx<'_>,
    src: &SourceTrigger,
    since: &str,
) -> Option<Vec<DetectedItem>> {
    if !valid_source(src) {
        return None;
    }
    // Only fixed SQL and parsed integers are interpolated. User phrases are
    // matched in Rust, never interpreted as SQL, regex, or instructions.
    let query = if since.is_empty() {
        "SELECT COALESCE(MAX(id), 0) AS id FROM audio_transcriptions".to_string()
    } else {
        let after = since.parse::<i64>().ok()?.max(0);
        // Scan both devices by insertion id so system-only activity still
        // advances a microphone subscription rather than rescanning forever.
        let read_chars = MAX_TRANSCRIPT_CHARS + 1;
        format!("SELECT id, timestamp, substr(transcription, 1, {read_chars}) AS transcription, is_input_device FROM audio_transcriptions WHERE id > {after} ORDER BY id ASC LIMIT 50")
    };
    // Bound the source's latency independently of remote connection proxies.
    let response = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        ctx.post_json(
            &format!("{}/raw_sql", ctx.api_base),
            serde_json::json!({"query": query}),
        ),
    )
    .await
    .ok()??;
    let rows = response.as_array()?;
    let mut items = Vec::with_capacity(rows.len());
    let mut bytes = 0;
    for row in rows {
        let id = row.get("id")?.as_i64()?.to_string();
        let timestamp = row.get("timestamp").and_then(|v| v.as_str()).unwrap_or("");
        let is_input = row
            .get("is_input_device")
            .is_some_and(|v| v.as_bool() == Some(true) || v.as_i64() == Some(1));
        let preview = bounded_preview(
            row.get("transcription")
                .and_then(|v| v.as_str())
                .unwrap_or(""),
        );
        if bytes + preview.len() > MAX_BATCH_BYTES && !items.is_empty() {
            break;
        }
        bytes += preview.len();
        items.push(DetectedItem {
            id: id.clone(),
            title: timestamp.to_string(),
            is_input: Some(is_input),
            preview,
            ts: id,
        });
    }
    Some(items)
}

#[cfg(test)]
mod tests {
    use super::super::{decide, token_cmp, CursorState, Decision};
    use super::*;

    fn source(phrases: &str) -> SourceTrigger {
        serde_json::from_value(serde_json::json!({
            "app": "audio", "kind": "phrase", "filter": {"phrases": phrases}
        }))
        .unwrap()
    }
    fn item(id: i64, text: &str) -> DetectedItem {
        DetectedItem {
            is_input: Some(true),
            id: id.to_string(),
            ts: id.to_string(),
            title: "2026-09-17T00:15:00Z".into(),
            preview: text.into(),
        }
    }

    #[test]
    fn voice_matches_case_punctuation_and_job_details_once() {
        let matched = matching_items(
            &source("start job\nstop job"),
            vec![
                item(
                    1,
                    "START, job number four, client Acme. Then stop job four.",
                ),
                item(2, "restart job four"),
                item(3, "start a different job"),
                item(4, "Stop job four."),
            ],
        );
        assert_eq!(
            matched.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(),
            vec!["1", "4"]
        );
        assert!(matched[0].preview.contains("client Acme"));
        assert_eq!(matched[0].title, "2026-09-17T00:15:00Z");
    }

    #[test]
    fn voice_empty_or_punctuation_only_phrases_never_match() {
        for phrase in ["", "  ", "!!!\n..."] {
            assert!(matching_items(&source(phrase), vec![item(1, "anything")]).is_empty());
        }
    }

    #[test]
    fn voice_unicode_and_literal_metacharacters() {
        assert_eq!(
            matching_items(
                &source("DÉMARRER tâche"),
                vec![item(1, "démarrer TÂCHE quatre")]
            )
            .len(),
            1
        );
        assert!(matching_items(
            &source("start .* job"),
            vec![item(1, "start unrelated job")]
        )
        .is_empty());
    }

    #[test]
    fn voice_baselines_without_replay_and_commits_nonmatches() {
        assert!(
            matches!(decide("audio", None, None, &[item(90, "start job")], ""), Decision::Init(t) if t == "90")
        );
        let cursor = CursorState {
            initialized: true,
            token: "90".into(),
        };
        let raw = vec![
            item(90, "start job"),
            item(91, "ordinary conversation"),
            item(92, "start job four"),
            item(93, "ordinary conversation"),
        ];
        let Decision::Emit { items, token, .. } = decide("audio", Some(&cursor), None, &raw, "")
        else {
            panic!("new rows must be scanned")
        };
        assert_eq!(token, "93");
        assert_eq!(matching_items(&source("start job"), items).len(), 1);
        let committed = CursorState {
            initialized: true,
            token,
        };
        assert!(matches!(
            decide("audio", Some(&committed), None, &raw, ""),
            Decision::Skip
        ));
        assert_eq!(
            token_cmp("audio", "9007199254740993", "9007199254740992"),
            std::cmp::Ordering::Greater
        );
    }
    #[tokio::test]
    async fn voice_fetch_is_authenticated_bounded_and_microphone_only() {
        use wiremock::matchers::{header, method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        Mock::given(method("POST")).and(path("/raw_sql"))
            .and(header("authorization", "Bearer test-local-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
                {"id": 102, "timestamp": "2026-09-17T00:15:00Z", "transcription": "start job four, client Acme", "is_input_device": 1},
                {"id": 103, "timestamp": "2026-09-17T00:15:01Z", "transcription": "stop job four", "is_input_device": 0}
            ]))).mount(&server).await;
        let client = reqwest::Client::new();
        let ctx = SourceCtx {
            http: &client,
            api_base: &server.uri(),
            api_key: Some("test-local-key"),
        };
        let mut src = source("start job'); DROP TABLE audio_transcriptions; --");
        let rows = fetch(&ctx, &src, "100").await.unwrap();
        assert_eq!(rows[0].preview, "start job four, client Acme");
        assert_eq!(rows[0].id, "102");
        assert_eq!(rows[1].is_input, Some(false));
        assert!(matching_items(&source("stop job"), rows.clone()).is_empty());
        assert_eq!(rows[1].ts, "103");
        src.filter.insert("device".into(), "all".into());
        assert_eq!(
            fetch(&ctx, &src, "100").await.unwrap()[1].preview,
            "stop job four"
        );
        fetch(&ctx, &src, "").await.unwrap();
        assert!(fetch(&ctx, &src, "0; DROP TABLE audio_transcriptions")
            .await
            .is_none());
        let reqs = server.received_requests().await.unwrap();
        assert_eq!(reqs.len(), 3);
        let queries: Vec<String> = reqs
            .iter()
            .map(|r| {
                serde_json::from_slice::<serde_json::Value>(&r.body).unwrap()["query"]
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect();
        assert_eq!(queries[0], "SELECT id, timestamp, substr(transcription, 1, 16385) AS transcription, is_input_device FROM audio_transcriptions WHERE id > 100 ORDER BY id ASC LIMIT 50");
        assert_eq!(queries[0], queries[1]);
        assert_eq!(
            queries[2],
            "SELECT COALESCE(MAX(id), 0) AS id FROM audio_transcriptions"
        );
    }

    #[tokio::test]
    async fn voice_subscriber_skips_idle_audio_retries_and_survives_restart() {
        use super::super::{apply_completion, process_subscriber, subscription_key, WatcherState};
        let dir = tempfile::tempdir().unwrap();
        let pipe = "job-notes";
        std::fs::create_dir(dir.path().join(pipe)).unwrap();
        let src = source("start job\nstop job");
        let key = subscription_key(pipe, &src);
        let mut state = WatcherState::default();
        process_subscriber(&mut state, pipe, &src, &key, &[item(90, "start job old")]);
        assert!(state.pending.is_empty());
        process_subscriber(
            &mut state,
            pipe,
            &src,
            &key,
            &[item(91, "ordinary conversation")],
        );
        assert_eq!(state.committed[&key].token, "91");
        assert!(!dir.path().join(pipe).join(".trigger-context.json").exists());
        let raw = vec![
            item(92, "start job four, client Acme"),
            item(93, "nothing to run"),
        ];
        process_subscriber(&mut state, pipe, &src, &key, &raw);
        assert_eq!(state.pending[&key].token, "93");
        assert_eq!(state.committed[&key].token, "91");
        let context = super::super::trigger_context(&src, &matching_items(&src, raw.clone()));
        let delivery_id = state.pending[&key].delivery_id.clone();
        assert!(!apply_completion(&mut state, pipe, true, None));
        assert!(!apply_completion(
            &mut state,
            pipe,
            true,
            Some("unrelated-run")
        ));
        assert_eq!(context["items"].as_array().unwrap().len(), 1);
        assert_eq!(
            context["items"][0]["preview"],
            "start job four, client Acme"
        );
        assert!(!apply_completion(
            &mut state,
            pipe,
            false,
            Some(&delivery_id)
        ));
        process_subscriber(&mut state, pipe, &src, &key, &raw);
        assert_eq!(state.pending[&key].attempts, 1);
        assert!(apply_completion(&mut state, pipe, true, Some(&delivery_id)));
        state.save(dir.path());
        let mut reloaded = WatcherState::load(dir.path());
        process_subscriber(&mut reloaded, pipe, &src, &key, &raw);
        assert!(reloaded.pending.is_empty());
        assert_eq!(reloaded.committed[&key].token, "93");
    }
    #[test]
    fn voice_truncation_cannot_create_a_false_word_match() {
        let prefix = " ".repeat(MAX_TRANSCRIPT_CHARS - "start job".len());
        assert!(matching_items(
            &source("start job"),
            vec![item(1, &bounded_preview(&format!("{prefix}start jobber")))]
        )
        .is_empty());
        assert_eq!(
            matching_items(
                &source("start job"),
                vec![item(
                    1,
                    &bounded_preview(&format!("{prefix}start job, more"))
                )]
            )
            .len(),
            1
        );
        assert_eq!(bounded_preview("start job"), "start job");
    }

    #[test]
    fn voice_rejects_invalid_or_unbounded_configuration() {
        for value in ["x".repeat(257), vec!["start"; 33].join("\n")] {
            assert!(!valid_source(&source(&value)));
        }
        let mut src = source("start job");
        src.filter.insert("device".into(), "output-typo".into());
        assert!(!valid_source(&src));
        assert!(valid_source(&source(&vec!["é".repeat(256); 32].join("\n"))));
        // A phrase cannot cross segment boundaries or match part of a word.
        assert!(matching_items(
            &source("start job"),
            vec![item(1, "start"), item(2, "job"), item(3, "restart job")]
        )
        .is_empty());
    }

    #[tokio::test]
    async fn voice_poll_shares_reads_and_retries_an_immutable_snapshot() {
        use super::super::{poll_once, subscription_key, WatcherState};
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/raw_sql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
                {"id": 11, "transcription": "start job Acme", "is_input_device": 1},
                {"id": 12, "transcription": "stop job Acme", "is_input_device": 0}
            ])))
            .mount(&server)
            .await;
        let mic = source("start job");
        let mut all = source("stop job");
        all.filter.insert("device".into(), "all".into());
        let pipes = vec![(
            "jobs".into(),
            serde_json::from_value(serde_json::json!({
                "schedule": "manual", "enabled": true, "trigger": {"sources": [mic, all]}
            }))
            .unwrap(),
        )];
        let mut state = WatcherState::default();
        let mic_key = subscription_key("jobs", &mic);
        let all_key = subscription_key("jobs", &all);
        for key in [&mic_key, &all_key] {
            state.committed.insert(
                key.clone(),
                CursorState {
                    token: "10".into(),
                    initialized: true,
                },
            );
        }
        let client = reqwest::Client::new();
        let api_base = server.uri();
        let ctx = SourceCtx {
            http: &client,
            api_base: &api_base,
            api_key: None,
        };
        let dir = tempfile::tempdir().unwrap();
        poll_once(dir.path(), &pipes, &mut state, &ctx, &[]).await;
        assert_eq!(server.received_requests().await.unwrap().len(), 1);
        assert_eq!(state.pending.len(), 2);
        assert_eq!(state.pending[&mic_key].context["items"][0]["id"], "11");
        assert_eq!(state.pending[&all_key].context["items"][0]["id"], "12");
        let original = state.pending[&mic_key].clone();
        poll_once(dir.path(), &pipes, &mut state, &ctx, &[]).await;
        assert_eq!(
            server.received_requests().await.unwrap().len(),
            1,
            "no reads while pending"
        );
        poll_once(
            dir.path(),
            &pipes,
            &mut state,
            &ctx,
            &[("jobs".into(), false, Some(original.delivery_id.clone()))],
        )
        .await;
        assert_eq!(
            server.received_requests().await.unwrap().len(),
            1,
            "retries reuse their snapshot"
        );
        assert_eq!(state.pending[&mic_key].context, original.context);
        assert_eq!(state.pending[&mic_key].delivery_id, original.delivery_id);
        assert_eq!(state.pending[&mic_key].attempts, 1);
        assert_eq!(state.pending[&all_key].attempts, 0);
        assert!(super::super::apply_completion(
            &mut state,
            "jobs",
            true,
            Some(&original.delivery_id)
        ));
        assert!(
            state.pending.contains_key(&all_key),
            "one completion cannot acknowledge another source"
        );
        assert_eq!(state.committed[&all_key].token, "10");
    }

    #[tokio::test]
    async fn voice_batch_budget_leaves_excess_rows_for_next_poll() {
        use wiremock::matchers::method;
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        let rows: Vec<_> = (1..=6).map(|id| serde_json::json!({"id": id, "transcription": "x".repeat(MAX_TRANSCRIPT_CHARS), "is_input_device": 1})).collect();
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_body_json(rows))
            .mount(&server)
            .await;
        let client = reqwest::Client::new();
        let api_base = server.uri();
        let ctx = SourceCtx {
            http: &client,
            api_base: &api_base,
            api_key: None,
        };
        let batch = fetch(&ctx, &source("start job"), "0").await.unwrap();
        assert_eq!(batch.len(), 4);
        assert_eq!(batch.last().unwrap().ts, "4");
        assert_eq!(
            batch.iter().map(|item| item.preview.len()).sum::<usize>(),
            MAX_BATCH_BYTES
        );
    }

    #[tokio::test]
    async fn voice_invalid_disabled_and_timed_out_sources_do_not_advance() {
        use super::super::{poll_once, subscription_key, WatcherState};
        use wiremock::matchers::method;
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_delay(std::time::Duration::from_secs(3))
                    .set_body_json(serde_json::json!([{"id": 99}])),
            )
            .mount(&server)
            .await;
        let client = reqwest::Client::new();
        let api_base = server.uri();
        let ctx = SourceCtx {
            http: &client,
            api_base: &api_base,
            api_key: None,
        };
        let dir = tempfile::tempdir().unwrap();
        let mut state = WatcherState::default();
        let config = |enabled, src: &SourceTrigger| {
            serde_json::from_value(serde_json::json!({"schedule": "manual", "enabled": enabled, "trigger": {"sources": [src]}})).unwrap()
        };
        let src = source("start job");
        poll_once(
            dir.path(),
            &[
                ("jobs".into(), config(false, &src)),
                ("invalid".into(), config(true, &source("!!!"))),
            ],
            &mut state,
            &ctx,
            &[],
        )
        .await;
        assert!(server.received_requests().await.unwrap().is_empty());
        let key = subscription_key("jobs", &src);
        state.committed.insert(
            key.clone(),
            CursorState {
                token: "10".into(),
                initialized: true,
            },
        );
        poll_once(
            dir.path(),
            &[("jobs".into(), config(true, &src))],
            &mut state,
            &ctx,
            &[],
        )
        .await;
        assert_eq!(state.committed[&key].token, "10");
        assert!(state.pending.is_empty());
    }

    #[tokio::test]
    async fn voice_new_subscription_baselines_and_read_failure_preserves_cursor() {
        use super::super::{poll_once, subscription_key, WatcherState};
        use wiremock::matchers::{body_json, method};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_body_json(
                serde_json::json!([{"id": 11, "transcription": "start job", "is_input_device": 1}]),
            ))
            .with_priority(2)
            .mount(&server)
            .await;
        Mock::given(body_json(serde_json::json!({"query": "SELECT COALESCE(MAX(id), 0) AS id FROM audio_transcriptions"})))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([{"id": 1000}]))).with_priority(1).mount(&server).await;
        let old = source("ordinary phrase");
        let new = source("start job");
        let pipes = vec![(
            "jobs".into(),
            serde_json::from_value(serde_json::json!({
                "schedule": "manual", "trigger": {"sources": [old, new]}
            }))
            .unwrap(),
        )];
        let mut state = WatcherState::default();
        let old_key = subscription_key("jobs", &old);
        let new_key = subscription_key("jobs", &new);
        state.committed.insert(
            old_key.clone(),
            CursorState {
                token: "10".into(),
                initialized: true,
            },
        );
        let client = reqwest::Client::new();
        let api_base = server.uri();
        let ctx = SourceCtx {
            http: &client,
            api_base: &api_base,
            api_key: None,
        };
        let dir = tempfile::tempdir().unwrap();
        poll_once(dir.path(), &pipes, &mut state, &ctx, &[]).await;
        assert_eq!(
            state.committed[&new_key].token, "1000",
            "new source must not replay the old subscriber's backlog"
        );
        assert_eq!(state.committed[&old_key].token, "11");
        assert!(state.pending.is_empty());
        assert_eq!(server.received_requests().await.unwrap().len(), 2);
        server.reset().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&server)
            .await;
        poll_once(dir.path(), &pipes, &mut state, &ctx, &[]).await;
        assert_eq!(state.committed[&old_key].token, "11");
        assert_eq!(state.committed[&new_key].token, "1000");
    }
}
