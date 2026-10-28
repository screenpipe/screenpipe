// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Durable release receipts. Recording owns the source; only a completed
//! detector may publish a particular source revision under the active policy.
//! Neither inference nor network I/O runs while holding the writer.

use super::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReleasePolicy {
    pub identity: String,
    pub text: bool,
    pub images: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ReleaseJob {
    #[serde(default)]
    pub redaction: crate::FieldRedactions,
    pub kind: String,
    pub id: String,
    pub revision: i64,
    pub policy: String,
    pub values: BTreeMap<String, Option<String>>,
    pub storage_generation: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ReadyChange {
    pub sequence: i64,
    pub kind: String,
    pub id: String,
    pub revision: i64,
}

pub(crate) struct Surface {
    pub kind: &'static str,
    pub table: &'static str,
    pub columns: &'static [&'static str],
}

// Every exported free-text field belongs to one receipt. Structural fields
// (IDs, times, geometry) remain unchanged. Images have an independent receipt.
pub(crate) const SURFACES: &[Surface] = &[
    Surface {
        kind: "frames",
        table: "frames",
        columns: &[
            "full_text",
            "accessibility_text",
            "accessibility_tree_json",
            "text_json",
            "window_name",
            "browser_url",
            "app_name",
            "document_path",
        ],
    },
    Surface {
        kind: "audio",
        table: "audio_transcriptions",
        columns: &["transcription", "device"],
    },
    Surface {
        kind: "input",
        table: "ui_events",
        columns: &[
            "text_content",
            "element_value",
            "element_description",
            "element_ancestors",
            "window_title",
            "browser_url",
            "element_name",
            "app_name",
        ],
    },
    Surface {
        kind: "elements",
        table: "elements",
        columns: &["text", "properties"],
    },
    Surface {
        kind: "memory",
        table: "memories",
        columns: &["content", "source", "source_context", "tags"],
    },
    Surface {
        kind: "parsed",
        table: "semantic_items",
        columns: &["title", "body", "actor", "status", "metadata_json"],
    },
    Surface {
        kind: "segments",
        table: "meeting_transcript_segments",
        columns: &["transcript", "speaker_name", "device_name"],
    },
    Surface {
        kind: "activity_tasks",
        table: "activity_tasks",
        columns: &["title", "app_name"],
    },
    Surface {
        kind: "activity_actions",
        table: "activity_actions",
        columns: &["summary", "app_name"],
    },
    Surface {
        kind: "exports",
        table: "_privacy_exports",
        columns: &["text_json"],
    },
    Surface {
        kind: "image",
        table: "frames",
        columns: &["snapshot_path", "name"],
    },
];

/// Audio receipts track sync revisions only; transcripts never require AI redaction.
pub fn is_audio_surface(kind: &str) -> bool {
    matches!(kind, "audio" | "segments")
}

/// Scheduling includes audio receipt bookkeeping, which never invokes a detector.
pub fn text_release_kinds() -> Vec<&'static str> {
    SURFACES
        .iter()
        .filter(|s| s.kind != "image")
        .map(|s| s.kind)
        .collect()
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS _privacy_policy(id INTEGER PRIMARY KEY CHECK(id=1),identity TEXT NOT NULL,text_required INTEGER NOT NULL,image_required INTEGER NOT NULL,epoch INTEGER NOT NULL DEFAULT 0,revocation INTEGER NOT NULL DEFAULT 0);
INSERT OR IGNORE INTO _privacy_policy(id,identity,text_required,image_required,epoch,revocation) VALUES(1,'',0,0,0,0);
CREATE TABLE IF NOT EXISTS _privacy_release(kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,policy TEXT,attempts INTEGER NOT NULL DEFAULT 0,retry_at INTEGER,PRIMARY KEY(kind,id));
CREATE TABLE IF NOT EXISTS _privacy_ready(sequence INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,policy TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS _privacy_certified ON _privacy_release(kind,policy,id);
CREATE INDEX IF NOT EXISTS _privacy_pending ON _privacy_release(kind,retry_at) WHERE policy IS NULL;
CREATE INDEX IF NOT EXISTS _privacy_ready_stream ON _privacy_ready(kind,sequence);
CREATE INDEX IF NOT EXISTS _privacy_ready_record ON _privacy_ready(kind,id);
CREATE TABLE IF NOT EXISTS _privacy_discovery(kind TEXT PRIMARY KEY,policy TEXT NOT NULL,after_id INTEGER NOT NULL DEFAULT 0,complete INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS _privacy_work(sequence INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,id TEXT NOT NULL,available_at INTEGER NOT NULL,UNIQUE(kind,id));
CREATE INDEX IF NOT EXISTS _privacy_work_due ON _privacy_work(kind,available_at,sequence);
CREATE TRIGGER IF NOT EXISTS privacy_enqueue_insert AFTER INSERT ON _privacy_release WHEN NEW.policy IS NULL BEGIN
 INSERT INTO _privacy_work(kind,id,available_at) VALUES(NEW.kind,NEW.id,unixepoch()) ON CONFLICT(kind,id) DO UPDATE SET available_at=excluded.available_at;
END;
CREATE TRIGGER IF NOT EXISTS privacy_enqueue_update AFTER UPDATE OF policy,revision ON _privacy_release WHEN NEW.policy IS NULL BEGIN
 INSERT INTO _privacy_work(kind,id,available_at) VALUES(NEW.kind,NEW.id,unixepoch()) ON CONFLICT(kind,id) DO UPDATE SET available_at=excluded.available_at;
 DELETE FROM _privacy_ready WHERE kind=NEW.kind AND id=NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS privacy_dequeue_update AFTER UPDATE OF policy ON _privacy_release WHEN NEW.policy IS NOT NULL BEGIN
 DELETE FROM _privacy_work WHERE kind=NEW.kind AND id=NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS privacy_dequeue_delete AFTER DELETE ON _privacy_release BEGIN
 DELETE FROM _privacy_work WHERE kind=OLD.kind AND id=OLD.id;
 DELETE FROM _privacy_ready WHERE kind=OLD.kind AND id=OLD.id;
END;
"#;

fn err(message: &str) -> sqlx::Error {
    sqlx::Error::Protocol(message.into())
}

impl DatabaseManager {
    /// Configure before exposing the API or starting sync. Existing timestamp
    /// markers deliberately confer no release authority.
    pub async fn configure_release(&self, policy: &ReleasePolicy) -> Result<(), sqlx::Error> {
        if (policy.text || policy.images) && policy.identity.is_empty() {
            return Err(err("privacy policy identity is required"));
        }
        let mut tx = self.begin_immediate_with_retry().await?;
        sqlx::raw_sql(SCHEMA).execute(&mut **tx.conn()).await?;
        // The full model identity is stored once. Receipt keys are local policy
        // generations, so long remote/model identities cannot multiply across
        // every captured row and index. Upgrade existing draft receipts in place.
        let compact: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pragma_table_info('_privacy_policy') WHERE name='receipt_key')")
            .fetch_one(&mut **tx.conn()).await?;
        if !compact {
            sqlx::query(
                "ALTER TABLE _privacy_policy ADD COLUMN receipt_key INTEGER NOT NULL DEFAULT 1",
            )
            .execute(&mut **tx.conn())
            .await?;
            sqlx::query("UPDATE _privacy_release SET policy=CASE WHEN policy=(SELECT identity FROM _privacy_policy WHERE id=1) THEN '1' ELSE NULL END WHERE policy IS NOT NULL")
                .execute(&mut **tx.conn()).await?;
            sqlx::query("DELETE FROM _privacy_ready WHERE policy!=(SELECT identity FROM _privacy_policy WHERE id=1)")
                .execute(&mut **tx.conn()).await?;
            sqlx::query("UPDATE _privacy_ready SET policy='1'")
                .execute(&mut **tx.conn())
                .await?;
        }
        let has_completed_at: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('_privacy_release') WHERE name='completed_at')"
        ).fetch_one(&mut **tx.conn()).await?;
        if !has_completed_at {
            sqlx::query("ALTER TABLE _privacy_release ADD COLUMN completed_at INTEGER")
                .execute(&mut **tx.conn())
                .await?;
        }
        super::privacy_exports::install(&mut **tx.conn()).await?;
        super::redaction_status::install(&mut **tx.conn(), self.storage.is_some()).await?;
        sqlx::query("DELETE FROM _privacy_export_scan WHERE EXISTS(SELECT 1 FROM _privacy_policy WHERE identity!=? OR text_required!=? OR image_required!=?)")
            .bind(&policy.identity).bind(policy.text).bind(policy.images).execute(&mut **tx.conn()).await?;
        sqlx::query("UPDATE _privacy_export_sources SET pending=1,delivered_version=NULL WHERE EXISTS(SELECT 1 FROM _privacy_policy WHERE identity!=? OR text_required!=? OR image_required!=?)")
            .bind(&policy.identity).bind(policy.text).bind(policy.images).execute(&mut **tx.conn()).await?;
        sqlx::query("DELETE FROM _privacy_discovery WHERE EXISTS(SELECT 1 FROM _privacy_policy WHERE identity!=? OR text_required!=? OR image_required!=?)")
            .bind(&policy.identity).bind(policy.text).bind(policy.images).execute(&mut **tx.conn()).await?;
        sqlx::query("UPDATE _privacy_policy SET identity=?,text_required=?,image_required=?,receipt_key=receipt_key+1,epoch=epoch+1,revocation=revocation+1 WHERE identity!=? OR text_required!=? OR image_required!=?")
            .bind(&policy.identity).bind(policy.text).bind(policy.images).bind(&policy.identity).bind(policy.text).bind(policy.images).execute(&mut **tx.conn()).await?;
        let mut schema_changed = false;
        for surface in SURFACES {
            let physical = if surface.table == "elements"
                && self.storage.as_ref().is_some_and(|s| s.has_bulk())
            {
                "_bulk_element_rows"
            } else {
                surface.table
            };
            let table_type: Option<String> =
                sqlx::query_scalar("SELECT type FROM sqlite_master WHERE name=?")
                    .bind(physical)
                    .fetch_optional(&mut **tx.conn())
                    .await?;
            // The specialized hybrid elements virtual table cannot own normal
            // triggers. Keep it closed until its adapter certifies revisions.
            if table_type.as_deref() != Some("table") {
                continue;
            }
            let columns: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_table_info(?)")
                .bind(physical)
                .fetch_all(&mut **tx.conn())
                .await?;
            if !surface
                .columns
                .iter()
                .all(|c| columns.iter().any(|existing| existing == c))
            {
                continue;
            }
            // Image eligibility depends on capture time as well as its paths.
            // Correcting a clock-skewed timestamp must reset its queued deadline.
            let mut watched = surface.columns.to_vec();
            if surface.kind == "exports" {
                watched.extend(["source_version", "template_json", "timestamp"]);
            }
            // Changes to exported timing revoke an assembled source version too.
            if matches!(surface.kind, "frames" | "image" | "audio" | "input") {
                watched.push("timestamp");
            }
            if surface.kind == "memory" {
                watched.push("created_at");
            }
            if physical == "_bulk_element_rows" {
                watched.push("_archive_deleted");
            }
            let changed = watched
                .iter()
                .map(|c| format!("NEW.\"{c}\" IS NOT OLD.\"{c}\""))
                .collect::<Vec<_>>()
                .join(" OR ");
            let names = watched
                .iter()
                .map(|c| format!("\"{c}\""))
                .collect::<Vec<_>>()
                .join(",");
            let mut changed_contract = false;
            for event in ["INSERT", "UPDATE", "DELETE"] {
                let id = if event == "DELETE" {
                    "OLD.id"
                } else {
                    "NEW.id"
                };
                let clause = if event == "UPDATE" {
                    format!("UPDATE OF {names}")
                } else {
                    event.into()
                };
                let maintenance = if self.storage.is_some()
                    && (event == "UPDATE"
                        || (event == "DELETE" && physical == "_bulk_element_rows"))
                {
                    " AND (SELECT maintenance=0 FROM storage_metadata WHERE singleton=1)"
                } else {
                    ""
                };
                let kind = surface.kind;
                let requirement = if kind == "image" {
                    "image_required"
                } else {
                    "text_required"
                };
                let active = format!("((SELECT {requirement} FROM _privacy_policy WHERE id=1)=1 OR EXISTS(SELECT 1 FROM _privacy_release WHERE kind='{kind}' AND id=CAST({id} AS TEXT)))");
                let when = if event == "UPDATE" {
                    format!("WHEN {active} AND ({changed}){maintenance}")
                } else {
                    format!("WHEN {active}{maintenance}")
                };
                let table = physical;
                let mutation = if event == "DELETE" && kind == "exports" {
                    // Upload-copy IDs are AUTOINCREMENT and never reused. Their
                    // source version markers survive separately after delivery.
                    format!("DELETE FROM _privacy_release WHERE kind='exports' AND id=CAST({id} AS TEXT);")
                } else if event == "DELETE" {
                    format!("UPDATE _privacy_release SET revision=revision+1,policy=NULL,attempts=0,retry_at=NULL WHERE kind='{kind}' AND id=CAST({id} AS TEXT); DELETE FROM _privacy_work WHERE kind='{kind}' AND id=CAST({id} AS TEXT);")
                } else {
                    format!("INSERT INTO _privacy_release(kind,id,revision) VALUES('{kind}',CAST({id} AS TEXT),1) ON CONFLICT(kind,id) DO UPDATE SET revision=revision+1,policy=NULL,attempts=0,retry_at=NULL;")
                };
                let mutation = if physical == "_bulk_element_rows" && event != "DELETE" {
                    format!("{mutation} DELETE FROM _privacy_work WHERE kind='{kind}' AND id=CAST({id} AS TEXT) AND NEW._archive_deleted=1;")
                } else {
                    mutation
                };
                let create_trigger = |when: &str| {
                    format!("CREATE TRIGGER privacy_{kind}_{event} AFTER {clause} ON {table} {when} BEGIN
                  UPDATE _privacy_policy SET epoch=epoch+1,revocation=revocation+1 WHERE EXISTS(SELECT 1 FROM _privacy_release WHERE kind='{kind}' AND id=CAST({id} AS TEXT) AND policy IS NOT NULL);
                  {mutation}
                  END")
                };
                let old_image_update =
                    (kind == "image" && event == "UPDATE").then(|| create_trigger(&when));
                let create = if old_image_update.is_some() {
                    let changed = watched
                        .iter()
                        .map(|column| {
                            let changed = format!("NEW.\"{column}\" IS NOT OLD.\"{column}\"");
                            if *column == "snapshot_path" {
                                format!(
                                    "({changed} AND NOT ({} AND EXISTS(SELECT 1 FROM _privacy_release r JOIN _privacy_policy p ON CAST(p.receipt_key AS TEXT)=r.policy WHERE r.kind='image' AND r.id=CAST(NEW.id AS TEXT))))",
                                    crate::storage::read_schema::SNAPSHOT_MEDIA_RELOCATION
                                )
                            } else {
                                changed
                            }
                        })
                        .collect::<Vec<_>>()
                        .join(" OR ");
                    // Relocation preserves the image receipt. A simultaneous
                    // name or timestamp edit still invalidates that receipt.
                    // Pending inference must restart against the new locator:
                    // it may still be processing the JPEG that compaction moved.
                    create_trigger(&format!("WHEN {active} AND ({changed}){maintenance}"))
                } else {
                    create_trigger(&when)
                };
                let existing: Option<String> = sqlx::query_scalar(
                    "SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?",
                )
                .bind(format!("privacy_{kind}_{event}"))
                .fetch_optional(&mut **tx.conn())
                .await?;
                // Policy changes only update policy data. Recreating unchanged
                // triggers invalidates cached FTS/write statements in other
                // pooled connections and adds needless schema-lock work.
                if existing.as_deref() != Some(create.as_str()) {
                    // This exact installed image contract already certified all
                    // watched values. Removing its relocation false positive
                    // adds no coverage and needs no historical reprocessing.
                    changed_contract |=
                        existing.is_some() && existing.as_deref() != old_image_update.as_deref();
                    schema_changed = true;
                    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
                        "DROP TRIGGER IF EXISTS privacy_{kind}_{event}; {create};"
                    )))
                    .execute(&mut **tx.conn())
                    .await?;
                }
            }
            if changed_contract {
                // A receipt from an older field/trigger contract cannot certify
                // newly covered values, even if the model policy did not change.
                sqlx::query("UPDATE _privacy_release SET policy=NULL,revision=revision+1,attempts=0,retry_at=NULL WHERE kind=?")
                    .bind(surface.kind).execute(&mut **tx.conn()).await?;
                sqlx::query("DELETE FROM _privacy_discovery WHERE kind=?")
                    .bind(surface.kind)
                    .execute(&mut **tx.conn())
                    .await?;
                sqlx::query(
                    "UPDATE _privacy_policy SET epoch=epoch+1,revocation=revocation+1 WHERE id=1",
                )
                .execute(&mut **tx.conn())
                .await?;
            }
        }
        if self.storage.is_some() {
            sqlx::raw_sql("CREATE TRIGGER IF NOT EXISTS privacy_frame_generation AFTER UPDATE OF generation ON frame_payloads WHEN NEW.generation != OLD.generation BEGIN
              UPDATE _privacy_policy SET epoch=epoch+1,revocation=revocation+1 WHERE EXISTS(SELECT 1 FROM _privacy_release WHERE kind='frames' AND id=CAST(NEW.frame_id AS TEXT) AND policy IS NOT NULL);
              INSERT INTO _privacy_release(kind,id,revision) VALUES('frames',CAST(NEW.frame_id AS TEXT),1) ON CONFLICT(kind,id) DO UPDATE SET revision=revision+1,policy=NULL,attempts=0,retry_at=NULL;
            END;").execute(&mut **tx.conn()).await?;
        }
        tx.commit().await?;
        if schema_changed {
            // As with storage trigger migrations, connections opened before
            // the schema change need a schema read before their first DML.
            // Configuration owns startup admission, before API/capture workers.
            let _writer = self.coordinated_writer().lock().await?;
            let mut writers = Vec::new();
            for _ in 0..self.write_pool.size() {
                let mut conn = self.write_pool.acquire().await?;
                sqlx::query("SELECT name FROM main.sqlite_schema LIMIT 1")
                    .fetch_optional(&mut *conn)
                    .await?;
                writers.push(conn);
            }
        }
        if policy.text {
            self.set_frame_privacy_policy(&crate::storage::PrivacyPolicy {
                identity: policy.identity.clone(),
                required_surfaces: 63,
            })
            .await?;
        }
        Ok(())
    }

    pub async fn release_policy(&self) -> Result<ReleasePolicy, sqlx::Error> {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='_privacy_policy')",
        )
        .fetch_one(&self.pool)
        .await?;
        if !exists {
            return Ok(ReleasePolicy::default());
        }
        let row = sqlx::query(
            "SELECT identity,text_required,image_required FROM _privacy_policy WHERE id=1",
        )
        .fetch_one(&self.pool)
        .await?;
        Ok(ReleasePolicy {
            identity: row.get("identity"),
            text: row.get("text_required"),
            images: row.get("image_required"),
        })
    }

    pub async fn release_pending(
        &self,
        kind: &str,
        limit: u32,
    ) -> Result<Vec<ReleaseJob>, sqlx::Error> {
        self.release_pending_aged(kind, limit, 0).await
    }

    pub async fn release_pending_aged(
        &self,
        kind: &str,
        limit: u32,
        min_age_seconds: i64,
    ) -> Result<Vec<ReleaseJob>, sqlx::Error> {
        self.release_pending_ordered(kind, limit, min_age_seconds, false)
            .await
    }

    /// Select from the indexed work queue. Alternate recent and oldest work in
    /// callers so continuous capture cannot starve historical records.
    pub async fn release_pending_ordered(
        &self,
        kind: &str,
        limit: u32,
        min_age_seconds: i64,
        oldest: bool,
    ) -> Result<Vec<ReleaseJob>, sqlx::Error> {
        if limit == 0 {
            return Ok(vec![]);
        }
        let surface = SURFACES
            .iter()
            .find(|s| s.kind == kind)
            .ok_or_else(|| err("unknown privacy surface"))?;
        let policy = self.release_policy().await?;
        if !(if kind == "image" {
            policy.images
        } else {
            policy.text
        }) {
            return Ok(vec![]);
        }
        let columns = surface
            .columns
            .iter()
            .map(|c| format!("s.\"{c}\""))
            .collect::<Vec<_>>()
            .join(",");
        let age = if kind == "image" {
            format!(
                " AND unixepoch(s.timestamp)<=unixepoch()-{}",
                min_age_seconds.max(0)
            )
        } else {
            String::new()
        };
        self.discover_release_work(surface, &policy.identity)
            .await?;
        let order = if oldest { "ASC" } else { "DESC" };
        if kind == "image" && min_age_seconds > 0 {
            self.schedule_image_maturity(min_age_seconds).await?;
        }
        // Candidate traversal is bounded even for malformed/future timestamps.
        // Young images move to a future deadline; subsequent polls advance past
        // them. The source lookup never scans certified capture history.
        // Audio no longer uses the detector that scheduled old retry deadlines.
        // Complete its revision bookkeeping without waiting for those failures.
        let due = if is_audio_surface(kind) {
            "1"
        } else {
            "available_at<=unixepoch()"
        };
        let sql = format!("WITH candidates AS MATERIALIZED (SELECT kind,id,available_at,sequence FROM _privacy_work INDEXED BY _privacy_work_due WHERE kind=? AND {due} ORDER BY available_at {order},sequence {order} LIMIT 256) SELECT CAST(s.id AS TEXT) AS source_id,r.revision,{columns} FROM candidates w CROSS JOIN _privacy_release r ON r.kind=w.kind AND r.id=w.id CROSS JOIN {} s ON s.id=w.id WHERE r.policy IS NULL{age} ORDER BY w.available_at {order},w.sequence {order} LIMIT ?", surface.table);
        let mut rows = sqlx::query(sqlx::AssertSqlSafe(sql.clone()))
            .bind(kind)
            .bind(limit.min(256))
            .fetch_all(&self.pool)
            .await?;
        // Recent young captures must not make the worker sleep while an old
        // mature backlog is runnable. One bounded fallback preserves fairness.
        if rows.is_empty() && kind == "image" && !oldest {
            rows = sqlx::query(sqlx::AssertSqlSafe(sql.replace("DESC", "ASC")))
                .bind(kind)
                .bind(limit.min(256))
                .fetch_all(&self.pool)
                .await?;
        }
        let mut jobs: Vec<ReleaseJob> = rows
            .iter()
            .map(|row| {
                let values = surface
                    .columns
                    .iter()
                    .map(|c| Ok((c.to_string(), row.try_get(*c)?)))
                    .collect::<Result<_, sqlx::Error>>()?;
                Ok(ReleaseJob {
                    redaction: Default::default(),
                    kind: kind.into(),
                    id: row.try_get("source_id")?,
                    revision: row.try_get("revision")?,
                    policy: policy.identity.clone(),
                    values,
                    storage_generation: None,
                })
            })
            .collect::<Result<_, sqlx::Error>>()?;
        if self.storage.is_some() && kind == "frames" {
            let ids = jobs
                .iter()
                .filter_map(|j| j.id.parse().ok())
                .collect::<Vec<i64>>();
            let mut payloads = self
                .frame_payloads(&ids, crate::storage::Projection::All)
                .await?;
            for job in &mut jobs {
                let payload = payloads
                    .remove(&job.id.parse().map_err(|_| err("invalid frame id"))?)
                    .ok_or_else(|| err("frame changed during privacy read"))?;
                job.storage_generation = Some(payload.generation);
                job.values.insert("full_text".into(), payload.full_text);
                job.values
                    .insert("accessibility_text".into(), payload.accessibility_text);
                job.values.insert(
                    "accessibility_tree_json".into(),
                    payload.accessibility_tree_json,
                );
                job.values.insert("text_json".into(), payload.text_json);
            }
        }
        Ok(jobs)
    }

    async fn schedule_image_maturity(&self, min_age: i64) -> Result<(), sqlx::Error> {
        // Move at most one bounded page out of the runnable queue per poll.
        // This also handles skewed/future timestamps without busy-looping or
        // making every empty poll scan all pending young screenshots.
        let rows: Vec<(i64, i64, i64)> = sqlx::query_as("WITH candidates AS MATERIALIZED (SELECT sequence,id FROM _privacy_work WHERE kind='image' AND available_at<=unixepoch() ORDER BY available_at,sequence LIMIT 256) SELECT w.sequence,COALESCE(unixepoch(s.timestamp)+?,unixepoch()+3600),r.revision FROM candidates w CROSS JOIN frames s ON s.id=w.id CROSS JOIN _privacy_release r ON r.kind='image' AND r.id=w.id WHERE unixepoch(s.timestamp) IS NULL OR unixepoch(s.timestamp)+?>unixepoch()")
            .bind(min_age).bind(min_age).fetch_all(&self.pool).await?;
        if rows.is_empty() {
            return Ok(());
        }
        let mut tx = self.begin_immediate_with_retry().await?;
        for (sequence, deadline, revision) in rows {
            sqlx::query(
                "UPDATE _privacy_work SET available_at=MAX(available_at,?) WHERE sequence=? AND EXISTS(SELECT 1 FROM _privacy_release r WHERE r.kind=_privacy_work.kind AND r.id=_privacy_work.id AND r.revision=?)",
            )
            .bind(deadline)
            .bind(sequence)
            .bind(revision)
            .execute(&mut **tx.conn())
            .await?;
        }
        tx.commit().await
    }

    /// Discover legacy captures and policy rechecks in bounded primary-key
    /// pages. The durable cursor survives restart; capture never waits for a
    /// history-sized transaction. New captures enqueue through source triggers.
    async fn discover_release_work(
        &self,
        surface: &Surface,
        policy: &str,
    ) -> Result<(), sqlx::Error> {
        let state: Option<(String, i64, bool)> =
            sqlx::query_as("SELECT policy,after_id,complete FROM _privacy_discovery WHERE kind=?")
                .bind(surface.kind)
                .fetch_optional(&self.pool)
                .await?;
        if state
            .as_ref()
            .is_some_and(|(p, _, complete)| p == policy && *complete)
        {
            return Ok(());
        }
        let mut tx = self.begin_immediate_with_retry().await?;
        // Re-read inside the writer to serialize concurrent discovery callers.
        let current: String = sqlx::query_scalar("SELECT identity FROM _privacy_policy WHERE id=1")
            .fetch_one(&mut **tx.conn())
            .await?;
        if current != policy {
            return Ok(());
        }
        sqlx::query("INSERT INTO _privacy_discovery(kind,policy) VALUES(?,?) ON CONFLICT(kind) DO UPDATE SET policy=excluded.policy,after_id=0,complete=0 WHERE policy!=excluded.policy")
            .bind(surface.kind).bind(policy).execute(&mut **tx.conn()).await?;
        let (after, complete): (i64, bool) =
            sqlx::query_as("SELECT after_id,complete FROM _privacy_discovery WHERE kind=?")
                .bind(surface.kind)
                .fetch_one(&mut **tx.conn())
                .await?;
        if complete {
            return Ok(());
        }
        let ids: Vec<(i64, bool)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "SELECT s.id,EXISTS(SELECT 1 FROM _privacy_work w WHERE w.kind=? AND w.id=CAST(s.id AS TEXT)) FROM {} s WHERE s.id>? ORDER BY s.id LIMIT 128",
            surface.table
        )))
        .bind(surface.kind)
        .bind(after)
        .fetch_all(&mut **tx.conn())
        .await?;
        for (id, already_queued) in &ids {
            sqlx::query("INSERT INTO _privacy_release(kind,id) VALUES(?,CAST(? AS TEXT)) ON CONFLICT(kind,id) DO UPDATE SET policy=NULL,attempts=0,retry_at=NULL WHERE policy IS NOT NULL AND policy!=(SELECT receipt_key FROM _privacy_policy WHERE identity=?)")
                .bind(surface.kind).bind(id).bind(policy).execute(&mut **tx.conn()).await?;
            // Discovery is old work even though enrollment happens now. Giving
            // it today's queue time lets every history page jump ahead of live
            // capture in the recent-first lane. Keep existing capture/retry
            // deadlines, and enroll newly discovered history at the old end.
            // This also recovers pending receipts from earlier draft versions.
            sqlx::query("INSERT INTO _privacy_work(kind,id,available_at) SELECT kind,id,COALESCE(retry_at,0) FROM _privacy_release WHERE kind=? AND id=CAST(? AS TEXT) AND policy IS NULL ON CONFLICT(kind,id) DO UPDATE SET available_at=excluded.available_at WHERE ?=0")
                .bind(surface.kind).bind(id).bind(already_queued).execute(&mut **tx.conn()).await?;
        }
        sqlx::query("UPDATE _privacy_discovery SET after_id=?,complete=? WHERE kind=?")
            .bind(ids.last().map(|(id, _)| *id).unwrap_or(after))
            .bind(ids.len() < 128)
            .bind(surface.kind)
            .execute(&mut **tx.conn())
            .await?;
        tx.commit().await
    }

    /// Cheap validity check before resuming a partially processed record.
    /// Atomic publication repeats this check, so this is an optimization only.
    pub async fn release_job_current(&self, job: &ReleaseJob) -> Result<bool, sqlx::Error> {
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM _privacy_release r JOIN _privacy_policy p ON p.id=1 WHERE r.kind=? AND r.id=? AND r.revision=? AND r.policy IS NULL AND p.identity=? AND ((r.kind='image' AND p.image_required=1) OR (r.kind!='image' AND p.text_required=1)))")
            .bind(&job.kind).bind(&job.id).bind(job.revision).bind(&job.policy).fetch_one(&self.pool).await
    }

    /// Commit sanitized values and their receipt together. A concurrent source
    /// edit or policy change rejects the complete result, leaving it retryable.
    pub async fn publish_release(
        &self,
        job: &ReleaseJob,
        values: &BTreeMap<String, Option<String>>,
    ) -> Result<bool, sqlx::Error> {
        let surface = SURFACES
            .iter()
            .find(|s| s.kind == job.kind)
            .ok_or_else(|| err("unknown privacy surface"))?;
        if values.len() != surface.columns.len()
            || !surface.columns.iter().all(|c| values.contains_key(*c))
        {
            return Err(err("incomplete privacy result"));
        }
        if job.kind == "image" {
            return Err(err("image certification requires the media adapter"));
        }
        // Hybrid frame replacements must use generation-aware storage. Never
        // update archived payload columns through raw SQL.
        if self.storage.is_some() && surface.table == "frames" {
            let payload = crate::storage::FramePayload {
                id: job.id.parse().map_err(|_| err("invalid frame id"))?,
                generation: job
                    .storage_generation
                    .ok_or_else(|| err("missing frame generation"))?,
                full_text: values["full_text"].clone(),
                accessibility_text: values["accessibility_text"].clone(),
                accessibility_tree_json: values["accessibility_tree_json"].clone(),
                text_json: values["text_json"].clone(),
            };
            return self
                .replace_frame_payload_with_release(
                    &payload,
                    &job.policy,
                    63,
                    values["window_name"].as_deref(),
                    values["browser_url"].as_deref(),
                    Some((job, values)),
                    None,
                    None,
                )
                .await;
        }
        let mut tx = self.begin_immediate_with_retry().await?;
        let current: (String, i64, bool) = sqlx::query_as("SELECT identity,COALESCE((SELECT revision FROM _privacy_release WHERE kind=? AND id=? AND policy IS NULL),-1),text_required FROM _privacy_policy WHERE id=1").bind(&job.kind).bind(&job.id).fetch_one(&mut **tx.conn()).await?;
        if current != (job.policy.clone(), job.revision, true) {
            return Ok(false);
        }
        let set = surface
            .columns
            .iter()
            .map(|c| format!("\"{c}\"=?"))
            .collect::<Vec<_>>()
            .join(",");
        let mut query = sqlx::query(sqlx::AssertSqlSafe(format!(
            "UPDATE {} SET {set} WHERE id=?",
            surface.table
        )));
        for column in surface.columns {
            query = query.bind(values.get(*column).unwrap());
        }
        if query
            .bind(&job.id)
            .execute(&mut **tx.conn())
            .await?
            .rows_affected()
            == 0
        {
            return Ok(false);
        }
        // Legacy compaction eligibility is independent from release authority.
        if matches!(job.kind.as_str(), "audio" | "input" | "elements") {
            sqlx::query(sqlx::AssertSqlSafe(format!(
                "UPDATE {} SET redacted_at=unixepoch() WHERE id=?",
                surface.table
            )))
            .bind(&job.id)
            .execute(&mut **tx.conn())
            .await?;
        }
        if job.kind == "exports" {
            let (stream, template): (String, String) =
                sqlx::query_as("SELECT stream,template_json FROM _privacy_exports WHERE id=?")
                    .bind(&job.id)
                    .fetch_one(&mut **tx.conn())
                    .await?;
            let row = super::privacy_exports::restore_payload(
                &template,
                values["text_json"]
                    .as_deref()
                    .ok_or_else(|| err("missing derived text"))?,
            )?;
            let row = super::privacy_exports::local_sql_payload(&stream, row);
            sqlx::query("UPDATE _privacy_exports SET released_json=? WHERE id=?")
                .bind(row.to_string())
                .bind(&job.id)
                .execute(&mut **tx.conn())
                .await?;
        }
        certify(&mut **tx.conn(), job).await?;
        tx.commit().await?;
        Ok(true)
    }

    pub async fn release_ready(&self, kind: &str, id: &str) -> Result<bool, sqlx::Error> {
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM _privacy_release r JOIN _privacy_policy p ON CAST(p.receipt_key AS TEXT)=r.policy WHERE r.kind=? AND r.id=?)")
            .bind(kind).bind(id).fetch_one(&self.pool).await
    }

    pub async fn ready_changes(
        &self,
        after: i64,
        limit: u32,
    ) -> Result<Vec<ReadyChange>, sqlx::Error> {
        let rows=sqlx::query("SELECT c.sequence,c.kind,c.id,c.revision FROM _privacy_ready c JOIN _privacy_release r ON r.kind=c.kind AND r.id=c.id AND r.revision=c.revision AND r.policy=c.policy JOIN _privacy_policy p ON CAST(p.receipt_key AS TEXT)=c.policy WHERE c.sequence>? ORDER BY c.sequence LIMIT ?")
            .bind(after).bind(limit).fetch_all(&self.pool).await?;
        rows.iter()
            .map(|r| {
                Ok(ReadyChange {
                    sequence: r.try_get("sequence")?,
                    kind: r.try_get("kind")?,
                    id: r.try_get("id")?,
                    revision: r.try_get("revision")?,
                })
            })
            .collect()
    }
}

