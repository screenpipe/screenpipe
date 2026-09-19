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
const platformJobs = ["resolve-release", "localization", "release-enterprise-windows", "release-enterprise-linux", "release-enterprise-macos"];

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

test("enterprise handoff carries the consumer translation snapshot", async () => {
  const { github, calls } = api();
  await dispatchEnterprise({ github, context, sha, version: "2.7.53", forceGithubRunners: false, dryRun: true, localizationRunId: "123" });
  expect(calls[1].args.inputs.localization_run_id).toBe("123");
  const handoff = app.jobs["dispatch-enterprise"].steps.find((step: any) => step.env?.LOCALIZATION_RUN_ID);
  expect(handoff.env.LOCALIZATION_RUN_ID).toContain("github.run_id");
  expect(handoff.with.script).toContain("localizationRunId: process.env.LOCALIZATION_RUN_ID");
});

test("every platform waits for and downloads one finalized snapshot", () => {
  for (const workflow of [app, enterprise]) {
    const preparation = workflow.jobs.localization;
    const action = preparation.steps.find((step: any) => step.id === "localization");
    expect(action.uses).toBe("./.release-workflow/.github/actions/prepare-desktop-localization");
    expect(action.with["gt-api-key"]).toBe("${{ secrets.GT_API_KEY }}");
    for (const [name, job] of Object.entries(workflow.jobs) as [string, any][]) {
      if (name !== "publish-tauri" && !name.startsWith("release-enterprise-")) continue;
      expect(job.needs).toContain("localization");
      expect(job.env.SCREENPIPE_I18N_MODE).toBe("cached");
      expect(job.env.SCREENPIPE_I18N_SNAPSHOT).toContain(".release-localization/snapshot.json");
      const download = job.steps.find((step: any) => step.uses === "actions/download-artifact@v4");
      expect(download.with.name).toContain("desktop-localization-");
      expect(download.with.path).toBe(".release-localization");
      const cleanIndex = job.steps.findIndex((step: any) => step.name === "Clean persistent Windows workspace");
      expect(job.steps.indexOf(download)).toBeGreaterThan(cleanIndex);
      expect(JSON.stringify(job)).not.toContain("secrets.GT_API_KEY");
    }
  }
  const prepare = readYaml(".github/actions/prepare-desktop-localization/action.yml");
  const finalize = prepare.runs.steps.find((step: any) => step.name === "Finalize and validate translations");
  expect(finalize.env.SCREENPIPE_I18N_MODE).toContain("'cached' || 'generate'");
  expect(finalize["continue-on-error"]).toBeUndefined();
  expect(enterprise.jobs.localization.steps.find((step: any) => step.id === "localization").with["source-run-id"]).toBe("${{ inputs.localization_run_id }}");
});

test("production packaging enables localization without changing development defaults", () => {
  const config = (name: string) => JSON.parse(readFileSync(join(root, `apps/screenpipe-app-tauri/src-tauri/tauri${name}.conf.json`), "utf8"));
  expect(config("").build.beforeBuildCommand).toBe("bun run build");
  for (const flavor of [".prod", ".beta", ".enterprise"]) {
    expect(config(flavor).build.beforeBuildCommand).toBe("bun run build:production");
    expect(config(flavor).build.beforeDevCommand).toBe("bun run dev");
  }
});
