// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Owner-authored edits use the catalog's atomic writer and revision boundary.
//! Source indices refer to the checked revision; clients cannot fabricate evidence.
use super::{
    search::OptionalPipePerms,
    workflow_catalog::{error, persist, WRITER},
    workflows::{read_catalog, workflow_id, WorkflowCatalogSource},
};
use axum::{http::StatusCode, Extension, Json};
use oasgen::{oasgen, OaSchema};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;

type ApiError = (StatusCode, Json<Value>);
#[derive(Deserialize, OaSchema)]
#[serde(deny_unknown_fields)]
pub struct EditRequest {
    pub id: String,
    pub expected_revision: u64,
    pub title: String,
    pub description: String,
    pub trigger: String,
    pub outcome: String,
    pub stages: Vec<StageEdit>,
    #[serde(default)]
    pub variables: Option<Vec<WorkflowVariable>>,
    #[serde(default)]
    pub archived: Option<bool>,
    #[serde(default, rename = "reviewStatus")]
    pub review_status: Option<String>,
    #[serde(default, rename = "reviewNote")]
    pub review_note: Option<String>,
    #[serde(default, rename = "restoreRevision")]
    pub restore_revision: Option<u64>,
}
#[derive(Deserialize, OaSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct StageEdit {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub required_access: Option<String>,
    #[serde(default)]
    pub exceptions: Option<String>,
    #[serde(default)]
    pub escalation: Option<String>,
    #[serde(default)]
    pub response_template: Option<String>,
    #[serde(default)]
    pub linked_workflow_id: Option<String>,
    pub image_layout: Option<ImageLayout>,
    pub source_index: Option<usize>,
    pub name: String,
    pub description: String,
    pub procedure: Vec<ProcedureEdit>,
}
#[derive(Deserialize, Serialize, OaSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ImageLayout {
    pub order: Vec<u64>,
    pub hidden: Vec<u64>,
    pub before_text: bool,
}
fn image_layout_ok(layout: &ImageLayout) -> bool {
    [&layout.order, &layout.hidden].iter().all(|ids| {
        ids.len() <= 100
            && ids.iter().all(|id| *id <= 9_007_199_254_740_991)
            && ids.iter().collect::<HashSet<_>>().len() == ids.len()
    })
}
fn without_image_layout(value: &Value) -> Value {
    let mut value = value.clone();
    if let Some(object) = value.as_object_mut() {
        object.remove("imageLayout");
    }
    value
}
#[derive(Deserialize, OaSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ProcedureEdit {
    #[serde(default)]
    pub id: Option<String>,
    pub source_index: Option<usize>,
    pub kind: String,
    pub text: String,
}
#[derive(Deserialize, Serialize, OaSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkflowVariable {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub description: String,
    pub examples: Vec<VariableExample>,
}
#[derive(Deserialize, Serialize, OaSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct VariableExample {
    pub step_id: String,
    pub field: String,
    pub value: String,
}
fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
fn validate_variables(items: &[WorkflowVariable]) -> bool {
    let mut ids = HashSet::new();
    let mut names = HashSet::new();
    items.len() <= 40
        && items.iter().all(|v| {
            identifier(&v.id)
                && ids.insert(&v.id)
                && ["input", "output"].contains(&v.kind.as_str())
                && !v.name.trim().is_empty()
                && v.name.chars().count() <= 100
                && names.insert(v.name.trim().to_lowercase())
                && v.description.chars().count() <= 1000
                && v.examples.len() <= 20
                && v.examples.iter().all(|e| {
                    identifier(&e.step_id)
                        && !e.field.is_empty()
                        && e.field.len() <= 100
                        && !e.value.trim().is_empty()
                        && e.value.chars().count() <= 1000
                })
        })
}
/// Catalog-owned, bounded snapshots. Never accept history/evidence supplied by a client.
fn keep_version(previous: &Value, next: &mut Value) -> Result<(), ApiError> {
    let mut snapshot = previous.clone();
    snapshot
        .as_object_mut()
        .ok_or_else(invalid)?
        .remove("versions");
    screenpipe_core::workflows::discard_screenshot_pixels(&mut snapshot);
    let mut versions = previous["versions"].as_array().cloned().unwrap_or_default();
    versions.push(
        json!({"revision":previous["revision"].as_u64().unwrap_or(0),
        "at":previous["userEditedAt"].as_str().unwrap_or(""),"snapshot":snapshot}),
    );
    while versions.len() > 10
        || (versions.len() > 1
            && serde_json::to_vec(&versions).map_or(usize::MAX, |v| v.len()) > 2 * 1024 * 1024)
    {
        versions.remove(0);
    }
    if serde_json::to_vec(&versions).map_or(usize::MAX, |v| v.len()) > 2 * 1024 * 1024 {
        return Err(error(StatusCode::BAD_REQUEST, "This workflow is too large to preserve a version safely. Your saved workflow is unchanged."));
    }
    next["versions"] = json!(versions);
    Ok(())
}
fn invalid() -> ApiError {
    error(StatusCode::BAD_REQUEST, "Enter a title and at least one named step. Text must be under 8,000 characters and blocks must have valid source references.")
}
fn text_ok(text: &str, required: bool) -> bool {
    text.len() <= 8000 && (!required || !text.trim().is_empty())
}

