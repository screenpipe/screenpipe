// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Evidence available for API consumers. Legacy timestamps are processing
//! watermarks, not detector success, method, or proof that all PII was removed.

use super::*;
use serde_json::{json, Value};

impl DatabaseManager {
    async fn redaction_snapshot(
        &self,
    ) -> Result<crate::storage::snapshot::ReadConnection, sqlx::Error> {
        if crate::storage::snapshot::in_snapshot(&self.pool) {
            crate::storage::snapshot::acquire(&self.pool).await
        } else {
            Ok(crate::storage::snapshot::ReadConnection::Transaction(
                self.pool.begin().await?,
            ))
        }
    }

    /// Frame fields and current-policy receipts, without reading captured text.
    /// Unknown historical methods and outcomes stay null. Never infer them from
    /// today's recording flags or from placeholders in the stored content.
    pub async fn frame_redaction_status(&self, id: i64) -> Result<Value, sqlx::Error> {
        let mut snapshot = self.redaction_snapshot().await?;
        let row = sqlx::query(
            "SELECT full_text_redacted_at,accessibility_redacted_at,
            accessibility_tree_redacted_at,window_name_redacted_at,browser_url_redacted_at,
            text_json_redacted_at,image_redacted_at FROM frames WHERE id=?",
        )
        .bind(id)
        .fetch_optional(&mut *snapshot)
        .await?;
        let Some(row) = row else {
            return Ok(Value::Null);
        };
        let mut fields = serde_json::Map::new();
        for (field, column) in [
            ("full_text", "full_text_redacted_at"),
            ("accessibility_text", "accessibility_redacted_at"),
            ("accessibility_tree_json", "accessibility_tree_redacted_at"),
            ("window_name", "window_name_redacted_at"),
            ("browser_url", "browser_url_redacted_at"),
            ("text_json", "text_json_redacted_at"),
            ("image", "image_redacted_at"),
        ] {
            let timestamp: Option<i64> = row.try_get(column)?;
            fields.insert(
                field.into(),
                json!({
                    "processed_at": timestamp,
                    "processed": if timestamp.is_some() { Some(true) } else { None },
                    "method": null, "pseudonymized": null, "result": null
                }),
            );
        }
        for field in ["app_name", "document_path"] {
            fields.insert(field.into(), json!({"processed":null,"processed_at":null,"method":null,"pseudonymized":null,"result":null}));
        }
        // The schema is installed at server startup, but DB library users may
        // read old databases before configuring a release policy.
        let installed: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pragma_table_info('_privacy_release') WHERE name='completed_at')")
            .fetch_one(&mut *snapshot).await?;
        let mut receipts = serde_json::Map::new();
        if installed {
            let rows = sqlx::query(
                "SELECT r.kind,r.completed_at,r.revision,
                (r.policy=CAST(p.receipt_key AS TEXT)) AS current,
                CASE r.kind WHEN 'image' THEN p.image_required ELSE p.text_required END AS required
                FROM _privacy_release r CROSS JOIN _privacy_policy p
                WHERE r.id=? AND r.kind IN ('frames','image') AND p.id=1",
            )
            .bind(id.to_string())
            .fetch_all(&mut *snapshot)
            .await?;
            for row in rows {
                let current: bool = row.try_get::<Option<bool>, _>("current")?.unwrap_or(false);
                receipts.insert(row.try_get::<String, _>("kind")?, json!({
                    "complete": current,
                    "required": row.try_get::<bool, _>("required")?,
                    "completed_at": if current { row.try_get::<Option<i64>, _>("completed_at")? } else { None },
                    "revision": row.try_get::<i64, _>("revision")?,
                }));
            }
        }
        let frame_status = observations(&mut snapshot, "frames", id).await?;
        let image_status = observations(&mut snapshot, "image", id).await?;
        let tracked = frame_status["tracked"] == true;
        for value in fields.values_mut() {
            if tracked && value["processed"].is_null() {
                value["processed"] = json!(false);
                value["result"] = json!("skipped");
            }
        }
        for status in [&frame_status, &image_status] {
            if let Some(actual) = status["fields"].as_object() {
                fields.extend(actual.clone());
            }
        }
        let fully_redacted = if installed {
            sqlx::query_scalar::<_, bool>(sqlx::AssertSqlSafe(format!(
                "SELECT EXISTS(SELECT 1 FROM frames s WHERE id=? AND ({}))",
                completion_predicate("frames", "s", self.storage.is_some())
            )))
            .bind(id)
            .fetch_one(&mut *snapshot)
            .await?
        } else {
            false
        };
        let elements = element_status(&mut snapshot, id).await?;
        Ok(
            json!({"fields": fields, "receipts": receipts, "fully_redacted": fully_redacted, "elements":elements,
            "scope": "frame_fields_image_and_elements", "historical_details": "unknown"}),
        )
    }
}

