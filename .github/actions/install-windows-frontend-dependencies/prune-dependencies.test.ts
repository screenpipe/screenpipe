// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneDependencies } from "./prune-dependencies";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(packages: string[]) {
  const root = mkdtempSync(join(tmpdir(), "release-dependencies-")); roots.push(root);
  const lock = (names: string[]) => writeFileSync(join(root, "bun.lock"), JSON.stringify({ lockfileVersion: 1, packages: Object.fromEntries(names.map(name => [name, []])) }));
  lock(packages);
  const file = (path: string, content = "untouched") => {
    const full = join(root, path); mkdirSync(join(full, ".."), { recursive: true }); writeFileSync(full, content); return full;
  };
  return { root, lock, file };
}

test("removes the orphan Tauri updater while retaining warm packages and Bun metadata", () => {
  const f = fixture(["@tauri-apps/cli", "react"]);
  const retained = f.file("node_modules/@tauri-apps/cli/warm-marker");
  f.file("node_modules/@tauri-apps/plugin-updater/package.json", '{"version":"2.10.0"}');
  const metadata = f.file("node_modules/.bun/install-cache");
  expect(pruneDependencies(f.root)).toEqual(["@tauri-apps/plugin-updater"]);
  expect(readFileSync(retained, "utf8")).toBe("untouched");
  expect(existsSync(metadata)).toBe(true);
  expect(pruneDependencies(f.root)).toEqual([]);
});

test("a changed lockfile prunes removed scoped and nested packages without rebuilding retained ones", () => {
  const f = fixture(["parent", "parent/@scope/child", "@scope/parent", "@scope/parent/child", "@scope/parent/@scope/child"]);
  const retained = f.file("node_modules/@scope/parent/node_modules/@scope/child/warm-marker");
  const nested = f.file("node_modules/parent/node_modules/@scope/child/package.json");
  const scoped = f.file("node_modules/@scope/parent/node_modules/child/package.json");
  expect(pruneDependencies(f.root)).toEqual([]);
  f.lock(["parent", "@scope/parent", "@scope/parent/@scope/child"]);
  expect(pruneDependencies(f.root).sort()).toEqual(["@scope/parent/node_modules/child", "parent/node_modules/@scope/child"]);
  expect(existsSync(nested)).toBe(false); expect(existsSync(scoped)).toBe(false);
  expect(readFileSync(retained, "utf8")).toBe("untouched");
});

test("invalid or unsupported locks fail before deleting any installed package", () => {
  const f = fixture(["react", "../outside"]);
  const orphan = f.file("node_modules/orphan/package.json");
  expect(() => pruneDependencies(f.root)).toThrow("Invalid Bun package key");
  expect(existsSync(orphan)).toBe(true);
  writeFileSync(join(f.root, "bun.lock"), '{"lockfileVersion":2,"packages":{"react":[]}}');
  expect(() => pruneDependencies(f.root)).toThrow("Unsupported Bun lockfile");
  expect(existsSync(orphan)).toBe(true);
});

test("removing an orphan junction does not delete its external target", () => {
  const f = fixture(["react"]);
  const external = f.file("external/package.json");
  mkdirSync(join(f.root, "node_modules"));
  symlinkSync(join(f.root, "external"), join(f.root, "node_modules/orphan"), process.platform === "win32" ? "junction" : "dir");
  expect(pruneDependencies(f.root)).toEqual(["orphan"]);
  expect(readFileSync(external, "utf8")).toBe("untouched");
});
