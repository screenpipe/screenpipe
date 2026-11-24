// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Enrich enterprise frame exports from the retained payload, not the lossy
//! search projection. Normal sync and explicit backfill share this path.

use super::{EnterpriseSyncError, FrameRow};
use screenpipe_db::{storage::Projection, DatabaseManager};
use serde_json::Value;

pub(crate) async fn hydrate_frame_trees(
    db: &DatabaseManager,
    frames: &mut [FrameRow],
    redact_pii: bool,
) -> Result<(), EnterpriseSyncError> {
    let ids: Vec<_> = frames.iter().map(|frame| frame.frame_id).collect();
    // This reader handles both SQLite and archived payloads with the existing
    // privacy/revocation checks. The sync export token is admitted again before
    // upload; a failed read must abort the page so its cursor remains retryable.
    let payloads = db
        .frame_payloads(&ids, Projection::Detail)
        .await
        .map_err(|e| EnterpriseSyncError::LocalApi(format!("read frame AX payloads: {e}")))?;
    // Parsing and redacting a full page can be CPU-heavy. Keep it off the
    // async workers that also serve recording and local API requests.
    let mut trees = tokio::task::spawn_blocking(move || {
        payloads
            .into_iter()
            .map(|(id, payload)| {
                let tree = payload
                    .accessibility_tree_json
                    .as_deref()
                    .map(|json| export_tree(json, redact_pii))
                    .transpose()?;
                Ok((id, tree))
            })
            .collect::<Result<std::collections::BTreeMap<_, _>, EnterpriseSyncError>>()
    })
    .await
    .map_err(|e| EnterpriseSyncError::LocalApi(format!("prepare frame AX payloads: {e}")))??;
    for frame in frames {
        // Keep the selected ID and scan boundary even if retention removed its
        // payload. The final export filter drops it before serialization.
        frame.accessibility_tree = trees.remove(&frame.frame_id).flatten();
    }
    Ok(())
}

fn export_tree(json: &str, redact_pii: bool) -> Result<Value, EnterpriseSyncError> {
    let mut tree: Value = serde_json::from_str(json)
        .map_err(|_| EnterpriseSyncError::LocalApi("invalid stored AX tree JSON".into()))?;
    if redact_pii {
        redact_strings(&mut tree);
    }
    Ok(tree)
}

fn redact_strings(value: &mut Value) {
    match value {
        Value::String(text) => *text = screenpipe_core::pii_removal::remove_pii(text),
        Value::Array(items) => items.iter_mut().for_each(redact_strings),
        Value::Object(fields) => fields.values_mut().for_each(redact_strings),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn complete_tree_keeps_empty_nodes_and_unknown_properties() {
        let tree = serde_json::json!([
            {"role":"Window","text":"","depth":0},
            {"role":"Button","text":"Search","depth":1,"bounds":[1,2,3,4],
             "properties":{"automation_id":"search","class_name":"Button","future":{"x":true}}}
        ]);
        assert_eq!(export_tree(&tree.to_string(), false).unwrap(), tree);
    }

    #[test]
    fn pii_setting_covers_nested_tree_values_without_removing_structure() {
        let tree = serde_json::json!([{"text":"a.person@example.com", "properties":{
            "value":"b.person@example.com", "automation_id":"search", "is_enabled":true},
            "bounds":[10,20,30,40]}]);
        let output = export_tree(&tree.to_string(), true).unwrap();
        assert!(!output.to_string().contains("@example.com"));
        assert_eq!(output[0]["properties"]["automation_id"], "search");
        assert_eq!(output[0]["bounds"], tree[0]["bounds"]);
    }

    #[test]
    fn malformed_tree_fails_instead_of_silently_exporting_text_only() {
        assert!(export_tree("{broken", false).is_err());
    }

    #[tokio::test]
    async fn retained_tree_reaches_wire_and_missing_frames_are_left_for_filtering() {
        for archived in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let db = if archived {
                // This tiny synthetic fixture tests export contents, not disk
                // admission. Match the DB suite's fixture configuration.
                let mut options = screenpipe_db::storage::MigrationOptions::default();
                options.budget.disk_reserve_bytes = 0;
                DatabaseManager::new_hybrid(dir.path(), Default::default(), options)
                    .await
                    .unwrap()
            } else {
                DatabaseManager::new(
                    dir.path().join("db.sqlite").to_str().unwrap(),
                    Default::default(),
                )
                .await
                .unwrap()
            };
            db.execute_raw_sql_write("INSERT INTO frames(id,timestamp,accessibility_tree_json) VALUES(1,'2026-10-15T00:00:00Z','[{\"role\":\"Button\",\"text\":\"\",\"properties\":{\"automation_id\":\"search\"}}]'),(2,'2026-10-15T00:00:01Z',NULL)").await.unwrap();
            if archived {
                assert_eq!(db.seal_frame_payloads().await.unwrap(), 2);
            }
            let row = |id| FrameRow {
                frame_id: id,
                timestamp: "2026-10-15T00:00:00Z".into(),
                app_name: None,
                window_name: None,
                browser_url: None,
                text: None,
                text_redaction: None,
                accessibility_tree: None,
            };
            let mut frames = vec![row(1), row(2)];
            hydrate_frame_trees(&db, &mut frames, false).await.unwrap();
            let body = screenpipe_telemetry_wire::build_jsonl(
                "device",
                "label",
                &frames,
                &[],
                &[],
                &[],
                &[],
            );
            let record: Value =
                serde_json::from_slice(body.split(|b| *b == b'\n').next().unwrap()).unwrap();
            assert_eq!(
                record["accessibility_tree"][0]["properties"]["automation_id"],
                "search"
            );
            assert!(frames[1].accessibility_tree.is_none());
            let mut missing = vec![row(3)];
            hydrate_frame_trees(&db, &mut missing, false).await.unwrap();
            assert!(missing[0].accessibility_tree.is_none());
            db.close().await;
        }
    }
}
