// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { classifyGraderError } from './grader-outcome.mjs';

const repo = resolve(import.meta.dir, '../..');
const prefix = 'apps/screenpipe-app-tauri/';
const item = JSON.parse(readFileSync(join(import.meta.dir, 'cases.json'), 'utf8'))
  .cases.find(c => c.id === 'app-chat-repeat-prompt-identity');
const paths = ['tsconfig.json', 'lib/stores/chat-store.ts', 'lib/chat-dedup.ts',
  'lib/utils/chat-title.ts', 'lib/chat/ephemeral-side-conversation.ts'];
function sources(ref) {
  const available = new Set(execFileSync('git', ['ls-tree', '-r', '--name-only', ref, prefix],
    { cwd: repo, encoding: 'utf8' }).trim().split('\n'));
  return Object.fromEntries(paths.filter(p => available.has(prefix + p)).map(p =>
    [p, execFileSync('git', ['show', `${ref}:${prefix}${p}`], { cwd: repo, encoding: 'utf8' })]));
}
const broken = sources(item.base_ref), fixed = sources(item.oracle_ref);
const current = sources('HEAD');
const fixture = readFileSync(join(import.meta.dir, 'graders/chat-repeat-identity.fixture.ts.txt'));
const root = mkdtempSync(join(tmpdir(), 'chat-repeat-identity-calibration-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const logRoot = process.env.EVAL_CALIBRATION_RESULTS_DIR;
function grade(name, files) {
  const cwd = join(root, name);
  for (const [path, source] of Object.entries(files)) {
    const file = join(cwd, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, source);
  }
  symlinkSync(join(repo, prefix, 'node_modules'), join(cwd, 'node_modules'), 'dir');
  writeFileSync(join(cwd, 'eval-chat-repeat-identity.test.ts'), fixture);
  const args = ['--no-env-file', 'test', 'eval-chat-repeat-identity.test.ts'];
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 30_000,
    env: { PATH: dirname(process.execPath) } });
  if (logRoot) {
    mkdirSync(logRoot, { recursive: true });
    writeFileSync(join(logRoot, `${name}.stdout`), result.stdout ?? '');
    writeFileSync(join(logRoot, `${name}.stderr`), result.stderr ?? '');
    writeFileSync(join(logRoot, `${name}.json`), JSON.stringify({ command: [process.execPath, ...args],
      cwd, exit_code: result.status, signal: result.signal, error: result.error?.message ?? null,
      grader_error_kind: classifyGraderError(result) }, null, 2) + '\n');
  }
  return result;
}
function passes(r) {
  expect(r.error).toBeUndefined();
  expect(r.signal).toBeNull();
  expect(r.status).toBe(0);
  expect(r.stderr).toContain('12 pass');
}
function fails(r, count) {
  expect(r.error).toBeUndefined();
  expect(r.signal).toBeNull();
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('expect(received).toEqual(expected)');
  expect(r.stderr).toContain(`${count} fail`);
  expect(r.stderr).toContain(`${12 - count} pass`);
  expect(classifyGraderError(r)).toBeNull();
}
function replace(files, path, old, next) {
  expect(files[path].split(old)).toHaveLength(2);
  return { ...files, [path]: files[path].replace(old, next) };
}
const store = 'lib/stores/chat-store.ts', dedup = 'lib/chat-dedup.ts';
test('parent fails five identity outcomes and preserves seven neighbors', () => fails(grade('parent', broken), 5));
test('reference passes all outcomes', () => passes(grade('reference', fixed)));
test('current source preserves the scoped contract', () => passes(grade('current', current)));
test('equivalent identity encoding is accepted', () => passes(grade('equivalent', replace(fixed, dedup,
  'return JSON.stringify([semanticKey, messageId, messageTimestamp]);',
  'return JSON.stringify({ text: semanticKey, id: messageId, time: messageTimestamp });'))));
test('unused corrected helper cannot hide the broken selector', () => fails(grade('unused-helper',
  { ...broken, [dedup]: fixed[dedup] }), 5));
test('blanket duplicate suppression removal is rejected', () => fails(grade('no-dedup', replace(fixed, store,
  'const all = dedupeSessionRecords(Object.values(state.sessions));',
  'const all = Object.values(state.sessions);')), 3));
test('a hidden copy cannot replace the visible survivor', () => fails(grade('hidden-wins', replace(fixed, store,
  'if (!!a.hidden !== !!b.hidden) return !a.hidden;',
  'if (!!a.hidden !== !!b.hidden) return !!a.hidden;')), 1));
test('timestamp alone is insufficient identity', () => fails(grade('timestamp-only', replace(fixed, dedup,
  'return JSON.stringify([semanticKey, messageId, messageTimestamp]);',
  'return JSON.stringify([semanticKey, messageTimestamp]);')), 1));
test('message id alone is insufficient identity', () => fails(grade('id-only', replace(fixed, dedup,
  'return JSON.stringify([semanticKey, messageId, messageTimestamp]);',
  'return JSON.stringify([semanticKey, messageId]);')), 1));
test('empty output cannot hide the regression', () => fails(grade('empty-output', replace(fixed, store,
  'const all = dedupeSessionRecords(Object.values(state.sessions));', 'const all = [];')), 12));
test('missing actual selector is an infrastructure error', () => {
  const files = { ...fixed };
  delete files[store];
  const r = grade('missing-source', files);
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('Cannot find module');
  expect(r.stderr).toContain('0 pass');
  expect(classifyGraderError(r)).toBe('bun_unhandled_error');
});
