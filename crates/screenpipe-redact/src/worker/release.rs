// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use super::Worker;
use crate::{RedactError, Redactor};
use screenpipe_db::privacy_release::ReleaseJob;
use std::collections::{BTreeMap, VecDeque};
use std::sync::atomic::Ordering;
use std::time::Instant;

pub(super) struct ReleaseScheduler {
    kinds: Vec<&'static str>,
    next: usize,
    oldest: Vec<bool>,
    progress: Vec<Option<Progress>>,
    local_streams: Vec<String>,
    local_next: usize,
}

impl Default for ReleaseScheduler {
    fn default() -> Self {
        let kinds = screenpipe_db::privacy_release::text_release_kinds();
        Self {
            oldest: vec![false; kinds.len()],
            progress: (0..kinds.len()).map(|_| None).collect(),
            kinds,
            next: 0,
            local_streams: screenpipe_db::privacy_exports::local_release_streams(),
            local_next: 0,
        }
    }
}

struct Field {
    column: String,
    pointer: Option<String>,
    text: String,
    session: Option<Box<dyn crate::RequiredRedaction>>,
}

struct Progress {
    job: ReleaseJob,
    values: BTreeMap<String, Option<String>>,
    json: BTreeMap<String, serde_json::Value>,
    fields: VecDeque<Field>,
}

impl Progress {
    fn new(job: ReleaseJob) -> Result<Self, RedactError> {
        let mut fields = VecDeque::new();
        let mut json = BTreeMap::new();
        // Audio keeps revision receipts for sync/retry bookkeeping only. Copy
        // transcripts unchanged, without sending any field to a local or cloud
        // detector. Local transcript reads do not wait for this bookkeeping.
        if screenpipe_db::privacy_release::is_audio_surface(&job.kind) {
            return Ok(Self {
                values: job.values.clone(),
                job,
                json,
                fields,
            });
        }
        for (column, value) in &job.values {
            let Some(text) = value.as_deref().filter(|s| !s.is_empty()) else {
                continue;
            };
            if column.ends_with("json")
                || matches!(column.as_str(), "properties" | "element_ancestors" | "tags")
            {
                let value: serde_json::Value = serde_json::from_str(text).map_err(|_| {
                    RedactError::Unexpected("invalid structured privacy source".into())
                })?;
                collect(&value, column, String::new(), &mut fields);
                json.insert(column.clone(), value);
            } else {
                fields.push_back(Field {
                    column: column.clone(),
                    pointer: None,
                    text: text.into(),
                    session: None,
                });
            }
        }
        Ok(Self {
            values: job.values.clone(),
            job,
            json,
            fields,
        })
    }

    async fn step(&mut self, redactor: &std::sync::Arc<dyn Redactor>) -> Result<(), RedactError> {
        let Some(field) = self.fields.front_mut() else {
            return Ok(());
        };
        if field.session.is_none() {
            field.session = Some(
                redactor
                    .clone()
                    .required_session(std::mem::take(&mut field.text)),
            );
        }
        let Some(out) = field.session.as_mut().unwrap().step().await? else {
            return Ok(());
        };
        if let Some(step) = &out.evidence {
            self.job
                .redaction
                .entry(field.column.clone())
                .and_modify(|e| e.merge(step))
                .or_insert_with(|| step.clone());
        }
        if let Some(pointer) = &field.pointer {
            let target = self
                .json
                .get_mut(&field.column)
                .and_then(|value| value.pointer_mut(pointer))
                .ok_or_else(|| {
                    RedactError::Unexpected("invalid structured privacy result".into())
                })?;
            *target = serde_json::Value::String(out.redacted);
        } else {
            self.values.insert(field.column.clone(), Some(out.redacted));
        }
        self.fields.pop_front();
        Ok(())
    }

    fn finish(&mut self) -> Result<(), RedactError> {
        for (column, value) in &self.json {
            self.values.insert(
                column.clone(),
                Some(serde_json::to_string(value).map_err(|_| {
                    RedactError::Unexpected("invalid structured privacy result".into())
                })?),
            );
        }
        Ok(())
    }
}

impl Worker {
    /// Test/standalone seam: number of fully published records, not attempts.
    pub async fn process_release_batch(&self, limit: u32) -> Result<u32, anyhow::Error> {
        Ok(self.process_release_slice(limit).await?.1)
    }

