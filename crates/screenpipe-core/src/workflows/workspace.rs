// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Durable agent handoffs. Interpretation and research strategy belong to prompts.
//! This state is stored with the catalog so publication and its receipt are atomic.
use chrono::{Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const TASKS: [&str; 4] = [
    "workflow-discover",
    "workflow-deepen",
    "workflow-review",
    "workflow-maintain",
];
pub fn is_task(task: &str) -> bool {
    TASKS.contains(&task)
}
pub fn empty() -> Value {
    json!({"revision":0,"cycle":null,"drafts":{},"receipts":{}})
}
pub fn state(catalog: &Value) -> Value {
    catalog.get("agentWorkspace").cloned().unwrap_or_else(empty)
}
pub fn revision(ws: &Value) -> u64 {
    ws["revision"].as_u64().unwrap_or(0)
}
pub fn assigned(ws: &Value, task: &str) -> bool {
    ws["drafts"]
        .as_object()
        .into_iter()
        .flat_map(|d| d.values())
        .any(|d| d["status"] == "open" && d["assignee"] == task)
}
pub fn ready(ws: &Value, task: &str) -> bool {
    if !is_task(task) {
        return false;
    }
    if ws["cycle"].is_null() {
        return task == TASKS[0];
    }
    if ws["cycle"]["status"] == "paused" {
        // Stop affects this run, not the user's recurring task settings.
        return task == TASKS[0]
            && ws["cycle"]["pausedAt"]
                .as_str()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .is_some_and(|at| Utc::now().signed_duration_since(at) >= Duration::hours(24));
    }
    if ws["cycle"]["status"] == "complete" {
        // Completion events must not start an endless sequence of fresh scans.
        return task == TASKS[0]
            && ws["cycle"]["end"]
                .as_str()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .is_some_and(|end| Utc::now().signed_duration_since(end) >= Duration::hours(1));
    }
    assigned(ws, task)
        || match task {
            "workflow-discover" | "workflow-maintain" => ws["cycle"]["finished"][task] != true,
            "workflow-review" => can_finish(ws),
            _ => false,
        }
}
pub fn can_finish(ws: &Value) -> bool {
    !ws["cycle"].is_null()
        && ws["cycle"]["status"] == "running"
        && ws["cycle"]["finished"][TASKS[0]] == true
        && ws["cycle"]["finished"][TASKS[3]] == true
        && !TASKS.iter().any(|task| assigned(ws, task))
}

#[derive(Debug, Deserialize, Serialize)]
pub struct Change {
    pub action: String,
    pub expected_revision: u64,
    #[serde(default)]
    pub draft_id: Option<String>,
    #[serde(default)]
    pub assignee: Option<String>,
    #[serde(default)]
    pub payload: Option<Value>,
    #[serde(default)]
    pub note: String,
}

/// Persist the stop before cancelling runners so late writes and queued wakes
/// cannot advance the cycle. Drafts and scheduling preferences remain intact.
pub fn pause(ws: &mut Value) {
    if ws["cycle"]["status"] == "running" {
        ws["cycle"]["status"] = json!("paused");
        ws["cycle"]["pausedAt"] = json!(Utc::now().to_rfc3339());
        ws["revision"] = json!(revision(ws) + 1);
    }
}

pub fn start(ws: &mut Value, catalog: &Value) {
    if ws["cycle"]["status"] == "paused" {
        ws["cycle"]["status"] = json!("running");
        ws["cycle"].as_object_mut().unwrap().remove("pausedAt");
        ws["revision"] = json!(revision(ws) + 1);
        return;
    }
    if !ws["cycle"].is_null() && ws["cycle"]["status"] == "running" {
        return;
    }
    // Keep the last completed investigation per agent across cycles/restarts.
    // Durable facts belong in the catalog; these bounded notes retain research
    // gaps and decisions, not another copy of every draft or captured source.
    if ws["cycle"]["status"] == "complete" {
        for task in TASKS {
            if let Some(note) = ws["cycle"]["notes"][task]
                .as_str()
                .filter(|s| !s.trim().is_empty())
            {
                let summary: String = note.chars().take(8000).collect();
                let entry = json!({"cycleId":ws["cycle"]["id"],"through":ws["cycle"]["end"],
                    "note":summary,"truncated":summary.len() < note.len()});
                if !ws["researchNotes"].is_object() {
                    ws["researchNotes"] = json!({});
                }
                ws["researchNotes"][task] = entry;
            }
        }
    }
    let now = Utc::now();
    let start = catalog["checkedThrough"]
        .as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|v| v.with_timezone(&Utc) - Duration::hours(2))
        .unwrap_or(now - Duration::days(7))
        .max(now - Duration::days(90));
    ws["cycle"] = json!({"id":uuid::Uuid::new_v4().to_string(),"status":"running", "start":start.to_rfc3339(),"end":now.to_rfc3339(),"finished":{},"changes":{"created":0,"updated":0}});
    // Completed drafts remain in the last catalog backup. Keep pending drafts on resume.
    ws["drafts"] = json!({});
    ws["revision"] = json!(revision(ws) + 1);
}

