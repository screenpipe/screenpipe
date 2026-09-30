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
  .find(c => c.id === 'app-onboarding-fresh-assignment-login');
const root = mkdtempSync(join(tmpdir(), 'onboarding-assignment-calibration-'));
const archives = new Map();
const fixtureSource = execFileSync('git', ['show', `${item.oracle_ref}:${fixture}`], { cwd: repo });
const paths = ['app/onboarding', 'components', 'lib', 'scripts', 'vitest.config.ts',
  'vitest.setup.ts', 'package.json', 'tsconfig.json', 'postcss.config.js', 'tailwind.config.js']
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
test('parent exposes both intended failures and eleven preserved outcomes', () => {
  const r = grade('parent', item.base_ref); fails(r);
  expect(r.stdout).toContain('2 failed | 11 passed');
}, 120_000);
test('historical reference passes all thirteen selected outcomes', () => {
  const r = grade('reference'); expect(r.status).toBe(0); expect(r.stdout).toContain('13 passed');
}, 120_000);
test('equivalent state variable naming is accepted', () => {
  const r = grade('renamed', item.oracle_ref, cwd => {
    const file = join(cwd, page);
    writeFileSync(file, readFileSync(file, 'utf8').replaceAll('previousLoginStateRef', 'lastHydratedAuthState'));
  }); expect(r.status).toBe(0);
}, 120_000);
test('an unused correct page cannot hide the unchanged broken caller', () => {
  fails(grade('unused-page', item.oracle_ref, cwd => {
    writeFileSync(join(cwd, dirname(page), 'unused-correct-page.tsx'), readFileSync(join(cwd, page)));
    writeFileSync(join(cwd, page), execFileSync('git', ['show', `${item.base_ref}:${page}`], { cwd: repo }));
  }));
}, 120_000);
test('restoring the old login gate rejects duplicate completion effects', () => {
  fails(grade('old-gate', item.oracle_ref, cwd => writeFileSync(join(cwd, gate),
    execFileSync('git', ['show', `${item.base_ref}:${gate}`], { cwd: repo }))));
}, 120_000);
test('discarding login completion is rejected', () => {
  fails(grade('lost-login', item.oracle_ref, cwd => change(cwd, page,
    'if (loginCompleted && currentSlide === "login" && !isManagedDeployment)',
    'if (false && loginCompleted && currentSlide === "login" && !isManagedDeployment)')));
}, 120_000);
test('counting hydration as a fresh login is rejected', () => {
  fails(grade('hydration-login', item.oracle_ref, cwd => change(cwd, page,
    'previousLoginStateRef.current === false && isLoggedIn', 'isLoggedIn')));
}, 120_000);
test('forcing every assignment to control is rejected by treatment preservation', () => {
  fails(grade('control-only', item.oracle_ref, cwd => change(cwd, page,
    'variant: typeof value === "string" ? value : "control",', 'variant: "control",')));
}, 120_000);
test('accepting earlier matching-identity callbacks is rejected', () => {
  fails(grade('stale-flags', item.oracle_ref, cwd => change(cwd, page,
    'if (matchingIdentityResponses < 3)', 'if (matchingIdentityResponses < 1)')));
}, 120_000);
test('reporting a disabled flag as a load failure is rejected', () => {
  fails(grade('false-error', item.oracle_ref, cwd => change(cwd, page,
    'settle({ variant: "control", source: "posthog" });', 'fallBackToControl("load_error");')));
}, 120_000);
test('missing page remains a setup failure rather than a reproduced regression', () => {
  const r = grade('missing', item.oracle_ref, cwd => rmSync(join(cwd, page)));
  expect(r.status).toBe(1); expect(r.stdout + r.stderr).toMatch(/Failed to resolve import|Failed to load url/);
  expect(r.stdout).not.toContain('13 passed');
}, 120_000);
