// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
//! Real HTTP source verification, workspace publication and disk reload. An
//! optional real-agent artifact uses the same assertions as the fixed fixture.
use chrono::{Duration, Utc};
use screenpipe_audio::audio_manager::AudioManagerBuilder;
use screenpipe_core::pipes::PipeManager;
use screenpipe_db::DatabaseManager;
use screenpipe_engine::SCServer;
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Arc};

fn fixture() -> Value {
    let start = Utc::now() - Duration::days(3);
    let rows: Vec<Value> = [(0, "New receipt form opened for INV-123. Started entering the vendor invoice number."),
        (6, "Receipt INV-123 saved successfully. Receipt entry complete; new blank form is closed."),
        (60, "New receipt form opened for INV-456. Started entering the vendor invoice number."),
        (68, "Receipt INV-456 saved successfully. Receipt entry complete; new blank form is closed."),
        (4, "INV-123 total verified. Saving this receipt now.")]
        .into_iter().map(|(m, quote)|json!({"timestamp":(start+Duration::minutes(m)).to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"app":"Receipts","quote":quote})).collect();
    let runs = [0,2].map(|i|json!({"start":rows[i],"end":rows[i+1],"summary":"Enter the invoice and confirm the receipt was saved."}));
    let mut stages = [0,1].map(|i|json!({"name":if i==0{"Enter invoice"}else{"Save receipt"},"description":"Enter invoice details and confirm the saved receipt.","apps":["Receipts"],"procedure":[{"kind":"action","text":if i==0{"Enter the invoice number."}else{"Confirm the receipt was saved."},"timestamp":rows[i]["timestamp"],"app":"Receipts","quote":rows[i]["quote"]}],"evidence":[rows[i]],"openQuestions":[]}));
    // Publication must validate this fifth reference before applying UI limits.
    stages[0]["evidence"] = json!(rows);
    stages[0]["procedure"].as_array_mut().unwrap().push(json!({"kind":"check","text":"Verify the receipt total.","timestamp":rows[4]["timestamp"],"app":"Receipts","quote":rows[4]["quote"]}));
    json!({"rows":rows,"expectedAverageMinutes":7,"expectedSamples":2,"payload":{"id":"wf-receipts","title":"Record vendor invoice receipts","description":"Enter vendor invoices and confirm the receipts are saved.","trigger":"A vendor invoice arrives","outcome":"Receipt saved","apps":["Receipts"],"confidence":90,"timingRuns":runs,"stages":stages,"evidence":rows,"captureSequence":[rows[0],rows[1]],"limitations":[],"openQuestions":[],"variations":[],"bottlenecks":[]}})
}

async fn post(client: &reqwest::Client, base: &str, body: Value) -> (u16, Value) {
    let response = client
        .post(format!("{base}/workflows/workspace"))
        .bearer_auth("timing-test-key")
        .json(&body)
        .send()
        .await
        .unwrap();
    (response.status().as_u16(), response.json().await.unwrap())
}
async fn get(client: &reqwest::Client, base: &str, path: &str) -> Value {
    let response = client
        .get(format!("{base}{path}"))
        .bearer_auth("timing-test-key")
        .send()
        .await
        .unwrap();
    assert!(
        response.status().is_success(),
        "{path}: {}",
        response.status()
    );
    response.json().await.unwrap()
}

