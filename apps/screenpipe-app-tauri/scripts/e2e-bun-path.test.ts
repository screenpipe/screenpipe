// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const launcher = resolve(import.meta.dir, "../e2e/helpers/app-launcher.ts");
const source = ts.createSourceFile(launcher, readFileSync(launcher, "utf8"), ts.ScriptTarget.Latest, true);
let initializer: ts.Expression | undefined;
for (const statement of source.statements) {
  if (!ts.isVariableStatement(statement)) continue;
  for (const declaration of statement.declarationList.declarations) {
    if (declaration.name.getText(source) === "E2E_BUN_PATH") initializer = declaration.initializer;
  }
}
if (!initializer) throw new Error("E2E launcher does not export its Bun path");
const actualPath = (appRoot: string, platform: string): string => runInNewContext(
  ts.transpile(`(${initializer!.getText(source)})`), { APP_ROOT: appRoot, process: { platform }, resolve },
);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

for (const [platform, relativePath] of [
  ["linux", "src-tauri/bun-x86_64-unknown-linux-gnu"],
  ["win32", "src-tauri/target/debug-dev/bun.exe"],
  ["darwin", "src-tauri/target/debug-dev/bun"],
] as const) {
  test(`${platform} MCP configuration launches its staged Bun without a PATH fallback`, () => {
    const root = mkdtempSync(resolve(tmpdir(), "screenpipe-bun-fixture-")); roots.push(root);
    const sidecar = resolve(root, relativePath);
    mkdirSync(dirname(sidecar), { recursive: true });
    copyFileSync(process.execPath, sidecar);
    chmodSync(sidecar, 0o755);
    const version = execFileSync(actualPath(root, platform), ["--version"], { encoding: "utf8", env: { ...process.env, PATH: "" } });
    expect(version.trim()).toBe(Bun.version);
  });
}

test("a missing canonical Linux sidecar fails instead of substituting the runner's Bun", () => {
  const root = mkdtempSync(resolve(tmpdir(), "screenpipe-bun-missing-")); roots.push(root);
  expect(() => execFileSync(actualPath(root, "linux"), ["--version"])).toThrow(/ENOENT/);
});
