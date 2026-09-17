// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Shared workflow task identity and admission policy. The gateway owns balances,
//! allowance thresholds and charging; desktop never invents a second credit ledger.
use serde_json::{json, Value};
use std::path::Path;

// The desktop's authenticated PostHog bridge supplies the rollout decision.
// Never persist this grant: a restarted engine waits for a fresh decision.
static ROLLOUT_ENABLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
pub fn set_rollout_enabled(enabled: bool) {
    ROLLOUT_ENABLED.store(enabled, std::sync::atomic::Ordering::SeqCst);
}
pub fn rollout_enabled() -> bool {
    ROLLOUT_ENABLED.load(std::sync::atomic::Ordering::SeqCst)
}
fn require_rollout(enabled: bool) -> anyhow::Result<()> {
    if !enabled {
        anyhow::bail!(
            "workflow_rollout_disabled: Workflows is not available for this account yet."
        );
    }
    Ok(())
}

pub const TASKS: [&str; 5] = [
    "workflow-activity",
    "workflow-patterns",
    "workflow-procedures",
    "workflow-timing",
    "workflow-discovery",
];
pub fn stage(name: &str) -> Option<usize> {
    TASKS.iter().position(|n| *n == name)
}
pub fn task_at(path: &Path) -> Option<&str> {
    path.file_name()
        .and_then(|n| n.to_str())
        .filter(|n| stage(n).is_some() && path.join("pipe.md").is_file())
}

#[cfg(test)]
pub fn admission(usage: &Value) -> Result<(), (&'static str, &'static str)> {
    admission_for_model(usage, "auto")
}
fn admission_for_model(usage: &Value, model: &str) -> Result<(), (&'static str, &'static str)> {
    let plan = usage
        .pointer("/hosted_ai/plan")
        .and_then(Value::as_str)
        .ok_or((
            "workflow_usage_unavailable",
            "Could not verify workflow access. Reconnect and try again.",
        ))?;
    if plan == "unknown" {
        return Err((
            "workflow_usage_unavailable",
            "Could not verify workflow access. Reconnect and try again.",
        ));
    }
    // Match the gateway's privileged allowance label as well as paid billing tiers.
    // check_admission obtains this value from the authenticated gateway response.
    if !matches!(
        plan,
        "business"
            | "business_max"
            | "business_ultra"
            | "pro"
            | "pro_max"
            | "pro_ultra"
            | "team"
            | "enterprise"
            | "super_admin"
    ) {
        return Err(("workflow_business_required", "Automatic workflow discovery requires Business. Your saved workflows are still available."));
    }
    // Owned-GPU inference has no paid-provider allowance debit. Authentication,
    // Business entitlement and gateway capacity limits still apply.
    if model == super::model_choice::PRIVATE_MODEL {
        return Ok(());
    }
    if usage["cost_limit_reached"] == true || usage["remaining"].as_f64().is_some_and(|n| n <= 0.0)
    {
        return Err(("workflow_allowance_paused", "Workflow updates paused because the AI allowance is exhausted. Manage usage to see available capacity and reset times."));
    }
    if usage
        .pointer("/background_pipe_advisory/reason")
        .and_then(Value::as_str)
        == Some("background_pipe_allowance_low")
    {
        return Err(("workflow_allowance_paused", "Workflow updates paused to preserve AI allowance for chat. Increase capacity or wait for the allowance to recover."));
    }
    if usage["cost_limit_reached"].as_bool().is_none() {
        return Err(("workflow_usage_unavailable", "AI allowance is unavailable. Saved workflows remain accessible; try again after reconnecting."));
    }
    Ok(())
}

