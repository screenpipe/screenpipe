// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const repo = resolve(import.meta.dir, '../..');
const root = mkdtempSync(join(tmpdir(), 'pipe-hook-calibration-'));
const c = JSON.parse(readFileSync(join(import.meta.dir, 'cases.json'), 'utf8')).cases.find(c => c.id === 'app-pipe-write-permission-hook');
const file = c.oracle_paths[0];
afterAll(() => rmSync(root, { recursive: true, force: true }));
function grade(name, ref, mutate = source => source) {
  const dir = join(root, name);
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  const source = execFileSync('git', ['show', `${ref}:${file}`], { cwd: repo, encoding: 'utf8' });
  writeFileSync(join(dir, file), mutate(source));
  copyFileSync(join(import.meta.dir, c.grader.fixtures[0].local_path), join(dir, 'eval-pipe-write-hook.test.ts'));
  const result = spawnSync(process.execPath, ['test', 'eval-pipe-write-hook.test.ts'], {
    cwd: dir, encoding: 'utf8', timeout: 20000, env: { PATH: process.env.PATH, CI: 'true', TZ: 'UTC' },
  });
  if (process.env.EVAL_CALIBRATION_OUTPUT) {
    const out = resolve(process.env.EVAL_CALIBRATION_OUTPUT);
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, name + '.stdout'), result.stdout ?? '');
    writeFileSync(join(out, name + '.stderr'), result.stderr ?? '');
    writeFileSync(join(out, name + '.json'), JSON.stringify({ status: result.status, signal: result.signal, error: result.error?.message ?? null }));
  }
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return result;
}
function pass(result) { expect(result.status).toBe(0); expect(result.stderr).toContain('18 pass'); }
function fail(result, name) {
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('(fail) ' + name);
  expect(result.stderr).toMatch(/expect\(received\)/);
  expect(result.stderr).not.toContain('Cannot find');
}
function replace(source, from, to) { expect(source).toContain(from); return source.replace(from, to); }
const hook = 'pi.on("tool_call", async (event: any) => {';
test('broken parent fails intended hook outcomes and preserves nearby behavior', () => {
  const result = grade('parent', c.base_ref);
  fail(result, 'built-in write outside');
  expect(result.stderr).toContain('10 pass');
  expect(result.stderr).toContain('8 fail');
});
test('historical reference passes', () => pass(grade('reference', c.oracle_ref)));
test('current contract passes', () => pass(grade('current', process.env.EVAL_CURRENT_REF || 'b7493b57550a7dc6128cc820caf10eaa8f480775')));
test('renamed private checks remain equivalent', () => pass(grade('equivalent', c.oracle_ref, s => s.replaceAll('checkFilesystemWrite', 'inspectShellWrite').replaceAll('checkFileToolWrite', 'inspectFileWrite'))));
test('unused correct guard cannot repair the broken hook', () => fail(grade('unused-correct', c.base_ref, s => s + '\nfunction unusedCorrectGuard() { return { block: true }; }\n'), 'built-in write outside'));
test('deny-all shortcut loses preserved writes', () => fail(grade('deny-all', c.oracle_ref, s => replace(s, hook, hook + '\nreturn { block: true };')), 'relative file write'));
test('allow-all shortcut loses write enforcement', () => fail(grade('allow-all', c.oracle_ref, s => replace(s, hook, hook + '\nreturn;')), 'built-in write outside'));
test('blocking read tools loses preserved access', () => fail(grade('block-read', c.oracle_ref, s => replace(s, hook, hook + '\nif (event.tool === "read") return { block: true };')), 'read outside remains available'));
