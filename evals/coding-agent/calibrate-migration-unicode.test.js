// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { classifyGraderError } from './grader-outcome.mjs';
const repo = resolve(import.meta.dir, '../..');
const item = JSON.parse(readFileSync(join(import.meta.dir, 'cases.json'))).cases.find(c => c.id === 'app-migration-unicode-search-probe');
const source = 'crates/screenpipe-db/src/storage/lifecycle.rs';
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
const parent = git('show', `${item.base_ref}:${source}`);
const fixed = git('show', `${item.oracle_ref}:${source}`);
const fixture = readFileSync(join(import.meta.dir, 'graders/migration-unicode.rs'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function replace(text, from, to) { expect(text.split(from)).toHaveLength(2); return text.replace(from, to); }
function term(body) {
  const start = fixed.indexOf('fn migration_search_term(text: &str) -> Option<String> {');
  const end = fixed.indexOf('\nasync fn resume_legacy_migration(', start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  return fixed.slice(0, start) + `fn migration_search_term(text: &str) -> Option<String> { ${body} }\n` + fixed.slice(end);
}
test('calibrate actual migration outcomes with equivalent and broken implementations', () => {
  const root = mkdtempSync(join(tmpdir(), 'migration-unicode-calibration-'));
  try {
    const archive = execFileSync('git', ['archive', item.base_ref, 'Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', '.cargo', 'crates', 'LICENSE.md'], { cwd: repo, maxBuffer: 128 * 1024 * 1024 });
    execFileSync('tar', ['-x', '-C', root], { input: archive });
    writeFileSync(join(root, 'crates/screenpipe-db/tests/eval_migration_unicode.rs'), fixture);
    const controls = [
      ['parent', parent, 'fail'],
      ['reference', fixed, 'pass'],
      ['equivalent', term('text.split(|c: char| !c.is_alphanumeric()).find(|word| word.len() > 2).map(|word| format!("\\\"{word}\\\""))'), 'pass'],
      ['unused', parent, 'fail'],
      ['skip-search', term('let _ = text; None'), 'fail'],
      ['lost-payloads', replace(fixed, 'let frozen = source.begin_immediate_with_retry().await?;\n            verify_integrity', 'source.execute_raw_sql_write("UPDATE frames SET full_text = \'\'").await?;\n            let frozen = source.begin_immediate_with_retry().await?;\n            verify_integrity'), 'fail'],
      ['blanket-success', replace(fixed, 'migrate_with_progress(root, config, options, |_| {}).await', 'let _ = (root, config, options); Ok(serde_json::from_value(serde_json::json!({"database_id":"synthetic","generation":"synthetic","frames":2,"tables":[],"source_bytes":0,"index_bytes":0,"payload_bytes":0})).unwrap())'), 'fail'],
      ['missing', null, 'error'],
    ];
    for (const [name, body, expected] of controls) {
      if (body === null) rmSync(join(root, source)); else writeFileSync(join(root, source), body);
      const unused = join(root, 'unused-correct.rs');
      if (name === 'unused') writeFileSync(unused, fixed); else rmSync(unused, { force: true });
      // Only grader calibration reuses this ordinary local target directory.
      // Each test creates independent temporary databases. No cache links or agent run.
      const result = spawnSync('/bin/bash', ['-c', item.grader.command], { cwd: root, encoding: 'utf8', timeout: item.grader.timeout_seconds * 1000, maxBuffer: 8 * 1024 * 1024 });
      const errorKind = classifyGraderError(result);
      const observed = result.error || result.signal || errorKind ? 'error' : result.status === 0 ? 'pass' : 'fail';
      if (process.env.SCREENPIPE_EVAL_CALIBRATION_RECEIPTS) {
        const dir = resolve(process.env.SCREENPIPE_EVAL_CALIBRATION_RECEIPTS); mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${name}.json`), JSON.stringify({ command: item.grader.command, expected, observed, status: result.status, signal: result.signal, error: result.error?.message ?? null, error_kind: errorKind, source_sha256: body === null ? null : hash(body), fixture_sha256: hash(fixture), stdout: result.stdout, stderr: result.stderr }, null, 2));
      }
      expect(result.error).toBeUndefined(); expect(result.signal).toBeNull(); expect(observed).toBe(expected);
      if (expected === 'pass') expect(result.stdout).toContain('7 passed; 0 failed');
      if (expected === 'fail') { expect(result.status).toBe(101); expect(result.stdout).toContain('test result: FAILED.'); }
      if (name === 'parent') { expect(result.stdout).toContain('4 passed; 3 failed'); expect(result.stdout).toContain('unterminated string'); }
      if (name === 'skip-search') expect(result.stdout).toContain('genuine_missing_index_is_refused_without_discarding_history ... FAILED');
      if (name === 'missing') expect(errorKind).toBe('rust_compile_error');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 1_500_000);