impl DatabaseManager {
    pub fn protected_reads_enabled(&self) -> bool {
        self.release_owner.is_some()
    }

    /// A separate read adapter shares the existing writer and its owner. Raw
    /// internal worker reads never accidentally inherit consumer filtering.
    pub async fn protected_reads(self: &Arc<Self>) -> Result<Arc<Self>, sqlx::Error> {
        if self.release_owner.is_some() {
            return Ok(Arc::clone(self));
        }
        let policy = self.release_policy().await?;
        if !policy.text && !policy.images {
            return Ok(Arc::clone(self));
        }
        let storage = self.storage.clone();
        let mut views = Vec::new();
        for surface in SURFACES
            .iter()
            .filter(|s| s.kind != "image" && !is_audio_surface(s.kind))
        {
            let exists: bool =
                sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name=?)")
                    .bind(surface.table)
                    .fetch_one(&self.pool)
                    .await?;
            if !exists {
                continue;
            }
            let logical = format!("_bulk_logical_{}", surface.table);
            let bulk: bool =
                sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name=?)")
                    .bind(&logical)
                    .fetch_one(&self.pool)
                    .await?;
            let source = if bulk { logical } else { surface.table.into() };
            let columns: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_table_info(?)")
                .bind(surface.table)
                .fetch_all(&self.pool)
                .await?;
            let preserve_structure = matches!(surface.kind, "activity_tasks" | "activity_actions");
            let ready = format!("gate.text_required=0 OR EXISTS(SELECT 1 FROM _privacy_release r INDEXED BY _privacy_certified WHERE r.kind='{}' AND r.policy=CAST(gate.receipt_key AS TEXT) AND r.id=CAST(s.id AS TEXT))", surface.kind);
            let projection=columns.iter().map(|column| {
                if preserve_structure && surface.columns.contains(&column.as_str()) {
                    let placeholder = match column.as_str() {
                        "title" => "'Activity — privacy processing'",
                        "summary" => "'Action — privacy processing'",
                        _ => "NULL",
                    };
                    return format!("CASE WHEN {ready} THEN s.\"{column}\" ELSE {placeholder} END AS \"{column}\"");
                }
                if surface.table=="frames" && matches!(column.as_str(),"name"|"snapshot_path"|"video_chunk_id") {
                    format!("CASE WHEN gate.image_required=0 OR EXISTS(SELECT 1 FROM _privacy_release r INDEXED BY _privacy_certified WHERE r.kind='image' AND r.policy=CAST(gate.receipt_key AS TEXT) AND r.id=CAST(s.id AS TEXT)) THEN s.\"{column}\" END AS \"{column}\"")
                } else {format!("s.\"{column}\"")}
            }).collect::<Vec<_>>().join(",");
            if preserve_structure {
                views.push(format!("CREATE TEMP VIEW {} AS SELECT {projection} FROM _privacy_policy gate CROSS JOIN main.{source} s WHERE gate.id=1;", surface.table));
                continue;
            }
            // Check the singleton policy and indexed existence of any certified
            // row before traversing capture history. An entirely pending backlog
            // must return empty without one receipt lookup per captured row.
            views.push(format!("DROP VIEW IF EXISTS temp.{t}; CREATE TEMP VIEW {t} AS SELECT {projection} FROM _privacy_policy gate CROSS JOIN main.{source} s WHERE gate.id=1 AND (gate.text_required=0 OR EXISTS(SELECT 1 FROM _privacy_release r WHERE r.kind='{kind}' AND r.policy=CAST(gate.receipt_key AS TEXT))) AND (gate.text_required=0 OR EXISTS(SELECT 1 FROM _privacy_release r INDEXED BY _privacy_certified WHERE r.kind='{kind}' AND r.policy=CAST(gate.receipt_key AS TEXT) AND r.id=CAST(s.id AS TEXT)));",t=surface.table,kind=surface.kind));
        }
        for surface in super::privacy_exports::LOCAL_SURFACES {
            let table = surface.table;
            let columns: Vec<(String, bool)> =
                sqlx::query_as("SELECT name,\"notnull\" FROM pragma_table_info(?)")
                    .bind(table)
                    .fetch_all(&self.pool)
                    .await?;
            let projection = columns.iter().map(|(column, required)| {
                if !surface.columns.contains(&column.as_str()) { return format!("s.\"{column}\""); }
                let pending = if !required { "NULL" } else if surface.json.contains(&column.as_str()) { "'{}'" } else { "'Privacy processing'" };
                format!("CASE WHEN gate.text_required=0 THEN s.\"{column}\" WHEN r.policy=CAST(gate.receipt_key AS TEXT) THEN json_extract(e.released_json,'$.{column}') ELSE {pending} END AS \"{column}\"")
            }).collect::<Vec<_>>().join(",");
            views.push(format!("DROP VIEW IF EXISTS temp.{table}; CREATE TEMP VIEW {table} AS SELECT {projection} FROM _privacy_policy gate CROSS JOIN main.{table} s LEFT JOIN _privacy_exports e ON e.stream='local_{table}' AND e.source_id=CAST(s.id AS TEXT) LEFT JOIN _privacy_release r ON r.kind='exports' AND r.id=CAST(e.id AS TEXT) WHERE gate.id=1;"));
        }
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(self.pool.options().get_max_connections())
            .acquire_timeout(Duration::from_secs(5))
            .after_connect(move |conn, _| {
                let storage = storage.clone();
                let views = views.clone();
                Box::pin(async move {
                    if let Some(storage) = storage.filter(|s| s.has_bulk()) {
                        crate::storage::bulk::register_connection(conn, storage, true).await?;
                    }
                    sqlx::query("PRAGMA query_only=OFF")
                        .execute(&mut *conn)
                        .await?;
                    for view in views {
                        sqlx::raw_sql(sqlx::AssertSqlSafe(view))
                            .execute(&mut *conn)
                            .await?;
                    }
                    sqlx::query("PRAGMA query_only=ON")
                        .execute(&mut *conn)
                        .await?;
                    Ok(())
                })
            })
            .connect_with(self.pool.connect_options().as_ref().clone())
            .await?;
        crate::recovery::register_database_pool(self.pool.connect_options().get_filename(), &pool);
        let mut registry = self.release_read_pools.lock().await;
        if self.close_token.is_cancelled() {
            drop(registry);
            pool.close().await;
            return Err(sqlx::Error::PoolClosed);
        }
        registry.push(pool.clone());
        drop(registry);
        Ok(self.protected_read_adapter(pool))
    }

    pub(super) fn protected_read_adapter(self: &Arc<Self>, pool: SqlitePool) -> Arc<Self> {
        Arc::new(Self {
            release_owner: Some(Arc::clone(self)),
            redaction_read_pool: Arc::clone(&self.redaction_read_pool),
            release_read_pools: Arc::clone(&self.release_read_pools),
            storage: self.storage.clone(),
            upload_source_id: tokio::sync::OnceCell::new(),
            pool,
            write_pool: self.write_pool.clone(),
            write_semaphore: Arc::clone(&self.write_semaphore),
            heavy_read_semaphore: Arc::clone(&self.heavy_read_semaphore),
            write_queue: self.write_queue.clone(),
            write_queue_health: self.write_queue_health.clone(),
            persistent_failure_hook: self.persistent_failure_hook.clone(),
            manager_lease: None,
            close_token: self.close_token.clone(),
        })
    }

    /// Revokes assembled uploads only when already released content or the
    /// policy changes. New completions do not starve an in-flight batch.
    pub async fn release_revocation(&self) -> Result<Option<i64>, sqlx::Error> {
        let policy = self.release_policy().await?;
        if !policy.text && !policy.images {
            return Ok(None);
        }
        sqlx::query_scalar("SELECT revocation FROM _privacy_policy WHERE id=1")
            .fetch_one(&self.pool)
            .await
            .map(Some)
    }

    /// A refresh must not replace durable intervals using an incomplete source set.
    pub async fn activity_sources_ready(
        &self,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<bool, sqlx::Error> {
        let Some(owner) = &self.release_owner else {
            return Ok(true);
        };
        if !owner.release_policy().await?.text {
            return Ok(true);
        }
        for (kind, table, timestamp) in [
            ("frames", "frames", "timestamp"),
            ("input", "ui_events", "timestamp"),
        ] {
            let pending: bool = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
                "SELECT EXISTS(SELECT 1 FROM {table} s CROSS JOIN _privacy_policy p WHERE p.id=1 AND s.{timestamp}>=? AND s.{timestamp}<? AND julianday(s.{timestamp}) BETWEEN julianday(?) AND julianday(?) AND NOT EXISTS(SELECT 1 FROM _privacy_release r WHERE r.kind=? AND r.id=CAST(s.id AS TEXT) AND r.policy=CAST(p.receipt_key AS TEXT)))")))
                .bind(start.format("%Y-%m-%d").to_string()).bind((end + chrono::Duration::days(1)).format("%Y-%m-%d").to_string()).bind(start.to_rfc3339()).bind(end.to_rfc3339()).bind(kind).fetch_one(&owner.pool).await?;
            if pending {
                return Ok(false);
            }
        }
        Ok(true)
    }

    pub async fn release_epoch(&self) -> Result<Option<i64>, sqlx::Error> {
        if self.release_owner.is_none() {
            return Ok(None);
        }
        sqlx::query_scalar("SELECT epoch FROM _privacy_policy WHERE id=1")
            .fetch_one(&self.pool)
            .await
            .map(Some)
    }
}

