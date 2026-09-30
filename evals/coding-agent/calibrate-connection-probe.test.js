// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
const repo = resolve(import.meta.dir, '../..'), app = 'apps/screenpipe-app-tauri';
const item = JSON.parse(readFileSync(join(import.meta.dir, 'cases.json'), 'utf8')).cases.find(c => c.id === 'app-connection-probe-response');
const hook = `${app}/lib/utils/ai-preset-connection.ts`;
const body = `${app}/lib/utils/chat-test-body.ts`;
const root = mkdtempSync(join(tmpdir(), 'connection-probe-calibration-')), archives = new Map();
const paths = [`${app}/lib`];
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
  for (const link of item.grader_dependency_links) symlinkSync(join(repo, link.source_path), join(cwd, link.destination_path), 'dir');
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
function passes(r) { expect(r.status).toBe(0); expect(r.stdout).toContain('16 passed'); expect(r.stdout + r.stderr).not.toMatch(/Unhandled|Uncaught/); }
function fails(r) { expect(r.status).toBe(1); expect(r.stderr).toMatch(/AssertionError|wrong provider identity/); expect(r.stdout + r.stderr).not.toMatch(/Unhandled|Uncaught|Failed to resolve import|Failed to load url|Cannot find module/); }
test('parent fails five response outcomes and preserves eleven', () => { const r = grade('parent', item.base_ref); fails(r); expect(r.stdout).toContain('5 failed | 11 passed'); }, 60000);
test('reference passes all response outcomes', () => passes(grade('reference')), 60000);
test('current source passes all response outcomes', () => passes(grade('current', '4c638a9cf2a028133a67231393c9b40baf4211bc')), 60000);
test('unused correct source cannot hide the broken public service', () => fails(grade('unused', item.oracle_ref, cwd => {
  writeFileSync(join(cwd, `${app}/lib/utils/unused-correct.ts`), readFileSync(join(cwd, hook)));
  for (const path of [hook, body]) writeFileSync(join(cwd, path), execFileSync('git', ['show', `${item.base_ref}:${path}`], { cwd: repo }));
})), 60000);
test('an alternative SSE parser passes without requesting non-streaming', () => passes(grade('sse-alternative', item.base_ref, cwd => {
  change(cwd, 'const data = await response.json();', String.raw`const wire = await response.text();
  let data;
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    let text = '';
    for (const line of wire.split('\n')) {
      if (!line.startsWith('data: ') || line.slice(6).trim() === '[DONE]') continue;
      const event = JSON.parse(line.slice(6));
      text += isAnthropic ? (event.delta?.text || '') : (event.choices?.[0]?.delta?.content || '');
    }
    data = isAnthropic ? {content: [{text}]} : {choices: [{message: {content: text}}]};
  } else data = JSON.parse(wire);`);
})), 60000);
test('losing response compatibility on token retry fails', () => fails(grade('retry-loss', item.oracle_ref, cwd => change(cwd, '      response = await request(endpoint, {', '      (body as any).stream = true; response = await request(endpoint, {'))), 60000);
test('losing Anthropic response compatibility fails', () => fails(grade('anthropic-loss', item.oracle_ref, cwd => change(cwd, 'stream: false,', 'stream: true,'))), 60000);
test('constant successful replies fail', () => fails(grade('constant', item.oracle_ref, cwd => change(cwd, '    reply,', '    reply: "hi",'))), 60000);
test('dropping provider credentials fails', () => fails(grade('identity-loss', item.oracle_ref, cwd => change(cwd, 'return headers;', 'return {"Content-Type": "application/json"};'))), 60000);
test('missing public service stays a setup error', () => {
  const r = grade('missing', item.oracle_ref, cwd => rmSync(join(cwd, hook)));
  expect(r.status).toBe(1); expect(r.stdout).toContain('no tests'); expect(r.stdout + r.stderr).toMatch(/Failed to resolve import|Failed to load url/);
}, 60000);
