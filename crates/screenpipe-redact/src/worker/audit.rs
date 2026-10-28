// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Field evidence travels with the value; publish both after a source CAS.
use super::{tables, TargetTable, Worker};
use crate::{RedactError, RedactionOutput, Redactor};
use screenpipe_db::{FieldRedactions, RedactionEvidence, RedactionMethod, RedactionResult};
use sqlx::Row;
use std::collections::BTreeMap;
use std::sync::Mutex;

pub(super) struct ObservedRedactor<'a> {
    pub inner: &'a dyn Redactor,
    pub complete: bool,
    pub evidence: Mutex<Option<RedactionEvidence>>,
}

impl<'a> ObservedRedactor<'a> {
    pub fn new(inner: &'a dyn Redactor, complete: bool) -> Self {
        Self {
            inner,
            complete,
            evidence: Mutex::new(None),
        }
    }
    pub fn evidence(&self) -> RedactionEvidence {
        self.evidence
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_else(|| RedactionEvidence::new(RedactionMethod::AsyncRegex, false, false))
    }
}

#[async_trait::async_trait]
impl Redactor for ObservedRedactor<'_> {
    fn name(&self) -> &str {
        self.inner.name()
    }
    fn version(&self) -> u32 {
        self.inner.version()
    }
    async fn redact_batch(&self, texts: &[String]) -> Result<Vec<RedactionOutput>, RedactError> {
        let mut results = if self.complete {
            let mut results = Vec::new();
            for text in texts {
                results.push(self.inner.redact_complete(text).await?);
            }
            results
        } else {
            self.inner.redact_batch(texts).await?
        };
        for output in &mut results {
            if output.evidence.is_none() {
                let method = if self.inner.name() == "regex" {
                    RedactionMethod::AsyncRegex
                } else if self.inner.provides_model_detection() {
                    RedactionMethod::AsyncModel
                } else {
                    return Err(RedactError::Unexpected(
                        "redactor did not report processing evidence".into(),
                    ));
                };
                output.evidence = Some(RedactionEvidence::new(
                    method,
                    self.inner.uses_pseudonyms(),
                    output.input != output.redacted,
                ));
            }
            if let Some(step) = &output.evidence {
                let mut evidence = self.evidence.lock().unwrap();
                if let Some(current) = evidence.as_mut() {
                    current.merge(step);
                } else {
                    *evidence = Some(step.clone());
                }
            }
        }
        Ok(results)
    }
}

pub(crate) fn processing_failure_cause(error: &anyhow::Error) -> String {
    if let Some(error) = error.downcast_ref::<serde_json::Error>() {
        format!(
            "structured JSON parse failed at line {}, column {}; source retained for retry",
            error.line(),
            error.column()
        )
    } else if let Some(error) = error.downcast_ref::<crate::tree_json::TreeRedactError>() {
        match error {
            crate::tree_json::TreeRedactError::Json(e) => format!(
                "structured JSON parse failed at line {}, column {}; source retained for retry",
                e.line(),
                e.column()
            ),
            crate::tree_json::TreeRedactError::Redact(e) => crate::pipeline::fallback_cause(e),
        }
    } else if let Some(error) = error.downcast_ref::<RedactError>() {
        crate::pipeline::fallback_cause(error)
    } else {
        "field processing failed; source retained for retry".into()
    }
}

impl Worker {
    pub(super) async fn audited_field(
        &self,
        column: &str,
        value: &str,
        complete: bool,
    ) -> Result<(String, RedactionEvidence), anyhow::Error> {
        let observed = ObservedRedactor::new(self.redactor.as_ref(), complete);
        let clean = match column {
            "text_json" => crate::ocr_json::redact_ocr_text_json_with_redactor(value, &observed)
                .await?
                .unwrap_or_else(|| value.into()),
            "accessibility_tree_json" | "properties" => {
                crate::tree_json::redact_tree_json_with_redactor_fields(
                    value,
                    &observed,
                    &self.cfg.columns.a11y_json_fields(),
                )
                .await?
                .unwrap_or_else(|| value.into())
            }
            "element_ancestors" => {
                crate::tree_json::redact_tree_json_with_redactor_fields(value, &observed, &["name"])
                    .await?
                    .unwrap_or_else(|| value.into())
            }
            _ => observed.redact(value).await?.redacted,
        };
        let mut evidence = observed.evidence();
        self.note_excluded_fields(column, value, &mut evidence)?;
        Ok((clean, evidence))
    }