fn without_ids(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .filter(|(key, _)| key.as_str() != "id")
                .map(|(key, value)| (key.clone(), without_ids(value)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(without_ids).collect()),
        _ => value.clone(),
    }
}
/// Reapply only owner-authored fields, never metadata supplied by an agent.
pub(super) fn preserve_edits(previous: &Value, next: &mut Value) {
    for key in [
        "variables",
        "archived",
        "reviewStatus",
        "reviewNote",
        "versions",
    ] {
        if previous.get(key).is_some() {
            next[key] = previous[key].clone();
        } else if let Some(object) = next.as_object_mut() {
            object.remove(key);
        }
    }
    next["userEdits"] = previous["userEdits"].clone();
    next["userEditedAt"] = previous["userEditedAt"].clone();
    if let Some(stages) = next["stages"].as_array_mut() {
        for stage in stages {
            let matches: Vec<_> = previous["stages"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|old| old["name"] == stage["name"])
                .collect();
            if matches.len() == 1 {
                let old = matches[0];
                if old.get("id").is_some() {
                    stage["id"] = old["id"].clone();
                }
                if let Some(blocks) = stage.get_mut("procedure").and_then(Value::as_array_mut) {
                    for block in blocks {
                        let found: Vec<_> = old["procedure"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter(|p| p["kind"] == block["kind"] && p["text"] == block["text"])
                            .collect();
                        if found.len() == 1 && found[0].get("id").is_some() {
                            block["id"] = found[0]["id"].clone();
                        }
                    }
                }
            }
        }
    }

    if let Some(edits) = previous["userEdits"].as_object() {
        for key in ["title", "description", "trigger", "outcome", "bottlenecks"] {
            if edits.get(key) == Some(&Value::Bool(true)) {
                next[key] = previous[key].clone();
            }
        }
        if edits.get("stages") == Some(&Value::Bool(true)) {
            // A reorder or one edited step must not freeze every other step's
            // research. Preserve owner-authored structure and changed steps;
            // accept verified enrichment only for an unedited, named match.
            let proposed = next["stages"].as_array().cloned().unwrap_or_default();
            next["stages"] = json!(previous["stages"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|stage| {
                    let matches: Vec<_> = proposed
                        .iter()
                        .filter(|candidate| candidate["name"] == stage["name"])
                        .collect();
                    if stage["userEdited"] != true && matches.len() == 1 {
                        let mut enriched = matches[0].clone();
                        if let Some(layout) = stage.get("imageLayout") {
                            enriched["imageLayout"] = layout.clone();
                        } else if let Some(object) = enriched.as_object_mut() {
                            object.remove("imageLayout");
                        }
                        enriched
                    } else {
                        stage.clone()
                    }
                })
                .collect::<Vec<_>>());
            // Prior edits alone do not invalidate newly verified timing. Only
            // invalidate when preserving owner changes alters the reviewed map.
            if next["stages"]
                .as_array()
                .unwrap()
                .iter()
                .map(without_image_layout)
                .collect::<Vec<_>>()
                != proposed
                    .iter()
                    .map(without_image_layout)
                    .collect::<Vec<_>>()
            {
                invalidate_step_claims(next);
            }
        }
    }
}
fn invalidate_step_claims(workflow: &mut Value) {
    workflow["evidenceStatus"] = json!("candidate");
    workflow["timing"] = Value::Null;
    workflow["durationSource"] = json!("unknown");
    workflow["durationSampleCount"] = json!(0);
    workflow["captureSequence"] = json!([]);
}
fn apply_edit(previous: &Value, body: &EditRequest) -> Result<Value, ApiError> {
    if body.expected_revision != previous["revision"].as_u64().unwrap_or(0) {
        return Err(error(StatusCode::CONFLICT, "This workflow changed while you were editing. Your draft is kept. Reopen the latest workflow before applying your edits."));
    }
    if let Some(revision) = body.restore_revision {
        let saved = previous["versions"]
            .as_array()
            .and_then(|v| v.iter().find(|v| v["revision"].as_u64() == Some(revision)))
            .ok_or_else(|| {
                error(
                    StatusCode::NOT_FOUND,
                    "That saved version is no longer available.",
                )
            })?;
        let mut next = saved["snapshot"].clone();
        if !next.is_object() {
            return Err(invalid());
        }
        next["id"] = previous["id"].clone();
        next["revision"] = json!(body.expected_revision + 1);
        next["userEditedAt"] = json!(chrono::Utc::now().to_rfc3339());
        next["userEdits"] = json!({"title":true,"description":true,"trigger":true,"outcome":true,"stages":true,"bottlenecks":true});
        if let Some(stages) = next.get_mut("stages").and_then(Value::as_array_mut) {
            for stage in stages {
                stage["userEdited"] = json!(true);
            }
        }
        // Preserve the historical references, but do not treat a restore as new execution.
        invalidate_step_claims(&mut next);
        keep_version(previous, &mut next)?;
        return Ok(next);
    }
    if body
        .variables
        .as_ref()
        .is_some_and(|v| !validate_variables(v))
        || body
            .review_status
            .as_ref()
            .is_some_and(|v| !["needs-review", "needs-edits", "reviewed"].contains(&v.as_str()))
        || body
            .review_note
            .as_ref()
            .is_some_and(|v| !text_ok(v, false))
    {
        return Err(invalid());
    }
    if !text_ok(&body.title, true)
        || [&body.description, &body.trigger, &body.outcome]
            .iter()
            .any(|v| !text_ok(v, false))
        || body.stages.is_empty()
        || body.stages.len() > 100
    {
        return Err(invalid());
    }
    let original = previous["stages"].as_array().ok_or_else(invalid)?;
    let mut used = HashSet::new();
    let mut stages = Vec::new();
    let mut names = std::collections::HashMap::new();
    let mut step_ids = HashSet::new();
    for stage in &body.stages {
        if !text_ok(&stage.name, true)
            || !text_ok(&stage.description, false)
            || stage.procedure.len() > 100
            || stage
                .image_layout
                .as_ref()
                .is_some_and(|layout| !image_layout_ok(layout))
        {
            return Err(invalid());
        }
        let prior = match stage.source_index {
            Some(index) if used.insert(index) => original.get(index).ok_or_else(invalid)?.clone(),
            Some(_) => return Err(invalid()),
            None => {
                json!({"activeMinutes":0,"waitingMinutes":0,"durationSource":"unknown","apps":[],"confidence":0,"observedOccurrences":0,"observedDays":0,"evidence":[]})
            }
        };
        let mut next = prior.clone();
        if let Some(id) = &stage.id {
            if !identifier(id) || !step_ids.insert(id) {
                return Err(invalid());
            }
            if prior["id"].as_str().is_some_and(|old| old != id) {
                return Err(invalid());
            }
            next["id"] = json!(id);
        }
        for (key, value) in [
            ("requiredAccess", &stage.required_access),
            ("exceptions", &stage.exceptions),
            ("escalation", &stage.escalation),
            ("responseTemplate", &stage.response_template),
            ("linkedWorkflowId", &stage.linked_workflow_id),
        ] {
            if let Some(value) = value {
                if !text_ok(value, false)
                    || (key == "linkedWorkflowId"
                        && !value.is_empty()
                        && (!value.starts_with("wf-") || value.len() > 200))
                {
                    return Err(invalid());
                }
                next[key] = json!(value.trim());
            }
        }
        next["name"] = json!(stage.name.trim());
        next["description"] = json!(stage.description.trim());
        if let Some(name) = prior["name"].as_str() {
            names.insert(name.to_lowercase(), stage.name.trim().to_owned());
        }
        let mut used_details = HashSet::new();
        let mut details = Vec::new();
        let mut block_ids = HashSet::new();
        for detail in &stage.procedure {
            if !["action", "input", "output", "decision", "check"].contains(&detail.kind.as_str())
                || !text_ok(&detail.text, true)
            {
                return Err(invalid());
            }
            let mut source = match detail.source_index {
                Some(index) if used_details.insert(index) => prior["procedure"]
                    .as_array()
                    .and_then(|p| p.get(index))
                    .ok_or_else(invalid)?
                    .clone(),
                Some(_) => return Err(invalid()),
                None => json!({"quote":"","timestamp":"","app":""}),
            };
            if let Some(id) = &detail.id {
                if !identifier(id)
                    || !block_ids.insert(id)
                    || source["id"].as_str().is_some_and(|old| old != id)
                {
                    return Err(invalid());
                }
                source["id"] = json!(id);
            }
            if source["kind"] != detail.kind || source["text"] != detail.text.trim() {
                source["userEdited"] = json!(true);
            }
            source["kind"] = json!(detail.kind);
            source["text"] = json!(detail.text.trim());
            details.push(source);
        }
        // Preserve the absence of a procedure array for unchanged legacy stages.
        if !details.is_empty() || prior.get("procedure").is_some() {
            next["procedure"] = json!(details);
        }
        if without_ids(&next) != without_ids(&prior) {
            next["timing"] = Value::Null;
            next["userEdited"] = json!(true);
        }
        if let Some(layout) = &stage.image_layout {
            next["imageLayout"] = json!(layout);
        }
        stages.push(next);
    }
    let mut next = previous.clone();
    let mut edits = previous["userEdits"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    for (key, value) in [
        ("title", &body.title),
        ("description", &body.description),
        ("trigger", &body.trigger),
        ("outcome", &body.outcome),
    ] {
        let value = json!(value.trim());
        if previous[key] != value {
            edits.insert(key.into(), json!(true));
            next[key] = value;
        }
    }
    next["stages"] = json!(stages);
    if without_ids(&next["stages"]) != without_ids(&json!(original)) {
        let presentation_only = without_ids(&json!(stages
            .iter()
            .map(without_image_layout)
            .collect::<Vec<_>>()))
            == without_ids(&json!(original
                .iter()
                .map(without_image_layout)
                .collect::<Vec<_>>()));
        edits.insert("stages".into(), json!(true));
        if !presentation_only {
            // Rename surviving step associations and remove associations to deleted steps.
            let mut friction = vec![];
            for item in previous["bottlenecks"].as_array().into_iter().flatten() {
                if let Some(name) =
                    names.get(&item["stage"].as_str().unwrap_or_default().to_lowercase())
                {
                    let mut item = item.clone();
                    item["stage"] = json!(name);
                    friction.push(item);
                }
            }
            next["bottlenecks"] = json!(friction);
            edits.insert("bottlenecks".into(), json!(true));
            invalidate_step_claims(&mut next);
        }
    }
    for (key, value) in [
        ("variables", body.variables.as_ref().map(|v| json!(v))),
        ("archived", body.archived.map(|v| json!(v))),
        (
            "reviewStatus",
            body.review_status.as_ref().map(|v| json!(v)),
        ),
        (
            "reviewNote",
            body.review_note.as_ref().map(|v| json!(v.trim())),
        ),
    ] {
        if let Some(value) = value {
            next[key] = value;
        }
    }
    if next == *previous {
        return Ok(next);
    }
    next["userEdits"] = json!(edits);
    next["userEditedAt"] = json!(chrono::Utc::now().to_rfc3339());
    next["revision"] = json!(body.expected_revision + 1);
    keep_version(previous, &mut next)?;
    Ok(next)
}
#[oasgen]
pub(crate) async fn edit(
    Extension(source): Extension<WorkflowCatalogSource>,
    perms: OptionalPipePerms,
    Json(body): Json<EditRequest>,
) -> Result<Json<Value>, ApiError> {
    if perms.0.is_some() {
        return Err(error(
            StatusCode::FORBIDDEN,
            "Only the desktop owner can make manual workflow edits.",
        ));
    }
    let _guard = WRITER.lock().await;
    let before = read_catalog(&source).await?;
    let mut next = before.clone();
    let workflow = next["analysis"]["workflows"]
        .as_array_mut()
        .ok_or_else(invalid)?
        .iter_mut()
        .find(|w| workflow_id(w) == body.id)
        .ok_or_else(|| error(StatusCode::NOT_FOUND, "Workflow was not found."))?;
    *workflow = apply_edit(workflow, &body)?;
    workflow["id"] = json!(body.id);
    let saved = workflow.clone();
    if next != before {
        next["revision"] = json!(before["revision"].as_u64().unwrap_or(0) + 1);
        persist(&source, &before, &next).await?;
    }
    Ok(Json(json!({"workflow": saved})))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn variables_versions_archive_and_restore_keep_original_sources() {
        let previous = original();
        let raw = json!({"id":"wf-test","expected_revision":3,"title":"Prepare a report","description":"Description","trigger":"Request","outcome":"Report","stages":[{"sourceIndex":0,"id":"step-0","name":"Read","description":"Review named source","requiredAccess":"Read access","procedure":[]}],
          "variables":[{"id":"source","kind":"input","name":"Source","description":"Document to review","examples":[{"stepId":"step-0","field":"description","value":"original document"}]}],"archived":true,"reviewStatus":"needs-edits","reviewNote":"Check the last step"});
        let body: EditRequest = serde_json::from_value(raw).unwrap();
        let saved = apply_edit(&previous, &body).unwrap();
        assert_eq!(saved["variables"][0]["name"], "Source");
        assert_eq!(
            saved["stages"][0]["evidence"],
            previous["stages"][0]["evidence"]
        );
        assert_eq!(saved["versions"][0]["revision"], 3);
        let mut refreshed = previous.clone();
        preserve_edits(&saved, &mut refreshed);
        assert_eq!(refreshed["variables"], saved["variables"]);
        assert_eq!(refreshed["archived"], true);
        let mut restore = body;
        restore.expected_revision = 4;
        restore.restore_revision = Some(3);
        let restored = apply_edit(&saved, &restore).unwrap();
        assert_eq!(restored["revision"], 5);
        assert_eq!(
            restored["stages"][0]["description"],
            previous["stages"][0]["description"]
        );
        assert_eq!(
            restored["stages"][0]["evidence"],
            previous["stages"][0]["evidence"]
        );
        assert_eq!(restored["stages"][0]["userEdited"], true);
        assert_eq!(restored["versions"].as_array().unwrap().len(), 2);
        assert!(restored["versions"][0]["snapshot"]
            .get("versions")
            .is_none());
        assert!(apply_edit(&restored, &restore).is_err());
    }
    #[test]
    fn rejects_duplicate_variables_and_preserves_timing_for_identity_only_edits() {
        let previous = original();
        let mut body = request();
        body.stages[0].id = Some("step-0".into());
        let saved = apply_edit(&previous, &body).unwrap();
        assert_eq!(
            saved["stages"][0]["timing"],
            previous["stages"][0]["timing"]
        );
        let item = json!({"id":"x","kind":"input","name":"Source","description":"","examples":[]});
        body.variables = Some(serde_json::from_value(json!([item, item])).unwrap());
        assert!(apply_edit(&previous, &body).is_err());
    }
    #[test]
    fn history_is_bounded_and_discovery_cannot_invent_owner_metadata() {
        let mut saved = original();
        for n in 0..12 {
            let mut body = request();
            body.expected_revision = saved["revision"].as_u64().unwrap();
            body.title = format!("Revision {n}");
            saved = apply_edit(&saved, &body).unwrap();
        }
        assert_eq!(saved["versions"].as_array().unwrap().len(), 10);
        assert!(saved["versions"]
            .as_array()
            .unwrap()
            .iter()
            .all(|v| v["snapshot"].get("versions").is_none()));
        let mut forged = json!({"archived":true,"versions":[{"revision":999}],"variables":[{"name":"Invented"}],"stages":[]});
        preserve_edits(&original(), &mut forged);
        assert!(forged.get("archived").is_none());
        assert!(forged.get("versions").is_none());
        assert!(forged.get("variables").is_none());
    }
    fn original() -> Value {
        json!({"id":"wf-test","revision":3,"title":"Prepare a report","description":"Description","trigger":"Request","outcome":"Report","timing":{"averageMinutes":5},"stages":[
            {"name":"Read","description":"Review sources","evidence":[{"detail":"Original source"}],"screenshot":{"dataUrl":"fixture-image"},"screenshots":[{"frameId":1,"dataUrl":"fixture-one"},{"frameId":2,"dataUrl":"fixture-two"}],"procedure":[{"kind":"action","text":"Read notes","quote":"Original quotation","app":"Notes","timestamp":"2026-09-01T10:00:00Z"}]},
            {"name":"Write","description":"Draft report","evidence":[]}],"bottlenecks":[{"stage":"Read","label":"Wait"}]})
    }
    fn request() -> EditRequest {
        serde_json::from_value(json!({"id":"wf-test","expected_revision":3,"title":"Prepare a report","description":"Description","trigger":"Request","outcome":"Report","stages":[
            {"sourceIndex":0,"name":"Read","description":"Review sources","procedure":[{"sourceIndex":0,"kind":"action","text":"Read notes"}]},
            {"sourceIndex":1,"name":"Write","description":"Draft report","procedure":[]}]})).unwrap()
    }
    #[test]
    fn image_selection_edits_preserve_sources_timing_and_survive_discovery() {
        let prior = original();
        let mut body = request();
        body.stages[0].image_layout = Some(ImageLayout {
            order: vec![2, 1],
            hidden: vec![1],
            before_text: true,
        });
        let saved = apply_edit(&prior, &body).unwrap();
        assert_eq!(
            saved["stages"][0]["screenshots"],
            prior["stages"][0]["screenshots"]
        );
        assert_eq!(
            saved["stages"][0]["evidence"],
            prior["stages"][0]["evidence"]
        );
        assert_eq!(saved["timing"], prior["timing"]);
        assert_eq!(saved["stages"][0]["imageLayout"]["hidden"], json!([1]));
        let mut next = prior.clone();
        preserve_edits(&saved, &mut next);
        assert_eq!(
            next["stages"][0]["imageLayout"],
            saved["stages"][0]["imageLayout"]
        );
        assert_eq!(next["timing"], prior["timing"]);
        body.stages[0].image_layout.as_mut().unwrap().order = vec![1, 1];
        assert_eq!(
            apply_edit(&prior, &body).unwrap_err().0,
            StatusCode::BAD_REQUEST
        );
    }
    #[test]
    fn unchanged_save_is_noop_and_conflict_does_not_mutate() {
        let prior = original();
        let mut body = request();
        assert_eq!(apply_edit(&prior, &body).unwrap(), prior);
        body.expected_revision = 2;
        assert_eq!(
            apply_edit(&prior, &body).unwrap_err().0,
            StatusCode::CONFLICT
        );
        assert_eq!(prior, original());
    }
    #[test]
    fn step_timing_follows_reorders_but_not_changed_instructions() {
        let mut prior = original();
        prior["stages"][0]["timing"] = json!({"averageMinutes":2});
        prior["stages"][1]["timing"] = json!({"averageMinutes":3});
        let mut body = request();
        body.stages.swap(0, 1);
        let reordered = apply_edit(&prior, &body).unwrap();
        assert_eq!(
            reordered["stages"][0]["timing"],
            prior["stages"][1]["timing"]
        );
        assert_eq!(
            reordered["stages"][1]["timing"],
            prior["stages"][0]["timing"]
        );
        assert!(reordered["timing"].is_null());
        body.stages[1].procedure[0].text = "Read a different set of sources".into();
        let edited = apply_edit(&prior, &body).unwrap();
        assert!(edited["stages"][1]["timing"].is_null());
        assert_eq!(edited["stages"][0]["timing"], prior["stages"][1]["timing"]);
    }
    #[test]
    fn rename_reorder_add_delete_preserve_references_not_verification() {
        let prior = original();
        let mut body = request();
        body.title = "My report".into();
        body.stages[0].name = "Check sources".into();
        body.stages[0].procedure[0].text = "Check all references".into();
        body.stages.swap(0, 1);
        let saved = apply_edit(&prior, &body).unwrap();
        assert_eq!(
            saved["stages"][1]["evidence"],
            prior["stages"][0]["evidence"]
        );
        assert_eq!(
            saved["stages"][1]["screenshot"],
            prior["stages"][0]["screenshot"]
        );
        assert_eq!(
            saved["stages"][1]["screenshots"],
            prior["stages"][0]["screenshots"]
        );
        assert_eq!(
            saved["stages"][1]["procedure"][0]["quote"],
            "Original quotation"
        );
        assert_eq!(saved["stages"][1]["procedure"][0]["userEdited"], true);
        assert_eq!(saved["bottlenecks"][0]["stage"], "Check sources");
        assert_eq!(saved["evidenceStatus"], "candidate");
        assert!(saved["timing"].is_null());
        assert_eq!(saved["revision"], 4);
        body.stages.remove(1);
        body.stages.push(StageEdit {
            id: None,
            required_access: None,
            exceptions: None,
            escalation: None,
            response_template: None,
            linked_workflow_id: None,
            image_layout: None,
            source_index: None,
            name: "Deliver".into(),
            description: "".into(),
            procedure: vec![],
        });
        let saved = apply_edit(&prior, &body).unwrap();
        assert_eq!(saved["bottlenecks"], json!([]));
        assert_eq!(saved["stages"][1]["evidence"], json!([]));
        assert_eq!(saved["stages"][1]["observedOccurrences"], 0);
    }
    #[test]
    fn invalid_indices_duplicate_sources_and_oversized_text_are_rejected() {
        let mut body = request();
        body.stages[1].source_index = Some(0);
        assert!(apply_edit(&original(), &body).is_err());
        body.stages[1].source_index = Some(99);
        assert!(apply_edit(&original(), &body).is_err());
        let mut body = request();
        body.stages[0].procedure[0].source_index = Some(10);
        assert!(apply_edit(&original(), &body).is_err());
        let mut body = request();
        body.title = "x".repeat(8001);
        assert!(apply_edit(&original(), &body).is_err());
        let mut body = request();
        body.stages.clear();
        assert!(apply_edit(&original(), &body).is_err());
    }
    #[test]
    fn ai_refresh_keeps_manual_edits_but_can_update_unedited_fields() {
        let mut body = request();
        body.title = "My title".into();
        let saved = apply_edit(&original(), &body).unwrap();
        let mut agent = json!({"title":"AI title","description":"New evidence","userEdits":{"description":"Forged"}});
        preserve_edits(&saved, &mut agent);
        assert_eq!(agent["title"], "My title");
        assert_eq!(agent["description"], "New evidence");
        assert!(agent["userEdits"].get("description").is_none());
    }
    #[test]
    fn edited_structure_does_not_freeze_unedited_step_research() {
        let previous = json!({"userEdits":{"stages":true},"stages":[
            {"name":"Review","description":"Old","procedure":[]},
            {"name":"Send","description":"My wording","userEdited":true,"procedure":[]}
        ]});
        let mut next = json!({"stages":[
            {"name":"Send","description":"Overwritten","procedure":[{"text":"AI"}]},
            {"name":"Review","description":"Investigated","procedure":[{"text":"Verified detail"}],"screenshot":{"visualVerified":true}},
            {"name":"Deleted by owner","description":"Should not return"}
        ]});
        preserve_edits(&previous, &mut next);
        assert_eq!(next["stages"].as_array().unwrap().len(), 2);
        assert_eq!(next["stages"][0]["description"], "Investigated");
        assert_eq!(next["stages"][0]["procedure"][0]["text"], "Verified detail");
        assert_eq!(next["stages"][0]["screenshot"]["visualVerified"], true);
        assert_eq!(next["stages"][1], previous["stages"][1]);
        assert_eq!(next["evidenceStatus"], "candidate");
    }
    #[test]
    fn ambiguous_or_missing_step_matches_preserve_owner_structure() {
        let previous =
            json!({"userEdits":{"stages":true},"stages":[{"name":"Review","procedure":[]}]});
        for proposed in [json!([]), json!([{"name":"Review"},{"name":"Review"}])] {
            let mut next = json!({"stages":proposed});
            preserve_edits(&previous, &mut next);
            assert_eq!(next["stages"], previous["stages"]);
        }
    }
    #[test]
    fn historical_edit_flag_does_not_discard_newly_verified_timing() {
        let previous =
            json!({"userEdits":{"stages":true},"stages":[{"name":"Review","procedure":[]}]});
        let mut next = json!({"stages":[{"name":"Review","procedure":[{"text":"Supported action"}]}],
            "evidenceStatus":"verified","timing":{"averageMinutes":7},"durationSource":"observed","durationSampleCount":2});
        let reviewed = next.clone();
        preserve_edits(&previous, &mut next);
        assert_eq!(next["stages"], reviewed["stages"]);
        assert_eq!(next["timing"], reviewed["timing"]);
        assert_eq!(next["durationSampleCount"], 2);
        assert_eq!(next["evidenceStatus"], "verified");
    }
    #[tokio::test]
    async fn http_edit_contract_rejects_fabricated_evidence_and_saves_owner_edits() {
        use axum::{
            body::{to_bytes, Body},
            http::Request,
            routing::post,
            Router,
        };
        use tower::ServiceExt;
        let dir = tempfile::tempdir().unwrap();
        let before = json!({"schemaVersion":5,"revision":1,"analysis":{"workflows":[original()]}});
        tokio::fs::write(
            dir.path().join("catalog.json"),
            serde_json::to_vec(&before).unwrap(),
        )
        .await
        .unwrap();
        let router = Router::new()
            .route("/workflows/edits", post(edit))
            .layer(Extension(WorkflowCatalogSource(Some(
                dir.path().to_owned(),
            ))));
        let mut body = json!({"id":"wf-test","expected_revision":3,"title":"HTTP saved title","description":"Description","trigger":"Request","outcome":"Report","stages":[{"sourceIndex":0,"name":"Read","description":"Review sources","procedure":[]}]});
        body["stages"][0]["evidence"] = json!([{"detail":"Fabricated"}]);
        let request = |value: &Value| {
            Request::builder()
                .method("POST")
                .uri("/workflows/edits")
                .header("content-type", "application/json")
                .body(Body::from(value.to_string()))
                .unwrap()
        };
        assert_eq!(
            router
                .clone()
                .oneshot(request(&body))
                .await
                .unwrap()
                .status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
        body["stages"][0]
            .as_object_mut()
            .unwrap()
            .remove("evidence");
        let response = router.oneshot(request(&body)).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let value: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap())
                .unwrap();
        assert_eq!(value["workflow"]["title"], "HTTP saved title");
        assert_eq!(
            value["workflow"]["stages"][0]["evidence"],
            original()["stages"][0]["evidence"]
        );
    }
    #[tokio::test]
    async fn agent_capabilities_cannot_submit_manual_edits() {
        use screenpipe_core::pipes::permissions::PipePermissions;
        let perms = PipePermissions {
            pipe_name: "workflow-maintain".into(),
            allow_rules: vec![],
            deny_rules: vec![],
            use_default_allowlist: true,
            time_range: None,
            days: None,
            pipe_token: None,
            pipe_dir: None,
            privacy_filter: false,
        };
        let result = edit(
            Extension(WorkflowCatalogSource(None)),
            OptionalPipePerms(Some(std::sync::Arc::new(perms))),
            Json(request()),
        )
        .await;
        assert_eq!(result.unwrap_err().0, StatusCode::FORBIDDEN);
    }
    #[test]
    fn real_reconciliation_preserves_manual_steps_without_duplicating_images() {
        let mut body = request();
        body.stages[0].name = "Edited step".into();
        let saved = apply_edit(&original(), &body).unwrap();
        assert_eq!(saved["userEdits"]["stages"], true);
        assert!(!saved["userEdits"].to_string().contains("fixture-image"));
        let catalog = json!({"revision":1,"analysis":{"workflows":[saved.clone()]}});
        let mut update = original();
        update["description"] = json!("Newly observed description");
        let next =
            super::super::workflow_catalog::reconcile(catalog, vec![update], "2026-09-20").unwrap();
        let next = &next["analysis"]["workflows"][0];
        assert_eq!(next["stages"], saved["stages"]);
        assert_eq!(next["description"], "Newly observed description");
        assert_eq!(next["evidenceStatus"], "candidate");
    }
    #[tokio::test]
    async fn save_roundtrip_conflict_and_storage_failure() {
        let dir = tempfile::tempdir().unwrap();
        let before = json!({"schemaVersion":5,"revision":8,"analysis":{"workflows":[original(),{"id":"wf-other","title":"Untouched"}]}});
        tokio::fs::write(
            dir.path().join("catalog.json"),
            serde_json::to_vec(&before).unwrap(),
        )
        .await
        .unwrap();
        let source = WorkflowCatalogSource(Some(dir.path().to_owned()));
        let mut body = request();
        body.title = "Saved title".into();
        let result = edit(
            Extension(source.clone()),
            OptionalPipePerms(None),
            Json(body),
        )
        .await
        .unwrap()
        .0;
        let disk = read_catalog(&source).await.unwrap();
        assert_eq!(disk["analysis"]["workflows"][0], result["workflow"]);
        assert_eq!(disk["revision"], 9);
        assert_eq!(
            disk["analysis"]["workflows"][1],
            before["analysis"]["workflows"][1]
        );
        assert_eq!(
            edit(
                Extension(source.clone()),
                OptionalPipePerms(None),
                Json(request())
            )
            .await
            .unwrap_err()
            .0,
            StatusCode::CONFLICT
        );
        assert_eq!(read_catalog(&source).await.unwrap(), disk);
        // Deterministically make backup replacement fail, without chmod/root assumptions.
        tokio::fs::remove_file(dir.path().join("catalog.backup.json"))
            .await
            .unwrap();
        tokio::fs::create_dir(dir.path().join("catalog.backup.json"))
            .await
            .unwrap();
        let mut body = request();
        body.expected_revision = 4;
        body.title = "Must not persist".into();
        assert!(edit(
            Extension(source.clone()),
            OptionalPipePerms(None),
            Json(body)
        )
        .await
        .is_err());
        assert_eq!(read_catalog(&source).await.unwrap(), disk);
    }
}
