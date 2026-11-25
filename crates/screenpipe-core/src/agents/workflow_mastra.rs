// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use super::{install_spawned_pid, pi, AgentExecutor, AgentOutput, ExecutionHandle, SharedPid};
use anyhow::{anyhow, Context, Result};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc::UnboundedSender;

pub(crate) const AGENT: &str = "workflow-mastra";
const RUNNER_ENV: &str = "SCREENPIPE_MASTRA_RUNNER";

pub(crate) struct WorkflowMastraExecutor {
    runner: PathBuf,
    pi: Arc<dyn AgentExecutor>,
}

struct WorkflowPrompt<'a> {
    prompt: &'a str,
    model: &'a str,
    instructions: &'a str,
    provider: &'a str,
    provider_url: Option<&'a str>,
    thinking_level: Option<&'a str>,
}

impl WorkflowMastraExecutor {
    pub(crate) fn from_env(pi: Arc<dyn AgentExecutor>) -> Option<Self> {
        Some(Self {
            runner: std::env::var_os(RUNNER_ENV)
                .filter(|path| !path.is_empty())?
                .into(),
            pi,
        })
    }

    async fn execute_workflow(
        &self,
        job: WorkflowPrompt<'_>,
        working_dir: &Path,
        shared_pid: Option<SharedPid>,
        output: Option<UnboundedSender<String>>,
    ) -> Result<AgentOutput> {
        use crate::workflows::pipeline;

        if !pipeline::has_pending_input(working_dir).await? {
            return Ok(AgentOutput {
                stdout: "No new workflow input; saved results kept.".into(),
                stderr: String::new(),
                success: true,
                pid: None,
            });
        }
        let cloud_token = self.pi.user_token();
        pipeline::check_admission_for_provider(
            self.pi.screenpipe_api_url(),
            cloud_token.as_deref(),
            job.model,
            job.provider,
        )
        .await?;

        let before = pipeline::save_state(working_dir).await?;
        let token = cloud_token
            .as_deref()
            .filter(|_| job.provider == "screenpipe");
        let result = self
            .execute(job, token, working_dir, shared_pid, output)
            .await?;
        if result.success {
            pipeline::verify_saved(working_dir, before).await?;
        }
        Ok(result)
    }

    async fn execute(
        &self,
        job: WorkflowPrompt<'_>,
        cloud_token: Option<&str>,
        working_dir: &Path,
        shared_pid: Option<SharedPid>,
        output: Option<UnboundedSender<String>>,
    ) -> Result<AgentOutput> {
        let task = working_dir
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        anyhow::ensure!(
            crate::workflows::workspace::is_task(task),
            "Mastra is scoped to workflow tasks"
        );
        anyhow::ensure!(!job.model.trim().is_empty(), "Choose a Workflows AI model");
        anyhow::ensure!(
            self.runner.is_absolute() && self.runner.is_file(),
            "Set {RUNNER_ENV} to the absolute path of the Mastra runner"
        );
        let bun =
            pi::find_bun_executable().context("Bun is required for the Mastra workflow runner")?;
        let request = serde_json::to_vec(&serde_json::json!({
            "task": task,
            "model": job.model,
            "provider": job.provider,
            "providerUrl": job.provider_url,
            "cloudToken": cloud_token,
            "instructions": job.instructions,
            "thinkingLevel": job.thinking_level.unwrap_or("low"),
            "prompt": job.prompt,
        }))?;
        let mut command = Command::new(bun);
        command
            .args(["--no-install", "--no-env-file"])
            .arg(&self.runner)
            .current_dir(working_dir)
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        command.process_group(0);

        let mut child = command
            .spawn()
            .context("Starting the local Mastra workflow runner")?;
        let pid = child.id().context("Mastra runner did not report a PID")?;
        if shared_pid
            .as_ref()
            .is_some_and(|shared| install_spawned_pid(shared, pid))
        {
            child.kill().await?;
            return Err(anyhow!("Mastra workflow was cancelled before startup"));
        }

        let mut stdin = child.stdin.take().context("Mastra stdin unavailable")?;
        let mut stdout =
            BufReader::new(child.stdout.take().context("Mastra stdout unavailable")?).lines();
        let mut stderr = child.stderr.take().context("Mastra stderr unavailable")?;
        let send_request = async move { stdin.write_all(&request).await };
        let collect_stdout = async {
            let mut lines = Vec::new();
            while let Some(line) = stdout.next_line().await? {
                if let Some(output) = &output {
                    let _ = output.send(line.clone());
                }
                lines.push(line);
            }
            Ok::<_, std::io::Error>(lines.join("\n"))
        };
        let collect_stderr = async {
            let mut text = String::new();
            stderr.read_to_string(&mut text).await?;
            Ok::<_, std::io::Error>(text)
        };
        let (_, stdout, stderr, status) =
            tokio::try_join!(send_request, collect_stdout, collect_stderr, child.wait())?;
        Ok(AgentOutput {
            stdout,
            stderr,
            success: status.success(),
            pid: Some(pid),
        })
    }
}

