// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use async_trait::async_trait;
use screenpipe_core::pii_removal::{
    remove_pii_with_evidence, remove_pii_with_renderer, PiiPseudonymizer,
};
use screenpipe_db::{
    privacy_release::ReleasePolicy, CaptureField, CaptureRedactions, DatabaseManager,
    FieldRedactions, RedactionMethod, RedactionResult,
};
use screenpipe_redact::{
    Pipeline, PipelineConfig, Pseudonymizer, RedactError, RedactionOutput, Redactor,
    TextRedactionPolicy,
};
use std::{collections::BTreeMap, sync::Arc};

fn tokens(text: &str) -> Vec<String> {
    regex::Regex::new(r"\[[A-Z_]+_[0-9a-f]{12}\]")
        .unwrap()
        .find_iter(text)
        .map(|m| m.as_str().to_owned())
        .collect()
}

#[tokio::test]
async fn team_identifiers_and_passwords_survive_every_processing_pass() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("team.key");
    std::fs::write(&path, [17u8; 32]).unwrap();
    let a = Arc::new(Pseudonymizer::from_shared_key_file(&path).unwrap());
    let b = Arc::new(Pseudonymizer::from_shared_key_file(&path).unwrap());
    let renderer = PiiPseudonymizer(Box::new(move |kind, value| a.inline_token(kind, value)));
    let pipeline = Pipeline::regex_only_with_policy(TextRedactionPolicy::from_labels(&[
        "url".into(),
        "secret".into(),
        "id".into(),
        "email".into(),
        "phone".into(),
    ]))
    .with_pseudonyms(Some(b));
    for source in [
        "192.168.1.100",
        "password: AbC123",
        "password=AbC123",
        "password=\"AbC123\"",
        "alice@example.com",
        "+1-415-555-1234",
        "4111-1111-1111-1111",
        "123-45-6789",
    ] {
        let inline = remove_pii_with_renderer(source, Some(&renderer));
        let background = pipeline.redact(source).await.unwrap().redacted;
        assert!(!tokens(&inline).is_empty(), "{source}");
        assert_eq!(tokens(&inline), tokens(&background), "{source}");
        assert_eq!(remove_pii_with_renderer(&inline, Some(&renderer)), inline);
        assert_eq!(pipeline.redact(&inline).await.unwrap().redacted, inline);
        assert_eq!(remove_pii_with_renderer(&inline, None), inline);
        let neighbour = format!("{inline} password: freshSecret");
        let clean = pipeline.redact(&neighbour).await.unwrap().redacted;
        assert!(clean.contains(&tokens(&inline)[0]));
        assert!(!clean.contains("freshSecret"));
    }
    for source in [
        "password: [SECRET_abcdefabcdef]raw",
        "password: [SECRET_abcdefabcdeg]",
        "DATABASE_PASSWORD=AbC123xyz",
    ] {
        let clean = remove_pii_with_renderer(source, Some(&renderer));
        assert_ne!(clean, source);
        assert_eq!(remove_pii_with_renderer(&clean, Some(&renderer)), clean);
    }
}

struct Model(bool);
#[async_trait]
impl Redactor for Model {
    fn name(&self) -> &str {
        "acceptance-model"
    }
    fn version(&self) -> u32 {
        1
    }
    fn provides_model_detection(&self) -> bool {
        true
    }
    async fn redact_batch(&self, texts: &[String]) -> Result<Vec<RedactionOutput>, RedactError> {
        if self.0 {
            return Err(RedactError::Unavailable(
                "private remote response must not enter evidence".into(),
            ));
        }
        Ok(texts
            .iter()
            .map(|text| RedactionOutput {
                evidence: None,
                input: text.clone(),
                redacted: text.replace("private", "[PERSON]"),
                spans: vec![],
            })
            .collect())
    }
}