// Called only in the same writer transaction as the sanitized replacement.
pub(crate) async fn certify(
    conn: &mut sqlx::SqliteConnection,
    job: &ReleaseJob,
) -> Result<(), sqlx::Error> {
    super::redaction_status::record(
        conn,
        &job.kind,
        job.id
            .parse()
            .map_err(|_| err("invalid evidence record id"))?,
        &job.redaction,
    )
    .await?;
    sqlx::query("INSERT INTO _privacy_release(kind,id,revision,policy) VALUES(?,?,0,(SELECT receipt_key FROM _privacy_policy WHERE identity=?)) ON CONFLICT(kind,id) DO UPDATE SET policy=excluded.policy,attempts=0,retry_at=NULL")
        .bind(&job.kind).bind(&job.id).bind(&job.policy).execute(&mut *conn).await?;
    sqlx::query("UPDATE _privacy_release SET completed_at=unixepoch() WHERE kind=? AND id=?")
        .bind(&job.kind)
        .bind(&job.id)
        .execute(&mut *conn)
        .await?;
    sqlx::query("UPDATE _privacy_policy SET epoch=epoch+1 WHERE id=1")
        .execute(&mut *conn)
        .await?;
    sqlx::query("DELETE FROM _privacy_ready WHERE kind=? AND id=?")
        .bind(&job.kind)
        .bind(&job.id)
        .execute(&mut *conn)
        .await?;
    sqlx::query("INSERT INTO _privacy_ready(kind,id,revision,policy) SELECT kind,id,revision,policy FROM _privacy_release WHERE kind=? AND id=?")
        .bind(&job.kind).bind(&job.id).execute(&mut *conn).await?;
    Ok(())
}

