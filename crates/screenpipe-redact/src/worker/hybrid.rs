// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use super::Worker;
use screenpipe_db::storage::{PrivacyPolicy, Projection, StorageMode};
use sqlx::Row;
use std::sync::Arc;

impl Worker {
    pub fn with_frame_storage(mut self, db: Arc<screenpipe_db::DatabaseManager>) -> Self {
        self.release_db = Some(Arc::clone(&db));
        if db.storage_mode() == StorageMode::HybridParquetV1 {
            self.frame_storage = Some(db);
        }
        self
    }

    pub async fn process_hybrid_frames(&self, limit: u32) -> Result<u32, anyhow::Error> {
        let Some(db) = &self.frame_storage else {
            return Ok(0);
        };
        let columns = self.cfg.columns;
        let required = 1
            | 8
            | if columns.accessibility_text { 2 } else { 0 }
            | if columns.accessibility_tree { 4 } else { 0 }
            | if columns.window_name { 16 } else { 0 }
            | if columns.browser_url { 32 } else { 0 };
        let identity = format!("{}:{columns:?}", self.redactor.policy_identity());
        db.set_frame_privacy_policy(&PrivacyPolicy {
            identity: identity.clone(),
            required_surfaces: required,
        })
        .await?;
        let order = if self.background_oldest(super::TargetTable::FullText).await {
            "ASC"
        } else {
            "DESC"
        };
        let ids:Vec<i64>=sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT p.frame_id FROM frame_payloads p CROSS JOIN storage_metadata m WHERE (p.completed_surfaces & m.required_surfaces)!=m.required_surfaces AND (p.retry_at IS NULL OR p.retry_at<=strftime('%s','now')) ORDER BY p.frame_id {order} LIMIT ?")))
            .bind(limit).fetch_all(&db.pool).await?;
        let mut count = 0;
        for id in ids {
            // Ordinary captures and archival do not revoke an older payload.
            // Its read pins its own files; deletion/privacy still revoke this token,
            // and replacement below compares both generation and policy.
            let token = db.storage_export_token().await?;
            let Some(mut payload) = db.frame_payloads(&[id], Projection::All).await?.remove(&id)
            else {
                continue;
            };
            let row = sqlx::query(
                "SELECT window_name,browser_url,app_name,document_path FROM frames WHERE id=?",
            )
            .bind(id)
            .fetch_one(&db.pool)
            .await?;
            let mut window: Option<String> = row.try_get("window_name")?;
            let mut url: Option<String> = row.try_get("browser_url")?;
            let mut app: Option<String> = row.try_get("app_name")?;
            let mut document: Option<String> = row.try_get("document_path")?;
            let original_metadata = std::collections::BTreeMap::from([
                ("window_name".into(), window.clone()),
                ("browser_url".into(), url.clone()),
                ("app_name".into(), app.clone()),
                ("document_path".into(), document.clone()),
            ]);
            {
                let _admission = token.admit(&db.pool).await?;
            }
            drop(token);
            let mut evidence = screenpipe_db::FieldRedactions::new();
            let mut processing_field = None;
            let detection = async {
                for (field, enabled, value) in [
                    ("full_text", true, &mut payload.full_text),
                    (
                        "accessibility_text",
                        columns.accessibility_text,
                        &mut payload.accessibility_text,
                    ),
                    (
                        "accessibility_tree_json",
                        columns.accessibility_tree,
                        &mut payload.accessibility_tree_json,
                    ),
                    ("text_json", true, &mut payload.text_json),
                    ("app_name", true, &mut app),
                    ("document_path", true, &mut document),
                    ("window_name", columns.window_name, &mut window),
                    ("browser_url", columns.browser_url, &mut url),
                ] {
                    if enabled {
                        processing_field = Some(field);
                        if let Some(text) = value.as_mut().filter(|s| !s.is_empty()) {
                            let (clean, step) = self.audited_field(field, text, true).await?;
                            *text = clean;
                            evidence.insert(field.into(), step);
                        } else {
                            evidence.insert(
                                field.into(),
                                screenpipe_db::RedactionEvidence::new(
                                    screenpipe_db::RedactionMethod::AsyncRegex,
                                    false,
                                    false,
                                ),
                            );
                        }
                    }
                }
                Ok::<_, anyhow::Error>(())
            }
            .await;
            match detection {
                Ok(()) => {
                    let metadata = std::collections::BTreeMap::from([
                        ("window_name".into(), window.clone()),
                        ("browser_url".into(), url.clone()),
                        ("app_name".into(), app.clone()),
                        ("document_path".into(), document.clone()),
                    ]);
                    let degraded = evidence
                        .values()
                        .any(|e| e.method == screenpipe_db::RedactionMethod::AsyncRegexFallback);
                    if let Some((field, step)) = evidence.iter().find(|(_, e)| {
                        e.method == screenpipe_db::RedactionMethod::AsyncRegexFallback
                    }) {
                        db.persist_redaction_failure("frames", id, Some(field), step, true)
                            .await;
                    }
                    if degraded {
                        self.status.lock().await.last_error=Some(format!("PII model processing pending: frame={id}; regex fallback retained for retry"));
                    }
                    if db
                        .replace_frame_payload_with_redaction(
                            &payload,
                            &identity,
                            if degraded { 0 } else { required },
                            window.as_deref(),
                            url.as_deref(),
                            &evidence,
                            &original_metadata,
                            &metadata,
                        )
                        .await?
                    {
                        if !degraded {
                            count += 1;
                        }
                    }
                }
                Err(error) => {
                    // The receipt contains an error class, never captured text
                    // or detector output. Retry stays scoped to this generation.
                    let mut failed = screenpipe_db::RedactionEvidence::new(
                        if self.redactor.provides_model_detection() {
                            screenpipe_db::RedactionMethod::AsyncModel
                        } else {
                            screenpipe_db::RedactionMethod::AsyncRegex
                        },
                        false,
                        false,
                    );
                    failed.complete = false;
                    failed.result = screenpipe_db::RedactionResult::Skipped;
                    failed.cause = Some(super::audit::processing_failure_cause(&error));
                    let failed_fields = processing_field
                        .map(|field| {
                            screenpipe_db::FieldRedactions::from([(field.into(), failed.clone())])
                        })
                        .unwrap_or_default();
                    db.defer_frame_redaction(id, payload.generation, &identity, &failed_fields)
                        .await?;
                    db.persist_redaction_failure("frames", id, processing_field, &failed, true)
                        .await;
                    let mut status = self.status.lock().await;
                    status.last_error =
                        Some("frame surface processing failed; retry scheduled".into());
                    tracing::debug!(frame_id=id,error_type=%std::any::type_name_of_val(&error),"frame privacy processing deferred");
                }
            }
        }
        if count > 0 {
            let mut status = self.status.lock().await;
            status.redacted_total += count as u64;
            status.last_redacted_at = Some(chrono::Utc::now());
        }
        Ok(count)
    }
}