#[tokio::test]
async fn audit_reports_observed_paths_and_does_not_copy_detector_bodies() {
    let (clean, inline) = remove_pii_with_evidence("alice@example.com");
    assert_eq!(inline.method, RedactionMethod::InlineRegex);
    assert_eq!(inline.result, RedactionResult::Replaced);
    assert!(!serde_json::to_string(&inline)
        .unwrap()
        .contains("alice@example.com"));
    assert_eq!(
        remove_pii_with_evidence("ordinary text").1.result,
        RedactionResult::NoMatch
    );
    let regex = Pipeline::regex_only()
        .redact("ordinary text")
        .await
        .unwrap();
    assert_eq!(regex.evidence.unwrap().method, RedactionMethod::AsyncRegex);
    let config = PipelineConfig {
        ai_min_chars: 0,
        ..Default::default()
    };
    let model = Pipeline::regex_then_ai(Arc::new(Model(false)), config.clone());
    let success = model.redact("private").await.unwrap();
    assert_eq!(
        success.evidence.as_ref().unwrap().method,
        RedactionMethod::AsyncModel
    );
    assert_eq!(success.evidence.unwrap().result, RedactionResult::Replaced);
    let failure = Pipeline::regex_then_ai(Arc::new(Model(true)), config)
        .redact("private")
        .await
        .unwrap();
    let evidence = failure.evidence.unwrap();
    assert_eq!(evidence.method, RedactionMethod::AsyncRegexFallback);
    assert!(!evidence.complete);
    let startup = Pipeline::regex_fallback_with_policy(
        TextRedactionPolicy::default(),
        "local model unavailable",
    )
    .redact("ordinary text")
    .await
    .unwrap();
    assert_eq!(
        startup.evidence.as_ref().unwrap().method,
        RedactionMethod::AsyncRegexFallback
    );
    assert!(!startup.evidence.unwrap().complete);
    assert!(!serde_json::to_string(&evidence)
        .unwrap()
        .contains("private remote"));
    assert_eq!(failure.redacted, "private");
    assert_eq!(clean, "[EMAIL]");
}

async fn database(path: &std::path::Path) -> Arc<DatabaseManager> {
    let db = Arc::new(
        DatabaseManager::new(path.to_str().unwrap(), Default::default())
            .await
            .unwrap(),
    );
    db.configure_release(&ReleasePolicy {
        identity: "acceptance:v1".into(),
        text: false,
        images: false,
    })
    .await
    .unwrap();
    db
}

#[tokio::test]
async fn evidence_is_durable_invalidates_on_edits_and_filters_before_pagination() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("db.sqlite");
    let db = database(&path).await;
    let (text, step) = remove_pii_with_evidence("alice@example.com");
    let mut evidence = CaptureRedactions::new();
    evidence.insert(CaptureField::FullText, step.clone());
    evidence.insert(CaptureField::AccessibilityText, step);
    let id = db
        .insert_snapshot_frame_with_redaction(
            "display",
            chrono::Utc::now(),
            "",
            None,
            None,
            None,
            None,
            true,
            None,
            Some(&text),
            Some("accessibility"),
            None,
            None,
            None,
            None,
            None,
            evidence,
        )
        .await
        .unwrap();
    let pending = db
        .insert_snapshot_frame_with_ocr(
            "display",
            chrono::Utc::now(),
            "",
            None,
            None,
            None,
            None,
            true,
            None,
            Some("raw@example.com"),
            Some("accessibility"),
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
    let status = db.frame_redaction_status(id).await.unwrap();
    assert_eq!(status["fields"]["full_text"]["method"], "inline_regex");
    assert_eq!(status["fully_redacted"], true);
    assert_eq!(
        db.frame_redaction_status(pending).await.unwrap()["fields"]["full_text"]["processed"],
        false
    );
    let filtered = db.fully_redacted_reads().await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM frames")
            .fetch_one(&filtered.pool)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT id FROM frames ORDER BY id LIMIT 1 OFFSET 0")
            .fetch_one(&filtered.pool)
            .await
            .unwrap(),
        id
    );
    // A newer degraded attempt must override older successful inline evidence,
    // including when both operations have the same second-resolution timestamp.
    let stored = BTreeMap::from([("full_text".into(), Some(text.clone()))]);
    let mut fallback =
        screenpipe_db::RedactionEvidence::new(RedactionMethod::AsyncRegexFallback, false, false);
    fallback.complete = false;
    assert!(db
        .apply_field_redactions(
            "frames",
            id,
            &stored,
            &stored,
            &FieldRedactions::from([("full_text".into(), fallback)]),
            "acceptance:v1"
        )
        .await
        .unwrap());
    assert_eq!(
        db.frame_redaction_status(id).await.unwrap()["fully_redacted"],
        false
    );
    let mut recovered =
        screenpipe_db::RedactionEvidence::new(RedactionMethod::AsyncModel, false, false);
    // Reused detector output must not make a newly processed row appear to
    // have been redacted before it was captured.
    recovered.processed_at = 1;
    let applied_after = chrono::Utc::now().timestamp();
    assert!(db
        .apply_field_redactions(
            "frames",
            id,
            &stored,
            &stored,
            &FieldRedactions::from([("full_text".into(), recovered)]),
            "acceptance:v1"
        )
        .await
        .unwrap());
    assert_eq!(
        db.frame_redaction_status(id).await.unwrap()["fully_redacted"],
        true
    );
    assert!(
        db.frame_redaction_status(id).await.unwrap()["fields"]["full_text"]["processed_at"]
            .as_i64()
            .unwrap()
            >= applied_after
    );
    db.execute_raw_sql_write(&format!(
        "UPDATE frames SET full_text='edited raw' WHERE id={id}"
    ))
    .await
    .unwrap();
    assert_eq!(
        db.frame_redaction_status(id).await.unwrap()["fully_redacted"],
        false
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM frames")
            .fetch_one(&filtered.pool)
            .await
            .unwrap(),
        0
    );
    let original = BTreeMap::from([("full_text".into(), Some(text))]);
    let values = BTreeMap::from([("full_text".into(), Some("stale output".into()))]);
    assert!(!db
        .apply_field_redactions(
            "frames",
            id,
            &original,
            &values,
            &FieldRedactions::new(),
            "acceptance:v1"
        )
        .await
        .unwrap());
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT full_text FROM frames WHERE id=?")
            .bind(id)
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        "edited raw"
    );
    drop(filtered);
    db.close().await;
    drop(db);
    let reopened = database(&path).await;
    let status = reopened.frame_redaction_status(id).await.unwrap();
    assert_eq!(
        status["fields"]["accessibility_text"]["method"],
        "inline_regex"
    );
    assert_eq!(status["fields"]["full_text"]["processed"], false);
    assert_eq!(status["fully_redacted"], false);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM frames")
            .fetch_one(&reopened.pool)
            .await
            .unwrap(),
        2
    );
    reopened.close().await;
}