pub fn apply(ws: &mut Value, task: &str, change: &Change) -> Result<Value, String> {
    if !is_task(task) {
        return Err("Unknown workflow agent.".into());
    }
    if revision(ws) != change.expected_revision {
        return Err(
            "Workspace changed. Read context and retry against the current revision.".into(),
        );
    }
    if ws["cycle"]["status"] != "running" {
        return Err("Start or resume an update first.".into());
    }
    if change.note.trim().is_empty() {
        return Err("Include the evidence decision or remaining question in note.".into());
    }
    let rev = revision(ws) + 1;
    let mut id = change.draft_id.clone();
    match change.action.as_str() {
        "propose" | "handoff" => {
            let assignee = change
                .assignee
                .as_deref()
                .filter(|v| is_task(v))
                .ok_or("Choose an existing workflow agent.")?;
            let key = id
                .get_or_insert_with(|| uuid::Uuid::new_v4().to_string())
                .clone();
            let old = &ws["drafts"][&key];
            if change.action == "handoff" && old.is_null() {
                return Err("Draft not found.".into());
            }
            if !old.is_null() && (old["status"] != "open" || old["assignee"] != task) {
                return Err("Only the assigned agent can change an open draft.".into());
            }
            if old.is_null() && !matches!(task, "workflow-discover" | "workflow-maintain") {
                return Err(
                    "Discover or Maintain creates new drafts; other agents refine assigned drafts."
                        .into(),
                );
            }
            if change.action == "handoff"
                && assignee == task
                && change
                    .payload
                    .as_ref()
                    .is_none_or(|payload| payload == &old["payload"])
            {
                return Err("This self-handoff does not edit the draft. Supply the changed workflow object in payload, or hand the draft to another agent with a question. note is commentary only; it never changes description, stages or procedure. No changes were saved.".into());
            }
            let payload = change
                .payload
                .clone()
                .unwrap_or_else(|| old["payload"].clone());
            if !payload.is_object() {
                return Err("A draft payload must be an object.".into());
            }
            let mut history = old["history"].as_array().cloned().unwrap_or_default();
            history.push(json!({"agent":task,"note":change.note,"revision":rev}));
            // Bound storage, not the agent's semantic decisions.
            if history.len() > 30 {
                history.remove(0);
            }
            ws["drafts"][&key] = json!({"id":key,"status":"open","version":rev,"assignee":assignee,"payload":payload,"history":history});
        }
        "reject" => {
            let key = id.as_deref().ok_or("draft_id is required.")?;
            if ws["drafts"][key].is_null() {
                return Err("Draft not found.".into());
            }
            if task != TASKS[2]
                || ws["drafts"][key]["assignee"] != task
                || ws["drafts"][key]["status"] != "open"
            {
                return Err("Review must own this open draft to reject it.".into());
            }
            ws["drafts"][key]["status"] = json!("rejected");
            ws["drafts"][key]["decision"] = json!(change.note);
        }
        "finish" => {
            if assigned(ws, task) {
                return Err("Resolve or hand off your open drafts before finishing.".into());
            }
            if task == TASKS[2] {
                return Err("Review finishes through the atomic catalog commit.".into());
            }
            ws["cycle"]["finished"][task] = json!(true);
            ws["cycle"]["notes"][task] = json!(change.note);
        }
        _ => return Err("Unknown workspace action.".into()),
    }
    if ws["drafts"].as_object().map_or(0, |d| d.len()) > 200
        || serde_json::to_vec(ws).map_err(|e| e.to_string())?.len() > 2_000_000
    {
        return Err("Workspace is full. Finish the current drafts before proposing more.".into());
    }
    ws["revision"] = json!(rev);
    ws["receipts"][task] = json!({"revision":rev,"cycle":ws["cycle"]["id"],"note":change.note});
    Ok(json!({"revision":rev,"draft_id":id,"saved":true}))
}

