// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('Git fixtures and binary oracle patches preserve exact bytes and provenance', () => {
  const repo = mkdtempSync(join(tmpdir(), 'eval-binary-fixtures-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const binary = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
  const text = Buffer.from('Synthetic text: café 日本語\n');
  const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  try {
    git('init', '-q'); git('config', 'user.name', 'Synthetic eval control');
    git('config', 'user.email', 'fixture@example.invalid'); git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'state.bin'), Buffer.from([0]));
    writeFileSync(join(repo, 'source.bin'), Buffer.from([1]));
    writeFileSync(join(repo, 'source.txt'), text);
    writeFileSync(join(repo, 'empty.bin'), Buffer.alloc(0));
    writeFileSync(join(repo, 'executable.sh'), '#!/bin/sh\nexit 0\n');
    git('add', 'state.bin', 'source.bin', 'source.txt', 'empty.bin', 'executable.sh');
    git('commit', '-qm', 'Synthetic broken state'); const base = git('rev-parse', 'HEAD');
    writeFileSync(join(repo, 'state.bin'), binary); writeFileSync(join(repo, 'source.bin'), binary);
    git('commit', '-qam', 'Synthetic fixed state'); const fix = git('rev-parse', 'HEAD');
    writeFileSync(join(repo, 'local.bin'), binary);
    writeFileSync(join(repo, 'grade.mjs'), `
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
const expected = Buffer.from(Array.from({length:256}, (_,i)=>i));
for (const path of ['git.bin','explicit.bin','local.bin']) assert.deepEqual(readFileSync(path), expected, path);
assert.equal(readFileSync('text.txt','utf8'), ${JSON.stringify(text.toString())});
assert.equal(readFileSync('empty.out').length, 0);
assert.ok(statSync('executable.out').mode & 0o111);
assert.deepEqual(readFileSync('state.bin'), expected, 'intended synthetic product state');
`);
    const fixtures = [
      { source_path: 'source.bin', destination_path: 'git.bin' },
      { source_ref: fix, source_path: 'source.bin', destination_path: 'explicit.bin' },
      { local_path: 'local.bin', destination_path: 'local.bin' },
      { source_path: 'source.txt', destination_path: 'text.txt' },
      { source_path: 'empty.bin', destination_path: 'empty.out' },
      { source_path: 'executable.sh', destination_path: 'executable.out', executable: true },
      { local_path: 'grade.mjs', destination_path: 'grade.mjs' },
    ];
    const manifest = join(repo, 'cases.json');
    writeFileSync(manifest, JSON.stringify({ schema_version: 1, suite: 'synthetic-binary-fixtures', dataset_version: '1', cases: [{
      id: 'binary-fixtures', name: 'Synthetic byte-preservation control', base_ref: base, oracle_ref: fix,
      oracle_paths: ['state.bin'], source: { kind: 'git_regression', fix_commit: fix },
      prompt: 'Synthetic runner calibration. No model or live service.',
      grader: { command: 'exec node grade.mjs', timeout_seconds: 5, fixtures },
    }] }));
    const output = join(repo, 'results');
    const result = spawnSync('node', [new URL('./run.mjs', import.meta.url).pathname, '--repo', repo,
      '--manifest', manifest, '--verify', '--results-dir', output], { encoding: 'utf8', timeout: 20000 });
    expect(result.error).toBeUndefined();
    const [verification] = JSON.parse(readFileSync(join(output, 'verification.json'), 'utf8'));
    expect(result.status).toBe(0);
    expect(verification.valid).toBe(true);
    expect(verification.baseline.outcome).toBe('fail');
    expect(verification.oracle.outcome).toBe('pass');
    expect(readFileSync(join(output, 'baseline/binary-fixtures/trial-1/grader.stderr.log'), 'utf8')).toContain('intended synthetic product state');
    for (const trial of [verification.baseline, verification.oracle]) {
      expect(trial.harness_error).toBeUndefined(); expect(trial.grader_error_kind).toBeNull();
      for (const destination of ['git.bin', 'explicit.bin', 'local.bin']) {
        expect(trial.grader_provenance.fixtures.find((f: any) => f.destination_path === destination).sha256).toBe(hash(binary));
      }
      for (const f of trial.grader_provenance.fixtures.filter((f: any) => f.source_path)) expect(f.source_commit).toBe(fix);
      expect(trial.grader_provenance.fixtures.find((f: any) => f.destination_path === 'text.txt').sha256).toBe(hash(text));
      expect(trial.grader_provenance.fixtures.find((f: any) => f.destination_path === 'empty.out').sha256).toBe(hash(Buffer.alloc(0)));
    }
    expect(verification.baseline.grader_provenance.fingerprint).toBe(verification.oracle.grader_provenance.fingerprint);
  } finally { rmSync(repo, { recursive: true, force: true }); }
}, 30000);