#[tokio::test]
async fn audio_bookkeeping_receipts_never_certify_unprocessed_transcripts() {
    let root = tempfile::tempdir().unwrap();
    let db = database(&root.path().join("db.sqlite")).await;
    db.configure_release(&ReleasePolicy {
        identity: "acceptance:v1".into(),
        text: true,
        images: false,
    })
    .await
    .unwrap();
    db.execute_raw_sql_write("INSERT INTO audio_chunks(id,file_path) VALUES(1,'fixture.wav'); INSERT INTO audio_transcriptions(id,audio_chunk_id,offset_index,timestamp,transcription,device) VALUES(1,1,0,'2026-10-28','raw@example.com','fixture')").await.unwrap();
    let job = db.release_pending("audio", 10).await.unwrap().remove(0);
    assert!(db.publish_release(&job, &job.values).await.unwrap());
    assert_eq!(
        db.record_redaction_status("audio", 1).await.unwrap()["fully_redacted"],
        false
    );
    let filtered = db.fully_redacted_reads().await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM audio_transcriptions")
            .fetch_one(&filtered.pool)
            .await
            .unwrap(),
        0
    );
    let chunk = db.insert_audio_chunk("inline.wav", None).await.unwrap();
    let (clean, evidence) = remove_pii_with_evidence("inline@example.com");
    db.insert_audio_transcription_with_redaction(
        chunk,
        &clean,
        0,
        "fixture",
        &screenpipe_db::AudioDevice {
            name: "fixture".into(),
            device_type: screenpipe_db::DeviceType::Input,
        },
        None,
        None,
        None,
        Some(chrono::Utc::now()),
        {
            let mut fields = CaptureRedactions::new();
            fields.insert(CaptureField::Transcription, evidence);
            fields
        },
    )
    .await
    .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM audio_transcriptions")
            .fetch_one(&filtered.pool)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM audio_transcriptions")
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        2
    );
    drop(filtered);
    db.close().await;
}

