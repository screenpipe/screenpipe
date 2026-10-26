// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dispatchEnterprise, reportEnterprise } from "./enterprise-release.cjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const readYaml = (path: string): any => Bun.YAML.parse(readFileSync(join(root, path), "utf8"));
const app = readYaml(".github/workflows/release-app.yml");
const enterprise = readYaml(".github/workflows/release-enterprise.yml");
const installAction = "install-windows-frontend-dependencies";
const sha = "01afe5afda5fa75f3e4d733ef9a934b975347f48";
const context = { repo: { owner: "screenpipe", repo: "screenpipe" }, runId: 123, ref: "refs/heads/main" };
const platformJobs = ["resolve-release", "localization", "release-enterprise-windows", "release-enterprise-linux", "release-enterprise-macos"];

test("attribution packaging follows signing and precedes every consumer upload, including dry runs", () => {
  const steps = app.jobs["publish-tauri"].steps;
  const prepare = steps.findIndex((step: any) => step.name === "Prepare attribution carrier from finalized release");
  expect(prepare).toBeGreaterThan(steps.findIndex((step: any) => step.name === "Validate app ticket and finalize updater tarball (macOS)"));
  expect(steps[prepare].if).toBeUndefined();
  expect(steps[prepare]["continue-on-error"]).toBeUndefined();
  for (const [index, step] of steps.entries()) {
    if (step.env?.RELEASE_UPLOAD_TOKEN) {
      expect(index).toBeGreaterThan(prepare);
      expect(step.run).toContain('${ATTRIBUTION_ARTIFACT_DIR:?}');
      expect(step.if).toContain("dry_run != 'true'");
    }
    if (step.name?.match(/^Upload (macOS|Windows) dry-run artifacts$/)) {
      expect(step.with.path).toContain("${{ env.ATTRIBUTION_ARTIFACT_DIR }}/screenpipe-attribution.*");
    }
  }
});