/// Persist on the caller's existing writer transaction, never a second writer.
pub async fn track_capture(
    conn: &mut sqlx::SqliteConnection,
    kind: &str,
    id: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT OR IGNORE INTO redaction_records(kind,record_id) VALUES(?,?)")
        .bind(kind)
        .bind(id)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

pub async fn record(
    conn: &mut sqlx::SqliteConnection,
    kind: &str,
    id: i64,
    fields: &crate::FieldRedactions,
) -> Result<(), sqlx::Error> {
    if fields.is_empty() {
        return Ok(());
    }
    let installed: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='_privacy_policy')",
    )
    .fetch_one(&mut *conn)
    .await?;
    let policy: Option<String> = if installed {
        sqlx::query_scalar("SELECT identity FROM _privacy_policy WHERE id=1")
            .fetch_optional(&mut *conn)
            .await?
    } else {
        None
    };
    for (field, incoming) in fields {
        let mut inherited = incoming.clone();
        // A cached detector result can predate this row. Timestamp its actual
        // application; inline evidence retains the original capture-time call.
        if inherited.method != crate::RedactionMethod::InlineRegex {
            inherited.processed_at = Utc::now().timestamp();
        }
        if inherited.result == crate::RedactionResult::NoMatch {
            let prior:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM redaction_evidence WHERE kind=? AND record_id=? AND field=? AND json_extract(evidence,'$.pseudonymized')=1)").bind(kind).bind(id).bind(field).fetch_one(&mut *conn).await?;
            inherited.pseudonymized |= prior;
        }
        let evidence = &inherited;
        if evidence.result != crate::RedactionResult::Skipped {
            sqlx::query("DELETE FROM redaction_evidence WHERE kind=? AND record_id=? AND field=? AND json_extract(evidence,'$.result')='skipped'").bind(kind).bind(id).bind(field).execute(&mut *conn).await?;
        }
        let method = serde_json::to_string(&evidence.method)
            .map_err(|e| sqlx::Error::Protocol(e.to_string()))?;
        sqlx::query("INSERT OR REPLACE INTO redaction_evidence(kind,record_id,field,method,evidence,policy) VALUES(?,?,?,?,?,?)")
            .bind(kind).bind(id).bind(field).bind(method).bind(serde_json::to_string(evidence).map_err(|e| sqlx::Error::Protocol(e.to_string()))?).bind(&policy).execute(&mut *conn).await?;
    }
    Ok(())
}