#[tokio::test]
#[ignore = "explicit capture writer cost measurement"]
async fn measure_inline_capture_evidence_writer_cost() {
    let root = tempfile::tempdir().unwrap();
    let db = database(&root.path().join("db.sqlite")).await;
    let (clean, step) = remove_pii_with_evidence("person@example.com");
    let mut evidence = CaptureRedactions::new();
    evidence.insert(CaptureField::FullText, step.clone());
    evidence.insert(CaptureField::AccessibilityText, step);
    let mut times = [std::time::Duration::ZERO; 2];
    // Equal fixture workloads in alternating order, sharing the normal writer.
    for audited in [false, true, false, true] {
        let started = std::time::Instant::now();
        for _ in 0..64 {
            db.insert_snapshot_frame_with_redaction(
                "display",
                chrono::Utc::now(),
                "",
                None,
                None,
                None,
                None,
                true,
                None,
                Some(&clean),
                Some("accessibility"),
                None,
                None,
                None,
                None,
                None,
                if audited {
                    evidence.clone()
                } else {
                    CaptureRedactions::new()
                },
            )
            .await
            .unwrap();
        }
        times[audited as usize] += started.elapsed();
    }
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM frames")
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        256
    );
    eprintln!("capture writer fixture: 128 writes each; without field observations={:.3} ms/write, with two observations={:.3} ms/write; fixed capture evidence={} bytes", times[0].as_secs_f64()*1000.0/128.0,times[1].as_secs_f64()*1000.0/128.0,std::mem::size_of::<CaptureRedactions>());
    db.close().await;
}