    async fn audited_record(
        &self,
        original: &BTreeMap<String, Option<String>>,
        context: Option<&str>,
    ) -> Result<Option<(BTreeMap<String, Option<String>>, FieldRedactions)>, anyhow::Error> {
        let mut inputs = Vec::new();
        for (column, value) in original {
            let Some(text) = value.as_deref().filter(|s| !s.is_empty()) else {
                continue;
            };
            let keys = self.structured_keys(column);
            if let Some(keys) = keys {
                crate::tree_json::collect_redactable(
                    &serde_json::from_str(text)?,
                    &keys,
                    &mut inputs,
                );
            } else {
                inputs.push(text.into());
            }
        }
        let mut seen = std::collections::HashSet::new();
        inputs.retain(|s| seen.insert(s.clone()));
        let augmented = crate::a11y_context::augment_text(&inputs.join("\n"), context);
        let Some((out, mut map)) = self.redactor.redact_with_map(&augmented.text).await? else {
            return Ok(None);
        };
        map.extend_pairs(
            augmented
                .secret_pairs_with(&out.spans, |value| self.redactor.secret_replacement(value)),
        );
        let Some(base) = out.evidence else {
            return Ok(None);
        };
        let mut values = original.clone();
        let mut evidence = FieldRedactions::new();
        for (column, value) in original {
            let Some(text) = value.as_deref().filter(|s| !s.is_empty()) else {
                continue;
            };
            let clean = if let Some(keys) = self.structured_keys(column) {
                crate::tree_json::redact_tree_json_with_fields(text, &map, &keys)?
                    .unwrap_or_else(|| text.into())
            } else {
                map.apply(text)
            };
            let changed = if self.structured_keys(column).is_some() {
                serde_json::from_str::<serde_json::Value>(text)?
                    != serde_json::from_str::<serde_json::Value>(&clean)?
            } else {
                text != clean
            };
            let mut step = base.clone();
            step.result = if changed {
                RedactionResult::Replaced
            } else {
                RedactionResult::NoMatch
            };
            step.pseudonymized = self.redactor.uses_pseudonyms() && changed;
            self.note_excluded_fields(column, text, &mut step)?;
            values.insert(column.clone(), Some(clean));
            evidence.insert(column.clone(), step);
        }
        Ok(Some((values, evidence)))
    }