for (const [target, platform, folder, filename, input, extension, os] of [
  ["aarch64-apple-darwin", "macos-arm", "macos", "screenpipe.app", "--app", "zip", "macOS"],
  ["x86_64-apple-darwin", "macos-intel", "macos", "screenpipe.app", "--app", "zip", "macOS"],
  ["x86_64-pc-windows-msvc", "windows", "nsis", "screenpipe_2.7.116_x64-setup.exe", "--artifact", "exe", "Windows"],
  ["aarch64-pc-windows-msvc", "windows-arm", "nsis", "screenpipe_2.7.116_arm64-setup.exe", "--artifact", "exe", "Windows"],
  ["x86_64-unknown-linux-gnu", "linux", "appimage", "screenpipe_2.7.116_amd64.AppImage", "--artifact", "AppImage", "Linux"],
]) {
  test(`release shell selects and uploads carrier plus manifest together: ${target}`, () => {
    const fixture = mkdtempSync(join(tmpdir(), "attribution release "));
    try {
      const base = "apps/screenpipe-app-tauri/src-tauri";
      const artifact = `${base}/target/${target}/release/bundle/${folder}/${filename}`;
      mkdirSync(join(fixture, artifact, ".."), { recursive: true });
      writeFileSync(join(fixture, artifact), "signed-artifact-fixture");
      writeFileSync(join(fixture, base, "Cargo.toml"), 'version = "2.7.116"\n');
      mkdirSync(join(fixture, "bin"));
      mkdirSync(join(fixture, ".github/scripts"), { recursive: true });
      // Replace external signing/packaging and transport only; execute the real
      // workflow shell and verify its complete argument boundary on every target.
      const packager = `#!/usr/bin/env bun
import {writeFileSync} from 'node:fs';
const args=process.argv.slice(2), out=args[args.indexOf('--output')+1];
writeFileSync(process.env.PACKAGE_LOG,JSON.stringify(args));
writeFileSync(out+'/screenpipe-attribution.${extension}','carrier');
writeFileSync(out+'/screenpipe-attribution.json','{}');
`;
      for (const name of ["python", "python3"]) {
        writeFileSync(join(fixture, "bin", name), packager);
        chmodSync(join(fixture, "bin", name), 0o755);
      }
      const uploader = join(fixture, ".github/scripts/upload-release-artifacts.sh");
      writeFileSync(uploader, '#!/usr/bin/env bash\nprintf "%s\\0" "$@" > "$UPLOAD_LOG"\n');
      chmodSync(uploader, 0o755);
      const env = { ...process.env, PATH: `${join(fixture, "bin")}:${process.env.PATH}`, TARGET: target,
        RUNNER_TEMP: fixture, GITHUB_ENV: join(fixture, "env"), PACKAGE_LOG: join(fixture, "pack.json"), UPLOAD_LOG: join(fixture, "upload.json") };
      const steps = app.jobs["publish-tauri"].steps;
      const prepare = steps.find((s: any) => s.name === "Prepare attribution carrier from finalized release");
      expect(prepare).toBeDefined();
      const prepared = spawnSync("bash", ["-e", "-c", prepare.run], { cwd: fixture, env, encoding: "utf8" });
      expect({ status: prepared.status, stderr: prepared.stderr }).toEqual({ status: 0, stderr: "" });
      const output = readFileSync(env.GITHUB_ENV, "utf8").trim().replace("ATTRIBUTION_ARTIFACT_DIR=", "");
      expect(JSON.parse(readFileSync(env.PACKAGE_LOG, "utf8"))).toEqual([
        "scripts/package-attribution-carrier.py", input, artifact, "--platform", platform, "--release", "2.7.116", "--output", output,
      ]);
      const upload = steps.find((s: any) => s.name === `Upload to Cloudflare R2 (${os})`);
      const uploaded = spawnSync("bash", ["-e", "-c", upload.run.replaceAll("${{ matrix.target }}", target)], {
        cwd: fixture, env: { ...env, ATTRIBUTION_ARTIFACT_DIR: output }, encoding: "utf8",
      });
      expect({ status: uploaded.status, stderr: uploaded.stderr }).toEqual({ status: 0, stderr: "" });
      const args = readFileSync(env.UPLOAD_LOG, "utf8").split("\0").slice(0, -1);
      expect(args.slice(0, 3)).toEqual(["consumer", "2.7.116", target]);
      expect(args).toContain(join(output, `screenpipe-attribution.${extension}`));
      expect(args).toContain(join(output, "screenpipe-attribution.json"));
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });
}

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

test("all Windows native dependency builds select the shared Ninja setup", () => {
  const appStep = app.jobs["publish-tauri"].steps.find((step: any) => step.name === "Configure Ninja for Windows native dependencies");
  expect(appStep.if).toBe("matrix.os_type == 'windows'");
  expect(appStep.run).toBe("./.github/scripts/setup-ninja-windows.ps1");

  const enterpriseStep = enterprise.jobs["release-enterprise-windows"].steps.find(
    (step: any) => step.name === "Configure Ninja for Windows native dependencies",
  );
  expect(enterpriseStep.run).toBe("./.github/scripts/setup-ninja-windows.ps1");
  const cliSteps = readYaml(".github/workflows/release-cli.yml").jobs["build-windows"].steps;
  const cliNinjaIndex = cliSteps.findIndex((step: any) => step.name === "Configure Ninja for Windows native dependencies");
  expect(cliNinjaIndex).toBeGreaterThan(-1);
  expect(cliSteps[cliNinjaIndex].run).toBe("./.github/scripts/setup-ninja-windows.ps1");
  expect(cliSteps[cliNinjaIndex].shell).toBe("pwsh");
  expect(cliNinjaIndex).toBeLessThan(cliSteps.findIndex((step: any) => step.name === "Build CLI"));
  expect(readFileSync(join(root, ".github/scripts/setup-ninja-windows.ps1"), "utf8")).toContain('"CMAKE_GENERATOR=Ninja"');
});

test("Windows CLI compiles through the short target path without moving smoke probe outputs", () => {
  const job = readYaml(".github/workflows/release-cli.yml").jobs["build-windows"];
  const build = job.steps.find((step: any) => step.name === "Build CLI");
  expect(build.env.CARGO_TARGET_DIR).toBe("C:/t");
  expect(build.env.CMAKE_GENERATOR).toBe("Ninja Multi-Config");
  expect(build.env.CMAKE_CONFIGURATION_TYPES.split(";")).toEqual(["Debug", "Release", "RelWithDebInfo", "MinSizeRel"]);
  const junction = job.steps.find((step: any) => step.name === "Shorten target dir to avoid MAX_PATH");
  expect(junction.run).toContain('$shortDir = "C:\\t"');
  expect(junction.run).toContain("mklink /J $targetDir $shortDir");
  expect(job.env?.CARGO_TARGET_DIR).toBeUndefined();
  const smoke = job.steps.find((step: any) => step.name === "Build + run ort-smoke natively; stage for the SDE job");
  expect(smoke.env?.CARGO_TARGET_DIR).toBeUndefined();
  expect(smoke.run).toContain('.github/ci/ort-smoke/target/debug/ort-smoke.exe');
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

test("consumer and enterprise signing refresh trust before any Windows signing", () => {
  const actionPath = ".github/actions/refresh-windows-signing-trust";
  for (const job of [app.jobs["publish-tauri"], enterprise.jobs["release-enterprise-windows"]]) {
    const checkout = job.steps.find((step: any) => step.with?.["sparse-checkout"]?.includes(actionPath));
    expect(checkout.with.ref).toBe("${{ github.workflow_sha }}");
    expect(checkout.with.path).toBe(".release-workflow");
    const refresh = job.steps.findIndex((step: any) => step.uses === `./.release-workflow/${actionPath}`);
    const install = job.steps.findIndex((step: any) => step.run?.includes("CodeSignTool-v1.3.2-windows.zip"));
    const sign = job.steps.findIndex((step: any) => step.env?.ESIGNER_PASSWORD);
    expect(refresh).toBeGreaterThan(install);
    expect(sign).toBeGreaterThan(refresh);
    expect(job.steps[refresh]["continue-on-error"]).toBeUndefined();
  }
  const appRefresh = app.jobs["publish-tauri"].steps.find((step: any) => step.uses === `./.release-workflow/${actionPath}`);
  expect(appRefresh.if).toBe("matrix.os_type == 'windows'");
  const contracts = readYaml(".github/workflows/test-release-workflows.yml");
  expect(contracts.jobs["windows-signing-trust"].strategy.matrix.os).toEqual(["windows-latest", "windows-11-arm"]);
});
