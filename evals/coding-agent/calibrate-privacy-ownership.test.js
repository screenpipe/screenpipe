// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { afterAll, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
const repo = resolve(import.meta.dir, "../..");
const manifest = JSON.parse(readFileSync(join(import.meta.dir, "cases.json"), "utf8"));
const item = manifest.cases.find(item => item.id === "app-privacy-category-rule-ownership");
const prefix = "apps/screenpipe-app-tauri/";
const section = "components/settings/privacy-section.tsx";
const card = "components/settings/capture-filters/content-filters-card.tsx";
const switches = "components/settings/capture-filters/category-switches.tsx";
const helper = "lib/settings/capture-categories.ts";
const paths = [section, card, switches, helper, "lib/settings/capture-filters.ts"];
const show = (ref, path) => execFileSync("git", ["-c", "core.commitGraph=false", "show", `${ref}:${prefix}${path}`], { cwd: repo, encoding: "utf8" });
const broken = Object.fromEntries(paths.map(path => [path, show(item.base_ref, path)]));
const fixed = Object.fromEntries(paths.map(path => [path, show(item.oracle_ref, path)]));
const grader = readFileSync(join(import.meta.dir, "graders/app-privacy-ownership.test.js"), "utf8");
const root = mkdtempSync(join(tmpdir(), "privacy-ownership-calibration-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
function replace(source, old, replacement) {
  expect(source.split(old)).toHaveLength(2);
  return source.replace(old, replacement);
}
function grade(name, sources) {
  const cwd = join(root, name); mkdirSync(cwd);
  for (const [path, source] of Object.entries(sources)) {
    const file = join(cwd, prefix, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, source);
  }
  writeFileSync(join(cwd, "grader.test.js"), grader);
  return spawnSync(process.execPath, ["test", "grader.test.js"], { cwd, encoding: "utf8", timeout: 30_000, env: { PATH: dirname(process.execPath) } });
}
function fails(result) {
  expect(result.error).toBeUndefined(); expect(result.signal).toBeNull(); expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/expect\(received\)|error: category .+ renders/); expect(result.stderr).not.toContain("Unhandled error");
  expect(result.stderr).not.toContain("Cannot find module");
}
test("parent reaches ownership failures while preserving cleanup and legacy behavior", () => {
  const result = grade("parent", broken); fails(result);
  expect(result.stderr).toContain("7 pass"); expect(result.stderr).toContain("8 fail");
});
test("historical fix passes every caller outcome", () => {
  const result = grade("reference", fixed); expect(result.status).toBe(0); expect(result.stderr).toContain("15 pass");
});
test("fixed helper alone cannot conceal broken UI wiring", () => fails(grade("helper-only", { ...broken, [helper]: fixed[helper] })));
test("component wiring without persisting ownership is rejected", () => fails(grade("no-persistence", { ...fixed,
  [section]: replace(fixed[section], 'categoryOwnedFilters: next.owned ?? { apps: [], domains: [] },', ''),
})));
test("persisted ownership must be loaded into the card", () => fails(grade("no-reload", { ...fixed,
  [section]: replace(fixed[section], 'categoryOwned={settings.categoryOwnedFilters}', ''),
})));
test("the card must forward ownership into the actual toggle", () => fails(grade("no-card-forward", { ...fixed, [card]: broken[card] })));
test("equivalent callback and component renaming is accepted", () => {
  const sources = Object.fromEntries(Object.entries(fixed).map(([p,s]) => [p, s.replaceAll("handleCategoryToggle", "toggleCaptureGroup").replaceAll("CategoryRow", "CaptureGroupRow").replaceAll("setCategoryEnabled", "toggleCategoryExclusions")]));
  expect(grade("renamed", sources).status).toBe(0);
});
test("equivalent ownership field names remain valid", () => {
  const sources = Object.fromEntries(Object.entries(fixed).map(([p,s]) => [p, s.replaceAll("categoryOwnedFilters", "captureGroupProvenance").replaceAll("categoryOwned", "captureProvenance").replace(/\bowned\b/g, "provenance")]));
  expect(grade("ownership-renamed", sources).status).toBe(0);
});
test("a no-op toggle cannot pass by preserving all user entries", () => fails(grade("no-op", { ...fixed,
  [helper]: replace(fixed[helper], 'return enabled ? enableCategory(targets, category) : disableCategory(targets, category);', 'return targets;'),
})));
test("removing all categories cannot hide failing scenarios", () => fails(grade("empty-categories", { ...fixed,
  [switches]: fixed[switches].replaceAll('CAPTURE_CATEGORIES.map', '[].map'),
})));
test("missing real source is a setup error, not a behavioral contrast", () => {
  const sources = { ...fixed }; delete sources[card]; const result = grade("missing-source", sources);
  expect(result.status).toBe(1); expect(result.stderr).toContain("Cannot find module"); expect(result.stderr).toContain("0 pass");
});
