// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkProbe, type Scenario } from "./check-probe";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");
const candidate = resolve(root, process.env.RECORDING_CANDIDATE_ROOT ?? ".");

test("production Windows restoration invariant, with a failing blackout control", () => {
  // Compile the real pure helper, not a TypeScript reimplementation. Keep this
  // bridge fail-closed: a rename/refactor requires explicitly updating it.
  const source = readFileSync(join(candidate, "crates/screenpipe-screen/src/screenshot_privacy/windows.rs"), "utf8");
  const functions = source.match(/^fn restore_opaque_witness_pixel\([^]*?^\}/gm);
  expect(functions?.length).toBe(1);
  // Also ensure the production path still invokes the protected helper.
  expect(source).toContain("restore_opaque_witness_pixel(trusted, target);");
  const fixtures = read("scripts/recording-regression/witness-tests.rs");
  const dir = mkdtempSync(join(tmpdir(), "screenpipe-recording-regression-"));
  try {
    for (const [name, implementation, shouldPass] of [
      ["production", functions![0], true],
      ["blackout-control", "fn restore_opaque_witness_pixel(_trusted: &[u8], _target: &mut [u8]) {}", false],
      ["privacy-control", "fn restore_opaque_witness_pixel(trusted: &[u8], target: &mut [u8]) { target[..3].copy_from_slice(&trusted[..3]); }", false],
    ] as const) {
      const input = join(dir, `${name}.rs`);
      const binary = join(dir, process.platform === "win32" ? `${name}.exe` : name);
      writeFileSync(input, `${implementation}\n${fixtures}`);
      const build = Bun.spawnSync(["rustc", "--edition=2021", "--test", input, "-o", binary], { timeout: 30_000 });
      expect(build.exitCode, build.stderr.toString()).toBe(0);
      const result = Bun.spawnSync([binary], { timeout: 5_000 });
      expect(result.exitCode === 0, result.stdout.toString()).toBe(shouldPass);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);

test("release verification reads the candidate source, not the workflow checkout", () => {
  const dir = mkdtempSync(join(tmpdir(), "screenpipe-recording-candidate-"));
  try {
    const path = join(dir, "crates/screenpipe-screen/src/screenshot_privacy");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "windows.rs"), read("crates/screenpipe-screen/src/screenshot_privacy/windows.rs")
      .replace(/^fn restore_opaque_witness_pixel\([^]*?^\}/m,
        "fn restore_opaque_witness_pixel(_trusted: &[u8], _target: &mut [u8]) {}"));
    const result = Bun.spawnSync([process.execPath, "test", join(root, "scripts/recording-regression/safeguards.test.ts"),
      "--test-name-pattern", "^production Windows restoration"], {
      env: { ...process.env, RECORDING_CANDIDATE_ROOT: dir }, timeout: 120_000,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("(fail) production Windows restoration");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 120_000);

const scenario: Scenario = {
  name: "overlapping-windows", samples: 3, width: 1280, height: 720,
  minAllowedPixels: 50_000, minStoredAllowedPixels: 45_000,
};
const makeRows = (): any[] => [
  ...Array.from({ length: scenario.samples }, (_, index) => ({
    index, saved: true, width: 1280, height: 720, jpeg_width: 1280, jpeg_height: 720,
    forbidden_pixels: 0, stored_forbidden_pixels: 0,
    allowed_pixels: 100_000, stored_allowed_pixels: 95_000,
    native_sequence: index + 1, system_relative_time: (index + 1) * 1_000_000, session_id: 1,
  })),
  { summary: true, scheduled: 3, saved: 3, captured_and_stored: 3, rejected: 0, usable: 3, leaked: 0 },
];
const encode = (rows: any[]) => rows.map(row => JSON.stringify(row)).join("\n");

test("synthetic probe result exposes only aggregate metrics", () => {
  const rows = makeRows();
  rows[0].path = "private-path-should-never-leave-desktop";
  rows[0].error = "private-error";
  expect(checkProbe(encode(rows), scenario)).toEqual({
    scenario: scenario.name, samples: 3, minAllowed: 100_000, minStoredAllowed: 95_000, status: "pass",
  });
});

test.each([
  ["partly black preview", (r: any[]) => { r[1].allowed_pixels = 1; }],
  ["partly black stored JPEG", (r: any[]) => { r[1].stored_allowed_pixels = 1; }],
  ["fully black preview", (r: any[]) => { r[1].allowed_pixels = 0; }],
  ["preview privacy leak", (r: any[]) => { r[1].forbidden_pixels = 1; }],
  ["stored privacy leak", (r: any[]) => { r[1].stored_forbidden_pixels = 1; }],
  ["missing metrics", (r: any[]) => { delete r[1].allowed_pixels; }],
  ["negative metrics", (r: any[]) => { r[1].forbidden_pixels = -1; }],
  ["fractional metrics", (r: any[]) => { r[1].allowed_pixels = 50_000.5; }],
  ["impossible coverage", (r: any[]) => { r[1].allowed_pixels = 1_000_000; }],
  ["missing sequence", (r: any[]) => { delete r[1].native_sequence; }],
  ["repeated sequence", (r: any[]) => { r[1].native_sequence = 1; }],
  ["repeated native time", (r: any[]) => { r[1].system_relative_time = 1_000_000; }],
  ["display session restarted", (r: any[]) => { r[1].session_id = 2; }],
  ["missing display session", (r: any[]) => { r[0].session_id = null; }],
  ["resized JPEG", (r: any[]) => { r[1].jpeg_width = 640; }],
  ["resized capture", (r: any[]) => { r[1].height = 1; }],
  ["reordered samples", (r: any[]) => { r[0].index = 1; }],
  ["rejected sample", (r: any[]) => { r[1] = { index: 1, saved: false, error: "sensitive error" }; }],
  ["missing summary", (r: any[]) => { r.pop(); }],
  ["missing sample", (r: any[]) => { r.splice(1, 1); }],
  ["duplicate summary", (r: any[]) => { r.push(r.at(-1)); }],
  ["false summary success", (r: any[]) => { r[3].usable = 0; }],
] as const)("probe rejects %s even if the summary claims success", (_, mutate) => {
  const rows = makeRows();
  mutate(rows);
  expect(() => checkProbe(encode(rows), scenario)).toThrow();
});

test("probe fails closed on absent or malformed reports and weak floors", () => {
  for (const input of ["", "not json", "null", "[]", "\"hello\"", "x".repeat(2_000_001)]) {
    expect(() => checkProbe(input, scenario)).toThrow();
  }
  for (const overrides of [{ minAllowedPixels: 0 }, { minStoredAllowedPixels: -1 }, { samples: 0 }, { samples: 1 }, { width: 0 }, { name: "private/window title" }]) {
    expect(() => checkProbe(encode(makeRows()), { ...scenario, ...overrides })).toThrow();
  }
  for (const invalid of [null, [], {}, { ...scenario, name: null }, { ...scenario, name: undefined }]) {
    expect(() => checkProbe(encode(makeRows()), invalid as any)).toThrow();
  }
});

test("CLI failure does not print raw JSON or probe paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "screenpipe-probe-cli-"));
  try {
    writeFileSync(join(dir, "scenario.json"), JSON.stringify(scenario));
    writeFileSync(join(dir, "probe.jsonl"), "private-input-sentinel");
    const result = Bun.spawnSync([process.execPath, join(root, "scripts/recording-regression/check-probe.ts"),
      join(dir, "scenario.json"), join(dir, "probe.jsonl")]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).not.toContain("private-input-sentinel");
    expect(result.stderr.toString()).not.toContain(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("all artifact builds depend on exact-candidate safeguards, including recovery", () => {
  const workflow = Bun.YAML.parse(read(".github/workflows/release-app.yml")) as any;
  const jobs = workflow.jobs;
  const gate = jobs["recording-safeguards"];
  expect(gate.needs).toEqual(["check_commit"]);
  expect(gate.if).toBeUndefined();
  expect(gate["continue-on-error"]).toBeUndefined();
  const checkouts = gate.steps.filter((s: any) => s.uses === "actions/checkout@v4");
  expect(checkouts.map((s: any) => s.with.ref)).toEqual([
    "${{ github.workflow_sha }}", "${{ needs.check_commit.outputs.release_sha }}",
  ]);
  expect(checkouts[1].with.path).toBe(".recording-candidate");
  expect(gate.steps.find((s: any) => s.name === "Check candidate recording invariants").env.RECORDING_CANDIDATE_ROOT)
    .toBe(".recording-candidate");
  expect(gate.steps.some((s: any) => s.run === "bun test ./scripts/recording-regression/")).toBe(true);
  expect(gate.steps.every((s: any) => !s.if && !s["continue-on-error"])).toBe(true);
  for (const name of ["draft", "localization"]) expect(jobs[name].needs).toContain("recording-safeguards");
  // Verify every path to an upload job traverses the gate. The workflow keeps
  // its original direct check_commit dependency for outputs as well.
  const dependsOnGate = (name: string): boolean => name === "recording-safeguards" ||
    (jobs[name].needs ?? []).some((dependency: string) => dependsOnGate(dependency));
  for (const [name, job] of Object.entries(jobs) as [string, any][]) {
    if (job.steps?.some((s: any) => /Upload to Cloudflare|enterprise-release\.cjs/.test(`${s.name ?? ""} ${s.run ?? ""}`))) {
      expect(dependsOnGate(name), name).toBe(true);
    }
  }
});