/// Check durable inputs before starting a model session. Missing inputs and
/// already-consumed revisions do not spend tokens or launch a second runner.
pub async fn has_pending_input(path: &Path) -> anyhow::Result<bool> {
    let Some(task) = task_at(path) else {
        return Ok(true);
    };
    let permissions: Value =
        serde_json::from_slice(&std::fs::read(path.join(".screenpipe-permissions.json"))?)?;
    let base = permissions["api_base"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Recorder address unavailable"))?;
    let url = reqwest::Url::parse(base)?;
    if url.scheme() != "http"
        || !matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
    {
        anyhow::bail!("Workflow requires its local recorder");
    }
    let response = reqwest::Client::new()
        .get(format!("{base}/workflows/pipeline?task={task}"))
        .bearer_auth(permissions["pipe_token"].as_str().unwrap_or_default())
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await?
        .error_for_status()?;
    let value: Value = response.json().await?;
    if let Some(reason) = value["blockedReason"].as_str() {
        anyhow::bail!("workflow_dependency_paused: {reason}");
    }
    if value["ready"] == true
        && stage(task).is_some_and(|index| index > 0)
        && value["reviewRequested"] != true
        && (value["input"]["unchanged"] == true
            || value["input"]["items"]
                .as_array()
                .is_some_and(Vec::is_empty))
    {
        // Deterministic no-change propagation. Keep prior enrichment and advance
        // only its coverage, without asking a model to restate identical input.
        let final_stage = task == TASKS[4];
        let body = if final_stage {
            json!({"expected_revision":value["catalogRevision"],"pipeline_revision":value["inputRevision"],"checked_through":value["checkedThrough"],"workflows":[]})
        } else {
            json!({"task":task,"expected_revision":value["revision"],"input_revision":value["inputRevision"],"checked_through":value["checkedThrough"],
                "items":value["previous"]["items"].as_array().cloned().unwrap_or_default(),"coverage":value["input"]["coverage"].as_array().cloned().unwrap_or_default()})
        };
        let route = if final_stage { "catalog" } else { "pipeline" };
        let receipt: Value = reqwest::Client::new()
            .post(format!("{base}/workflows/{route}"))
            .bearer_auth(permissions["pipe_token"].as_str().unwrap_or_default())
            .json(&body)
            .timeout(std::time::Duration::from_secs(30))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        if receipt["checkedThrough"] != value["checkedThrough"]
            || receipt["revision"].as_u64().is_none()
        {
            anyhow::bail!("missing_output: No valid no-change receipt");
        }
        return Ok(false);
    }
    value["ready"]
        .as_bool()
        .ok_or_else(|| anyhow::anyhow!("Workflow input status unavailable"))
}

pub async fn check_admission(
    api_url: &str,
    token: Option<&str>,
    model: &str,
) -> anyhow::Result<()> {
    require_rollout(rollout_enabled())?;
    let token = token.filter(|s| !s.is_empty()).ok_or_else(|| {
        anyhow::anyhow!("workflow_sign_in_required: Sign in to enable workflow updates.")
    })?;
    let response = reqwest::Client::new()
        .get(format!("{}/usage", api_url.trim_end_matches('/')))
        .bearer_auth(token)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|_| {
            anyhow::anyhow!("workflow_usage_unavailable: Could not check AI allowance.")
        })?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        anyhow::bail!("workflow_sign_in_required: Sign in again to resume workflow updates.");
    }
    if !response.status().is_success() {
        anyhow::bail!("workflow_usage_unavailable: Could not check AI allowance.");
    }
    let value: Value = response
        .json()
        .await
        .map_err(|_| anyhow::anyhow!("workflow_usage_unavailable: Invalid allowance response."))?;
    admission_for_model(&value, model).map_err(|(code, message)| {
        anyhow::anyhow!("{}", json!({"error":{"code":code,"message":message}}))
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn rollout_is_explicit_and_fail_closed() {
        assert!(super::require_rollout(false)
            .unwrap_err()
            .to_string()
            .contains("workflow_rollout_disabled"));
        assert!(super::require_rollout(true).is_ok());
    }
    use super::*;
    #[tokio::test]
    async fn unchanged_input_advances_a_verified_receipt_without_a_model() {
        use wiremock::{
            matchers::{body_partial_json, method, path},
            Mock, MockServer, ResponseTemplate,
        };
        let server = MockServer::start().await;
        let root = tempfile::tempdir().unwrap();
        let task = root.path().join(TASKS[1]);
        std::fs::create_dir(&task).unwrap();
        std::fs::write(task.join("pipe.md"), "fixture").unwrap();
        std::fs::write(
            task.join(".screenpipe-permissions.json"),
            serde_json::to_vec(&json!({"api_base":server.uri(),"pipe_token":"fixture"})).unwrap(),
        )
        .unwrap();
        Mock::given(method("GET")).and(path("/workflows/pipeline"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"ready":true,"revision":8,"inputRevision":8,"checkedThrough":"2026-09-15T00:00:00Z","input":{"unchanged":true,"coverage":[]},"previous":{"items":[{"id":"kept"}]}})))
            .mount(&server).await;
        Mock::given(method("POST"))
            .and(path("/workflows/pipeline"))
            .and(body_partial_json(
                json!({"expected_revision":8,"input_revision":8,"items":[{"id":"kept"}]}),
            ))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({"revision":9,"checkedThrough":"2026-09-15T00:00:00Z"})),
            )
            .expect(1)
            .mount(&server)
            .await;
        assert!(!has_pending_input(&task).await.unwrap());
    }
    #[tokio::test]
    async fn requested_review_does_not_skip_the_agent() {
        use wiremock::{matchers::method, Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        let root = tempfile::tempdir().unwrap();
        let task = root.path().join(TASKS[4]);
        std::fs::create_dir(&task).unwrap();
        std::fs::write(task.join("pipe.md"), "fixture").unwrap();
        std::fs::write(
            task.join(".screenpipe-permissions.json"),
            serde_json::to_vec(&json!({"api_base":server.uri(),"pipe_token":"fixture"})).unwrap(),
        )
        .unwrap();
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_json(
                json!({"ready":true,"reviewRequested":true,"input":{"unchanged":true}}),
            ))
            .mount(&server)
            .await;
        assert!(has_pending_input(&task).await.unwrap());
        assert_eq!(server.received_requests().await.unwrap().len(), 1);
    }
    #[test]
    fn private_model_ignores_paid_allowance_but_requires_business() {
        let mut usage =
            json!({"hosted_ai":{"plan":"business"},"remaining":0,"cost_limit_reached":true});
        assert!(admission_for_model(&usage, super::super::model_choice::PRIVATE_MODEL).is_ok());
        assert!(admission(&usage).is_err());
        usage["hosted_ai"]["plan"] = json!("free");
        assert!(admission_for_model(&usage, super::super::model_choice::PRIVATE_MODEL).is_err());
        assert!(
            admission_for_model(&Value::Null, super::super::model_choice::PRIVATE_MODEL).is_err()
        );
    }
    #[test]
    fn privileged_gateway_plan_retains_all_admission_checks() {
        for plan in ["business_ultra", "super_admin"] {
            let mut usage =
                json!({"hosted_ai":{"plan":plan},"remaining":100,"cost_limit_reached":false});
            assert!(admission(&usage).is_ok(), "{plan}");
            usage["cost_limit_reached"] = json!(true);
            assert_eq!(
                admission(&usage).unwrap_err().0,
                "workflow_allowance_paused"
            );
            usage["cost_limit_reached"] = Value::Null;
            assert_eq!(
                admission(&usage).unwrap_err().0,
                "workflow_usage_unavailable"
            );
            usage["cost_limit_reached"] = json!(false);
            usage["background_pipe_advisory"] = json!({"reason":"background_pipe_allowance_low"});
            assert_eq!(
                admission(&usage).unwrap_err().0,
                "workflow_allowance_paused"
            );
        }
        for plan in ["free", "basic", "internal"] {
            let usage =
                json!({"hosted_ai":{"plan":plan},"remaining":100,"cost_limit_reached":false});
            assert_eq!(
                admission(&usage).unwrap_err().0,
                "workflow_business_required"
            );
        }
    }

    #[test]
    fn gates_background_work_without_interpreting_unknown_as_empty() {
        let mut u =
            json!({"hosted_ai":{"plan":"business"},"remaining":100,"cost_limit_reached":false});
        assert!(admission(&u).is_ok());
        u["hosted_ai"]["plan"] = json!("basic");
        assert_eq!(admission(&u).unwrap_err().0, "workflow_business_required");
        u["hosted_ai"]["plan"] = json!("business_max");
        u["background_pipe_advisory"] =
            json!({"reason":"background_pipe_allowance_low","should_notify":false});
        assert_eq!(admission(&u).unwrap_err().0, "workflow_allowance_paused");
        u["background_pipe_advisory"] = Value::Null;
        u["cost_limit_reached"] = Value::Null;
        assert_eq!(admission(&u).unwrap_err().0, "workflow_usage_unavailable");
    }
}
