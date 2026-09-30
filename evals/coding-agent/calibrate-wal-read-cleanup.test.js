// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { classifyGraderError } from './grader-outcome.mjs';

const repo = resolve(import.meta.dir, '../..');
const item = JSON.parse(readFileSync(join(import.meta.dir, 'cases.json'))).cases.find(c => c.id === 'app-abandoned-read-wal-cleanup');
const root = mkdtempSync(join(tmpdir(), 'wal-read-calibration-'));
const source = 'crates/screenpipe-db/src/cancellable_query.rs';
const archive = execFileSync('git', ['archive', item.base_ref, 'Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', '.cargo', 'crates', 'LICENSE.md'], { cwd: repo, maxBuffer: 128 * 1024 * 1024 });
const parent = execFileSync('git', ['show', `${item.base_ref}:${source}`], { cwd: repo, encoding: 'utf8' });
const fixed = execFileSync('git', ['show', `${item.oracle_ref}:${source}`], { cwd: repo, encoding: 'utf8' });
afterAll(() => rmSync(root, { recursive: true, force: true }));

function replace(text, from, to) {
  expect(text.split(from)).toHaveLength(2);
  return text.replace(from, to);
}
function grade(name, text = fixed, extra = () => {}) {
  const cwd = join(root, name); mkdirSync(cwd);
  execFileSync('tar', ['-x', '-C', cwd], { input: archive });
  writeFileSync(join(cwd, source), text);
  mkdirSync(join(cwd, 'crates/screenpipe-db/tests'), { recursive: true });
  writeFileSync(join(cwd, 'crates/screenpipe-db/tests/eval_wal_read_cleanup.rs'), readFileSync(join(import.meta.dir, 'graders/wal-read-cleanup.rs')));
  symlinkSync(join(repo, 'target'), join(cwd, 'target'), 'dir');
  extra(cwd);
  const result = spawnSync('/bin/bash', ['-c', item.grader.command], { cwd, encoding: 'utf8', timeout: 600_000, maxBuffer: 8 * 1024 * 1024 });
  // Leave immutable per-control receipts when explicitly requested by the curator.
  if (process.env.SCREENPIPE_EVAL_CALIBRATION_RECEIPTS) {
    const directory = resolve(process.env.SCREENPIPE_EVAL_CALIBRATION_RECEIPTS); mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${name}.json`), JSON.stringify({ command: item.grader.command, status: result.status, signal: result.signal, error: result.error?.message ?? null, stdout: result.stdout, stderr: result.stderr }, null, 2));
  }
  return result;
}
function pass(result) {
  expect(result.error).toBeUndefined(); expect(result.signal).toBeNull();
  expect(result.status).toBe(0); expect(result.stdout).toContain('6 passed; 0 failed');
}
function fail(result) {
  expect(result.error).toBeUndefined(); expect(result.signal).toBeNull();
  expect(result.status).toBe(101); expect(classifyGraderError(result)).toBeNull();
  expect(result.stdout).toContain('test result: FAILED.');
}
test('parent leaks three snapshots and preserves three neighbors', () => {
  const result = grade('parent', parent); fail(result);
  expect(result.stdout).toContain('3 passed; 3 failed');
  expect(result.stdout).toContain('abandoned reader must release its WAL snapshot');
}, 600_000);
test('reference preserves all six outcomes', () => pass(grade('reference')), 600_000);
test('unused correct implementation cannot mask the actual broken guard', () => {
  fail(grade('unused', parent, cwd => writeFileSync(join(cwd, 'unused-correct.rs'), fixed)));
}, 600_000);
test('equivalent transaction cleanup condition is accepted', () => {
  pass(grade('equivalent', replace(fixed, 'if in_transaction {', 'if !(!in_transaction) {')));
}, 600_000);
test('retiring the connection instead of rolling back is accepted', () => {
  const start = fixed.indexOf('async fn clean_and_return_connection(');
  const end = fixed.indexOf('\n#[cfg(test)]', start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  pass(grade('retire-connection', fixed.slice(0, start) +
    'async fn clean_and_return_connection(connection: PoolConnection<Sqlite>) -> Result<(), sqlx::Error> { connection.close().await }\n' + fixed.slice(end)));
}, 600_000);
test('unconditional rollback breaks ordinary release and is rejected', () => {
  fail(grade('unconditional', replace(fixed, 'if in_transaction {', 'if true {')));
}, 600_000);
test('lost progress-handler cleanup is rejected by preserved behavior', () => {
  fail(grade('stale-handler', replace(fixed, 'handle.remove_progress_handler();', '/* mutation: retain the cancelled handler */')));
}, 600_000);
test('missing implementation is a compile error, never regression evidence', () => {
  const result = grade('missing', fixed, cwd => rmSync(join(cwd, source)));
  expect(result.status).toBe(101); expect(classifyGraderError(result)).toBe('rust_compile_error');
  expect(result.stdout).not.toContain('test result: FAILED.');
}, 600_000);
