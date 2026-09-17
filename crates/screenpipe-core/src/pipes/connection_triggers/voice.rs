// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Spoken phrase detection over newly persisted transcripts. No model calls,
//! recorder changes, or capture-thread work. Reuses the watcher's durable cursor
//! and completion/retry protocol; detection runs on its 30-second poll.

use super::{DetectedItem, SourceCtx, SourceTrigger};

fn words(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_lowercase)
        .collect()
}

fn phrases(src: &SourceTrigger) -> Vec<Vec<String>> {
    src.filter
        .get("phrases")
        .into_iter()
        .flat_map(|value| value.lines())
        .map(words)
        .filter(|phrase| !phrase.is_empty())
        .collect()
}

pub(super) fn matching_items(src: &SourceTrigger, items: Vec<DetectedItem>) -> Vec<DetectedItem> {
    let phrases = phrases(src);
    items
        .into_iter()
        .filter(|item| {
            let text = words(&item.preview);
            phrases
                .iter()
                .any(|phrase| text.windows(phrase.len()).any(|window| window == phrase))
        })
        .collect()
}

pub(super) async fn fetch(
    ctx: &SourceCtx<'_>,
    src: &SourceTrigger,
    since: &str,
) -> Option<Vec<DetectedItem>> {
    if phrases(src).is_empty() {
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
        format!("SELECT id, timestamp, transcription, is_input_device FROM audio_transcriptions WHERE id > {after} ORDER BY id ASC LIMIT 50")
    };
    let response = ctx
        .post_json(
            &format!("{}/raw_sql", ctx.api_base),
            serde_json::json!({"query": query}),
        )
        .await?;
    let rows = response.as_array()?;
    let mut items = Vec::with_capacity(rows.len());
    for row in rows {
        let id = row.get("id")?.as_i64()?.to_string();
        let timestamp = row.get("timestamp").and_then(|v| v.as_str()).unwrap_or("");
        let is_input = row
            .get("is_input_device")
            .is_some_and(|v| v.as_bool() == Some(true) || v.as_i64() == Some(1));
        let include_audio = is_input || src.filter.get("device").map(String::as_str) == Some("all");
        items.push(DetectedItem {
            id: id.clone(),
            title: timestamp.to_string(),
            preview: if include_audio {
                row.get("transcription")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string()
            } else {
                String::new()
            },
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
        assert!(rows[1].preview.is_empty());
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
        assert_eq!(queries[0], "SELECT id, timestamp, transcription, is_input_device FROM audio_transcriptions WHERE id > 100 ORDER BY id ASC LIMIT 50");
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
        process_subscriber(
            dir.path(),
            &mut state,
            pipe,
            &src,
            &key,
            &[item(90, "start job old")],
        );
        assert!(state.pending.is_empty());
        process_subscriber(
            dir.path(),
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
        process_subscriber(dir.path(), &mut state, pipe, &src, &key, &raw);
        assert_eq!(state.pending[&key].token, "93");
        assert_eq!(state.committed[&key].token, "91");
        let context: serde_json::Value = serde_json::from_slice(
            &std::fs::read(dir.path().join(pipe).join(".trigger-context.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(context["items"].as_array().unwrap().len(), 1);
        assert_eq!(
            context["items"][0]["preview"],
            "start job four, client Acme"
        );
        assert!(!apply_completion(&mut state, pipe, false));
        process_subscriber(dir.path(), &mut state, pipe, &src, &key, &raw);
        assert_eq!(state.pending[&key].attempts, 1);
        assert!(apply_completion(&mut state, pipe, true));
        state.save(dir.path());
        let mut reloaded = WatcherState::load(dir.path());
        process_subscriber(dir.path(), &mut reloaded, pipe, &src, &key, &raw);
        assert!(reloaded.pending.is_empty());
        assert_eq!(reloaded.committed[&key].token, "93");
    }
}
