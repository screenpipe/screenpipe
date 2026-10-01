// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const repo = resolve(import.meta.dir, '../..');
const item = JSON.parse(readFileSync(join(import.meta.dir, 'cases.json'))).cases.find(c => c.id === 'app-workflow-voice-immutable-response');
const root = mkdtempSync(join(tmpdir(), 'voice-response-calibration-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const fixture = readFileSync(join(import.meta.dir, 'graders/workflow-voice-response.fixture.ts.txt'));
function replaceOne(text, before, after) {
 expect(text.split(before)).toHaveLength(2);
 return text.replace(before, after);
}
function grade(name) {
 const cwd = join(root, name); mkdirSync(cwd);
 const ref = ['parent', 'unused', 'oracle-only'].includes(name) ? item.base_ref : item.oracle_ref;
 execFileSync('tar', ['-x', '-C', cwd], { input: execFileSync('git', ['archive', ref, 'packages/ai-gateway', 'crates/screenpipe-core/assets/extensions/lib'], { cwd: repo, maxBuffer: 32 * 1024 * 1024 }) });
 const src = join(cwd, 'packages/ai-gateway/src'), index = join(src, 'index.ts');
 if (name === 'unused' || name === 'oracle-only') writeFileSync(name === 'unused' ? index + '.unused.ts' : index, execFileSync('git', ['show', `${item.oracle_ref}:packages/ai-gateway/src/index.ts`], { cwd: repo }));
 let text = readFileSync(index, 'utf8');
 const response = 'const response = new Response(upstream.body, upstream);';
 if (name === 'equivalent') text = replaceOne(text, response, 'const response = new Response(upstream.body, { headers: new Headers(upstream.headers), status: upstream.status, statusText: upstream.statusText });');
 if (name === 'status-loss') text = replaceOne(text, response, 'const response = new Response(upstream.body, { headers: upstream.headers });');
 if (name === 'body-loss') text = replaceOne(text, response, 'const response = new Response(null, upstream);');
 if (name === 'cache-loss') text = replaceOne(text, "response.headers.set('Cache-Control', 'no-store');", "response.headers.set('Cache-Control', 'public');");
 if (name === 'cors-loss') text = replaceOne(text, "response.headers.set('Cache-Control', 'no-store');\n\t\t\treturn addCorsHeaders(response);", "response.headers.set('Cache-Control', 'no-store');\n\t\t\treturn response;");
 writeFileSync(index, text);
 if (name === 'missing') rmSync(index);
 writeFileSync(join(src, 'test/eval-workflow-voice-response.test.ts'), fixture);
 symlinkSync(join(repo, 'packages/ai-gateway/node_modules'), join(cwd, 'packages/ai-gateway/node_modules'), 'dir');
 const result = spawnSync(process.execPath, ['test', 'src/test/eval-workflow-voice-response.test.ts', '--timeout', '45000'], { cwd: join(cwd, 'packages/ai-gateway'), encoding: 'utf8', timeout: 60000, env: { PATH: `${dirname(process.execPath)}:${process.env.PATH || ''}`, HOME: cwd, CI: 'true', WRANGLER_SEND_METRICS: 'false' } });
 if (process.env.EVAL_CALIBRATION_RESULTS) {
  const out = resolve(process.env.EVAL_CALIBRATION_RESULTS); mkdirSync(out, { recursive: true });
  for (const ext of ['stdout', 'stderr']) writeFileSync(join(out, name + '.' + ext), result[ext] || '');
  writeFileSync(join(out, name + '.json'), JSON.stringify({ status: result.status, signal: result.signal, error: result.error?.message || null }) + '\n');
 }
 return result;
}
function fails(result) {
 expect(result.error).toBeUndefined(); expect(result.signal).toBeNull(); expect(result.status).toBe(1);
 expect(result.stderr).toContain('expect(received)'); expect(result.stderr).not.toContain('failed to bundle');
 expect(result.stderr).toContain('1 fail'); expect(result.stderr).toContain('1 pass');
}
function passes(result) { expect(result.status).toBe(0); expect(result.stderr).toContain('2 pass'); }
test('parent fails forwarding and preserves service-only refusal', () => fails(grade('parent')), 60000);
test('historical reference passes', () => passes(grade('reference')), 60000);
test('manifest oracle path is sufficient', () => passes(grade('oracle-only')), 60000);
test('unused correct code does not repair dispatch', () => fails(grade('unused')), 60000);
test('equivalent response reconstruction passes', () => passes(grade('equivalent')), 60000);
test('lost status is rejected', () => fails(grade('status-loss')), 60000);
test('lost body is rejected', () => fails(grade('body-loss')), 60000);
test('lost cache policy is rejected', () => fails(grade('cache-loss')), 60000);
test('lost CORS is rejected', () => fails(grade('cors-loss')), 60000);
test('missing source remains infrastructure failure', () => { const r = grade('missing'); expect(r.status).not.toBe(0); expect(r.stderr).toContain('failed to bundle'); expect(r.stderr).not.toContain('expect(received)'); }, 60000);