#[async_trait::async_trait]
impl AgentExecutor for WorkflowMastraExecutor {
    async fn run(
        &self,
        prompt: &str,
        model: &str,
        working_dir: &Path,
        provider: Option<&str>,
        provider_url: Option<&str>,
        _provider_api_key: Option<&str>,
        shared_pid: Option<SharedPid>,
        _continue_session: bool,
    ) -> Result<AgentOutput> {
        self.execute_workflow(
            WorkflowPrompt {
                prompt,
                model,
                provider: provider.unwrap_or("screenpipe"),
                provider_url,
                instructions: "",
                thinking_level: None,
            },
            working_dir,
            shared_pid,
            None,
        )
        .await
    }

    async fn run_streaming(
        &self,
        prompt: &str,
        model: &str,
        working_dir: &Path,
        provider: Option<&str>,
        provider_url: Option<&str>,
        _provider_api_key: Option<&str>,
        shared_pid: Option<SharedPid>,
        line_tx: UnboundedSender<String>,
        _continue_session: bool,
        thinking_level: Option<&str>,
        pipe_system_prompt: Option<&str>,
        _mcp_server_allowlist: Option<&[String]>,
        _session_owner: Option<&str>,
        _executor_config: Option<&serde_json::Value>,
    ) -> Result<AgentOutput> {
        self.execute_workflow(
            WorkflowPrompt {
                prompt,
                model,
                provider: provider.unwrap_or("screenpipe"),
                provider_url,
                instructions: pipe_system_prompt.unwrap_or_default(),
                thinking_level,
            },
            working_dir,
            shared_pid,
            Some(line_tx),
        )
        .await
    }

    fn kill(&self, handle: &ExecutionHandle) -> Result<()> {
        let pid = handle.current_pid();
        if pid != 0 {
            pi::kill_process_group(pid)?;
        }
        Ok(())
    }

    fn is_available(&self) -> bool {
        // Let execute report a tracked, actionable failure for bad opt-in paths.
        true
    }

    async fn ensure_installed(&self) -> Result<()> {
        Ok(())
    }

    fn name(&self) -> &str {
        AGENT
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{atomic::AtomicU32, Arc};
    use std::time::Duration;
    use tokio::sync::mpsc::unbounded_channel;

    #[tokio::test]
    #[ignore = "requires the Bun runtime installed where Screenpipe can discover it"]
    async fn workflow_mastra_streams_and_can_stop_the_subprocess() {
        let directory = tempfile::tempdir().unwrap();
        let cwd = directory.path().join("workflow-review");
        std::fs::create_dir(&cwd).unwrap();
        let runner = directory.path().join("fixture.ts");
        std::fs::write(
            &runner,
            r#"
const request = JSON.parse(await Bun.stdin.text());
if (request.task !== "workflow-review" || request.instructions !== "review instructions" || request.thinkingLevel !== "medium" || request.provider !== "screenpipe" || request.cloudToken !== "fixture-cloud") {
  throw new Error("unexpected task configuration");
}
console.log(JSON.stringify({ type: "test_ready", model: request.model }));
if (request.prompt === "wait") await Bun.sleep(30_000);
"#,
        )
        .unwrap();
        let executor = WorkflowMastraExecutor {
            runner,
            pi: Arc::new(pi::PiExecutor::new(None)),
        };

        for prompt in ["finish", "wait"] {
            let pid = Arc::new(AtomicU32::new(0));
            let handle = ExecutionHandle::new(pid.clone());
            let (send, mut receive) = unbounded_channel();
            let run = executor.execute(
                WorkflowPrompt {
                    prompt,
                    model: "fixture-model",
                    provider: "screenpipe",
                    provider_url: None,
                    instructions: "review instructions",
                    thinking_level: Some("medium"),
                },
                Some("fixture-cloud"),
                &cwd,
                Some(pid),
                Some(send),
            );
            let observe = async {
                let event = receive.recv().await.unwrap();
                assert!(event.contains("fixture-model"));
                assert!(handle.current_pid() > 0);
                if prompt == "wait" {
                    assert!(handle.request_stop().is_some());
                    executor.kill(&handle).unwrap();
                }
            };
            let (result, ()) =
                tokio::time::timeout(Duration::from_secs(8), async { tokio::join!(run, observe) })
                    .await
                    .unwrap();
            let output = result.unwrap();
            assert_eq!(output.success, prompt == "finish");
            assert!(output.stdout.contains("test_ready"));
        }
    }
}
