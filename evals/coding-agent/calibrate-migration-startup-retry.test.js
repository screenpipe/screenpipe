// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const repo = resolve(import.meta.dir, '../..');
const app = 'apps/screenpipe-app-tauri';
const page = `apps/screenpipe-app-tauri/components/storage-migration-prompt.tsx`;
const fixture = `apps/screenpipe-app-tauri/components/storage-migration-prompt.test.tsx`;
const item = JSON.parse(readFileSync(join(import.meta.dir, 'cases.json'), 'utf8')).cases
  .find(c => c.id === 'app-migration-startup-retry');
const root = mkdtempSync(join(tmpdir(), 'onboarding-assignment-calibration-'));
const archives = new Map();
const fixtureSource = readFileSync(join(import.meta.dir, 'graders/migration-startup-retry.fixture.tsx'));
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
  expect(result.stdout + result.stderr).toMatch(/expected|Unable to find (?:an element|role)/);
  expect(result.stdout + result.stderr).not.toMatch(/Failed to load url|Cannot find module|Failed to resolve import/);
}

test('parent fails readiness while preserving neighboring outcomes',()=>{const r=grade('parent',item.base_ref);fails(r);expect(r.stdout).toContain('2 failed | 14 passed');},120000);
test('reference passes all outcomes',()=>{const r=grade('reference');expect(r.status).toBe(0);expect(r.stdout).toContain('16 passed');},120000);
test('equivalent readiness expression is accepted',()=>expect(grade('equivalent',item.oracle_ref,cwd=>change(cwd,page,'!status.busy && !status.blocked_reason','!(status.busy || status.blocked_reason)')).status).toBe(0),120000);
test('unused correct component does not repair caller',()=>fails(grade('unused',item.base_ref,cwd=>writeFileSync(join(cwd,page+'.unused.tsx'),execFileSync('git',['show',`${item.oracle_ref}:${page}`],{cwd:repo})))),120000);
test('busy-only gate misses blocked recovery',()=>fails(grade('no-blocked',item.oracle_ref,cwd=>change(cwd,page,'!status.busy && !status.blocked_reason','!status.busy'))),120000);
test('blocked-only gate misses busy recovery',()=>fails(grade('no-busy',item.oracle_ref,cwd=>change(cwd,page,'!status.busy && !status.blocked_reason','!status.blocked_reason'))),120000);
test('blanket suppression loses healthy explicit action',()=>fails(grade('suppress',item.oracle_ref,cwd=>change(cwd,page,'const open = Boolean(','const open = false && Boolean('))),120000);
test('automatic effect cannot hide behind a closed dialog',()=>fails(grade('auto',item.oracle_ref,cwd=>change(cwd,page,'setStatus(result.data);','setStatus(result.data); void commands.startStorageMigration(result.data.root);'))),120000);
test('deferral must survive webview recreation',()=>fails(grade('deferral',item.oracle_ref,cwd=>change(cwd,page,'window.localStorage.setItem(deferredKey(status.root), status.app_session_id);',''))),120000);
test('recovery must not become source deletion',()=>fails(grade('delete',item.oracle_ref,cwd=>change(cwd,page,'await commands.cancelStorageMigration(status.root)','await commands.deleteOriginalStorageDatabase(status.root)'))),120000);
test('missing component remains an import error',()=>{const r=grade('missing',item.oracle_ref,cwd=>rmSync(join(cwd,page)));expect(r.status).toBe(1);expect(r.stdout+r.stderr).toMatch(/Failed to resolve import|Failed to load url/);expect(r.stdout).toContain('no tests');},120000);