/// Source edits invalidate evidence. Hybrid archival is a physical move, not
/// a source edit, and uses the existing storage maintenance guard.
pub(crate) async fn install(
    conn: &mut sqlx::SqliteConnection,
    hybrid: bool,
) -> Result<(), sqlx::Error> {
    for surface in super::privacy_release::SURFACES {
        let table = if hybrid && surface.kind == "elements" {
            "_bulk_element_rows"
        } else {
            surface.table
        };
        let columns: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_table_info(?)")
            .bind(table)
            .fetch_all(&mut *conn)
            .await?;
        if columns.is_empty() {
            continue;
        }
        let guard = if hybrid {
            " AND (SELECT maintenance=0 FROM storage_metadata WHERE singleton=1)"
        } else {
            ""
        };
        for field in surface
            .columns
            .iter()
            .filter(|f| columns.iter().any(|c| c == **f))
        {
            let kind = surface.kind;
            let audit_field = if kind == "image" { "image" } else { field };
            let watermark = match (kind, *field) {
                ("frames", "full_text") => Some("full_text_redacted_at"),
                ("frames", "accessibility_text") => Some("accessibility_redacted_at"),
                ("frames", "accessibility_tree_json") => Some("accessibility_tree_redacted_at"),
                ("frames", "text_json") => Some("text_json_redacted_at"),
                ("frames", "window_name") => Some("window_name_redacted_at"),
                ("frames", "browser_url") => Some("browser_url_redacted_at"),
                ("image", _) => Some("image_redacted_at"),
                ("input" | "elements", _) => Some("redacted_at"),
                _ => None,
            };
            let mut retry = watermark
                .map(|stamp| format!("UPDATE {table} SET {stamp}=NULL WHERE id=NEW.id;"))
                .unwrap_or_default();
            if kind == "frames" {
                retry.push_str("UPDATE frames SET full_text_redacted_at=NULL WHERE id=NEW.id;");
            }
            if kind == "frames" && *field == "text_json" {
                retry.push_str(
                    "DELETE FROM redaction_evidence WHERE kind='inline_ocr' AND record_id=NEW.id;",
                );
            }
            let sql = format!("CREATE TRIGGER IF NOT EXISTS audit_{kind}_{field}_update AFTER UPDATE OF \"{field}\" ON {table} WHEN NEW.\"{field}\" IS NOT OLD.\"{field}\"{guard} BEGIN DELETE FROM redaction_evidence WHERE kind='{kind}' AND record_id=NEW.id AND field='{audit_field}'; {retry} END;");
            sqlx::raw_sql(sqlx::AssertSqlSafe(sql))
                .execute(&mut *conn)
                .await?;
        }
        let kind = surface.kind;
        let delete_guard = if hybrid && table == "_bulk_element_rows" {
            " WHEN (SELECT maintenance=0 FROM storage_metadata WHERE singleton=1)"
        } else {
            ""
        };
        sqlx::raw_sql(sqlx::AssertSqlSafe(format!("CREATE TRIGGER IF NOT EXISTS audit_{kind}_delete AFTER DELETE ON {table}{delete_guard} BEGIN DELETE FROM redaction_evidence WHERE (kind='{kind}' OR ('{kind}'='frames' AND kind='inline_ocr')) AND record_id=OLD.id; DELETE FROM redaction_records WHERE kind='{kind}' AND record_id=OLD.id; END;"))).execute(&mut *conn).await?;
    }
    if hybrid {
        sqlx::raw_sql("CREATE TRIGGER IF NOT EXISTS audit_frame_generation AFTER UPDATE OF generation ON frame_payloads WHEN NEW.generation!=OLD.generation BEGIN DELETE FROM redaction_evidence WHERE kind IN ('frames','inline_ocr') AND record_id=NEW.frame_id; END;").execute(&mut *conn).await?;
    }
    Ok(())
}

pub(crate) type StoredEvidence = (String, String, String, Option<String>);
pub(crate) async fn snapshot_evidence(
    conn: &mut sqlx::SqliteConnection,
    kind: &str,
    id: i64,
) -> Result<Vec<StoredEvidence>, sqlx::Error> {
    sqlx::query_as("SELECT field,method,evidence,policy FROM redaction_evidence WHERE kind=? AND record_id=? ORDER BY sequence").bind(kind).bind(id).fetch_all(conn).await
}
pub(crate) async fn restore_evidence(
    conn: &mut sqlx::SqliteConnection,
    kind: &str,
    id: i64,
    rows: Vec<StoredEvidence>,
) -> Result<(), sqlx::Error> {
    for (field, method, data, policy) in rows {
        sqlx::query("INSERT OR IGNORE INTO redaction_evidence(kind,record_id,field,method,evidence,policy) VALUES(?,?,?,?,?,?)").bind(kind).bind(id).bind(field).bind(method).bind(data).bind(policy).execute(&mut *conn).await?;
    }
    Ok(())
}

