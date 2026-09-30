// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
const repo = resolve(import.meta.dir, '../..'), app = 'apps/screenpipe-app-tauri';
const item = JSON.parse(readFileSync(join(import.meta.dir, 'cases.json'), 'utf8')).cases.find(c => c.id === 'app-pipe-run-registered-outputs');
const hook = `${app}/lib/hooks/use-chat-inspector.ts`;
const root = mkdtempSync(join(tmpdir(), 'pipe-outputs-calibration-')), archives = new Map();
const paths = [hook, `${app}/lib/hooks/use-unified-artifacts.ts`, `${app}/lib/source-citations.ts`, `${app}/lib/api.ts`];
const receipts = process.env.SCREENPIPE_EVAL_CALIBRATION_RECEIPTS;
afterAll(() => rmSync(root, { recursive: true, force: true }));
function change(cwd, from, to) {
  const path = join(cwd, hook), source = readFileSync(path, 'utf8');
  expect(source.split(from)).toHaveLength(2);
  writeFileSync(path, source.replace(from, to));
}
function grade(name, ref = item.oracle_ref, mutate = () => {}) {
  const cwd = join(root, name); mkdirSync(cwd);
  if (!archives.has(ref)) archives.set(ref, execFileSync('git', ['archive', ref, ...paths], { cwd: repo, maxBuffer: 8 * 1024 * 1024 }));
  execFileSync('tar', ['-x', '-C', cwd], { input: archives.get(ref) });
  for (const f of item.grader.fixtures) writeFileSync(join(cwd, f.destination_path), readFileSync(join(import.meta.dir, f.local_path)));
  symlinkSync(join(repo, app, 'node_modules'), join(cwd, app, 'node_modules'), 'dir');
  mutate(cwd);
  const r = spawnSync('/bin/bash', ['-c', item.grader.command], { cwd, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: cwd, CI: 'true', TZ: 'UTC', NO_COLOR: '1' } });
  if (receipts) {
    mkdirSync(receipts, { recursive: true });
    writeFileSync(join(receipts, `${name}.stdout`), r.stdout || '');
    writeFileSync(join(receipts, `${name}.stderr`), r.stderr || '');
    writeFileSync(join(receipts, `${name}.json`), JSON.stringify({ ref, command: item.grader.command, exit_code: r.status, signal: r.signal, error: r.error?.message }, null, 2));
  }
  expect(r.error).toBeUndefined(); expect(r.signal).toBeNull();
  return r;
}
function passes(r) { expect(r.status).toBe(0); expect(r.stdout).toContain('6 passed'); expect(r.stdout + r.stderr).not.toMatch(/Unhandled|Uncaught/); }
function fails(r) { expect(r.status).toBe(1); expect(r.stderr).toContain('AssertionError'); expect(r.stdout + r.stderr).not.toMatch(/Unhandled|Uncaught|Failed to resolve import|Failed to load url|Cannot find module/); }
test('parent fails three intended outcomes and preserves three', () => { const r = grade('parent', item.base_ref); fails(r); expect(r.stdout).toContain('3 failed | 3 passed'); }, 60000);
test('reference passes all public hook outcomes', () => passes(grade('reference')), 60000);
test('equivalent private helper naming passes', () => passes(grade('equivalent', item.oracle_ref, cwd => {
  const p = join(cwd, hook); writeFileSync(p, readFileSync(p, 'utf8').replaceAll('mergePipeRunArtifactOutputs', 'combineRegisteredOutputs'));
})), 60000);
test('unused correct hook cannot hide the broken entry point', () => fails(grade('unused', item.oracle_ref, cwd => {
  writeFileSync(join(cwd, `${app}/lib/hooks/unused-correct.ts`), readFileSync(join(cwd, hook)));
  writeFileSync(join(cwd, hook), execFileSync('git', ['show', `${item.base_ref}:${hook}`], { cwd: repo }));
})), 60000);
test('cross-run output acceptance fails', () => fails(grade('source-bypass', item.oracle_ref, cwd => change(cwd, 'if (artifact.source !== pipeRunArtifactSource) continue;', '// calibration: source filter removed'))), 60000);
test('blanket registered-output suppression fails', () => fails(grade('blanket', item.oracle_ref, cwd => change(cwd, 'const outputs = [...toolOutputs];', 'const outputs = [...toolOutputs]; return outputs;'))), 60000);
test('missing public hook is a setup error', () => {
  const r = grade('missing', item.oracle_ref, cwd => rmSync(join(cwd, hook)));
  expect(r.status).toBe(1); expect(r.stdout).toContain('no tests'); expect(r.stdout + r.stderr).toMatch(/Failed to resolve import|Failed to load url/);
}, 60000);