    /// Attempts (including failures and partial records) drive CPU accounting.
    /// A slice yields between backend steps, including overlapping ONNX windows.
    /// Partial results stay in memory and are never visible until atomic publish.
    pub(super) async fn process_release_slice(
        &self,
        limit: u32,
    ) -> Result<(u32, u32), anyhow::Error> {
        let Some(db) = &self.release_db else {
            return Ok((0, 0));
        };
        let mut scheduler = self.release_scheduler.lock().await;
        let started = Instant::now();
        let (mut attempted, mut completed, mut empty) = (0, 0, 0);
        let mut preparing = false;
        while attempted < limit
            && empty < scheduler.kinds.len()
            && !self.paused.load(Ordering::SeqCst)
        {
            if attempted > 0 && started.elapsed() >= self.cfg.target_batch_duration {
                break;
            }
            let index = scheduler.next;
            scheduler.next = (index + 1) % scheduler.kinds.len();
            let kind = scheduler.kinds[index];
            if let Some(progress) = scheduler.progress[index].as_ref() {
                if !db.release_job_current(&progress.job).await? {
                    scheduler.progress[index] = None;
                }
            }
            if scheduler.progress[index].is_none() {
                if kind == "exports" && db.release_policy().await?.text {
                    let local = scheduler.local_next;
                    scheduler.local_next = (local + 1) % scheduler.local_streams.len();
                    // Reuse the caller's batch budget. Discovery and source
                    // revisions persist, including when no detector is healthy.
                    preparing |= db
                        .prepare_derived_exports(&scheduler.local_streams[local], "", limit)
                        .await?;
                }
                let jobs = match db
                    .release_pending_ordered(kind, 1, 0, scheduler.oldest[index])
                    .await
                {
                    Ok(jobs) => jobs,
                    Err(error) => {
                        crate::notify_database_error(
                            self.database_error_hook.as_ref(),
                            &anyhow::Error::from(error),
                        );
                        empty += 1;
                        continue;
                    }
                };
                let Some(job) = jobs.into_iter().next() else {
                    empty += 1;
                    continue;
                };
                scheduler.oldest[index] = !scheduler.oldest[index];
                match Progress::new(job.clone()) {
                    Ok(progress) => scheduler.progress[index] = Some(progress),
                    Err(error) => {
                        attempted += 1;
                        db.defer_release(&job).await?;
                        self.release_failed(&job, &error).await;
                        continue;
                    }
                }
            }
            empty = 0;
            attempted += 1;
            let progress = scheduler.progress[index].as_mut().unwrap();
            let mut failed = None;
            while !progress.fields.is_empty() && !self.paused.load(Ordering::SeqCst) {
                if let Err(error) = progress.step(&self.redactor).await {
                    failed = Some(error);
                    break;
                }
                if started.elapsed() >= self.cfg.target_batch_duration {
                    break;
                }
            }
            if let Some(error) = failed {
                if let Some(field) = progress.fields.front() {
                    let mut evidence = screenpipe_db::RedactionEvidence::new(
                        screenpipe_db::RedactionMethod::AsyncModel,
                        false,
                        false,
                    );
                    evidence.complete = false;
                    evidence.result = screenpipe_db::RedactionResult::Skipped;
                    evidence.cause =
                        Some("required detector failed; source retained for retry".into());
                    progress
                        .job
                        .redaction
                        .insert(field.column.clone(), evidence);
                }
                db.defer_release(&progress.job).await?;
                self.release_failed(&progress.job, &error).await;
                scheduler.progress[index] = None;
            } else if progress.fields.is_empty() {
                progress.finish()?;
                if db.publish_release(&progress.job, &progress.values).await? {
                    completed += 1;
                    let mut status = self.status.lock().await;
                    if !screenpipe_db::privacy_release::is_audio_surface(&progress.job.kind) {
                        status.redacted_total += 1;
                        status.last_redacted_at = Some(chrono::Utc::now());
                        status.last_error = None;
                    }
                }
                scheduler.progress[index] = None;
            }
        }
        Ok((attempted + u32::from(preparing), completed))
    }

    async fn release_failed(&self, job: &ReleaseJob, error: &RedactError) {
        // Remote bodies and request URLs can echo captured text or credentials.
        let cause = match error {
            RedactError::HttpStatus { status, .. } => format!("redactor HTTP status {status}"),
            RedactError::Http(error) => format!(
                "redactor HTTP failure: timeout={}, connect={}, status={:?}",
                error.is_timeout(),
                error.is_connect(),
                error.status()
            ),
            _ => error.to_string(),
        };
        let message = format!("Required PII processing pending; retry scheduled: kind={}, id={}, revision={}: {cause}", job.kind, job.id, job.revision);
        if let Some(db) = &self.release_db {
            let mut evidence = screenpipe_db::RedactionEvidence::new(
                screenpipe_db::RedactionMethod::AsyncModel,
                false,
                false,
            );
            evidence.complete = false;
            evidence.result = screenpipe_db::RedactionResult::Skipped;
            evidence.cause = Some(crate::pipeline::fallback_cause(error));
            db.persist_redaction_failure(
                &job.kind,
                job.id.parse().unwrap_or_default(),
                None,
                &evidence,
                true,
            )
            .await;
        }
        tracing::warn!("{message}");
        self.status.lock().await.last_error = Some(message);
    }
}

fn collect(value: &serde_json::Value, column: &str, path: String, out: &mut VecDeque<Field>) {
    match value {
        serde_json::Value::String(text) if !text.is_empty() => out.push_back(Field {
            column: column.into(),
            pointer: Some(path),
            text: text.clone(),
            session: None,
        }),
        serde_json::Value::Array(items) => {
            for (i, item) in items.iter().enumerate() {
                collect(item, column, format!("{path}/{i}"), out);
            }
        }
        serde_json::Value::Object(items) => {
            for (key, item) in items {
                collect(
                    item,
                    column,
                    format!("{path}/{}", key.replace('~', "~0").replace('/', "~1")),
                    out,
                );
            }
        }
        _ => {}
    }
}