#[tokio::test]
async fn inline_ocr_element_fields_keep_exact_outcomes_without_repeating_detection() {
    let root = tempfile::tempdir().unwrap();
    let db = database(&root.path().join("db.sqlite")).await;
    let raw = serde_json::json!([
        {"text":"person@example.com","level":"0","page_num":"0","block_num":"0","par_num":"0","line_num":"0","word_num":"0","left":"0","top":"0","width":"10","height":"10","conf":"90"},
        {"text":"ordinary text","level":"0","page_num":"0","block_num":"0","par_num":"0","line_num":"0","word_num":"0","left":"10","top":"0","width":"10","height":"10","conf":"90"}
    ]).to_string();
    let key = root.path().join("team.key");
    std::fs::write(&key, [7u8; 32]).unwrap();
    let pseudonyms = Arc::new(Pseudonymizer::from_shared_key_file(&key).unwrap());
    let renderer = PiiPseudonymizer(Box::new(move |kind, value| {
        pseudonyms.inline_token(kind, value)
    }));
    let mut clean: serde_json::Value = serde_json::from_str(&raw).unwrap();
    for block in clean.as_array_mut().unwrap() {
        block["text"] = serde_json::Value::String(remove_pii_with_renderer(
            block["text"].as_str().unwrap(),
            Some(&renderer),
        ));
    }
    let clean = clean.to_string();
    let step =
        screenpipe_db::RedactionEvidence::new(RedactionMethod::InlineRegex, true, clean != raw);
    let mut audit = CaptureRedactions::new();
    audit.insert(CaptureField::TextJson, step);
    audit.set_ocr_source(raw);
    assert!(!format!("{audit:?}").contains("person@example.com"));
    let id = db
        .insert_snapshot_frame_with_redaction(
            "display",
            chrono::Utc::now(),
            "",
            None,
            None,
            None,
            None,
            true,
            None,
            None,
            Some("ocr"),
            None,
            None,
            None,
            Some(("[EMAIL] ordinary text", &clean, "fixture")),
            None,
            audit,
        )
        .await
        .unwrap();
    // The existing supplementary write runs after the durable source commit.
    // Wait on observable completion, not an assumed wall-clock delay.
    let status = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let status = db.frame_redaction_status(id).await.unwrap();
            if status["elements"]["materialization_pending"] == false {
                break status;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let fields = &status["elements"]["records"];
    assert_eq!(fields.as_array().unwrap().len(), 2);
    assert_eq!(fields[0]["fields"]["text"]["method"], "inline_regex");
    assert_eq!(fields[0]["fields"]["text"]["result"], "replaced");
    assert_eq!(fields[0]["fields"]["text"]["pseudonymized"], true);
    assert_eq!(fields[1]["fields"]["text"]["result"], "no_match");
    assert_eq!(fields[1]["fields"]["text"]["pseudonymized"], false);
    assert!(fields[0]["fields"]["text"]["processed_at"]
        .as_i64()
        .is_some());
    assert!(!status.to_string().contains("person@example.com"));
    db.close().await;
    drop(db);
    let reopened = database(&root.path().join("db.sqlite")).await;
    assert_eq!(
        reopened.frame_redaction_status(id).await.unwrap()["elements"]["records"][0]["fields"]
            ["text"]["result"],
        "replaced"
    );
    reopened.close().await;
}

#[tokio::test]
async fn inline_ocr_evidence_chunks_at_sqlite_bind_boundary_without_losing_elements() {
    let root = tempfile::tempdir().unwrap();
    let db = database(&root.path().join("db.sqlite")).await;
    // Three metadata binds per element, at the documented legacy 999-bind
    // SQLite boundary. Exercise below, exactly at, and above one SQL batch.
    for count in [332usize, 333, 334] {
        let raw=serde_json::Value::Array((0..count).map(|_| serde_json::json!({"text":"person@example.com","level":"0","page_num":"0","block_num":"0","par_num":"0","line_num":"0","word_num":"0","left":"0","top":"0","width":"1","height":"1","conf":"90"})).collect()).to_string();
        let (clean, step) =
            screenpipe_core::pii_removal::remove_pii_json_with_evidence(&raw, &["text"]).unwrap();
        let mut audit = CaptureRedactions::new();
        audit.insert(CaptureField::TextJson, step);
        audit.set_ocr_source(raw);
        let id = db
            .insert_snapshot_frame_with_redaction(
                "display",
                chrono::Utc::now(),
                "",
                None,
                None,
                None,
                None,
                true,
                None,
                None,
                Some("ocr"),
                None,
                None,
                None,
                Some(("[EMAIL]", &clean, "fixture")),
                None,
                audit,
            )
            .await
            .unwrap();
        let status = tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                let status = db.frame_redaction_status(id).await.unwrap();
                if status["elements"]["materialization_pending"] == false {
                    break status;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let elements = status["elements"]["records"].as_array().unwrap();
        assert_eq!(elements.len(), count);
        assert!(elements
            .iter()
            .all(|e| e["fields"]["text"]["result"] == "replaced"));
    }
    db.close().await;
}

#[tokio::test]
#[ignore = "explicit inline OCR writer cost measurement"]
async fn measure_inline_ocr_evidence_writer_cost() {
    let root = tempfile::tempdir().unwrap();
    let db = database(&root.path().join("db.sqlite")).await;
    for count in [2usize, 334] {
        let raw=serde_json::Value::Array((0..count).map(|_|serde_json::json!({"text":"person@example.com","level":"0","page_num":"0","block_num":"0","par_num":"0","line_num":"0","word_num":"0","left":"0","top":"0","width":"1","height":"1","conf":"90"})).collect()).to_string();
        let (clean, step) =
            screenpipe_core::pii_removal::remove_pii_json_with_evidence(&raw, &["text"]).unwrap();
        for audited in [false, true] {
            let mut capture = std::time::Duration::ZERO;
            let mut deferred = std::time::Duration::ZERO;
            for _ in 0..16 {
                let mut audit = CaptureRedactions::new();
                audit.insert(CaptureField::TextJson, step.clone());
                if audited {
                    audit.set_ocr_source(raw.clone());
                }
                let started = std::time::Instant::now();
                let id = db
                    .insert_snapshot_frame_with_redaction(
                        "display",
                        chrono::Utc::now(),
                        "",
                        None,
                        None,
                        None,
                        None,
                        true,
                        None,
                        None,
                        Some("ocr"),
                        None,
                        None,
                        None,
                        Some(("[EMAIL]", &clean, "fixture")),
                        None,
                        audit,
                    )
                    .await
                    .unwrap();
                let captured = started.elapsed();
                capture += captured;
                tokio::time::timeout(std::time::Duration::from_secs(10),async {
                    loop {
                        let pending:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM redaction_records WHERE kind='frame_elements_pending' AND record_id=?)").bind(id).fetch_one(&db.pool).await.unwrap();
                        if !pending {break;}
                        tokio::task::yield_now().await;
                    }
                }).await.unwrap();
                deferred += started.elapsed() - captured;
                assert_eq!(
                    sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM elements WHERE frame_id=?")
                        .bind(id)
                        .fetch_one(&db.pool)
                        .await
                        .unwrap(),
                    count as i64
                );
            }
            eprintln!("OCR writer fixture: {count} leaves, per-leaf audit={audited}, 16 frames; source commit={:.3} ms/frame, deferred completion={:.3} ms/frame",capture.as_secs_f64()*1000.0/16.0,deferred.as_secs_f64()*1000.0/16.0);
        }
    }
    db.close().await;
}
