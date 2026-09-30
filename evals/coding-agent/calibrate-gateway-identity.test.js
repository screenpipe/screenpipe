// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

// Local deterministic grader calibration; no model or external provider call.
import { afterAll, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const repo = resolve(import.meta.dir, "../..");
const manifest = JSON.parse(readFileSync(join(import.meta.dir, "cases.json"), "utf8"));
const item = manifest.cases.find(item => item.id === "ai-gateway-verified-identity");
const authPath = "packages/ai-gateway/src/utils/auth.ts";
const subscriptionPath = "packages/ai-gateway/src/utils/subscription.ts";
const show = (ref, path) => execFileSync("git", ["-c", "core.commitGraph=false", "show", `${ref}:${path}`], {
  cwd: repo, encoding: "utf8",
});
const broken = show(item.base_ref, authPath);
const fixed = show(item.oracle_ref, authPath);
const subscription = show(item.base_ref, subscriptionPath);
const root = mkdtempSync(join(tmpdir(), "gateway-identity-calibration-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
function grade(name, source) {
  const workspace = join(root, name);
  const write = (path, contents) => {
    mkdirSync(dirname(join(workspace, path)), { recursive: true });
    writeFileSync(join(workspace, path), contents);
  };
  write(authPath, source); write(subscriptionPath, subscription);
  const fixture = item.grader.fixtures[0];
  const destination = join(workspace, fixture.destination_path);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(join(import.meta.dir, fixture.local_path), destination);
  return spawnSync(process.execPath, ["test", fixture.destination_path], {
    cwd: workspace, encoding: "utf8", timeout: 15_000,
    env: { PATH: dirname(process.execPath) },
  });
}
function behaviorFailure(result) {
  expect(result.error).toBeUndefined(); expect(result.signal).toBeNull();
  expect(result.status).toBe(1); expect(result.stderr).toContain("expect(received)");
  expect(result.stderr).not.toContain("Cannot find module");
}
test("broken parent fails identity assertions with 11 preserved passes", () => {
  const result = grade("parent", broken); behaviorFailure(result);
  expect(result.stderr).toContain("11 pass"); expect(result.stderr).toContain("17 fail");
});
test("known correct reference needs no further changes", () => {
  const result = grade("reference", fixed);
  expect(result.status).toBe(0); expect(result.stderr).toContain("28 pass");
});
test("equivalent helper renaming remains valid", () => {
  expect(fixed).toContain("validateSubscriptionWithId");
  const result = grade("renamed", fixed.replaceAll("validateSubscriptionWithId", "lookupVerifiedSubscription"));
  expect(result.status).toBe(0); expect(result.stderr).toContain("28 pass");
});
test("a raw-identifier fast path cannot bypass the verified boundary", () => {
  const anchor = "const token = authHeader.split(' ')[1];";
  expect(fixed.split(anchor)).toHaveLength(2);
  const bypass = `\n  if (token.startsWith('user_') || /^[0-9a-f-]{36}$/.test(token)) {\n    return { isValid: true, tier: 'logged_in', userId: token, deviceId: token };\n  }`;
  const result = grade("identity-bypass", fixed.replace(anchor, anchor + bypass));
  behaviorFailure(result); expect(result.stderr).toContain("8 fail");
});
test("blanket anonymous fallback fails legitimate authenticated access", () => {
  const anchor = "const authHeader = request.headers.get('Authorization');";
  expect(fixed.split(anchor)).toHaveLength(2);
  const deny = "\n  return { isValid: true, tier: 'anonymous', deviceId: headerDeviceId };";
  behaviorFailure(grade("deny-authenticated", fixed.replace(anchor, anchor + deny)));
});
