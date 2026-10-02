// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { classifyGraderError } from './grader-outcome.mjs';
const repo = resolve(import.meta.dir, '../..');
const item = JSON.parse(readFileSync(join(import.meta.dir, 'cases.json'))).cases.find(c => c.id === 'ai-gateway-settlement-replay-atomicity');
const receipts = process.env.EVAL_CALIBRATION_RESULTS_DIR;
if (receipts) mkdirSync(receipts, { recursive: true });
const root = mkdtempSync(join(receipts || tmpdir(), 'settlement-calibration-')), archives = new Map();
const tracker = 'packages/ai-gateway/src/services/cost-tracker.ts', ledger = 'packages/ai-gateway/src/services/hosted-ai-settlement-ledger.ts';
afterAll(() => { if (!receipts) rmSync(root, { recursive: true, force: true }); });
function replace(cwd, path, from, to) { const text = readFileSync(join(cwd, path), 'utf8'); expect(text.split(from)).toHaveLength(2); writeFileSync(join(cwd, path), text.replace(from, to)); }
function grade(name, ref = item.oracle_ref, mutate = () => {}) {
 const cwd = join(root, name); mkdirSync(cwd);
 if (!archives.has(ref)) archives.set(ref, execFileSync('git', ['-c','core.commitGraph=false','archive',ref,'packages/ai-gateway/src'], { cwd:repo, maxBuffer:32*1024*1024 }));
 execFileSync('tar',['-x','-C',cwd],{input:archives.get(ref)}); mutate(cwd);
 writeFileSync(join(cwd,'packages/ai-gateway/src/test/eval-settlement-replay.test.ts'),readFileSync(join(import.meta.dir,'graders/settlement-replay.fixture.ts.txt')));
 symlinkSync(join(repo,'packages/ai-gateway/node_modules'),join(cwd,'packages/ai-gateway/node_modules'),'dir');
 const args=['test','src/test/eval-settlement-replay.test.ts','--timeout=10000'];
 const r=spawnSync(process.execPath,args,{cwd:join(cwd,'packages/ai-gateway'),encoding:'utf8',timeout:45000,env:{PATH:dirname(process.execPath),HOME:cwd,CI:'true'}});
 if(receipts) writeFileSync(join(receipts,name+'.json'),JSON.stringify({ref,command:[process.execPath,...args],cwd,status:r.status,signal:r.signal,error:r.error?.message,stdout:r.stdout,stderr:r.stderr,failure_kind:classifyGraderError(r)},null,2));
 return r;
}
function fails(r) { expect(r.error).toBeUndefined(); expect(r.signal).toBeNull(); expect(r.status).toBe(1); expect(r.stderr).toContain('expect(received)'); expect(classifyGraderError(r)).toBeNull(); }
function passes(r) { expect(r.status).toBe(0); expect(r.stderr).toContain('10 pass'); }
test('parent fails six intended outcomes and preserves four',()=>{const r=grade('parent',item.base_ref);fails(r);expect(r.stderr).toContain('6 fail');expect(r.stderr).toContain('4 pass');});
test('reference passes all accounting outcomes',()=>passes(grade('reference')));
test('current source passes the same outcomes',()=>passes(grade('current','HEAD')));
test('equivalent private cost conversion binding is accepted',()=>passes(grade('equivalent',item.oracle_ref,cwd=>{const path=join(cwd,ledger);writeFileSync(path,readFileSync(path,'utf8').replaceAll('costMicroCents','scaledCost'));})));
test('unused corrected accounting cannot hide the broken caller',()=>fails(grade('unused',item.base_ref,cwd=>{for(const [source,dest] of [[tracker,tracker+'.unused.ts'],[ledger,ledger]])writeFileSync(join(cwd,dest),execFileSync('git',['show',item.oracle_ref+':'+source],{cwd:repo}));})));
test('blanket success without writes is rejected',()=>fails(grade('blanket',item.oracle_ref,cwd=>replace(cwd,tracker,'export async function logCost(env: Env, entry: CostLogEntry): Promise<boolean> {','export async function logCost(env: Env, entry: CostLogEntry): Promise<boolean> { return true;'))));
test('collapsing distinct request identities is rejected',()=>fails(grade('collapsed',item.oracle_ref,cwd=>replace(cwd,tracker,'settlementId: entry.settlement_id,',"settlementId: 'constant',"))));
test('ignoring changed cost in the replay identity is rejected',()=>fails(grade('cost-collision',item.oracle_ref,cwd=>replace(cwd,ledger,'deviceId,\n\t\t\tmicroCents,','deviceId,\n\t\t\t0,'))));
test('separate writes without atomic rollback are rejected',()=>fails(grade('partial-write',item.oracle_ref,cwd=>replace(cwd,ledger,'const results = await env.DB.batch<SettlementReadback>(statements);','const results = []; for (const statement of statements) results.push(await statement.all<SettlementReadback>());'))));
test('missing entrypoint is a setup error, not a baseline regression',()=>{const r=grade('missing',item.oracle_ref,cwd=>rmSync(join(cwd,tracker)));expect(r.status).toBe(1);expect(r.stderr).toContain('0 pass');expect(classifyGraderError(r)).toBe('bun_unhandled_error');});
