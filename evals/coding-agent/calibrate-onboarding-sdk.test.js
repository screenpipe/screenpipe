// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const repo = resolve(import.meta.dir, '../..');
const app = 'apps/screenpipe-app-tauri';
const page = `${app}/app/onboarding/page.tsx`;
const gate = `${app}/components/onboarding/login-gate.tsx`;
const fixture = `${app}/app/onboarding/page.test.tsx`;
const item = JSON.parse(readFileSync(join(import.meta.dir, 'cases.json'), 'utf8')).cases
  .find(c => c.id === 'app-onboarding-sdk-cold-start-assignment');
const root = mkdtempSync(join(tmpdir(), 'onboarding-sdk-calibration-'));
const archives = new Map();
const fixtureSource = execFileSync('git', ['show', `${item.oracle_ref}:${fixture}`], { cwd: repo });
const paths = ['app/onboarding', 'components', 'lib', 'scripts', 'vitest.config.ts',
  'vitest.setup.ts', 'gt.config.json', 'package.json', 'tsconfig.json', 'postcss.config.js', 'tailwind.config.js']
  .filter(path => spawnSync('git', ['cat-file', '-e', `${item.oracle_ref}:${app}/${path}`], { cwd: repo }).status === 0)
  .map(path => `${app}/${path}`);
afterAll(() => rmSync(root, { recursive: true, force: true }));

function change(cwd, path, from, to) {
  const file = join(cwd, path), source = readFileSync(file, 'utf8');
  expect(source.split(from)).toHaveLength(2);
  writeFileSync(file, source.replace(from, to));
}
function grade(name, ref = item.oracle_ref, mutate = () => {}) {
  const cwd = join(root, name); mkdirSync(cwd);
  if (!archives.has(ref)) archives.set(ref, execFileSync('git',
    ['-c', 'core.commitGraph=false', 'archive', ref, ...paths], { cwd: repo, maxBuffer: 128 * 1024 * 1024 }));
  execFileSync('tar', ['-x', '-C', cwd], { input: archives.get(ref) });
  writeFileSync(join(cwd, fixture), fixtureSource);
  symlinkSync(join(repo, app, 'node_modules'), join(cwd, app, 'node_modules'), 'dir');
  writeFileSync(join(cwd, '.eval-onboarding-sdk.mjs'), readFileSync(join(repo, 'evals/coding-agent/graders/onboarding-sdk-outcomes.mjs')));
  mutate(cwd);
  return spawnSync('/bin/bash', ['-c', item.grader.command], { cwd, encoding: 'utf8',
    timeout: 120_000, env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}` },
    maxBuffer: 4 * 1024 * 1024 });
}
function fails(result) {
  expect(result.error).toBeUndefined(); expect(result.signal).toBeNull();
  expect(result.status).toBe(1);
  expect(result.stdout + result.stderr).toMatch(/expected|Unable to find an element/);
  expect(result.stdout + result.stderr).not.toMatch(/Failed to load url|Cannot find module|Failed to resolve import/);
}
test('parent fails four cold outcomes and stale-cache acceptance, preserving six neighbors', () => {
  const r = grade('parent', item.base_ref); fails(r);
  expect(r.stdout).toContain('5 failed | 6 passed');
}, 120_000);
test('reference passes eleven outcome tests', () => {
  const r = grade('reference'); expect(r.status).toBe(0); expect(r.stdout).toContain('11 passed');
}, 120_000);
test('equivalent fresh-completion predicate is accepted', () => {
  const r = grade('equivalent', item.oracle_ref, cwd => change(cwd, page,
    'if (matchingIdentityResponses === 1)', 'if (matchingIdentityResponses < 2)'));
  expect(r.status).toBe(0);
}, 120_000);
test('unused correct page cannot mask the broken caller', () => {
  fails(grade('unused', item.oracle_ref, cwd => {
    writeFileSync(join(cwd, dirname(page), 'unused-correct-page.tsx'), readFileSync(join(cwd, page)));
    writeFileSync(join(cwd, page), execFileSync('git', ['show', `${item.base_ref}:${page}`], { cwd: repo }));
  }));
}, 120_000);
test('cached and older remote acceptance is rejected', () => {
  fails(grade('stale', item.oracle_ref, cwd => {
    change(cwd, page, 'if (typeof context?.errorsLoading !== "boolean") return;', '');
    change(cwd, page, 'if (matchingIdentityResponses === 1)', 'if (matchingIdentityResponses < 1)');
  }));
}, 120_000);
test('blanket control is rejected by treatment outcome', () => {
  fails(grade('control', item.oracle_ref, cwd => change(cwd, page,
    'variant: typeof value === "string" ? value : "control",', 'variant: "control",')));
}, 120_000);
test('missing page is setup failure, not an intended regression', () => {
  const r = grade('missing', item.oracle_ref, cwd => rmSync(join(cwd, page)));
  expect(r.status).toBe(1); expect(r.stdout + r.stderr).toMatch(/Failed to resolve import|Failed to load url/);
}, 120_000);
test('extending the preserved fallback deadline is rejected', () => {
  const r = grade('late-fallback', item.oracle_ref, cwd => change(cwd, page,
    'const TRIAL_ACTIVATION_ASSIGNMENT_TIMEOUT_MS = 5_000;',
    'const TRIAL_ACTIVATION_ASSIGNMENT_TIMEOUT_MS = 7_000;'));
  fails(r); expect(r.stdout).toContain('retains the five-second fallback');
}, 120_000);
test('unavailable locked SDK is an infrastructure exit before grading', () => {
  const r = grade('wrong-runtime', item.oracle_ref, cwd => {
    rmSync(join(cwd, app, 'node_modules'));
    mkdirSync(join(cwd, app, 'node_modules/posthog-js'), { recursive: true });
    writeFileSync(join(cwd, app, 'node_modules/posthog-js/package.json'), '{"version":"0.0.0"}');
  });
  expect(r.status).toBe(127); expect(r.stderr).toContain('Required locked SDK runtime unavailable');
  expect(r.stdout).not.toContain('RUN');
}, 120_000);
