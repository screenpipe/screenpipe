// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

async function status({ github, context, sha, dryRun, state, description }) {
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error("Expected a full release SHA");
  const { owner, repo } = context.repo;
  await github.rest.repos.createCommitStatus({
    owner, repo, sha, state, description,
    context: dryRun ? "Enterprise artifacts (dry run)" : "Enterprise artifacts",
    target_url: `${context.serverUrl || "https://github.com"}/${owner}/${repo}/actions/runs/${context.runId}`,
  });
}

async function dispatchEnterprise({ github, context, sha, version, forceGithubRunners, dryRun, localizationRunId = "" }) {
  const common = { github, context, sha, dryRun };
  await status({ ...common, state: "pending", description: "Consumer ready; waiting for enterprise artifacts" });
  try {
    await github.rest.actions.createWorkflowDispatch({
      ...context.repo,
      workflow_id: "release-enterprise.yml",
      ref: context.ref.replace(/^refs\/(heads|tags)\//, ""),
      inputs: {
        commit_hash: sha,
        version,
        force_github_runners: String(forceGithubRunners),
        dry_run: String(dryRun),
        ...(localizationRunId ? { localization_run_id: String(localizationRunId) } : {}),
      },
    });
  } catch (error) {
    await status({ ...common, state: "failure", description: "Enterprise build could not be started" });
    throw error;
  }
}

async function reportEnterprise({ github, context, sha, dryRun, results }) {
  const jobs = Object.entries(results);
  const complete = jobs.length > 0 && jobs.every(([, job]) => job.result === "success");
  await status({
    github, context, sha, dryRun,
    state: complete ? "success" : "failure",
    description: complete ? "All enterprise platforms succeeded" : "Enterprise artifacts incomplete; see build results",
  });
  if (!complete) {
    throw new Error(`Enterprise artifacts incomplete: ${jobs.map(([name, job]) => `${name}=${job.result}`).join(", ")}`);
  }
}

module.exports = { dispatchEnterprise, reportEnterprise };
