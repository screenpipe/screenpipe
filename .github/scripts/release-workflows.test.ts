// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dispatchEnterprise, reportEnterprise } from "./enterprise-release.cjs";

const root = new URL("../../", import.meta.url).pathname;
const readYaml = (path: string): any => Bun.YAML.parse(readFileSync(join(root, path), "utf8"));
const app = readYaml(".github/workflows/release-app.yml");
const enterprise = readYaml(".github/workflows/release-enterprise.yml");
const installAction = "install-windows-frontend-dependencies";
const sha = "01afe5afda5fa75f3e4d733ef9a934b975347f48";
const context = { repo: { owner: "screenpipe", repo: "screenpipe" }, runId: 123, ref: "refs/heads/main" };
const platformJobs = ["resolve-release", "release-enterprise-windows", "release-enterprise-linux", "release-enterprise-macos"];

function api(dispatchFails = false) {
  const calls: { method: string; args: any }[] = [];
  const github = { rest: {
    repos: { createCommitStatus: async (args: any) => { calls.push({ method: "status", args }); } },
    actions: { createWorkflowDispatch: async (args: any) => {
      calls.push({ method: "dispatch", args });
      if (dispatchFails) throw new Error("dispatch unavailable");
    } },
  } };
  return { github, calls };
}

test("enterprise dispatch is mandatory after all consumer platforms, without waiting for enterprise", () => {
  const job = app.jobs["dispatch-enterprise"];
  expect(job.needs).toEqual(expect.arrayContaining(["check_commit", "publish-tauri"]));
  expect(job.if).toBeUndefined();
  expect(job["continue-on-error"]).toBeUndefined();
  expect(job.permissions.actions).toBe("write");
  const step = job.steps.find((step: any) => step.env?.RELEASE_SHA);
  expect(step.env.RELEASE_SHA).toBe("${{ needs.check_commit.outputs.release_sha }}");
  expect(step.env.RELEASE_VERSION).toBe("${{ needs.check_commit.outputs.release_version }}");
  expect(step.env.DRY_RUN).toBe("${{ inputs.dry_run }}");
  expect(step.env.FORCE_GITHUB_RUNNERS).toBe("${{ inputs.force_github_runners }}");
  expect(step.with.script).toContain("await dispatchEnterprise(");
  expect(Object.values(app.jobs).some((job: any) => job.uses?.includes("release-enterprise.yml"))).toBe(false);
});

for (const dryRun of [false, true]) {
  test(`record pending before dispatch and preserve exact revision/flags (dry run=${dryRun})`, async () => {
    const { github, calls } = api();
    await dispatchEnterprise({ github, context, sha, version: "2.7.43", forceGithubRunners: true, dryRun });
    expect(calls.map((call) => call.method)).toEqual(["status", "dispatch"]);
    expect(calls[0].args).toMatchObject({ sha, state: "pending", context: dryRun ? "Enterprise artifacts (dry run)" : "Enterprise artifacts" });
    expect(calls[1].args).toEqual({
      ...context.repo, workflow_id: "release-enterprise.yml", ref: "main",
      inputs: { commit_hash: sha, version: "2.7.43", force_github_runners: "true", dry_run: String(dryRun) },
    });
  });
}

test("an enterprise dispatch failure becomes a failed commit check and fails the caller", async () => {
  const { github, calls } = api(true);
  await expect(dispatchEnterprise({ github, context, sha, version: "2.7.43", forceGithubRunners: false, dryRun: false })).rejects.toThrow("dispatch unavailable");
  expect(calls.map((call) => call.method)).toEqual(["status", "dispatch", "status"]);
  expect(calls.at(-1)?.args.state).toBe("failure");
});

test("refuse a branch name where an immutable artifact SHA is required", async () => {
  const { github, calls } = api();
  await expect(dispatchEnterprise({ github, context, sha: "main", version: "2.7.43", forceGithubRunners: false, dryRun: false })).rejects.toThrow("full release SHA");
  expect(calls).toHaveLength(0);
});

test("all versioned enterprise uploads honor the boolean dry-run input", () => {
  for (const job of Object.values(enterprise.jobs) as any[]) {
    for (const step of job.steps ?? []) {
      if (step.env?.RELEASE_UPLOAD_TOKEN) expect(step.if).toBe("${{ !inputs.dry_run }}");
    }
  }
});

test("different versions cannot evict an older queued enterprise build", () => {
  expect(enterprise.concurrency.group).toContain("inputs.commit_hash");
  expect(enterprise.concurrency["cancel-in-progress"]).toBe(false);
});

test("both Windows builds use the shared install action from the workflow revision", () => {
  for (const job of [app.jobs["publish-tauri"], enterprise.jobs["release-enterprise-windows"]]) {
    expect(job.steps.filter((step: any) => step.uses === `./.release-workflow/.github/actions/${installAction}`)).toHaveLength(1);
    const checkout = job.steps.find((step: any) => step.with?.["sparse-checkout"]?.includes(`.github/actions/${installAction}`));
    // Recovery can build an older app SHA which does not contain this action.
    expect(checkout.with.ref).toBe("${{ github.workflow_sha }}");
    expect(checkout.with.path).toBe(".release-workflow");
    expect(checkout.if ?? "").not.toContain("self-hosted");
  }
  const action = readYaml(`.github/actions/${installAction}/action.yml`);
  expect(action.runs.using).toBe("composite");
  expect(action.runs.steps[0].shell).toBe("pwsh");
});

test("completion reports every platform even if one is failed or skipped", () => {
  const gate = enterprise.jobs["enterprise-complete"];
  expect(gate.if).toBe("always()");
  expect(gate.needs).toEqual(platformJobs);
  expect(gate["continue-on-error"]).toBeUndefined();
  const step = gate.steps.find((step: any) => step.env?.BUILD_RESULTS);
  expect(step.env.BUILD_RESULTS).toBe("${{ toJSON(needs) }}");
  expect(step.with.script).toContain("await reportEnterprise(");
});

for (const failedJob of platformJobs) {
  for (const result of ["success", "failure", "skipped", "cancelled"]) {
    test(`completion: ${failedJob}=${result}`, async () => {
      const { github, calls } = api();
      const results = Object.fromEntries(platformJobs.map((name) => [name, { result: name === failedJob ? result : "success" }]));
      const report = reportEnterprise({ github, context, sha, dryRun: false, results });
      if (result === "success") await report;
      else await expect(report).rejects.toThrow("Enterprise artifacts incomplete");
      expect(calls[0].args).toMatchObject({ sha, state: result === "success" ? "success" : "failure", context: "Enterprise artifacts" });
    });
  }
}

test("an empty result cannot mark enterprise ready", async () => {
  const { github, calls } = api();
  await expect(reportEnterprise({ github, context, sha, dryRun: false, results: {} })).rejects.toThrow("incomplete");
  expect(calls[0].args.state).toBe("failure");
});