impl DatabaseManager {
    /// Compare sources and atomically publish transformed fields with evidence.
    /// Used outside required-release mode; it grants no release authority.
    pub async fn apply_field_redactions(
        &self,
        kind: &str,
        id: i64,
        original: &BTreeMap<String, Option<String>>,
        values: &BTreeMap<String, Option<String>>,
        evidence: &crate::FieldRedactions,
        expected_policy: &str,
    ) -> Result<bool, sqlx::Error> {
        let surface = super::privacy_release::SURFACES
            .iter()
            .find(|s| s.kind == kind && s.kind != "image")
            .ok_or_else(|| sqlx::Error::Protocol("unknown redaction surface".into()))?;
        if values.is_empty()
            || values
                .keys()
                .any(|c| !surface.columns.contains(&c.as_str()) || !original.contains_key(c))
            || original
                .keys()
                .any(|c| !surface.columns.contains(&c.as_str()))
        {
            return Err(sqlx::Error::Protocol("invalid redaction fields".into()));
        }
        let mut tx = self.begin_immediate_with_retry().await?;
        let current_policy: String =
            sqlx::query_scalar("SELECT identity FROM _privacy_policy WHERE id=1")
                .fetch_one(&mut **tx.conn())
                .await?;
        if current_policy != expected_policy {
            return Ok(false);
        }
        let previous = snapshot_evidence(&mut **tx.conn(), kind, id).await?;
        let mut query = sqlx::QueryBuilder::<Sqlite>::new(format!("UPDATE {} SET ", surface.table));
        {
            let mut separated = query.separated(",");
            for (column, value) in values {
                separated
                    .push(format!("\"{column}\"="))
                    .push_bind_unseparated(value);
            }
        }
        query.push(" WHERE id=").push_bind(id);
        for (column, value) in original {
            query
                .push(format!(" AND \"{column}\" IS "))
                .push_bind(value);
        }
        if query
            .build()
            .execute(&mut **tx.conn())
            .await?
            .rows_affected()
            == 0
        {
            return Ok(false);
        }
        restore_evidence(&mut **tx.conn(), kind, id, previous).await?;
        if !evidence.values().any(|e| {
            e.result == crate::RedactionResult::Skipped
                || e.method == crate::RedactionMethod::AsyncRegexFallback
        }) {
            if kind == "frames" {
                for field in values.keys() {
                    let stamp = match field.as_str() {
                        "full_text" => "full_text_redacted_at",
                        "accessibility_text" => "accessibility_redacted_at",
                        "accessibility_tree_json" => "accessibility_tree_redacted_at",
                        "text_json" => "text_json_redacted_at",
                        "window_name" => "window_name_redacted_at",
                        "browser_url" => "browser_url_redacted_at",
                        _ => continue,
                    };
                    sqlx::query(sqlx::AssertSqlSafe(format!(
                        "UPDATE frames SET {stamp}=unixepoch() WHERE id=?"
                    )))
                    .bind(id)
                    .execute(&mut **tx.conn())
                    .await?;
                }
            } else if matches!(kind, "input" | "elements") {
                sqlx::query(sqlx::AssertSqlSafe(format!(
                    "UPDATE {} SET redacted_at=unixepoch() WHERE id=?",
                    surface.table
                )))
                .bind(id)
                .execute(&mut **tx.conn())
                .await?;
            }
        }
        record(&mut **tx.conn(), kind, id, evidence).await?;
        tx.commit().await?;
        Ok(true)
    }

    /// Methods describe persisted operations, including inline, fallback and
    /// skipped outcomes. No source text, key bytes or model response is stored.
    pub async fn record_redaction_status(&self, kind: &str, id: i64) -> Result<Value, sqlx::Error> {
        let mut snapshot = self.redaction_snapshot().await?;
        let mut status = observations(&mut snapshot, kind, id).await?;
        let installed: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pragma_table_info('_privacy_policy') WHERE name='receipt_key')").fetch_one(&mut *snapshot).await?;
        let surface = super::privacy_release::SURFACES
            .iter()
            .find(|s| s.kind == kind)
            .ok_or_else(|| sqlx::Error::Protocol("unknown audit surface".into()))?;
        if let Some(fields) = status["fields"].as_object_mut() {
            let tracked: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM redaction_records WHERE kind=? AND record_id=?)",
            )
            .bind(kind)
            .bind(id)
            .fetch_one(&mut *snapshot)
            .await?;
            for field in surface.columns {
                fields.entry((*field).to_owned()).or_insert_with(|| json!({"processed": if tracked {Some(false)} else {None}, "processed_at":null, "method":null, "pseudonymized":null, "result":if tracked {Some("skipped")} else {None}}));
            }
        }
        let complete = if installed {
            sqlx::query_scalar::<_, bool>(sqlx::AssertSqlSafe(format!(
                "SELECT EXISTS(SELECT 1 FROM {} s WHERE s.id=? AND ({}))",
                surface.table,
                completion_predicate(kind, "s", self.storage.is_some())
            )))
            .bind(id)
            .fetch_one(&mut *snapshot)
            .await?
        } else {
            false
        };
        status["fully_redacted"] = json!(complete);
        Ok(status)
    }
}