    fn structured_keys(&self, column: &str) -> Option<Vec<&'static str>> {
        match column {
            "text_json" => Some(vec!["text"]),
            "accessibility_tree_json" | "properties" => Some(self.cfg.columns.a11y_json_fields()),
            "element_ancestors" => Some(vec!["name"]),
            _ => None,
        }
    }

    fn note_excluded_fields(
        &self,
        column: &str,
        value: &str,
        evidence: &mut RedactionEvidence,
    ) -> Result<(), serde_json::Error> {
        fn has_url(value: &serde_json::Value) -> bool {
            match value {
                serde_json::Value::Object(items) => items.iter().any(|(k, v)| {
                    k == "url" && v.as_str().is_some_and(|s| !s.is_empty()) || has_url(v)
                }),
                serde_json::Value::Array(items) => items.iter().any(has_url),
                _ => false,
            }
        }
        if matches!(column, "properties" | "accessibility_tree_json")
            && !self.cfg.columns.a11y_url_field
            && has_url(&serde_json::from_str(value)?)
        {
            evidence.complete = false;
            evidence.cause = Some("URL field excluded by recording privacy policy".into());
        }
        Ok(())
    }

    /// Production non-required mode. Unknown historical evidence remains
    /// unknown; only the fields actually processed get a new observation.
    pub(super) async fn process_audited(
        &self,
        table: TargetTable,
        limit: u32,
    ) -> Result<u32, anyhow::Error> {
        let Some(db) = &self.release_db else {
            return Ok(0);
        };
        let expected_policy = db.release_policy().await?.identity;
        let mut contexts = BTreeMap::new();
        let mut records: Vec<(i64, BTreeMap<String, Option<String>>)> = Vec::new();
        let kind = match table {
            TargetTable::FullText => {
                let order = if self.background_oldest(table).await {
                    "ASC"
                } else {
                    "DESC"
                };
                let rows = sqlx::query(sqlx::AssertSqlSafe(format!("SELECT id,full_text,app_name,document_path,accessibility_text,accessibility_tree_json,window_name,browser_url,text_json FROM frames WHERE full_text_redacted_at IS NULL ORDER BY id {order} LIMIT ?"))).bind(limit).fetch_all(&self.pool).await?;
                for row in rows {
                    let id: i64 = row.try_get("id")?;
                    contexts.insert(
                        id,
                        row.try_get::<Option<String>, _>("accessibility_tree_json")?,
                    );
                    let mut fields = BTreeMap::new();
                    let cols = self.cfg.columns;
                    for (enabled, field) in [
                        (true, "full_text"),
                        (true, "app_name"),
                        (true, "document_path"),
                        (cols.accessibility_text, "accessibility_text"),
                        (cols.accessibility_tree, "accessibility_tree_json"),
                        (cols.window_name, "window_name"),
                        (cols.browser_url, "browser_url"),
                        (true, "text_json"),
                    ] {
                        if enabled {
                            fields.insert(field.into(), row.try_get::<Option<String>, _>(field)?);
                        }
                    }
                    records.push((id, fields));
                }
                "frames"
            }
            TargetTable::UiEvents => {
                let active = self.cfg.columns.ui_event_columns();
                if active.is_empty() {
                    return Ok(0);
                }
                for row in tables::fetch_unredacted_ui_events(
                    &self.pool,
                    &active,
                    limit,
                    self.background_oldest(table).await,
                )
                .await?
                {
                    let mut fields: BTreeMap<String, Option<String>> = active
                        .iter()
                        .zip(row.cols)
                        .map(|(k, v)| ((*k).into(), v))
                        .collect();
                    let metadata =
                        sqlx::query("SELECT app_name,browser_url FROM ui_events WHERE id=?")
                            .bind(row.id)
                            .fetch_one(&self.pool)
                            .await?;
                    fields.insert("app_name".into(), metadata.try_get("app_name")?);
                    if self.cfg.columns.browser_url {
                        fields.insert("browser_url".into(), metadata.try_get("browser_url")?);
                    }
                    records.push((row.id, fields));
                }
                "input"
            }
            TargetTable::Elements => {
                if !self.cfg.columns.element_text && !self.cfg.columns.element_properties {
                    return Ok(0);
                }
                for row in tables::fetch_unredacted_elements(
                    &self.pool,
                    limit,
                    self.background_oldest(table).await,
                )
                .await?
                {
                    let mut fields = BTreeMap::new();
                    if self.cfg.columns.element_text {
                        fields.insert("text".into(), row.text);
                    }
                    if self.cfg.columns.element_properties {
                        fields.insert("properties".into(), row.properties);
                    }
                    records.push((row.id, fields));
                }
                "elements"
            }
            TargetTable::Accessibility if self.cfg.columns.accessibility_text => {
                for row in tables::fetch_unredacted(
                    &self.pool,
                    table,
                    limit,
                    self.background_oldest(table).await,
                )
                .await?
                {
                    records.push((
                        row.id,
                        BTreeMap::from([("accessibility_text".into(), Some(row.text))]),
                    ));
                }
                "frames"
            }
            _ => return Ok(0),
        };
        let mut completed = 0;
        let mut pending = false;
        for (id, original) in records {
            let mut values = original.clone();
            let mut evidence = FieldRedactions::new();
            let mapped = self
                .audited_record(&original, contexts.get(&id).and_then(|s| s.as_deref()))
                .await;
            let mut failed = false;
            let mut direct = true;
            match mapped {
                Ok(Some((mapped_values, mapped_evidence))) => {
                    values = mapped_values;
                    evidence = mapped_evidence;
                    direct = false;
                }
                Ok(None) => {}
                Err(error) => {
                    self.status.lock().await.last_error = Some(format!(
                        "PII record processing pending: kind={kind}, id={id}: {error}"
                    ));
                }
            }
            for (column, value) in original.iter().filter(|_| direct) {
                let Some(text) = value.as_deref().filter(|s| !s.is_empty()) else {
                    continue;
                };
                match self.audited_field(column, text, false).await {
                    Ok((clean, step)) => {
                        values.insert(column.clone(), Some(clean));
                        evidence.insert(column.clone(), step);
                    }
                    Err(error) => {
                        // A failed detector must leave durable, retryable work.
                        // The originating error is reported through WorkerStatus.
                        self.status.lock().await.last_error = Some(format!("PII field processing pending: kind={kind}, id={id}, field={column}: {error}"));
                        let mut step = RedactionEvidence::new(
                            if self.redactor.provides_model_detection() {
                                RedactionMethod::AsyncModel
                            } else {
                                RedactionMethod::AsyncRegex
                            },
                            false,
                            false,
                        );
                        step.complete = false;
                        step.result = RedactionResult::Skipped;
                        step.cause = Some(processing_failure_cause(&error));
                        evidence.insert(column.clone(), step);
                        failed = true;
                    }
                }
            }
            let degraded = evidence
                .values()
                .any(|e| e.method == RedactionMethod::AsyncRegexFallback);
            pending |= failed || degraded;
            if let Some((field, step)) = evidence.iter().find(|(_, e)| {
                e.result == RedactionResult::Skipped
                    || e.method == RedactionMethod::AsyncRegexFallback
            }) {
                db.persist_redaction_failure(kind, id, Some(field), step, true)
                    .await;
            }
            if degraded {
                self.status.lock().await.last_error=Some(format!("PII model processing pending: kind={kind}, id={id}; regex fallback retained for retry"));
            }
            if db
                .apply_field_redactions(kind, id, &original, &values, &evidence, &expected_policy)
                .await?
                && !failed
                && !degraded
            {
                completed += 1;
            }
        }
        if completed > 0 {
            let mut status = self.status.lock().await;
            status.redacted_total += completed as u64;
            status.last_redacted_at = Some(chrono::Utc::now());
            if !pending {
                status.last_error = None;
            }
        }
        Ok(completed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Pipeline, PipelineConfig, RedactedSpan, SpanLabel, TextRedactionPolicy};
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    struct NamedSpan(Arc<AtomicUsize>);
    #[async_trait::async_trait]
    impl Redactor for NamedSpan {
        fn name(&self) -> &str {
            "named-span"
        }
        fn version(&self) -> u32 {
            1
        }
        fn provides_model_detection(&self) -> bool {
            true
        }
        async fn redact_batch(
            &self,
            texts: &[String],
        ) -> Result<Vec<RedactionOutput>, RedactError> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(texts
                .iter()
                .map(|text| {
                    let spans = text
                        .match_indices("Alice")
                        .map(|(start, value)| RedactedSpan {
                            start,
                            end: start + value.len(),
                            label: SpanLabel::Person,
                            subtype: None,
                            text: value.into(),
                        })
                        .collect();
                    RedactionOutput {
                        evidence: None,
                        input: text.clone(),
                        redacted: text.replace("Alice", "[PERSON]"),
                        spans,
                    }
                })
                .collect())
        }
    }
    fn pipeline(calls: Arc<AtomicUsize>) -> Pipeline {
        Pipeline::regex_then_ai(
            Arc::new(NamedSpan(calls)),
            PipelineConfig {
                ai_min_chars: 0,
                policy: TextRedactionPolicy::from_labels(&[
                    "person".into(),
                    "email".into(),
                    "secret".into(),
                ]),
                ..Default::default()
            },
        )
    }
    #[tokio::test]
    async fn model_spans_are_mapped_back_after_regex_changes_offsets() {
        let source = "alice@example.com met Alice";
        let pipeline = pipeline(Arc::new(AtomicUsize::new(0)));
        let (out, map) = pipeline.redact_with_map(source).await.unwrap().unwrap();
        assert_eq!(out.redacted, "[EMAIL] met [PERSON]");
        assert_eq!(map.apply(source), out.redacted);
        assert!(out
            .spans
            .iter()
            .any(|s| s.label == SpanLabel::Person && s.start == source.find("Alice").unwrap()));
        assert_eq!(out.evidence.unwrap().method, RedactionMethod::AsyncModel);
    }
    #[tokio::test]
    async fn production_field_audit_preserves_one_model_pass_and_durable_capture() {
        let root = tempfile::tempdir().unwrap();
        let db = Arc::new(
            screenpipe_db::DatabaseManager::new(
                root.path().join("db.sqlite").to_str().unwrap(),
                Default::default(),
            )
            .await
            .unwrap(),
        );
        db.configure_release(&screenpipe_db::privacy_release::ReleasePolicy {
            identity: "audit-model:v1".into(),
            text: false,
            images: false,
        })
        .await
        .unwrap();
        db.execute_raw_sql_write("INSERT INTO frames(id,timestamp,full_text,accessibility_text,window_name,accessibility_tree_json) VALUES(1,'2026-10-28','alice@example.com met Alice','Alice','Alice','[{\"role\":\"AXText\",\"text\":\"Alice\"}]')").await.unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let worker = Worker::new_with_writer(
            db.pool.clone(),
            db.coordinated_writer(),
            Arc::new(pipeline(calls.clone())),
            super::super::WorkerConfig {
                resource_governor: None,
                ..Default::default()
            },
        )
        .with_frame_storage(db.clone());
        assert_eq!(
            worker
                .process_audited(TargetTable::FullText, 10)
                .await
                .unwrap(),
            1
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let text: String = sqlx::query_scalar("SELECT full_text FROM frames WHERE id=1")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(text, "[EMAIL] met [PERSON]");
        let status = db.frame_redaction_status(1).await.unwrap();
        for field in [
            "full_text",
            "accessibility_text",
            "window_name",
            "accessibility_tree_json",
        ] {
            assert_eq!(status["fields"][field]["method"], "async_model");
            assert_eq!(status["fields"][field]["result"], "replaced");
        }
        assert_eq!(status["fully_redacted"], true);
        db.execute_raw_sql_write("UPDATE frames SET window_name='Alice revised' WHERE id=1")
            .await
            .unwrap();
        assert_eq!(
            db.frame_redaction_status(1).await.unwrap()["fully_redacted"],
            false
        );
        assert_eq!(
            worker
                .process_audited(TargetTable::FullText, 10)
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            db.frame_redaction_status(1).await.unwrap()["fully_redacted"],
            true
        );
        db.execute_raw_sql_write(
            "INSERT INTO frames(id,timestamp,window_name) VALUES(2,'2026-10-28','Alice')",
        )
        .await
        .unwrap();
        assert_eq!(
            worker
                .process_audited(TargetTable::FullText, 10)
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            db.frame_redaction_status(2).await.unwrap()["fields"]["window_name"]["method"],
            "async_model"
        );
        db.close().await;
    }
    struct RecoveringModel(Arc<AtomicUsize>);
    #[async_trait::async_trait]
    impl Redactor for RecoveringModel {
        fn name(&self) -> &str {
            "recovering-local-model"
        }
        fn version(&self) -> u32 {
            1
        }
        fn provides_model_detection(&self) -> bool {
            true
        }
        async fn redact_batch(
            &self,
            texts: &[String],
        ) -> Result<Vec<RedactionOutput>, RedactError> {
            if self.0.fetch_add(1, Ordering::SeqCst) == 0 {
                return Err(RedactError::Unavailable("fixture unavailable".into()));
            }
            NamedSpan(Arc::new(AtomicUsize::new(0)))
                .redact_batch(texts)
                .await
        }
    }
    #[tokio::test]
    async fn failed_model_keeps_work_pending_while_capture_continues_and_same_input_recovers() {
        let root = tempfile::tempdir().unwrap();
        let db = Arc::new(
            screenpipe_db::DatabaseManager::new(
                root.path().join("db.sqlite").to_str().unwrap(),
                Default::default(),
            )
            .await
            .unwrap(),
        );
        db.configure_release(&screenpipe_db::privacy_release::ReleasePolicy {
            identity: "recovery:v1".into(),
            text: false,
            images: false,
        })
        .await
        .unwrap();
        db.execute_raw_sql_write(
            "INSERT INTO frames(id,timestamp,full_text) VALUES(1,'2026-10-28','Alice')",
        )
        .await
        .unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let model = Pipeline::regex_then_ai(
            Arc::new(RecoveringModel(calls.clone())),
            PipelineConfig {
                ai_min_chars: 0,
                policy: TextRedactionPolicy::from_labels(&["person".into()]),
                ..Default::default()
            },
        );
        let worker = Worker::new_with_writer(
            db.pool.clone(),
            db.coordinated_writer(),
            Arc::new(model),
            super::super::WorkerConfig {
                resource_governor: None,
                ..Default::default()
            },
        )
        .with_frame_storage(db.clone());
        assert_eq!(
            worker
                .process_audited(TargetTable::FullText, 10)
                .await
                .unwrap(),
            0
        );
        let status = db.frame_redaction_status(1).await.unwrap();
        assert_eq!(
            status["fields"]["full_text"]["method"],
            "async_regex_fallback"
        );
        assert_eq!(status["fully_redacted"], false);
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT full_text FROM frames WHERE id=1")
                .fetch_one(&db.pool)
                .await
                .unwrap(),
            "Alice"
        );
        // The normal capture writer still accepts and durably stores new work.
        let next = db
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
                Some("new capture"),
                Some("accessibility"),
                None,
                None,
                None,
                None,
                None,
            )
            .await
            .unwrap();
        assert_ne!(next, 1);
        assert_eq!(
            worker
                .process_audited(TargetTable::FullText, 10)
                .await
                .unwrap(),
            2
        );
        assert_eq!(
            db.frame_redaction_status(1).await.unwrap()["fully_redacted"],
            true
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT full_text FROM frames WHERE id=1")
                .fetch_one(&db.pool)
                .await
                .unwrap(),
            "[PERSON]"
        );
        assert!(
            calls.load(Ordering::SeqCst) >= 2,
            "fallback must not enter the success cache"
        );
        db.close().await;
    }

    #[tokio::test]
    async fn hybrid_evidence_survives_sealing_and_shares_filtered_request_snapshot() {
        let root = tempfile::tempdir().unwrap();
        let db = Arc::new(
            screenpipe_db::DatabaseManager::new_hybrid(
                root.path(),
                Default::default(),
                Default::default(),
            )
            .await
            .unwrap(),
        );
        db.configure_release(&screenpipe_db::privacy_release::ReleasePolicy {
            identity: "hybrid-audit:v1".into(),
            text: false,
            images: false,
        })
        .await
        .unwrap();
        db.execute_raw_sql_write("INSERT INTO frames(id,timestamp,full_text,accessibility_text,window_name) VALUES(1,'2026-10-28','alice@example.com met Alice','Alice','Alice')").await.unwrap();
        let worker = Worker::new_with_writer(
            db.pool.clone(),
            db.coordinated_writer(),
            Arc::new(pipeline(Arc::new(AtomicUsize::new(0)))),
            super::super::WorkerConfig {
                resource_governor: None,
                ..Default::default()
            },
        )
        .with_frame_storage(db.clone());
        assert_eq!(worker.process_hybrid_frames(10).await.unwrap(), 1);
        assert_eq!(db.seal_frame_payloads().await.unwrap(), 1);
        let filtered = db.fully_redacted_reads().await.unwrap();
        filtered
            .read_snapshot(async {
                let status = filtered.frame_redaction_status(1).await.unwrap();
                assert_eq!(status["fields"]["full_text"]["method"], "async_model");
                assert_eq!(status["fully_redacted"], true);
                assert_eq!(
                    sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM frames")
                        .fetch_one(&filtered.pool)
                        .await
                        .unwrap(),
                    1
                );
            })
            .await
            .unwrap();
        drop(filtered);
        db.close().await;
        drop(worker);
        drop(db);
        let reopened = Arc::new(
            screenpipe_db::DatabaseManager::new(
                root.path().join("db.sqlite").to_str().unwrap(),
                Default::default(),
            )
            .await
            .unwrap(),
        );
        reopened
            .configure_release(&screenpipe_db::privacy_release::ReleasePolicy {
                identity: "hybrid-audit:v1".into(),
                text: false,
                images: false,
            })
            .await
            .unwrap();
        assert_eq!(
            reopened.frame_redaction_status(1).await.unwrap()["fully_redacted"],
            true
        );
        reopened.close().await;
    }
}