impl DatabaseManager {
    pub async fn defer_release(&self, job: &ReleaseJob) -> Result<(), sqlx::Error> {
        let mut tx = self.begin_immediate_with_retry().await?;
        let pending: crate::FieldRedactions = job
            .redaction
            .iter()
            .filter(|(_, e)| e.result == crate::RedactionResult::Skipped)
            .map(|(k, e)| (k.clone(), e.clone()))
            .collect();
        let current: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM _privacy_release WHERE kind=? AND id=? AND revision=? AND policy IS NULL)").bind(&job.kind).bind(&job.id).bind(job.revision).fetch_one(&mut **tx.conn()).await?;
        if current {
            super::redaction_status::record(
                &mut **tx.conn(),
                &job.kind,
                job.id.parse().map_err(|_| err("invalid evidence id"))?,
                &pending,
            )
            .await?;
        }
        sqlx::query("UPDATE _privacy_release SET attempts=attempts+1,retry_at=unixepoch()+MIN(3600,30*(attempts+1)) WHERE kind=? AND id=? AND revision=? AND policy IS NULL AND (SELECT identity FROM _privacy_policy WHERE id=1)=?")
            .bind(&job.kind).bind(&job.id).bind(job.revision).bind(&job.policy)
            .execute(&mut **tx.conn()).await?;
        sqlx::query("UPDATE _privacy_work SET available_at=(SELECT retry_at FROM _privacy_release r WHERE r.kind=_privacy_work.kind AND r.id=_privacy_work.id) WHERE kind=? AND id=? AND EXISTS(SELECT 1 FROM _privacy_release r WHERE r.kind=_privacy_work.kind AND r.id=_privacy_work.id AND r.retry_at IS NOT NULL)")
            .bind(&job.kind).bind(&job.id).execute(&mut **tx.conn()).await?;
        tx.commit().await
    }
}