/// Completion means every present stored field was successfully processed under
/// this policy. It is separate from the required-model release authority.
fn completion_predicate(kind: &str, alias: &str, hybrid: bool) -> String {
    let surface = super::privacy_release::SURFACES
        .iter()
        .find(|s| s.kind == kind)
        .unwrap();
    let mut clauses = Vec::new();
    let fields: &[&str] = if kind == "image" {
        &["image"]
    } else if kind == "audio" {
        &["transcription"]
    } else {
        surface.columns
    };
    for field in fields {
        let empty = if kind == "image" {
            format!(
                "(NULLIF({alias}.snapshot_path,'') IS NULL AND NULLIF({alias}.name,'') IS NULL)"
            )
        } else if hybrid
            && kind == "frames"
            && matches!(
                *field,
                "full_text" | "accessibility_text" | "accessibility_tree_json" | "text_json"
            )
        {
            // Detail can be sealed outside SQLite. Never infer emptiness from
            // the cleared staging columns; require an explicit observation.
            "0".into()
        } else {
            format!("NULLIF({alias}.\"{field}\",'') IS NULL")
        };
        clauses.push(format!("({empty} OR EXISTS(SELECT 1 FROM redaction_evidence a WHERE a.kind='{kind}' AND a.record_id={alias}.id AND a.field='{field}' AND a.policy=(SELECT identity FROM _privacy_policy WHERE id=1) AND json_extract(a.evidence,'$.complete')=1 AND json_extract(a.evidence,'$.result')!='skipped' AND json_extract(a.evidence,'$.method')!='async_regex_fallback' AND NOT EXISTS(SELECT 1 FROM redaction_evidence bad WHERE bad.kind=a.kind AND bad.record_id=a.record_id AND bad.field=a.field AND bad.policy=a.policy AND (json_extract(bad.evidence,'$.complete')!=1 OR json_extract(bad.evidence,'$.result')='skipped' OR json_extract(bad.evidence,'$.method')='async_regex_fallback') AND bad.sequence>=a.sequence)))"));
    }
    let required = if kind == "image" {
        "image_required"
    } else {
        "text_required"
    };
    let receipt = if super::privacy_release::is_audio_surface(kind) {
        "0".into()
    } else {
        format!("EXISTS(SELECT 1 FROM _privacy_release r JOIN _privacy_policy p ON r.policy=CAST(p.receipt_key AS TEXT) WHERE r.kind='{kind}' AND r.id=CAST({alias}.id AS TEXT))")
    };
    let observed = clauses.join(" AND ");
    let mut predicate = if super::privacy_release::is_audio_surface(kind) {
        observed
    } else {
        format!("(({receipt}) OR ({observed})) AND ((SELECT {required} FROM _privacy_policy WHERE id=1)=0 OR {receipt})")
    };
    if kind == "frames" {
        predicate.push_str(&format!(" AND NOT EXISTS(SELECT 1 FROM redaction_records pending WHERE pending.kind='frame_elements_pending' AND pending.record_id={alias}.id)"));
        predicate.push_str(&format!(
            " AND ({})",
            completion_predicate("image", alias, hybrid)
        ));
        let source = "main.elements";
        predicate.push_str(&format!(" AND NOT EXISTS(SELECT 1 FROM {source} child WHERE child.frame_id=COALESCE({alias}.elements_ref_frame_id,{alias}.id) AND NOT ({}))", completion_predicate("elements", "child", hybrid)));
    }
    predicate
}

