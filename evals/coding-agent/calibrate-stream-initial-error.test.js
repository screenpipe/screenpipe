// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { classifyGraderError } from './grader-outcome.mjs';
const repo = resolve(import.meta.dir, '../..'), source = 'packages/ai-gateway/src/providers/openai.ts';
const fixture = 'evals/coding-agent/graders/gateway-stream-initial-error.test.js';
const item = JSON.parse(readFileSync(join(import.meta.dir, 'cases.json'), 'utf8')).cases.find(c => c.id === 'ai-gateway-lazy-stream-initial-error');
const receipts = process.env.EVAL_CALIBRATION_RESULTS_DIR;
if (receipts) mkdirSync(receipts, { recursive: true });
const root = mkdtempSync(join(receipts || tmpdir(), 'stream-initial-calibration-')), archives = new Map();
afterAll(() => { if (!receipts) rmSync(root, { recursive: true, force: true }); });
function grade(name, ref = item.oracle_ref, mutate = () => {}) {
  const cwd = join(root, name); mkdirSync(cwd);
  if (!archives.has(ref)) archives.set(ref, execFileSync('git', ['-c', 'core.commitGraph=false', 'archive', ref, 'packages/ai-gateway'], { cwd: repo, maxBuffer: 32 * 1024 * 1024 }));
  execFileSync('tar', ['-x', '-C', cwd], { input: archives.get(ref) });
  mkdirSync(dirname(join(cwd, fixture)), { recursive: true }); writeFileSync(join(cwd, fixture), readFileSync(join(repo, fixture))); mutate(cwd);
  const r = spawnSync(process.execPath, ['test', fixture], { cwd, encoding: 'utf8', timeout: 20_000, env: { PATH: dirname(process.execPath) } });
  if (receipts) writeFileSync(join(receipts, name + '.json'), JSON.stringify({ ref, command: [process.execPath, 'test', fixture], cwd, status: r.status, signal: r.signal, error: r.error?.message, stdout: r.stdout, stderr: r.stderr, failure_kind: classifyGraderError(r) }, null, 2));
  return r;
}
function change(cwd, from, to) { const path = join(cwd, source), text = readFileSync(path, 'utf8'); expect(text.split(from)).toHaveLength(2); writeFileSync(path, text.replace(from, to)); }
function fails(r) { expect(r.error).toBeUndefined(); expect(r.signal).toBeNull(); expect(r.status).toBe(1); expect(r.stderr).toContain('expect(received)'); expect(classifyGraderError(r)).toBeNull(); }
test('parent fails two intended lazy errors and preserves five neighbors', () => { const r = grade('parent', item.base_ref); fails(r); expect(r.stderr).toContain('2 fail'); expect(r.stderr).toContain('5 pass'); });
test('reference passes all seven outcomes', () => { const r = grade('reference'); expect(r.status).toBe(0); expect(r.stderr).toContain('7 pass'); });
test('current source passes the same outcomes', () => { const r = grade('current', 'HEAD'); expect(r.status).toBe(0); expect(r.stderr).toContain('7 pass'); });
test('equivalent private iterator names are accepted', () => { const r = grade('equivalent', item.oracle_ref, cwd => { const path = join(cwd, source); writeFileSync(path, readFileSync(path, 'utf8').replace(/\bfirstChunk\b/g, 'initialResult').replace(/\bprimedStream\b/g, 'forwardedStream')); }); expect(r.status).toBe(0); });
test('unused correct provider cannot hide unchanged broken dispatch', () => { const r = grade('unused-correct', item.base_ref, cwd => writeFileSync(join(cwd, 'packages/ai-gateway/src/providers/unused-correct.ts'), execFileSync('git', ['show', item.oracle_ref + ':' + source], { cwd: repo }))); fails(r); expect(r.stderr).toContain('2 fail'); });
test('dropping the first chunk is rejected', () => fails(grade('lost-first', item.oracle_ref, cwd => change(cwd, 'if (!firstChunk.done) yield firstChunk.value;', 'if (!firstChunk.done) { /* dropped */ }'))));
test('duplicating the first chunk is rejected', () => fails(grade('duplicate-first', item.oracle_ref, cwd => change(cwd, 'if (!firstChunk.done) yield firstChunk.value;', 'if (!firstChunk.done) { yield firstChunk.value; yield firstChunk.value; }'))));
test('fabricating a later error status is rejected', () => fails(grade('wrong-midstream-status', item.oracle_ref, cwd => change(cwd, "const errorStatus = error?.status || 500;", 'const errorStatus = 200;'))));
test('missing provider is a setup failure with zero executed tests', () => { const r = grade('missing-source', item.oracle_ref, cwd => rmSync(join(cwd, source))); expect(r.status).toBe(1); expect(r.stderr).toContain('0 pass'); expect(classifyGraderError(r)).toBe('bun_unhandled_error'); });
