// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Evidence available for API consumers. Legacy timestamps are processing
//! watermarks, not detector success, method, or proof that all PII was removed.

use super::*;
use serde_json::{json, Value};

impl DatabaseManager {
    /// Frame fields and current-policy receipts, without reading captured text.
    /// Unknown historical methods and outcomes stay null. Never infer them from
    /// today's recording flags or from placeholders in the stored content.
    pub async fn frame_redaction_status(&self, id: i64) -> Result<Value, sqlx::Error> {
        let mut snapshot = self.pool.begin().await?;
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
        snapshot.commit().await?;
        Ok(json!({"fields": fields, "receipts": receipts,
            "scope": "frame_fields_and_image", "historical_details": "unknown"}))
    }
}