/// Checked before source verification and again under the catalog writer.
pub fn check_publish(ws: &Value, rev: u64, id: Option<&str>) -> Result<(), String> {
    if let Some(id) = id {
        // A repeated request after a lost response gets the original receipt.
        if ws["drafts"][id]["status"] == "published" {
            return Ok(());
        }
    }
    if revision(ws) != rev {
        return Err("Workspace changed. Read context before publishing.".into());
    }
    if ws["cycle"]["status"] != "running" {
        return Err("Start or resume an update first.".into());
    }
    if let Some(id) = id {
        if ws["drafts"][id].is_null() {
            return Err("Draft not found.".into());
        }
        if ws["drafts"][id]["status"] != "open" || ws["drafts"][id]["assignee"] != TASKS[2] {
            return Err("Review must own an open draft before publishing.".into());
        }
    } else if !can_finish(ws) {
        return Err("Discovery, maintenance or draft review is still incomplete.".into());
    }
    Ok(())
}
pub fn publication_payload(
    ws: &Value,
    id: &str,
    proposed: Option<&Value>,
) -> Result<Value, String> {
    if ws["drafts"][id]["status"] == "published"
        && proposed.is_some_and(|payload| payload != &ws["drafts"][id]["payload"])
    {
        return Err("This draft was already published with a different payload. Propose a new correction instead of reusing its receipt.".into());
    }
    let payload = proposed.unwrap_or(&ws["drafts"][id]["payload"]);
    if !payload.is_object() {
        return Err(
            "Publication payload must be a workflow object matching outputContract.".into(),
        );
    }
    Ok(payload.clone())
}

pub fn published(ws: &mut Value, id: Option<&str>, payload: Option<&Value>, receipt: &Value) {
    if let Some(id) = id {
        if let Some(payload) = payload {
            ws["drafts"][id]["payload"] = payload.clone();
        }
        ws["drafts"][id]["status"] = json!("published");
        ws["drafts"][id]["receipt"] = receipt.clone();
        for key in ["created", "updated"] {
            ws["cycle"]["changes"][key] = json!(
                ws["cycle"]["changes"][key].as_u64().unwrap_or(0)
                    + receipt["changes"][key].as_u64().unwrap_or(0)
            );
        }
    } else {
        ws["cycle"]["status"] = json!("complete");
    }
    let rev = revision(ws) + 1;
    ws["revision"] = json!(rev);
    ws["receipts"][TASKS[2]] = json!({"revision":rev,"cycle":ws["cycle"]["id"],"saved":true});
}

