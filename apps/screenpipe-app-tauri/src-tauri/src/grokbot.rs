// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Install a private skill in Grok Bot's shared skill store. The Bun bridge
//! keeps gateway credentials outside the renderer and verifies every mutation.

use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tauri::AppHandle;
use tokio::io::AsyncWriteExt;

pub(crate) static GROKBOT_CONNECTION_LOCK: tokio::sync::Mutex<()> =
    tokio::sync::Mutex::const_new(());

const INSTALLER: &str = include_str!("../../lib/grokbot-installer.mjs");
const API_SKILL: &str =
    include_str!("../../../../crates/screenpipe-core/assets/skills/screenpipe-api/SKILL.md");

async fn run_bridge(
    app: &AppHandle,
    home: &Path,
    bun: &Path,
    action: &str,
) -> Result<Value, String> {
    let data_dir = crate::log_files::get_active_data_dir(app.clone()).await?;
    let api = crate::recording::local_api_context_from_app(app);
    let input = json!({ "home": home, "bun": bun, "dataDir": data_dir,
        "port": api.port, "skill": API_SKILL, "action": action });
    run_bridge_input(bun, &input).await
}

async fn run_bridge_input(bun: &Path, input: &Value) -> Result<Value, String> {
    let mut command = tokio::process::Command::new(bun);
    command
        .args(["-e", INSTALLER, "--", "--screenpipe-grokbot-installer"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let mut child = command
        .spawn()
        .map_err(|_| "Could not start Grok Bot setup.")?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(input.to_string().as_bytes())
            .await
            .map_err(|_| "Could not prepare Grok Bot setup.")?;
    }
    let output = tokio::time::timeout(Duration::from_secs(100), child.wait_with_output())
        .await
        .map_err(|_| "Grok Bot setup timed out. Open Grok Bot and retry.")?
        .map_err(|_| "Could not finish Grok Bot setup.")?;
    // Never include child output in errors: future runtime errors might contain
    // connection material. The bridge emits only a controlled status object.
    if !output.status.success() {
        return Err("Grok Bot setup failed. Open Grok Bot and retry.".into());
    }
    let result: Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| "Grok Bot returned an invalid setup result.")?;
    if let Some(error) = result.get("error").and_then(Value::as_str) {
        return Err(error.to_owned());
    }
    Ok(result)
}

async fn connection_in(
    app: &AppHandle,
    home: &Path,
    bun: &Path,
    action: &str,
    automatic: bool,
) -> Result<Value, String> {
    if !["status", "connect", "disconnect"].contains(&action) {
        return Err("Invalid Grok Bot connection action.".into());
    }
    let _guard = GROKBOT_CONNECTION_LOCK.lock().await;
    let opt_out_dir = crate::skills::ai_tool_auto_connect_opt_out_dir();
    let opted_out = opt_out_dir.join("grokbot").is_file();
    if automatic && opted_out {
        return Ok(json!({"detected": true, "connected": false, "optedOut": true}));
    }
    // Save intent before deletion. Even a failed remote removal must never
    // allow a background retry to silently reinstall the skill.
    if action == "disconnect" || (action == "connect" && !automatic) {
        crate::skills::set_ai_tool_auto_connect_opt_out_in(
            &opt_out_dir,
            "grokbot",
            action == "disconnect",
        )?;
    }
    let mut result = run_bridge(app, home, bun, action).await?;
    result["optedOut"] = json!(if action == "status" {
        opted_out
    } else {
        action == "disconnect"
    });
    Ok(result)
}

#[tauri::command]
#[specta::specta]
pub async fn grokbot_connection(app: AppHandle, action: String) -> Result<Value, String> {
    let home = dirs::home_dir().ok_or("Home directory is unavailable.")?;
    let bun =
        crate::pi::find_bun_executable().ok_or("Screenpipe's bundled runtime is unavailable.")?;
    connection_in(&app, &home, Path::new(&bun), &action, false).await
}

pub fn start_background(app: AppHandle, home: PathBuf, bun: PathBuf) {
    tauri::async_runtime::spawn(async move {
        // The existing AI-tool home isolation applies to this integration too.
        // A recently installed or signed-out Grok Bot gets time to start.
        for delay in [0, 15, 60] {
            tokio::time::sleep(Duration::from_secs(delay)).await;
            match connection_in(&app, &home, &bun, "connect", true).await {
                Ok(_) => return,
                Err(_) => tracing::info!("Grok Bot automatic skill installation is waiting for the app; retry is available in Connections"),
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn bundled_bridge_executes_with_an_isolated_home_without_connecting_real_accounts() {
        let fixture = tempfile::tempdir().unwrap();
        // `cargo test` puts this executable in target/.../deps, outside an
        // app bundle. Use the sidecar prepared by the required build script.
        let platform = match std::env::consts::OS {
            "macos" => "apple-darwin",
            "windows" => "pc-windows-msvc",
            "linux" => "unknown-linux-gnu",
            other => panic!("unsupported test platform: {other}"),
        };
        let bun = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!(
            "bun-{}-{platform}{}",
            std::env::consts::ARCH,
            std::env::consts::EXE_SUFFIX,
        ));
        assert!(bun.is_file(), "run the test through bun run test:tauri");
        let result = run_bridge_input(
            &bun,
            &json!({
                "home": fixture.path(), "bun": bun, "dataDir": fixture.path().join("data"),
                "port": 3137, "skill": "fixture skill", "action": "connect"
            }),
        )
        .await
        .unwrap();
        assert_eq!(result["detected"], false);
        assert_eq!(result["connected"], false);
        assert_eq!(std::fs::read_dir(fixture.path()).unwrap().count(), 0);
    }

    #[test]
    fn grokbot_disconnect_intent_persists_even_if_remote_removal_cannot_run() {
        let fixture = tempfile::tempdir().unwrap();
        crate::skills::set_ai_tool_auto_connect_opt_out_in(fixture.path(), "grokbot", true)
            .unwrap();
        assert!(fixture.path().join("grokbot").is_file());
        crate::skills::set_ai_tool_auto_connect_opt_out_in(fixture.path(), "grokbot", false)
            .unwrap();
        assert!(!fixture.path().join("grokbot").exists());
    }
}
