// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
const repo = resolve(import.meta.dir, '../..'), app = 'apps/screenpipe-app-tauri';
const item = JSON.parse(readFileSync(join(import.meta.dir, 'cases.json'), 'utf8')).cases.find(c => c.id === 'app-chat-concurrent-save');
const root = mkdtempSync(join(tmpdir(), 'chat-save-'));
const storage = app + '/lib/chat-storage.ts', merge = app + '/lib/chat-merge.ts';
const source = (path, ref = item.oracle_ref) => execFileSync('git', ['show', `${ref}:${path}`], { cwd: repo, encoding: 'utf8' });
afterAll(() => rmSync(root, { recursive: true, force: true }));
function prepare(name, ref = item.oracle_ref) {
  const cwd = join(root, name); mkdirSync(cwd);
  const paths = ['components', 'lib', 'vitest.config.ts', 'vitest.setup.ts', 'tsconfig.json', 'scripts/bun-test-files.ts'].map(p => app + '/' + p);
  execFileSync('tar', ['-xf', '-', '-C', cwd], { input: execFileSync('git', ['archive', ref, ...paths], { cwd: repo, maxBuffer: 64 * 1024 * 1024 }) });
  for (const f of item.grader.fixtures) {
    const dest = join(cwd, f.destination_path); mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, readFileSync(join(import.meta.dir, f.local_path)));
  }
  symlinkSync(join(repo, app, 'node_modules'), join(cwd, app, 'node_modules'), 'dir'); return cwd;
}
function run(cwd) {
  const r = spawnSync('node', ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.config.ts', 'lib/__tests__/eval-chat-save.test.ts', '--pool=forks', '--poolOptions.forks.singleFork=true'], {
    cwd: join(cwd, app), encoding: 'utf8', timeout: 20000,
    env: { PATH: process.env.PATH, HOME: cwd, CI: 'true', NODE_OPTIONS: '--localstorage-file=.eval-localstorage', NO_COLOR: '1' }
  });
  if (process.env.SCREENPIPE_EVAL_CALIBRATION_RECEIPTS) {
    mkdirSync(process.env.SCREENPIPE_EVAL_CALIBRATION_RECEIPTS, { recursive: true });
    writeFileSync(join(process.env.SCREENPIPE_EVAL_CALIBRATION_RECEIPTS, cwd.split('/').pop() + '.json'), JSON.stringify({ status: r.status, signal: r.signal, error: r.error?.message, stdout: r.stdout, stderr: r.stderr }, null, 2));
  }
  return r;
}
function fails(r) {
  expect(r.error).toBeUndefined(); expect(r.signal).toBeNull(); expect(r.status).toBe(1);
  expect(r.stderr).toContain('AssertionError'); expect(r.stderr).not.toMatch(/Cannot find module|Failed to (load|resolve import)|Unhandled/);
}
function replace(s, a, b) { expect(s.split(a)).toHaveLength(2); return s.replace(a, b); }
function mutant(name, path, s) { const cwd = prepare(name); writeFileSync(join(cwd, path), s); return run(cwd); }
test('parent reaches behavior assertions: eight failures and four preserved outcomes', () => {
  const r = run(prepare('parent', item.base_ref)); fails(r); expect(r.stdout).toContain('8 failed | 4 passed');
});
test('reference passes all twelve persisted outcomes', () => {
  const r = run(prepare('reference')); expect(r.status).toBe(0); expect(r.stdout).toContain('12 passed');
});
test('unused correct helper cannot rescue old persistence', () => {
  const cwd = prepare('unused', item.base_ref); writeFileSync(join(cwd, merge), source(merge)); fails(run(cwd));
});
test('equivalent helper naming passes without a reset-test export', () => {
  const cwd = prepare('equivalent');
  writeFileSync(join(cwd, storage), source(storage).replaceAll('mergeConversations', 'reconcileSavedConversation').replaceAll('__resetConversationWriteQueuesForTests', 'unusedQueueReset'));
  writeFileSync(join(cwd, merge), source(merge).replaceAll('mergeConversations', 'reconcileSavedConversation')); expect(run(cwd).status).toBe(0);
});
test('skipping conflict reconciliation is rejected', () => fails(mutant('conflict-bypass', storage, replace(source(storage), 'disk && diskRev > baseRev ? mergeConversations(disk, conv) : conv', 'conv'))));
test('always keeping disk rejects ordinary current edits and new messages', () => fails(mutant('always-disk', storage, replace(source(storage), 'disk && diskRev > baseRev ? mergeConversations(disk, conv) : conv', 'disk ?? conv'))));
test('discarding richer streaming payload is rejected', () => fails(mutant('streaming', merge, replace(source(merge), 'function pickRicherMessage(disk: ChatMessage, incoming: ChatMessage): ChatMessage {', 'function pickRicherMessage(disk: ChatMessage, incoming: ChatMessage): ChatMessage { return incoming;'))));
test('stale scalar overwrite is rejected', () => fails(mutant('scalars', merge, replace(source(merge), '    ...fillsGaps,', '    ...incoming,'))));
test('missing persistence module remains a setup failure', () => {
  const cwd = prepare('missing'); rmSync(join(cwd, storage)); const r = run(cwd);
  expect(r.status).toBe(1); expect(r.stderr).toMatch(/Failed to (load|resolve import)|Cannot find module/); expect(r.stderr).not.toContain('AssertionError');
});
