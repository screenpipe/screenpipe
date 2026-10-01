// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
const repo = resolve(import.meta.dir, "../..");
const item = JSON.parse(readFileSync(join(import.meta.dir, "cases.json"), "utf8")).cases.find(x => x.id === "ai-gateway-auth-log-privacy");
const path = "packages/ai-gateway/src/utils/auth.ts";
const dependency = "packages/ai-gateway/src/utils/subscription.ts";
const show = (ref, p) => execFileSync("git", ["show", `${ref}:${p}`], { cwd: repo, encoding: "utf8" });
const broken = show(item.base_ref, path), fixed = show(item.oracle_ref, path);
const root = mkdtempSync(join(tmpdir(), "auth-log-calibration-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
function grade(name, source, extra) {
  const workspace = join(root, name);
  const write = (p, data) => { mkdirSync(dirname(join(workspace, p)), { recursive: true }); writeFileSync(join(workspace, p), data); };
  if (source !== null) write(path, source);
  write(dependency, show(item.base_ref, dependency));
  if (extra) write("packages/ai-gateway/src/utils/unused-repair.ts", extra);
  const fixture = item.grader.fixtures[0];
  mkdirSync(dirname(join(workspace, fixture.destination_path)), { recursive: true });
  copyFileSync(join(import.meta.dir, fixture.local_path), join(workspace, fixture.destination_path));
  return spawnSync(process.execPath, ["test", fixture.destination_path], { cwd: workspace, encoding: "utf8", timeout: 15000, env: { PATH: dirname(process.execPath) } });
}
function failure(r) {
  expect(r.error).toBeUndefined(); expect(r.signal).toBeNull(); expect(r.status).toBe(1);
  expect(r.stderr).toContain("expect(received)"); expect(r.stderr).not.toContain("Cannot find module");
}
function patch(anchor, replacement) { expect(fixed.split(anchor)).toHaveLength(2); return fixed.replace(anchor, replacement); }
test("broken parent fails eight privacy checks and preserves four outcomes", () => {
  const r = grade("parent", broken); failure(r); expect(r.stderr).toContain("8 fail"); expect(r.stderr).toContain("4 pass");
});
test("historical auth-only reference passes all twelve outcomes", () => {
  const r = grade("reference", fixed); expect(r.status).toBe(0); expect(r.stderr).toContain("12 pass");
});
test("equivalent generic diagnostics and renamed private helper are accepted", () => {
  const r = grade("equivalent", fixed.replaceAll("validateScreenpipeToken", "validateLegacyCredential").replaceAll("clerk verification failed", "verification unavailable"));
  expect(r.status).toBe(0);
});
test("silencing diagnostics preserves authentication", () => {
  const r = grade("silent", fixed.replace(/^\s*console\.(log|error)\([^\n]*\);$/gm, "")); expect(r.status).toBe(0);
});
test("unused correct source cannot hide the active leaking module", () => { failure(grade("unused", broken, fixed)); });
test("logging an accepted raw token is rejected", () => {
  failure(grade("raw-token", patch("const payload = await verifyToken(token, {", "console.warn(token);\n    const payload = await verifyToken(token, {")));
});
test("logging a provider Error object is rejected", () => {
  failure(grade("raw-error", patch("} catch {\n    // Never log", "} catch (error) {\n    console.error(error);\n    // Never log")));
});
test("logging legacy email or canonical account ID is rejected", () => {
  failure(grade("email", patch("const userData = data.user;", "const userData = data.user; console.info(userData?.email);")));
  failure(grade("subject", patch("const resolvedUserId = clerkResult.userId || token;", "const resolvedUserId = clerkResult.userId || token; console.debug(resolvedUserId);")));
});
test("quiet blanket denial cannot replace authentication", () => {
  failure(grade("deny", patch("const authHeader = request.headers.get('Authorization');", "const authHeader = request.headers.get('Authorization'); return { isValid: true, tier: 'anonymous', deviceId: headerDeviceId };")));
});
test("quiet blanket paid access cannot replace rejection", () => {
  failure(grade("grant", patch("const authHeader = request.headers.get('Authorization');", "const authHeader = request.headers.get('Authorization'); return { isValid: true, tier: 'subscribed', userId: 'user_SyntheticSubjectCanary', deviceId: 'user_SyntheticSubjectCanary' };")));
});
test("missing auth source is a setup error", () => {
  const r = grade("missing", null); expect(r.status).not.toBe(0); expect(r.stderr).toContain("Cannot find module"); expect(r.stderr).not.toContain("expect(received)");
});
