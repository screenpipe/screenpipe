// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Opt-in publication of instruction-only workflow copies through the existing
//! scheduler. Account, destination, revision and consent are checked at send time.
use super::{
    search::OptionalPipePerms,
    workflow_catalog::{allowed, error, persist, WRITER},
    workflows::{read_catalog, workflow_id, WorkflowCatalogSource},
};
use crate::server::AppState;
use axum::{extract::State, http::StatusCode, Extension, Json};
use oasgen::{oasgen, OaSchema};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{sync::Arc, time::Duration};
type ApiError = (StatusCode, Json<Value>);
const TASK: &str = "workflow-share";

fn token(state: &AppState) -> Result<String, ApiError> {
    (**state.cloud_token.load())
        .clone()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| error(StatusCode::UNAUTHORIZED, "Sign in to share workflows."))
}
async fn cloud(token: &str, license: Option<&str>, body: Option<Value>) -> Result<Value, ApiError> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| {
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Team sharing is unavailable.",
            )
        })?;
    let base =
        std::env::var("SCREENPIPE_WEB_URL").unwrap_or_else(|_| "https://screenpipe.com".into());
    let url = format!(
        "{}/api/enterprise/member-workflows/import",
        base.trim_end_matches('/')
    );
    let request = if let Some(body) = body {
        client.post(url).json(&body)
    } else {
        client.get(url).query(
            &license
                .map(|id| vec![("license_id", id)])
                .unwrap_or_default(),
        )
    };
    let response = request.bearer_auth(token).send().await.map_err(|_| {
        error(
            StatusCode::BAD_GATEWAY,
            "Could not reach your team workspace.",
        )
    })?;
    let status = response.status();
    let value: Value = response
        .json()
        .await
        .map_err(|_| error(StatusCode::BAD_GATEWAY, "Invalid team sharing response."))?;
    if !status.is_success() {
        return Err(error(
            status,
            value["error"]
                .as_str()
                .unwrap_or("Your account cannot share to this workspace."),
        ));
    }
    Ok(value)
}
fn check_agent(perms: &OptionalPipePerms) -> Result<(), ApiError> {
    if perms.0.as_ref().is_some_and(|p| p.pipe_name != TASK) {
        return Err(error(
            StatusCode::FORBIDDEN,
            "Only the workflow sharing task can classify workflows.",
        ));
    }
    Ok(())
}
/// Explicit projection: source evidence and image/file references never leave
/// the device through this endpoint, even when a model asks to include them.
fn projection(workflow: &Value) -> Value {
    let steps: Vec<Value> = workflow["stages"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|stage| {
            stage["procedure"].as_array().into_iter().flatten().map(move |p| json!({
            "action":stage["name"], "detail":p["text"], "app":p["app"].as_str().unwrap_or("")
        }))
        })
        .collect();
    json!({"id":workflow_id(workflow),"revision":workflow["revision"].as_u64().unwrap_or(0),
        "title":workflow["title"], "description":workflow["description"],
        "trigger":workflow["trigger"], "outcome":workflow["outcome"], "steps":steps})
}
fn digest(value: &Value) -> String {
    format!("{:x}", Sha256::digest(value.to_string().as_bytes()))
}
fn consent_matches(settings: &Value, identity: &Value) -> bool {
    settings["enabled"] == true
        && identity["available"] == true
        && identity["account_id"].is_string()
        && identity["license_id"].is_string()
        && settings["account_id"] == identity["account_id"]
        && settings["license_id"] == identity["license_id"]
}
#[oasgen]
pub(crate) async fn context(
    State(state): State<Arc<AppState>>,
    Extension(source): Extension<WorkflowCatalogSource>,
    perms: OptionalPipePerms,
) -> Result<Json<Value>, ApiError> {
    check_agent(&perms)?;
    allowed(&state, &perms)?;
    let current = read_catalog(&source).await?;
    let settings = &current["teamSharing"];
    let jwt = token(&state)?;
    let destination = if perms.0.is_some() {
        settings["license_id"].as_str()
    } else {
        None
    };
    let identity = cloud(&jwt, destination, None).await?;
    let enabled = consent_matches(settings, &identity);
    let complete = current["agentWorkspace"]["cycle"]["status"] == "complete";
    let candidates: Vec<Value> = if enabled && complete {
        current["analysis"]["workflows"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|w| {
                let value = projection(w);
                let hash = digest(&value);
                let id = workflow_id(w);
                let receipt = &settings["decisions"][&id];
                if receipt["shared"] == true || receipt["hash"] == hash {
                    None
                } else {
                    Some(json!({"workflow":value,"hash":hash}))
                }
            })
            .take(20)
            .collect()
    } else {
        vec![]
    };
    Ok(Json(
        json!({"enabled":enabled,"account_id":identity["account_id"],"license_id":identity["license_id"],
        "ready":enabled && complete && !candidates.is_empty(),"receiptRevision":settings["revision"].as_u64().unwrap_or(0),"candidates":candidates}),
    ))
}
#[derive(Deserialize, OaSchema)]
pub(crate) struct Change {
    action: String,
    enabled: Option<bool>,
    account_id: Option<String>,
    license_id: Option<String>,
    workflow_id: Option<String>,
    hash: Option<String>,
    classification: Option<String>,
}
#[oasgen]
pub(crate) async fn change(
    State(state): State<Arc<AppState>>,
    Extension(source): Extension<WorkflowCatalogSource>,
    perms: OptionalPipePerms,
    Json(input): Json<Change>,
) -> Result<Json<Value>, ApiError> {
    check_agent(&perms)?;
    if input.action != "configure" || input.enabled != Some(false) {
        allowed(&state, &perms)?;
    }
    // Serializes consent changes with sends and the existing catalog writer.
    // A successful disable receipt means no queued classification can send later.
    let _guard = WRITER.lock().await;
    let before = read_catalog(&source).await?;
    let mut next = before.clone();
    if input.action == "configure" {
        if perms.0.is_some() {
            return Err(error(
                StatusCode::FORBIDDEN,
                "Only the desktop owner can change sharing.",
            ));
        }
        let enabled = input.enabled.ok_or_else(|| {
            error(
                StatusCode::BAD_REQUEST,
                "Choose whether sharing is enabled.",
            )
        })?;
        if !enabled {
            next["teamSharing"]["enabled"] = json!(false);
        } else {
            let jwt = token(&state)?;
            let identity = cloud(&jwt, input.license_id.as_deref(), None).await?;
            if token(&state)? != jwt
                || identity["available"] != true
                || identity["account_id"].as_str() != input.account_id.as_deref()
                || identity["license_id"].as_str() != input.license_id.as_deref()
                || !identity["account_id"].is_string()
                || !identity["license_id"].is_string()
            {
                return Err(error(StatusCode::CONFLICT, "Account changed. Try again."));
            }
            let same = before["teamSharing"]["account_id"] == identity["account_id"]
                && before["teamSharing"]["license_id"] == identity["license_id"];
            next["teamSharing"] = json!({"enabled":true,"account_id":identity["account_id"],"license_id":identity["license_id"],
                "decisions":if same { before["teamSharing"]["decisions"].clone() } else { json!({}) }});
        }
        persist(&source, &before, &next).await?;
        return Ok(Json(json!({"enabled":enabled})));
    }
    if input.action != "classify" {
        return Err(error(StatusCode::BAD_REQUEST, "Unknown sharing action."));
    }
    let classification = input.classification.as_deref().unwrap_or("");
    if !matches!(classification, "professional" | "personal" | "uncertain") {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "Choose professional, personal or uncertain.",
        ));
    }
    let settings = &before["teamSharing"];
    if settings["enabled"] != true || before["agentWorkspace"]["cycle"]["status"] != "complete" {
        return Err(error(
            StatusCode::CONFLICT,
            "Sharing is off or workflow updates are still running.",
        ));
    }
    let id = input.workflow_id.as_deref().unwrap_or("");
    let workflow = before["analysis"]["workflows"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|w| workflow_id(w) == id)
        .ok_or_else(|| error(StatusCode::NOT_FOUND, "Workflow no longer exists."))?;
    let value = projection(workflow);
    let hash = digest(&value);
    if input.hash.as_deref() != Some(hash.as_str()) {
        return Err(error(
            StatusCode::CONFLICT,
            "Workflow changed. Read it again before classifying.",
        ));
    }
    if settings["decisions"][id]["shared"] == true || settings["decisions"][id]["hash"] == hash {
        return Ok(Json(settings["decisions"][id].clone()));
    }
    let jwt = token(&state)?;
    let identity = cloud(&jwt, settings["license_id"].as_str(), None).await?;
    if !consent_matches(settings, &identity) || token(&state)? != jwt {
        return Err(error(
            StatusCode::CONFLICT,
            "Account or workspace changed. Enable sharing again.",
        ));
    }
    let receipt = if classification == "professional" {
        let mut value = value;
        value["classification"] = json!("professional");
        let result = cloud(
            &jwt,
            None,
            Some(json!({"license_id":identity["license_id"],"workflow":value})),
        )
        .await?;
        if result["license_id"] != identity["license_id"]
            || !result["artifact_id"].is_string()
            || !result["receipt"].is_string()
        {
            return Err(error(
                StatusCode::BAD_GATEWAY,
                "Team publication was not confirmed.",
            ));
        }
        Some(result)
    } else {
        None
    };
    if !next["teamSharing"]["decisions"].is_object() {
        next["teamSharing"]["decisions"] = json!({});
    }
    next["teamSharing"]["decisions"][id] = json!({"hash":hash,"classification":classification,"shared":receipt.is_some(),"receipt":receipt});
    next["teamSharing"]["revision"] = json!(settings["revision"].as_u64().unwrap_or(0) + 1);
    persist(&source, &before, &next).await?;
    Ok(Json(next["teamSharing"]["decisions"][id].clone()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn projection_excludes_private_evidence_and_pixels() {
        let value = projection(
            &json!({"title":"Close ticket","description":"Resolve requests","trigger":"New request","outcome":"Ticket closed","revision":3,
            "evidence":[{"quote":"PRIVATE"}],"screenshot":"PRIVATE","stages":[{"name":"Resolve","procedure":[{"text":"Check the issue","app":"Support","quote":"PRIVATE","timestamp":"PRIVATE"}],"screenshots":["PRIVATE"]}]}),
        );
        assert!(!value.to_string().contains("PRIVATE"));
        assert_eq!(value["steps"][0]["detail"], "Check the issue");
    }
    #[test]
    fn consent_binds_account_and_workspace() {
        let settings = json!({"enabled":true,"account_id":"a","license_id":"team"});
        assert!(consent_matches(
            &settings,
            &json!({"available":true,"account_id":"a","license_id":"team"})
        ));
        assert!(!consent_matches(
            &settings,
            &json!({"available":true,"account_id":"b","license_id":"team"})
        ));
        assert!(!consent_matches(
            &settings,
            &json!({"available":true,"account_id":"a","license_id":"other"})
        ));
        assert!(!consent_matches(&json!({}), &json!({})));
    }
}
