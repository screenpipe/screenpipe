// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const miner = new URL("./mine-history.mjs", import.meta.url).pathname;
function fixture(run: (repo: string, ids: Record<string, string>) => void) {
  const repo = mkdtempSync(join(tmpdir(), "eval-history-control-"));
  const git = (...args: string[]) => {
    const r = spawnSync("git", args, { cwd: repo, encoding: "utf8", timeout: 10_000 });
    if (r.status !== 0) throw new Error(r.stderr || String(r.error));
    return r.stdout.trim();
  };
  const commit = (subject: string, date: string, path: string) => {
    writeFileSync(join(repo, path), subject + "\n"); git("add", path);
    const r = spawnSync("git", ["commit", "-qm", subject], { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, timeout: 10_000 });
    if (r.status !== 0) throw new Error(r.stderr);
    return git("rev-parse", "HEAD");
  };
  try {
    git("init", "-q", "-b", "main"); git("config", "user.name", "Synthetic eval control");
    git("config", "user.email", "fixture@example.invalid"); git("config", "commit.gpgsign", "false");
    git("remote", "add", "origin", "https://example.invalid/synthetic.git");
    const root = commit("fix initial fixture", "2020-01-01T00:00:00Z", "root.test.js");
    const old = commit("fix old escaped failure", "2021-01-01T00:00:00Z", "old.test.js");
    git("checkout", "-qb", "side");
    const side = commit("fix merged branch failure", "2026-09-01T00:00:00Z", "side.test.js");
    git("checkout", "-q", "main");
    const unrelated = commit("maintain examples", "2026-09-02T00:00:00Z", "example.test.js");
    git("merge", "--no-ff", "--no-commit", "side");
    const merge = commit("fix merge resolution behavior", "2026-09-03T00:00:00Z", "resolution.test.js");
    run(repo, { root, old, side, unrelated, merge });
  } finally { rmSync(repo, { recursive: true, force: true }); }
}
function invoke(repo: string, ...args: string[]) {
  return spawnSync(process.execPath, [miner, "--repo", repo, "--ref", "main", ...args], { encoding: "utf8", timeout: 20_000 });
}
function scan(repo: string, ...args: string[]) {
  const result = invoke(repo, ...args); expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
}

test("default discovery reaches old fixes and merged branches without promoting roots or non-fixes", () => fixture((repo, ids) => {
  const page = scan(repo);
  expect(page.candidates.map((c: any) => c.fix_commit).sort()).toEqual([ids.old, ids.side, ids.merge].sort());
  expect(page.scanned_commits).toBe(5);
  expect(page.resolved_ref).toBe(ids.merge);
  expect(page.since).toBeNull();
}));

test("merge candidates expose each parent comparison and require resolution review", () => fixture((repo, ids) => {
  const merge = scan(repo).candidates.find((c: any) => c.fix_commit === ids.merge);
  expect(merge).toBeDefined();
  expect(merge.requires_merge_review).toBe(true);
  expect(merge.parents).toEqual([ids.unrelated, ids.side]);
  expect(merge.parent_comparisons).toHaveLength(2);
  expect(merge.parent_comparisons[0].changed_paths).toContain("side.test.js");
  expect(merge.parent_comparisons[1].changed_paths).toContain("example.test.js");
  expect(merge.parent_comparisons.every((p: any) => p.changed_paths.includes("resolution.test.js"))).toBe(true);
}));

test("bounded pages on a pinned head neither omit nor duplicate reachable commits", () => fixture((repo, ids) => {
  const seen: string[] = []; const candidates: string[] = []; let skip = 0;
  for (let n = 0; n < 3; n++) {
    const page = scan(repo, "--ref", ids.merge, "--limit", "2", "--skip", String(skip));
    expect(page.scanned_commits).toBeLessThanOrEqual(2);
    seen.push(...page.scanned_commit_ids); candidates.push(...page.candidates.map((c: any) => c.fix_commit));
    if (n < 2) { expect(page.next_skip).toBe(skip + 2); skip = page.next_skip; }
    else expect(page.next_skip).toBeNull();
  }
  expect(seen.sort()).toEqual(Object.values(ids).sort());
  expect(new Set(candidates).size).toBe(3);
  const empty = scan(repo, "--skip", "5");
  expect(empty.scanned_commits).toBe(0); expect(empty.next_skip).toBeNull();
}));

test("explicit date filters remain supported and invalid paging fails closed", () => fixture((repo, ids) => {
  const page = scan(repo, "--since", "2026-01-01");
  expect(page.candidates.map((c: any) => c.fix_commit).sort()).toEqual([ids.side, ids.merge].sort());
  for (const args of [["--skip", "-1"], ["--skip", "1.5"], ["--skip"], ["--limit", "0"], ["--ref", "does-not-exist"]]) {
    expect(invoke(repo, ...args).status).not.toBe(0);
  }
}));