impl DatabaseManager {
    /// A reusable read-only view filters before SQL pagination and counting.
    /// It shares the existing writer and never changes the workspace policy.
    pub async fn fully_redacted_reads(self: &Arc<Self>) -> Result<Arc<Self>, sqlx::Error> {
        let pool = self
            .redaction_read_pool
            .get_or_try_init(|| async {
                let mut views = Vec::new();
                let hybrid = self.storage.is_some();
                for kind in [
                    "frames", "audio", "input", "elements", "segments", "memory", "parsed",
                ] {
                    let surface = super::privacy_release::SURFACES
                        .iter()
                        .find(|s| s.kind == kind)
                        .unwrap();
                    let table = surface.table;
                    let logical = format!("_bulk_logical_{table}");
                    let bulk: bool = sqlx::query_scalar(
                        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name=?)",
                    )
                    .bind(&logical)
                    .fetch_one(&self.pool)
                    .await?;
                    let source = if bulk { logical } else { table.into() };
                    views.push(format!(
                        "DROP VIEW IF EXISTS temp.{table}; CREATE TEMP VIEW {table} AS SELECT s.* FROM main.{source} s WHERE {}",
                        completion_predicate(kind, "s", hybrid)
                    ));
                }
                let storage = self.storage.clone();
                let pool = sqlx::sqlite::SqlitePoolOptions::new()
                    .max_connections(self.pool.options().get_max_connections())
                    .acquire_timeout(self.pool.options().get_acquire_timeout())
                    .after_connect(move |conn, _| {
                        let views = views.clone();
                        let storage = storage.clone();
                        Box::pin(async move {
                            if let Some(storage) = storage.filter(|s| s.has_bulk()) {
                                crate::storage::bulk::register_connection(conn, storage, true)
                                    .await?;
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
                crate::recovery::register_database_pool(
                    self.pool.connect_options().get_filename(),
                    &pool,
                );
                let mut registry = self.release_read_pools.lock().await;
                if self.close_token.is_cancelled() {
                    drop(registry);
                    pool.close().await;
                    return Err(sqlx::Error::PoolClosed);
                }
                registry.push(pool.clone());
                Ok::<_, sqlx::Error>(pool)
            })
            .await?;
        Ok(self.protected_read_adapter(pool.clone()))
    }
}

async fn observations(
    conn: &mut sqlx::SqliteConnection,
    kind: &str,
    id: i64,
) -> Result<Value, sqlx::Error> {
    let tracked: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM redaction_records WHERE kind=? AND record_id=?)",
    )
    .bind(kind)
    .bind(id)
    .fetch_one(&mut *conn)
    .await?;
    let rows = sqlx::query("SELECT field,evidence FROM redaction_evidence WHERE kind=? AND record_id=? ORDER BY json_extract(evidence,'$.processed_at'),sequence")
            .bind(kind).bind(id).fetch_all(&mut *conn).await?;
    let mut fields = serde_json::Map::new();
    for row in rows {
        let field: String = row.try_get("field")?;
        let mut step: Value = serde_json::from_str(row.try_get::<&str, _>("evidence")?)
            .map_err(|e| sqlx::Error::Protocol(e.to_string()))?;
        step["processed"] = json!(true);
        let previous = fields.remove(&field);
        let mut steps = previous
            .as_ref()
            .and_then(|v: &Value| v.get("steps"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        steps.push(step.clone());
        step["pseudonymized"] = json!(steps.iter().any(|s| s["pseudonymized"] == true));
        step["steps"] = json!(steps);
        fields.insert(field, step);
    }
    Ok(json!({"fields":fields, "tracked":tracked}))
}

impl DatabaseManager {
    pub async fn audio_redaction_status(
        &self,
        chunk_id: i64,
        offset: i64,
        timestamp: DateTime<Utc>,
    ) -> Result<Value, sqlx::Error> {
        if chunk_id < 0 {
            return self.record_redaction_status("segments", -chunk_id).await;
        }
        let ids: Vec<i64> = {
            let mut snapshot = self.redaction_snapshot().await?;
            sqlx::query_scalar("SELECT id FROM audio_transcriptions WHERE audio_chunk_id=? AND offset_index=? AND julianday(timestamp)=julianday(?)")
                .bind(chunk_id).bind(offset).bind(timestamp.to_rfc3339()).fetch_all(&mut *snapshot).await?
        };
        let mut records = Vec::new();
        for id in ids {
            let mut status = self.record_redaction_status("audio", id).await?;
            status["transcription_id"] = json!(id);
            records.push(status);
        }
        if records.len() == 1 {
            return Ok(records.remove(0));
        }
        Ok(
            json!({"fully_redacted": !records.is_empty() && records.iter().all(|s| s["fully_redacted"]==true), "records": records}),
        )
    }
}

async fn element_status(
    conn: &mut sqlx::SqliteConnection,
    frame_id: i64,
) -> Result<Value, sqlx::Error> {
    let source_id: i64 =
        sqlx::query_scalar("SELECT COALESCE(elements_ref_frame_id,id) FROM frames WHERE id=?")
            .bind(frame_id)
            .fetch_one(&mut *conn)
            .await?;
    let rows: Vec<(i64,String,Option<i64>,bool)> = sqlx::query_as("SELECT e.id,e.source,e.redacted_at,EXISTS(SELECT 1 FROM redaction_records r WHERE r.kind='elements' AND r.record_id=e.id) FROM elements e WHERE frame_id=? ORDER BY id")
        .bind(source_id).fetch_all(&mut *conn).await?;
    let mut records: BTreeMap<i64,Value> = rows.into_iter().map(|(id,source,watermark,tracked)| {
        let mut fields=serde_json::Map::new();
        for name in ["text","properties"] { fields.insert(name.into(),json!({"processed":if tracked {Some(false)} else {None},"processed_at":null,"method":null,"pseudonymized":null,"result":if tracked {Some("skipped")} else {None}})); }
        (id,json!({"id":id,"source":source,"fields":fields,"processing_watermark":watermark,
            "derived_from":if source=="ocr" {Some(format!("frames/{source_id}/text_json"))} else {Some(format!("frames/{source_id}/accessibility_tree_json"))}}))
    }).collect();
    let evidence = sqlx::query("SELECT a.record_id,a.field,a.evidence FROM redaction_evidence a WHERE a.kind='elements' AND a.record_id IN (SELECT id FROM elements WHERE frame_id=?) ORDER BY json_extract(a.evidence,'$.processed_at'),a.sequence")
        .bind(source_id).fetch_all(&mut *conn).await?;
    for row in evidence {
        let id: i64 = row.try_get("record_id")?;
        let field: String = row.try_get("field")?;
        let mut step: Value = serde_json::from_str(row.try_get::<&str, _>("evidence")?)
            .map_err(|e| sqlx::Error::Protocol(e.to_string()))?;
        step["processed"] = json!(true);
        if let Some(record) = records.get_mut(&id) {
            let mut steps = record["fields"][&field]["steps"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            steps.push(step.clone());
            step["pseudonymized"] = json!(steps.iter().any(|s| s["pseudonymized"] == true));
            step["steps"] = json!(steps);
            record["fields"][&field] = step;
        }
    }
    let pending:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM redaction_records WHERE kind='frame_elements_pending' AND record_id=?)").bind(source_id).fetch_one(&mut *conn).await?;
    Ok(
        json!({"source_frame_id":source_id,"materialization_pending":pending,"records":records.into_values().collect::<Vec<_>>()}),
    )
}

impl DatabaseManager {
    /// Keep a failed hybrid generation pending without replacing its payload.
    pub async fn defer_frame_redaction(
        &self,
        id: i64,
        generation: i64,
        policy: &str,
        evidence: &crate::FieldRedactions,
    ) -> Result<(), sqlx::Error> {
        let mut tx = self.begin_immediate_with_retry().await?;
        let updated = sqlx::query("UPDATE frame_payloads SET attempts=attempts+1,retry_at=strftime('%s','now')+MIN(3600,30*(attempts+1)),last_error='configured surface processing failed' WHERE frame_id=? AND generation=? AND policy=?")
            .bind(id).bind(generation).bind(policy).execute(&mut **tx.conn()).await?;
        if updated.rows_affected() > 0 {
            record(&mut **tx.conn(), "frames", id, evidence).await?;
        }
        tx.commit().await?;
        Ok(())
    }

    /// Background-only checkpoint. Recording never waits for diagnostic I/O.
    pub async fn persist_redaction_failure(
        &self,
        kind: &str,
        id: i64,
        field: Option<&str>,
        evidence: &crate::RedactionEvidence,
        retryable: bool,
    ) {
        let path = self.pool.connect_options().get_filename().to_path_buf();
        let Some(root) = path.parent() else { return };
        let directory = root.join("redaction-diagnostics");
        let component = if kind == "image" { "image" } else { "text" };
        let failure = screenpipe_config::redaction::RedactionFailure {
            observed_at: Utc::now().timestamp(),
            kind: kind.into(),
            record_id: id,
            field: field.map(str::to_owned),
            method: evidence.method,
            result: evidence.result,
            retryable,
            cause: evidence
                .cause
                .clone()
                .unwrap_or_else(|| "PII processing pending".into()),
        };
        let write = tokio::task::spawn_blocking(move || -> Result<(), std::io::Error> {
            std::fs::create_dir_all(&directory)?;
            let mut temp = tempfile::NamedTempFile::new_in(&directory)?;
            serde_json::to_writer(&mut temp, &failure).map_err(std::io::Error::other)?;
            temp.as_file().sync_all()?;
            temp.persist(directory.join(format!("{component}.json")))
                .map_err(|e| e.error)?;
            Ok(())
        })
        .await;
        if !matches!(write, Ok(Ok(()))) {
            tracing::warn!(kind, id, "could not persist redaction support diagnostic");
        }
    }
}

/// The authorized support collector reads these observations, never the DB.
/// A prior failure is dated evidence; it is not a current-health verdict.
pub fn support_snapshot(root: &std::path::Path) -> Value {
    let mut snapshot = serde_json::Map::new();
    for component in ["text", "image"] {
        let path = root
            .join("redaction-diagnostics")
            .join(format!("{component}.json"));
        match std::fs::File::open(path) {
            Ok(file) => {
                match serde_json::from_reader::<_, screenpipe_config::redaction::RedactionFailure>(
                    file,
                ) {
                    Ok(failure) => {
                        snapshot.insert(component.into(), json!(failure));
                    }
                    Err(_) => {
                        snapshot.insert(
                            component.into(),
                            json!({"error":"redaction diagnostic is unreadable"}),
                        );
                    }
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => {
                snapshot.insert(
                    component.into(),
                    json!({"error":"redaction diagnostic is unavailable"}),
                );
            }
        }
    }
    Value::Object(snapshot)
}

#[derive(serde::Serialize, serde::Deserialize)]
struct InlineOcrEvidence {
    step: crate::RedactionEvidence,
    changed: Vec<bool>,
}

/// Derive leaf outcomes from the actual inline call's input/output. Only safe
/// metadata reaches SQLite. The raw source is dropped with the capture write.
pub(crate) async fn record_inline_ocr(
    conn: &mut sqlx::SqliteConnection,
    frame_id: i64,
    raw: &str,
    clean: &str,
    step: &crate::RedactionEvidence,
) -> Result<(), sqlx::Error> {
    let (Ok(Value::Array(raw)), Ok(Value::Array(clean))) =
        (serde_json::from_str(raw), serde_json::from_str(clean))
    else {
        return Ok(());
    };
    if raw.len() != clean.len() {
        return Ok(());
    }
    let mut changed = Vec::new();
    for (raw, clean) in raw.iter().zip(&clean) {
        let level = clean
            .get("level")
            .and_then(Value::as_str)
            .and_then(|s| s.parse::<i64>().ok())
            .unwrap_or(0);
        let Some(text) = clean
            .get("text")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
        else {
            continue;
        };
        // OCR materialization stores text only for native blocks and Tesseract
        // words. Hierarchy-only nodes have NULL text and need no text evidence.
        if level != 0 && level != 5 {
            continue;
        }
        let Some(original) = raw.get("text").and_then(Value::as_str) else {
            return Ok(());
        };
        changed.push(original != text);
    }
    let value = serde_json::to_string(&InlineOcrEvidence {
        step: step.clone(),
        changed,
    })
    .map_err(|e| sqlx::Error::Protocol(e.to_string()))?;
    sqlx::query("INSERT OR REPLACE INTO redaction_evidence(kind,record_id,field,method,evidence,policy) SELECT 'inline_ocr',record_id,'text',method,?,policy FROM redaction_evidence WHERE kind='frames' AND record_id=? AND field='text_json' AND method='\"inline_regex\"'")
        .bind(value).bind(frame_id).execute(conn).await?;
    Ok(())
}

/// Transfer source-call evidence to the exact materialized fields. This runs
/// in the existing deferred writer transaction, without repeating detection.
pub(crate) async fn materialize_inline_ocr(
    conn: &mut sqlx::SqliteConnection,
    frame_id: i64,
) -> Result<(), sqlx::Error> {
    let source:Option<(String,Option<String>)>=sqlx::query_as("SELECT evidence,policy FROM redaction_evidence WHERE kind='inline_ocr' AND record_id=? AND field='text'").bind(frame_id).fetch_optional(&mut *conn).await?;
    let Some((source, policy)) = source else {
        return Ok(());
    };
    let source: InlineOcrEvidence =
        serde_json::from_str(&source).map_err(|e| sqlx::Error::Protocol(e.to_string()))?;
    let ids:Vec<i64>=sqlx::query_scalar("SELECT id FROM elements WHERE frame_id=? AND source='ocr' AND text IS NOT NULL ORDER BY sort_order,id").bind(frame_id).fetch_all(&mut *conn).await?;
    if ids.len() != source.changed.len() {
        tracing::warn!(
            frame_id,
            elements = ids.len(),
            observations = source.changed.len(),
            "inline OCR evidence pending: materialization differs from source"
        );
        return Ok(());
    }
    let rows: Vec<(i64, String)> = ids
        .into_iter()
        .zip(source.changed)
        .map(|(id, changed)| {
            let mut step = source.step.clone();
            step.result = if changed {
                crate::RedactionResult::Replaced
            } else {
                crate::RedactionResult::NoMatch
            };
            step.pseudonymized &= changed;
            Ok((
                id,
                serde_json::to_string(&step).map_err(|e| sqlx::Error::Protocol(e.to_string()))?,
            ))
        })
        .collect::<Result<_, sqlx::Error>>()?;
    // SQLite versions supported by the existing OCR writer can have the legacy
    // 999-variable boundary. Three binds per observation; chunk, never truncate.
    for batch in rows.chunks(999 / 3) {
        let mut query=sqlx::QueryBuilder::<Sqlite>::new("INSERT OR REPLACE INTO redaction_evidence(kind,record_id,field,method,evidence,policy) ");
        query.push_values(batch, |mut row, (id, evidence)| {
            row.push("'elements'")
                .push_bind(id)
                .push("'text'")
                .push("'\"inline_regex\"'")
                .push_bind(evidence)
                .push_bind(&policy);
        });
        query.build().execute(&mut *conn).await?;
    }
    sqlx::query("DELETE FROM redaction_evidence WHERE kind='inline_ocr' AND record_id=?")
        .bind(frame_id)
        .execute(conn)
        .await?;
    Ok(())
}