/// Publication must preserve the reviewed procedure. Normalization can report
/// unsupported items, but may not silently save a different, partial procedure.
pub fn validate_publication(raw: &Value, normalized: &Value) -> Result<(), String> {
    let proposed = raw["workflows"].as_array().ok_or("Missing workflows")?;
    let saved = normalized["workflows"]
        .as_array()
        .ok_or("Missing workflows")?;
    if proposed.len() != saved.len() {
        return Err("Some workflows could not be verified.".into());
    }
    for (before, after) in proposed.iter().zip(saved) {
        let stages = before["stages"]
            .as_array()
            .ok_or("Missing workflow stages")?;
        let verified = after["stages"]
            .as_array()
            .ok_or("Missing verified stages")?;
        if stages.len() != verified.len() {
            return Err(
                "Some stages could not be verified. Revise the draft before publishing.".into(),
            );
        }
        for (index, (stage, saved)) in stages.iter().zip(verified).enumerate() {
            let requested = stage["procedure"].as_array().map_or(0, Vec::len);
            let retained = saved["procedure"].as_array().map_or(0, Vec::len);
            if requested != retained {
                return Err(format!("Stage {} retained {retained} of {requested} proposed procedure items. Check exact timestamp/app/quote references and the output contract, or explicitly revise unsupported claims. No workflow was saved.", index + 1));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn completed_research_survives_cycles_restart_and_pause() {
        let mut ws = empty();
        start(&mut ws, &json!({}));
        ws["cycle"]["notes"][TASKS[3]] = json!("wf-a: preparation verified; earlier recording unavailable. Recheck if new evidence appears.");
        ws["cycle"]["status"] = json!("complete");
        let old_id = ws["cycle"]["id"].clone();
        let mut restored = state(
            &serde_json::from_str::<Value>(&json!({"agentWorkspace":ws}).to_string()).unwrap(),
        );
        start(&mut restored, &json!({}));
        assert_eq!(restored["researchNotes"][TASKS[3]]["cycleId"], old_id);
        assert!(restored["researchNotes"][TASKS[3]]["note"]
            .as_str()
            .unwrap()
            .contains("earlier recording unavailable"));
        let saved_notes = restored["researchNotes"].clone();
        start(&mut restored, &json!({}));
        pause(&mut restored);
        start(&mut restored, &json!({}));
        assert_eq!(restored["researchNotes"], saved_notes);
        restored["cycle"]["status"] = json!("complete");
        restored["cycle"]["notes"][TASKS[0]] = json!("New job investigated");
        start(&mut restored, &json!({}));
        assert_eq!(restored["researchNotes"][TASKS[3]], saved_notes[TASKS[3]]);
        assert_eq!(
            restored["researchNotes"][TASKS[0]]["note"],
            "New job investigated"
        );
        restored["cycle"]["status"] = json!("complete");
        restored["cycle"]["notes"][TASKS[3]] = json!("Updated evidence closes the gap");
        start(&mut restored, &json!({}));
        assert_eq!(
            restored["researchNotes"][TASKS[3]]["note"],
            "Updated evidence closes the gap"
        );
    }
    #[test]
    fn retained_research_is_bounded_without_invalid_unicode() {
        let mut ws = empty();
        ws["cycle"] = json!({"status":"complete","notes":{TASKS[3]:"界".repeat(9000)}});
        start(&mut ws, &json!({}));
        assert_eq!(
            ws["researchNotes"][TASKS[3]]["note"]
                .as_str()
                .unwrap()
                .chars()
                .count(),
            8000
        );
        assert_eq!(ws["researchNotes"][TASKS[3]]["truncated"], true);
    }
    fn change(action: &str, ws: &Value, id: Option<String>, assignee: Option<&str>) -> Change {
        Change {
            action: action.into(),
            expected_revision: revision(ws),
            draft_id: id,
            assignee: assignee.map(str::to_owned),
            payload: Some(
                json!({"title":"Research invoice reconciliation","note":"literal quote with \"quotes\" and ]}"}),
            ),
            note: "Investigate actual observed actions, not menu labels".into(),
        }
    }
    #[test]
    fn completed_cycles_allow_hourly_discovery_without_completion_loops() {
        let mut ws = empty();
        ws["cycle"] =
            json!({"status":"complete","end":(Utc::now()-Duration::minutes(30)).to_rfc3339()});
        assert!(TASKS.iter().all(|task| !ready(&ws, task)));
        ws["cycle"]["end"] = json!((Utc::now() - Duration::minutes(61)).to_rfc3339());
        assert!(ready(&ws, TASKS[0]));
        assert!(TASKS[1..].iter().all(|task| !ready(&ws, task)));
        ws["cycle"] =
            json!({"status":"paused","pausedAt":(Utc::now()-Duration::minutes(61)).to_rfc3339()});
        assert!(TASKS.iter().all(|task| !ready(&ws, task)));
    }
    #[test]
    fn missing_targets_are_distinct_from_ownership_and_never_mutate() {
        let mut ws = empty();
        start(&mut ws, &json!({}));
        let proposal = change("propose", &ws, None, Some(TASKS[1]));
        let id = apply(&mut ws, TASKS[0], &proposal).unwrap()["draft_id"]
            .as_str()
            .unwrap()
            .to_owned();
        let before = ws.clone();
        for action in ["handoff", "reject"] {
            let c = change(action, &ws, Some("mistyped-id".into()), Some(TASKS[1]));
            assert_eq!(
                apply(&mut ws, TASKS[2], &c).unwrap_err(),
                "Draft not found."
            );
            assert_eq!(ws, before);
        }
        assert_eq!(
            check_publish(&ws, revision(&ws), Some("mistyped-id")).unwrap_err(),
            "Draft not found."
        );
        assert!(check_publish(&ws, revision(&ws), Some(&id))
            .unwrap_err()
            .contains("Review must own"));
        assert!(check_publish(&ws, revision(&ws) - 1, Some("mistyped-id"))
            .unwrap_err()
            .contains("Workspace changed"));
        assert_eq!(ws, before);
    }

    #[test]
    fn stop_preserves_drafts_blocks_late_writes_and_resumes_the_same_cycle() {
        let mut ws = empty();
        start(&mut ws, &json!({}));
        let proposal = change("propose", &ws, None, Some(TASKS[2]));
        let id = apply(&mut ws, TASKS[0], &proposal).unwrap()["draft_id"]
            .as_str()
            .unwrap()
            .to_owned();
        let before = ws.clone();
        pause(&mut ws);
        let paused = ws.clone();
        pause(&mut ws);
        assert_eq!(ws, paused); // repeated Stop does not postpone the daily run
        assert_eq!(ws["drafts"], before["drafts"]);
        for task in TASKS {
            assert!(!ready(&ws, task));
        }
        assert!(!can_finish(&ws));
        assert!(check_publish(&ws, revision(&ws), Some(&id)).is_err());
        let c = change("reject", &ws, Some(id), None);
        assert!(apply(&mut ws, TASKS[2], &c).is_err());
        assert_eq!(ws, paused);
        // The serialized state survives restart; a scheduled Discover may resume
        // the saved work the next day. Other roles cannot wake it prematurely.
        let mut restored: Value =
            serde_json::from_slice(&serde_json::to_vec(&ws).unwrap()).unwrap();
        restored["cycle"]["pausedAt"] = json!((Utc::now() - Duration::hours(25)).to_rfc3339());
        assert!(ready(&restored, TASKS[0]));
        for task in &TASKS[1..] {
            assert!(!ready(&restored, task));
        }
        start(&mut restored, &json!({}));
        assert_eq!(restored["drafts"], before["drafts"]);
        assert_eq!(restored["cycle"], before["cycle"]);
        assert!(ready(&restored, TASKS[2]));
        assert!(revision(&restored) > revision(&before));
    }

    #[test]
    fn publication_cannot_silently_drop_reviewed_steps() {
        let raw = json!({"workflows":[{"stages":[{"procedure":[{"text":"Open invoice"},{"text":"Save receipt"}]}]}]});
        assert!(validate_publication(&raw, &raw).is_ok());
        let partial = json!({"workflows":[{"stages":[{"procedure":[{"text":"Open invoice"}]}]}]});
        assert!(validate_publication(&raw, &partial)
            .unwrap_err()
            .contains("1 of 2"));
        assert!(validate_publication(&raw, &json!({"workflows":[]})).is_err());
        assert!(validate_publication(&json!({"workflows":[]}), &json!({"workflows":[]})).is_ok());
    }
    #[test]
    fn publish_uses_reviewed_payload_and_retry_cannot_hide_a_different_edit() {
        let mut ws = empty();
        start(&mut ws, &json!({}));
        let proposal = change("propose", &ws, None, Some(TASKS[2]));
        let id = apply(&mut ws, TASKS[0], &proposal).unwrap()["draft_id"]
            .as_str()
            .unwrap()
            .to_owned();
        let original = ws.clone();
        let edited = json!({"title":"Observed drafting only", "description":"Delivery is unverified", "stages":[]});
        assert_eq!(
            publication_payload(&ws, &id, None).unwrap(),
            ws["drafts"][&id]["payload"]
        );
        assert_eq!(
            publication_payload(&ws, &id, Some(&edited)).unwrap(),
            edited
        );
        for invalid in [Value::Null, json!("notes"), json!([])] {
            assert!(publication_payload(&ws, &id, Some(&invalid)).is_err());
        }
        assert_eq!(ws, original); // validation alone never edits durable state
        published(
            &mut ws,
            Some(&id),
            Some(&edited),
            &json!({"changes":{"created":1}}),
        );
        assert_eq!(ws["drafts"][&id]["payload"], edited);
        assert_eq!(
            publication_payload(&ws, &id, Some(&edited)).unwrap(),
            edited
        );
        assert!(
            publication_payload(&ws, &id, Some(&proposal.payload.unwrap()))
                .unwrap_err()
                .contains("different payload")
        );
    }
    #[test]
    fn self_handoff_requires_a_real_edit_but_research_handoffs_preserve_payload() {
        let mut ws = empty();
        start(&mut ws, &json!({}));
        let proposed = change("propose", &ws, None, Some(TASKS[2]));
        let id = apply(&mut ws, TASKS[0], &proposed).unwrap()["draft_id"]
            .as_str()
            .unwrap()
            .to_owned();
        let before = ws.clone();
        let mut edit = change("handoff", &ws, Some(id.clone()), Some(TASKS[2]));
        for payload in [None, Some(before["drafts"][&id]["payload"].clone())] {
            edit.payload = payload;
            assert!(apply(&mut ws, TASKS[2], &edit)
                .unwrap_err()
                .contains("note is commentary only"));
            assert_eq!(ws, before);
        }
        edit.payload = Some(json!({"title":"Corrected workflow", "stages":[]}));
        apply(&mut ws, TASKS[2], &edit).unwrap();
        let corrected = ws["drafts"][&id]["payload"].clone();
        let mut handoff = change("handoff", &ws, Some(id.clone()), Some(TASKS[1]));
        handoff.payload = None;
        apply(&mut ws, TASKS[2], &handoff).unwrap();
        assert_eq!(ws["drafts"][&id]["payload"], corrected);
        assert_eq!(ws["drafts"][&id]["assignee"], TASKS[1]);
    }
    #[test]
    fn independent_drafts_can_be_sent_back_without_blocking_publication() {
        let mut ws = empty();
        start(&mut ws, &json!({}));
        let c = change("propose", &ws, None, Some(TASKS[1]));
        let a = apply(&mut ws, TASKS[0], &c).unwrap()["draft_id"]
            .as_str()
            .unwrap()
            .to_owned();
        let c = change("propose", &ws, None, Some(TASKS[2]));
        let b = apply(&mut ws, TASKS[0], &c).unwrap()["draft_id"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(check_publish(&ws, revision(&ws), Some(&b)).is_ok());
        assert!(check_publish(&ws, revision(&ws), Some(&a)).is_err());
        let c = change("handoff", &ws, Some(a.clone()), Some(TASKS[2]));
        apply(&mut ws, TASKS[1], &c).unwrap();
        let c = change("handoff", &ws, Some(a.clone()), Some(TASKS[1]));
        apply(&mut ws, TASKS[2], &c).unwrap();
        let rev = revision(&ws);
        published(&mut ws, Some(&b), None, &json!({"changes":{"created":1}}));
        assert!(check_publish(&ws, rev, Some(&b)).is_ok());
        assert!(assigned(&ws, TASKS[1]));
        assert!(!can_finish(&ws));
    }
    #[test]
    fn completion_requires_all_work_and_keeps_fixed_requested_end() {
        let mut ws = empty();
        start(&mut ws, &json!({}));
        let end = ws["cycle"]["end"].clone();
        start(&mut ws, &json!({}));
        assert_eq!(ws["cycle"]["end"], end);
        assert!(!can_finish(&ws));
        for task in [TASKS[0], TASKS[3]] {
            let c = change("finish", &ws, None, None);
            apply(&mut ws, task, &c).unwrap();
        }
        assert!(can_finish(&ws));
        published(&mut ws, None, None, &json!({}));
        assert_eq!(ws["cycle"]["status"], "complete");
        let id = ws["cycle"]["id"].clone();
        start(&mut ws, &json!({}));
        assert_ne!(ws["cycle"]["id"], id);
    }
    #[test]
    fn stale_revisions_and_unowned_edits_are_rejected() {
        let mut ws = empty();
        start(&mut ws, &json!({}));
        let c = change("propose", &ws, None, Some(TASKS[1]));
        let id = apply(&mut ws, TASKS[0], &c).unwrap()["draft_id"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(apply(&mut ws, TASKS[0], &c).is_err());
        let c = change("handoff", &ws, Some(id), Some(TASKS[2]));
        assert!(apply(&mut ws, TASKS[0], &c).is_err());
    }
}
