// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const repo=resolve(import.meta.dir,'../..'),source='crates/screenpipe-core/assets/extensions/lib/tinfoil-transport.ts',protocol='crates/screenpipe-core/assets/extensions/lib/glm-protocol.ts';
const item=JSON.parse(readFileSync(join(import.meta.dir,'cases.json'),'utf8')).cases.find(c=>c.id==='app-private-reasoning-budget');
const show=(ref,path)=>execFileSync('git',['-c','core.commitGraph=false','show',`${ref}:${path}`],{cwd:repo,encoding:'utf8'});
const broken=show(item.base_ref,source),fixed=show(item.oracle_ref,source),normalizer=show(item.base_ref,protocol);
const fixture='evals/coding-agent/graders/private-reasoning-budget.test.ts',grader=readFileSync(join(repo,fixture));
const root=mkdtempSync(join(tmpdir(),'private-budget-calibration-'));afterAll(()=>rmSync(root,{recursive:true,force:true}));
function grade(name,text){const cwd=join(root,name);for(const [p,s] of [[source,text],[protocol,normalizer],[fixture,grader]]){if(s===null)continue;mkdirSync(dirname(join(cwd,p)),{recursive:true});writeFileSync(join(cwd,p),s);}return spawnSync(process.execPath,['test',fixture],{cwd,encoding:'utf8',timeout:30_000,env:{PATH:dirname(process.execPath)}});}
function fails(r){expect(r.error).toBeUndefined();expect(r.signal).toBeNull();expect(r.status).toBe(1);expect(r.stderr).toContain('expect(received)');expect(r.stderr).not.toContain('Cannot find module');expect(r.stderr).not.toContain('Unhandled error');}
function replace(s,old,next){expect(s.split(old)).toHaveLength(2);return s.replace(old,next);}
test('parent fails reasoning policy but preserves request boundaries',()=>{const r=grade('parent',broken);fails(r);expect(r.stderr).toContain('16 fail');expect(r.stderr).toContain('6 pass');});
test('reference passes all actual-adapter outcomes',()=>{const r=grade('reference',fixed);expect(r.status).toBe(0);expect(r.stderr).toContain('22 pass');});
test('equivalent local names and true expression pass',()=>expect(grade('equivalent',fixed.replaceAll('reasoningBudget','thinkingCap').replace('enable_thinking: true','enable_thinking: !false')).status).toBe(0));
test('discarding all reasoning cannot pass',()=>fails(grade('zero-budget',replace(fixed,'Math.min(reasoningBudget, Math.max(0, outputLimit - 1024))','0'))));
test('omitting reserved answer output cannot pass',()=>fails(grade('no-reserve',replace(fixed,'Math.min(reasoningBudget, Math.max(0, outputLimit - 1024))','reasoningBudget'))));
test('skipping client verification cannot pass',()=>fails(grade('skip-verification',replace(fixed,'await verifiedClient.ready();','/* deliberately broken verification bypass */'))));
test('reusing authenticated cache after token rotation cannot pass',()=>fails(grade('auth-cache',replace(fixed,'if (!client || clientAuth !== auth) {','if (!client) {'))));
test('fake successful response without sending cannot pass',()=>fails(grade('no-op',replace(fixed,'return async (input, init) => {',"return async (input, init) => { return new Response('data: [DONE]\\n\\n');"))));
test('missing source remains setup failure',()=>{const r=grade('missing',null);expect(r.status).toBe(1);expect(r.stderr).toContain('Cannot find module');expect(r.stderr).toContain('0 pass');});
