// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const helper = resolve(import.meta.dir, "dependabot-lockfiles.sh");
const cargoHelper = readFileSync(resolve(import.meta.dir, "../../scripts/regenerate-locks.sh"));
const fixtures: string[] = [];

afterEach(() => {
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "screenpipe-dependabot-"));
  fixtures.push(directory);
  const write = (path: string, text: string | Buffer) => {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), text);
  };
  const run = (args: string[], env: Record<string, string> = {}) => Bun.spawnSync(args, {
    cwd: directory,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const ok = (args: string[]) => {
    const result = run(args);
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  const commit = () => {
    ok(["git", "add", "."]);
    ok(["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"]);
    return ok(["git", "rev-parse", "HEAD"]);
  };
  ok(["git", "init", "-q"]);
  write(".gitignore", "node_modules/\ntarget/\n");
  return { directory, write, run, ok, commit };
}

function bunFixture() {
  const f = fixture();
  f.write("old/package.json", JSON.stringify({ name: "local-dep", version: "1.0.0" }));
  f.write("patched/package.json", JSON.stringify({ name: "local-dep", version: "1.0.1" }));
  const manifest = (path: string) => JSON.stringify({
    name: "fixture",
    dependencies: { "local-dep": `file:./${path}` },
    scripts: { postinstall: "touch lifecycle-script-ran" },
  });
  f.write("package.json", manifest("old"));
  f.ok(["bun", "install", "--lockfile-only", "--ignore-scripts"]);
  const base = f.commit();
  f.write("package.json", manifest("patched"));
  f.commit();
  return { ...f, base };
}

test("repairs a frozen Bun lockfile without running lifecycle scripts or changing the manifest", () => {
  const f = bunFixture();
  expect(f.run(["bun", "install", "--frozen-lockfile", "--ignore-scripts"]).exitCode).not.toBe(0);
  const result = f.run(["bash", helper, f.base]);
  expect(result.exitCode).toBe(0);
  expect(f.ok(["git", "diff", "--name-only"])).toBe("bun.lock");
  f.ok(["bun", "install", "--frozen-lockfile", "--ignore-scripts"]);
  expect(f.ok(["git", "ls-files", "--others", "--exclude-standard"])).toBe("");
  const repaired = readFileSync(join(f.directory, "bun.lock"), "utf8");
  f.ok(["bash", helper, f.base]);
  expect(readFileSync(join(f.directory, "bun.lock"), "utf8")).toBe(repaired);
});

test("repairs Cargo locks in dependent workspaces after a shared manifest changes", () => {
  const f = fixture();
  const manifest = (version: string) => `[package]\nname = "shared"\nversion = "${version}"\nedition = "2021"\n`;
  f.write("Cargo.toml", manifest("0.1.0"));
  f.write("src/lib.rs", "pub fn shared() {}\n");
  f.write("consumer/Cargo.toml", '[package]\nname = "consumer"\nversion = "0.1.0"\nedition = "2021"\n[dependencies]\nshared = { path = ".." }\n[workspace]\n');
  f.write("consumer/src/lib.rs", "pub fn consumer() {}\n");
  f.write("scripts/regenerate-locks.sh", cargoHelper);
  for (const manifestPath of ["Cargo.toml", "consumer/Cargo.toml"]) {
    f.ok(["cargo", "metadata", "--offline", "--format-version", "1", "--manifest-path", manifestPath]);
  }
  const base = f.commit();
  f.write("Cargo.toml", manifest("0.1.1"));
  f.commit();
  expect(f.run(["bash", "scripts/regenerate-locks.sh", "--check"]).exitCode).not.toBe(0);
  f.ok(["bash", helper, base]);
  expect(f.ok(["git", "diff", "--name-only"]).split("\n")).toEqual(["Cargo.lock", "consumer/Cargo.lock"]);
  f.ok(["bash", "scripts/regenerate-locks.sh", "--check"]);
});

test("propagates a dependency resolver failure", () => {
  const f = bunFixture();
  f.write("bin/bun", "#!/bin/sh\nexit 23\n");
  f.ok(["chmod", "+x", "bin/bun"]);
  expect(f.run(["bash", helper, f.base], { PATH: `${f.directory}/bin:${process.env.PATH}` }).exitCode).toBe(23);
});

test.each(["working tree", "index", "untracked"])("rejects non-lockfile changes in the %s", (location) => {
  const f = bunFixture();
  const changedFile = location === "untracked" ? "unexpected-source.ts" : "package.json";
  f.write(changedFile, location === "untracked" ? "// unexpected\n" : readFileSync(join(f.directory, changedFile), "utf8") + "\n");
  if (location === "index") f.ok(["git", "add", changedFile]);
  const result = f.run(["bash", helper, f.base]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain(`unexpected non-lockfile change: ${changedFile}`);
});
