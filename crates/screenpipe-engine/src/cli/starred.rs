// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use crate::routes::time::parse_flexible_datetime;
use chrono::Utc;
use clap::Subcommand;
use serde_json::{json, Value};

#[derive(Subcommand)]
pub enum StarCommand {
    /// List recent starred intervals (JSON, including has_audio).
    List {
        #[arg(long, default_value_t = 20)]
        limit: u32,
        #[arg(long, default_value_t = 0)]
        offset: u32,
    },
    /// Mark the next 5, 15, 30 or 60 minutes; optional session-scoped HD.
    Start {
        #[arg(long, default_value_t = 15)]
        minutes: u32,
        #[arg(long)]
        hd: bool,
    },
    /// End the currently active starred session.
    End,
    /// Edit exact start/end times. Accepts RFC3339 or relative times.
    Edit {
        id: String,
        #[arg(long)]
        start: String,
        #[arg(long)]
        end: String,
    },
}

pub async fn handle(command: &StarCommand, port: u16) -> anyhow::Result<()> {
    let base = std::env::var("SCREENPIPE_API_URL")
        .or_else(|_| std::env::var("SCREENPIPE_LOCAL_API_URL"))
        .unwrap_or_else(|_| format!("http://localhost:{port}"));
    let url = format!("{}/starred-sessions", base.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()?;
    let auth = |request: reqwest::RequestBuilder| match std::env::var("SCREENPIPE_LOCAL_API_KEY") {
        Ok(key) if !key.is_empty() => request.bearer_auth(key),
        _ => request,
    };
    let fetch = |request| async {
        let response = auth(request).send().await?;
        let status = response.status();
        let value: Value = response.json().await?;
        if !status.is_success() {
            anyhow::bail!(
                "starred sessions: {}",
                value["error"].as_str().unwrap_or("request failed")
            );
        }
        Ok::<Value, anyhow::Error>(value)
    };
    let write = match command {
        StarCommand::List { limit, offset } => {
            let value = fetch(
                client
                    .get(&url)
                    .query(&[("limit", limit.min(&100)), ("offset", offset)]),
            )
            .await?;
            println!("{}", serde_json::to_string_pretty(&value)?);
            return Ok(());
        }
        StarCommand::Start { minutes, hd } => {
            if ![5, 15, 30, 60].contains(minutes) {
                anyhow::bail!("--minutes must be 5, 15, 30 or 60");
            }
            let now = Utc::now();
            json!({"id":uuid::Uuid::new_v4(),"start":now,"end":now+chrono::Duration::minutes(*minutes as i64),"hd_requested":hd,"revision":0})
        }
        StarCommand::End | StarCommand::Edit { .. } => {
            let request = match command {
                StarCommand::Edit { id, .. } => client.get(&url).query(&[("id", id)]),
                _ => client
                    .get(&url)
                    .query(&[("start_time", Utc::now().to_rfc3339())]),
            };
            let value = fetch(request).await?;
            let mut row = value["data"]
                .as_array()
                .and_then(|rows| rows.first())
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("no matching starred session"))?;
            match command {
                StarCommand::Edit { start, end, .. } => {
                    row["start"] =
                        json!(parse_flexible_datetime(start).map_err(anyhow::Error::msg)?);
                    row["end"] = json!(parse_flexible_datetime(end).map_err(anyhow::Error::msg)?);
                }
                _ => {
                    row["end"] = json!(Utc::now());
                }
            }
            row
        }
    };
    let result = fetch(client.post(&url).json(&write)).await?;
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}