#[tokio::test]
async fn timing_survives_verified_publication_retries_and_disk_reload() {
    let input: Value = std::env::var("WORKFLOW_TIMING_AGENT_INPUT")
        .ok()
        .map(|path| serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap())
        .unwrap_or_else(fixture);
    let payload = input["payload"].clone();
    let dir = tempfile::tempdir().unwrap();
    let db = Arc::new(
        DatabaseManager::new(
            dir.path().join("db.sqlite").to_str().unwrap(),
            Default::default(),
        )
        .await
        .unwrap(),
    );
    db.insert_video_chunk("fixture.mp4", "fixture-monitor")
        .await
        .unwrap();
    for row in input["rows"].as_array().unwrap() {
        let at = chrono::DateTime::parse_from_rfc3339(row["timestamp"].as_str().unwrap())
            .unwrap()
            .with_timezone(&Utc);
        let id = db
            .insert_frame(
                "fixture-monitor",
                Some(at),
                None,
                row["app"].as_str(),
                Some("Invoice"),
                true,
                Some(0),
            )
            .await
            .unwrap();
        let mut tx = db.begin_immediate_with_retry().await.unwrap();
        sqlx::query("UPDATE frames SET full_text = ? WHERE id = ?")
            .bind(row["quote"].as_str().unwrap())
            .bind(id)
            .execute(&mut **tx.conn())
            .await
            .unwrap();
        tx.commit().await.unwrap();
    }
    let audio = Arc::new(
        AudioManagerBuilder::new()
            .is_disabled(true)
            .output_path(dir.path().join("audio"))
            .build(db.clone())
            .await
            .unwrap(),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let pm = Arc::new(tokio::sync::Mutex::new(PipeManager::new(
        dir.path().join("pipes"),
        HashMap::new(),
        None,
        address.port(),
    )));
    let mut server = SCServer::new(
        db.clone(),
        address,
        dir.path().to_path_buf(),
        true,
        true,
        audio,
        false,
        "balanced".into(),
    )
    .with_pipe_manager(pm);
    server.workflow_catalog_dir = Some(dir.path().join("workflows"));
    server.api_auth = true;
    server.api_auth_key = Some("timing-test-key".into());
    let router = server.try_create_router().await.unwrap();
    let serving = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let base = format!("http://{address}");
    let client = reqwest::Client::new();
    let path = dir.path().join("workflows/catalog.json");
    tokio::fs::create_dir_all(path.parent().unwrap())
        .await
        .unwrap();
    let mut prior = payload.clone();
    prior["timingRuns"] = json!([]);
    prior["timing"] = Value::Null;
    tokio::fs::write(
        &path,
        json!({"schemaVersion":5,"revision":1,"checkedThrough":(Utc::now()-Duration::days(1)).to_rfc3339(),"analysis":{"workflows":[prior]}}).to_string(),
    )
    .await
    .unwrap();
    assert_eq!(
        post(
            &client,
            &base,
            json!({"task":"workflow-discover","action":"start"})
        )
        .await
        .0,
        200
    );
    let contract = get(&client, &base, "/workflows/context").await;
    assert!(contract["workflowOutputContract"]
        .as_str()
        .unwrap()
        .starts_with("{\"id\":"));
    assert!(contract["outputContract"]
        .as_str()
        .unwrap()
        .starts_with("{\"evidenceVersion\":"));
    let context = get(
        &client,
        &base,
        "/workflows/workspace?task=workflow-maintain",
    )
    .await;
    let cycle_start = chrono::DateTime::parse_from_rfc3339(
        context["workspace"]["cycle"]["start"].as_str().unwrap(),
    )
    .unwrap();
    let run_start = chrono::DateTime::parse_from_rfc3339(
        payload["timingRuns"][0]["start"]["timestamp"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert!(
        run_start < cycle_start,
        "Timing research must work before the incremental cursor"
    );
    let (status,proposed)=post(&client,&base,json!({"task":"workflow-maintain","action":"propose","expected_revision":context["workspace"]["revision"],"payload":payload,"assignee":"workflow-review","note":"Two complete receipts found in the original source interval."})).await;
    assert_eq!(status, 200, "{proposed}");
    let context = get(&client, &base, "/workflows/workspace?task=workflow-review").await;
    let mut publish = json!({"task":"workflow-review","action":"publish","expected_revision":context["workspace"]["revision"],"catalog_revision":context["catalogRevision"],"draft_id":proposed["draft_id"],"note":"Verified both boundaries against the captured sources."});
    // A fabricated timing boundary must fail without replacing the catalog.
    let before = tokio::fs::read(&path).await.unwrap();
    let mut invalid = publish.clone();
    let mut bad = payload.clone();
    bad["timingRuns"][0]["end"]["quote"] =
        json!("Invented completion that is absent from the recorder.");
    invalid["payload"] = bad;
    let (status, error) = post(&client, &base, invalid).await;
    assert_eq!(status, 422, "{error}");
    // Verification persists an in-flight retry guard before awaiting source
    // checks, then clears it on a definitive 422. Those two workspace revision
    // changes are intentional; every other catalog/workspace field must survive.
    let before: Value = serde_json::from_slice(&before).unwrap();
    let after: Value = serde_json::from_slice(&tokio::fs::read(&path).await.unwrap()).unwrap();
    let expected_workspace_revision = before["agentWorkspace"]["revision"].as_u64().unwrap() + 2;
    assert_eq!(
        after["agentWorkspace"]["revision"],
        expected_workspace_revision
    );
    let mut expected = before;
    expected["agentWorkspace"]["revision"] = json!(expected_workspace_revision);
    assert_eq!(
        expected, after,
        "failed verification must preserve all published data and draft content"
    );
    // Retry against the current workspace, as a real client must after 422.
    publish["expected_revision"] = after["agentWorkspace"]["revision"].clone();
    let (status, receipt) = post(&client, &base, publish.clone()).await;
    assert_eq!(status, 200, "{receipt}");
    let saved = get(&client, &base, "/workflows/catalog").await;
    assert_eq!(saved["analysis"]["workflows"].as_array().unwrap().len(), 1);
    let timing = &saved["analysis"]["workflows"][0]["timing"];
    assert_eq!(
        timing["averageMinutes"].as_f64(),
        input["expectedAverageMinutes"].as_f64()
    );
    assert_eq!(timing["sampleCount"], input["expectedSamples"]);
    assert_eq!(timing["minMinutes"], 6.0);
    assert_eq!(timing["maxMinutes"], 8.0);
    assert_eq!(timing["basis"], "estimated-elapsed");
    let disk: Value = serde_json::from_slice(&tokio::fs::read(&path).await.unwrap()).unwrap();
    // HTTP localizes timestamps; disk stores UTC. Compare instants, not offsets.
    let canonical = |mut value: Value| {
        for run in value["runs"].as_array_mut().unwrap() {
            for boundary in ["start", "end"] {
                let at = chrono::DateTime::parse_from_rfc3339(
                    run[boundary]["timestamp"].as_str().unwrap(),
                )
                .unwrap();
                run[boundary]["timestamp"] = json!(at.with_timezone(&Utc).to_rfc3339());
            }
        }
        value
    };
    assert_eq!(
        canonical(disk["analysis"]["workflows"][0]["timing"].clone()),
        canonical(timing.clone())
    );
    assert_eq!(post(&client, &base, publish).await, (200, receipt));
    assert_eq!(
        get(&client, &base, "/workflows/catalog").await["revision"],
        saved["revision"]
    );
    // Completing a cycle with no further changes must retain the timing.
    for task in ["workflow-discover", "workflow-maintain", "workflow-review"] {
        let c = get(&client, &base, &format!("/workflows/workspace?task={task}")).await;
        let (status,r)=post(&client,&base,json!({"task":task,"action":"finish","expected_revision":c["workspace"]["revision"],"catalog_revision":c["catalogRevision"],"note":"All supported source work is saved."})).await;
        assert_eq!(status, 200, "{task}: {r}");
    }
    let reloaded = get(&client, &base, "/workflows/catalog").await;
    assert_eq!(reloaded["analysis"]["workflows"][0]["timing"], *timing);
    assert_eq!(reloaded["agentWorkspace"]["cycle"]["status"], "complete");
    if let Ok(output) = std::env::var("WORKFLOW_TIMING_CATALOG_OUTPUT") {
        tokio::fs::write(output, reloaded.to_string())
            .await
            .unwrap();
    }
    serving.abort();
    let _ = serving.await;
    db.close().await;
}