impl DatabaseManager {
    /// The image adapter calls this only after successful inference and a
    /// durable atomic replacement. Missing/legacy media never calls it.
    pub async fn publish_image_release(&self, job: &ReleaseJob) -> Result<bool, sqlx::Error> {
        if job.kind != "image" {
            return Err(err("expected image receipt"));
        }
        let mut tx = self.begin_immediate_with_retry().await?;
        let current:(String,i64,bool)=sqlx::query_as("SELECT identity,COALESCE((SELECT revision FROM _privacy_release WHERE kind='image' AND id=? AND policy IS NULL),-1),image_required FROM _privacy_policy WHERE id=1").bind(&job.id).fetch_one(&mut **tx.conn()).await?;
        if current != (job.policy.clone(), job.revision, true) {
            return Ok(false);
        }
        let updated =
            sqlx::query("UPDATE frames SET image_redacted_at=strftime('%s','now') WHERE id=?")
                .bind(&job.id)
                .execute(&mut **tx.conn())
                .await?;
        if updated.rows_affected() == 0 {
            return Ok(false);
        }
        certify(&mut **tx.conn(), job).await?;
        tx.commit().await?;
        Ok(true)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ReleasePage {
    pub sequence: i64,
    pub more: bool,
    pub rows: serde_json::Value,
}

impl DatabaseManager {
    /// Export in completion order, preserving each record's original capture
    /// timestamp. A fixed enrollment cutoff limits what history can leave.
    pub async fn release_export_page(
        &self,
        kind: &str,
        after: i64,
        cutoff: &str,
        limit: u32,
    ) -> Result<ReleasePage, sqlx::Error> {
        self.release_export_range_page(kind, after, cutoff, None, limit)
            .await
    }

    pub async fn release_export_range_page(
        &self,
        kind: &str,
        after: i64,
        cutoff: &str,
        end: Option<&str>,
        limit: u32,
    ) -> Result<ReleasePage, sqlx::Error> {
        if !self.protected_reads_enabled() {
            return Err(err("protected read adapter required"));
        }
        if matches!(kind, "activities" | "parsed" | "feedback") {
            return self
                .derived_release_page(kind, after, cutoff, end, limit)
                .await;
        }
        let (table, projection, time) = export_surface(kind)?;
        let (sequence, more) = self
            .ready_range_window(kind, table, time, None, after, cutoff, end, limit)
            .await?;
        let sql=format!("SELECT {projection} FROM _privacy_ready c JOIN _privacy_release r ON r.kind=c.kind AND r.id=c.id AND r.revision=c.revision AND r.policy=c.policy JOIN _privacy_policy p ON CAST(p.receipt_key AS TEXT)=c.policy JOIN {table} s ON s.id=c.id WHERE c.kind=? AND c.sequence>? AND c.sequence<=? AND julianday(s.{time})>=julianday(?) AND (? IS NULL OR julianday(s.{time})<julianday(?)) ORDER BY c.sequence");
        let rows = sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind(kind)
            .bind(after)
            .bind(sequence)
            .bind(cutoff)
            .bind(end)
            .bind(end)
            .fetch_all(&self.pool)
            .await?;
        let rows = self.hydrate_release_export(kind, &rows).await?;
        Ok(ReleasePage {
            sequence,
            rows,
            more,
        })
    }
    /// The policy generation changes for policy replacement, including a cycle
    /// back to the same identity. Record revocations leave this value unchanged.
    pub async fn release_policy_generation(&self) -> Result<Option<i64>, sqlx::Error> {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='_privacy_policy')",
        )
        .fetch_one(&self.pool)
        .await?;
        if !exists {
            return Ok(None);
        }
        sqlx::query_scalar("SELECT receipt_key FROM _privacy_policy WHERE id=1")
            .fetch_one(&self.pool)
            .await
            .map(Some)
    }

