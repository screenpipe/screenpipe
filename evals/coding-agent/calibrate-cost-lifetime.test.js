// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const repo = resolve(import.meta.dir, '../..');
const item = JSON.parse(readFileSync(join(import.meta.dir, 'cases.json'))).cases.find(c => c.id === 'app-gateway-response-lifetime-cost-settlement');
const root = mkdtempSync(join(tmpdir(), 'cost-lifetime-calibration-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const fixture = readFileSync(join(import.meta.dir, 'graders/cost-lifetime.fixture.ts.txt'));
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
 if (name === 'stream-detached') text = replaceOne(text, 'ctx.waitUntil(usagePromise.then(u => logCost(env, {', 'void (usagePromise.then(u => logCost(env, {');
 if (name === 'json-detached') text = replaceOne(text, 'ctx.waitUntil(settleActualOrReservedCost(', 'void (settleActualOrReservedCost(');
 if (name === 'synchronous-json') {
  text = replaceOne(text, 'ctx.waitUntil(settleActualOrReservedCost(', 'await settleActualOrReservedCost(');
  text = replaceOne(text, '\t\t\t\t\t));\n\t\t\t\t}\n\n\t\t\t\treturn attachLeaseRelease(response);', '\t\t\t\t\t);\n\t\t\t\t}\n\n\t\t\t\treturn attachLeaseRelease(response);');
 }
 if (name === 'equivalent-background') text = text.replaceAll('ctx.waitUntil(', '((task: Promise<unknown>) => ctx.waitUntil(Promise.resolve().then(() => task)))(');
 writeFileSync(index, text);
 const cost = join(src, 'services/cost-tracker.ts');
 if (name === 'cached-loss') writeFileSync(cost, replaceOne(readFileSync(cost, 'utf8'), 'nonNegativeNumber(entry.output_tokens),\n        nonNegativeNumber(entry.cache_read_tokens),', 'nonNegativeNumber(entry.output_tokens),\n        0,'));
 if (name === 'no-ledger') writeFileSync(cost, replaceOne(readFileSync(cost, 'utf8'), 'await env.DB.prepare(\n      `INSERT INTO cost_daily', 'await Promise.resolve(); return accumulatorRecorded;\n    await env.DB.prepare(\n      `INSERT INTO cost_daily'));
 if (name === 'sql-column-order') {
  let sql = replaceOne(readFileSync(cost, 'utf8'), 'requests, input_tokens, output_tokens, cache_read_tokens,', 'requests, output_tokens, input_tokens, cache_read_tokens,');
  sql = replaceOne(sql, 'nonNegativeNumber(entry.input_tokens),\n        nonNegativeNumber(entry.output_tokens),', 'nonNegativeNumber(entry.output_tokens),\n        nonNegativeNumber(entry.input_tokens),');
  writeFileSync(cost, sql);
 }
 if (name === 'missing') rmSync(index);
 writeFileSync(join(src, 'test/eval-cost-lifetime.test.ts'), fixture);
 symlinkSync(join(repo, 'packages/ai-gateway/node_modules'), join(cwd, 'packages/ai-gateway/node_modules'), 'dir');
 const result = spawnSync(process.execPath, ['test', 'src/test/eval-cost-lifetime.test.ts'], { cwd: join(cwd, 'packages/ai-gateway'), encoding: 'utf8', timeout: 15000, env: { PATH: dirname(process.execPath), HOME: cwd, CI: 'true' } });
 if (process.env.EVAL_CALIBRATION_RESULTS) {
  const out = resolve(process.env.EVAL_CALIBRATION_RESULTS); mkdirSync(out, { recursive: true });
  for (const ext of ['stdout', 'stderr']) writeFileSync(join(out, name + '.' + ext), result[ext] || '');
  writeFileSync(join(out, name + '.json'), JSON.stringify({ status: result.status, signal: result.signal, error: result.error?.message || null }) + '\n');
 }
 return result;
}
function fails(result, count = 2) {
 expect(result.error).toBeUndefined(); expect(result.signal).toBeNull(); expect(result.status).toBe(1);
 expect(result.stderr).toContain('expect(received)'); expect(result.stderr).not.toContain('Cannot find module');
 expect(result.stderr).toContain(`${count} fail`); expect(result.stderr).toContain(`${5 - count} pass`);
}
function passes(result) { expect(result.status).toBe(0); expect(result.stderr).toContain('5 pass'); }
test('parent loses both deferred writes and preserves three outcomes', () => fails(grade('parent')));
test('historical reference passes', () => passes(grade('reference')));
test('only the manifest oracle path is sufficient', () => passes(grade('oracle-only')));
test('unused fixed handler does not repair dispatch', () => fails(grade('unused')));
test('detached streaming accounting is rejected', () => fails(grade('stream-detached'), 1));
test('detached JSON accounting is rejected', () => fails(grade('json-detached'), 1));
test('cached-input loss is rejected', () => fails(grade('cached-loss')));
test('removing the actual daily write is rejected', () => fails(grade('no-ledger')));
test('synchronous JSON accounting is accepted', () => passes(grade('synchronous-json')));
test('equivalent background scheduling is accepted', () => passes(grade('equivalent-background')));
test('missing handler is a setup failure', () => { const r = grade('missing'); expect(r.status).not.toBe(0); expect(r.stderr).toContain('Cannot find module'); expect(r.stderr).not.toContain('expect(received)'); });

test('equivalent SQL column and binding order is accepted', () => passes(grade('sql-column-order')));
