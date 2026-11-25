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

async function markEnterprisePending({ github, context, sha, dryRun }) {
  await status({ github, context, sha, dryRun, state: "pending", description: "Building enterprise artifacts" });
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

module.exports = { markEnterprisePending, reportEnterprise };