    /// Refresh only selected IDs through current completion receipts. Never
    /// replace a processed export with a raw source, or enroll new captures.
    pub async fn refresh_release_export_selection(
        self: &Arc<Self>,
        kind: &str,
        ids: &[String],
    ) -> Result<serde_json::Value, sqlx::Error> {
        if self.close_token.is_cancelled() {
            return Err(sqlx::Error::PoolClosed);
        }
        let reader = if self.protected_reads_enabled() {
            Arc::clone(self)
        } else {
            // API admission already registered its protected pool. Reuse it
            // across chunks/ticks instead of accumulating a pool per refresh.
            let existing = self
                .release_read_pools
                .lock()
                .await
                .iter()
                .find(|pool| !pool.is_closed())
                .cloned();
            match existing {
                Some(pool) => self.protected_read_adapter(pool),
                None => self.protected_reads().await?,
            }
        };
        reader
            .refresh_release_export_selection_inner(kind, ids)
            .await
    }

    async fn refresh_release_export_selection_inner(
        &self,
        kind: &str,
        ids: &[String],
    ) -> Result<serde_json::Value, sqlx::Error> {
        if !self.protected_reads_enabled() {
            return Err(err("protected read adapter required"));
        }
        if ids.is_empty() {
            return Ok(serde_json::json!([]));
        }
        let ids = serde_json::to_string(ids).map_err(|_| err("invalid export IDs"))?;
        if matches!(kind, "activities" | "parsed" | "feedback") {
            let values: Vec<(String, String)> = sqlx::query_as("SELECT s.template_json,s.text_json FROM json_each(?) selected JOIN _privacy_exports s ON s.source_id=selected.value AND s.stream=? JOIN _privacy_release r ON r.kind='exports' AND r.id=CAST(s.id AS TEXT) JOIN _privacy_policy p ON CAST(p.receipt_key AS TEXT)=r.policy")
                .bind(ids).bind(kind).fetch_all(&self.pool).await?;
            let rows = values
                .into_iter()
                .map(|(template, texts)| super::privacy_exports::restore_payload(&template, &texts))
                .collect::<Result<Vec<_>, _>>()?;
            return Ok(serde_json::json!(rows));
        }
        let (table, projection, _) = export_surface(kind)?;
        let sql = format!("SELECT {projection} FROM json_each(?) selected JOIN {table} s ON s.id=selected.value JOIN _privacy_release r ON r.kind=? AND r.id=CAST(s.id AS TEXT) JOIN _privacy_policy p ON CAST(p.receipt_key AS TEXT)=r.policy");
        let rows = sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind(ids)
            .bind(kind)
            .fetch_all(&self.pool)
            .await?;
        self.hydrate_release_export(kind, &rows).await
    }

    async fn hydrate_release_export(
        &self,
        kind: &str,
        rows: &[sqlx::sqlite::SqliteRow],
    ) -> Result<serde_json::Value, sqlx::Error> {
        let mut rows = Self::raw_sql_rows(rows);
        if let Some(items) = rows.as_array_mut() {
            if kind == "memory" {
                for item in items.iter_mut() {
                    if let Some(tags) = item.get("tags").and_then(|v| v.as_str()) {
                        item["tags"] =
                            serde_json::from_str(tags).map_err(|_| err("invalid memory tags"))?;
                    }
                }
            }
            if kind == "frames" {
                for item in items.iter_mut() {
                    if let Some(tree) = item["accessibility_tree"].as_str() {
                        item["accessibility_tree"] = serde_json::from_str(tree)
                            .map_err(|_| err("invalid accessibility tree"))?;
                    }
                }
            }
            if kind == "frames" && self.storage.is_some() {
                let ids = items
                    .iter()
                    .filter_map(|i| i["frame_id"].as_i64())
                    .collect::<Vec<_>>();
                let payloads = self
                    .frame_payloads(&ids, crate::storage::Projection::All)
                    .await?;
                for item in items.iter_mut() {
                    let id = item["frame_id"]
                        .as_i64()
                        .ok_or_else(|| err("invalid frame id"))?;
                    let payload = payloads
                        .get(&id)
                        .ok_or_else(|| err("frame changed during export"))?;
                    item["accessibility_tree"] = payload
                        .accessibility_tree_json
                        .as_deref()
                        .map(serde_json::from_str::<serde_json::Value>)
                        .transpose()
                        .map_err(|_| err("invalid accessibility tree"))?
                        .unwrap_or(serde_json::Value::Null);
                    item["text"] = serde_json::json!(payload
                        .full_text
                        .as_ref()
                        .or(payload.accessibility_text.as_ref()));
                }
            }
        }
        Ok(rows)
    }
}

/// Bounded, aggregate status for the protected capture surfaces. Counts are
/// lower bounds when capped; discovery prevents claiming complete history
/// before legacy rows or a policy upgrade have been visited.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ReleaseQueueStatus {
    pub epoch: i64,
    pub enabled: bool,
    pub scope: String,
    pub surfaces: Vec<ReleaseSurfaceStatus>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ReleaseSurfaceStatus {
    pub kind: String,
    pub discovering: bool,
    pub pending: u32,
    pub pending_capped: bool,
    pub deferred: u32,
}

impl DatabaseManager {
    pub async fn release_queue_status(&self) -> Result<ReleaseQueueStatus, sqlx::Error> {
        let policy = self.release_policy().await?;
        let mut surfaces = Vec::new();
        if policy.text || policy.images {
            for surface in SURFACES.iter().filter(|s| {
                if s.kind == "image" {
                    policy.images
                } else {
                    policy.text && !is_audio_surface(s.kind)
                }
            }) {
                let complete: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM _privacy_discovery WHERE kind=? AND policy=? AND complete=1)")
                    .bind(surface.kind).bind(&policy.identity).fetch_one(&self.pool).await?;
                let (pending, deferred): (i64, i64) = sqlx::query_as("WITH pending AS MATERIALIZED (SELECT kind,id FROM _privacy_work WHERE kind=? ORDER BY available_at,sequence LIMIT 1001) SELECT COUNT(*),COALESCE(SUM(r.attempts>0 AND r.retry_at>unixepoch()),0) FROM pending w JOIN _privacy_release r ON r.kind=w.kind AND r.id=w.id")
                    .bind(surface.kind).fetch_one(&self.pool).await?;
                surfaces.push(ReleaseSurfaceStatus {
                    kind: surface.kind.into(),
                    discovering: !complete,
                    pending: pending.min(1000) as u32,
                    pending_capped: pending > 1000,
                    deferred: deferred.min(1000) as u32,
                });
            }
        }
        if policy.text {
            for stream in super::privacy_exports::local_release_streams() {
                let complete: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM _privacy_export_scan WHERE stream=? AND complete=1)").bind(&stream).fetch_one(&self.pool).await?;
                let pending: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM (SELECT 1 FROM _privacy_export_sources WHERE stream=? AND pending=1 LIMIT 1001)").bind(&stream).fetch_one(&self.pool).await?;
                surfaces.push(ReleaseSurfaceStatus {
                    kind: stream,
                    discovering: !complete,
                    pending: pending.min(1000) as u32,
                    pending_capped: pending > 1000,
                    deferred: 0,
                });
            }
        }
        let epoch = if policy.text || policy.images {
            sqlx::query_scalar("SELECT epoch FROM _privacy_policy WHERE id=1")
                .fetch_one(&self.pool)
                .await?
        } else {
            0
        };
        Ok(ReleaseQueueStatus {
            epoch,
            enabled: policy.text || policy.images,
            scope: "protected_capture_surfaces".into(),
            surfaces,
        })
    }
}

fn export_surface(kind: &str) -> Result<(&'static str, &'static str, &'static str), sqlx::Error> {
    Ok(match kind {
            "frames"=>("frames","s.id AS frame_id,s.timestamp,s.app_name,s.window_name,s.browser_url,s.accessibility_tree_json AS accessibility_tree,COALESCE(s.full_text,s.accessibility_text,'') AS text","timestamp"),
            "audio"=>("audio_transcriptions","s.id AS transcription_id,s.timestamp,s.transcription,NULL AS speaker,s.device","timestamp"),
            "input"=>("ui_events","s.id AS event_id,s.timestamp,s.event_type,s.app_name,s.window_title,s.browser_url,s.element_role,s.element_name,s.text_content","timestamp"),
            "memory"=>("memories","s.id AS memory_id,s.created_at,s.updated_at,s.content,s.source,s.tags,s.importance,s.frame_id","created_at"),
            _=>return Err(err("privacy export surface is not supported")),
    })
}
