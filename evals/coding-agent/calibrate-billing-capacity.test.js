// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const repo = resolve(import.meta.dir, '../..');
const item = JSON.parse(readFileSync(join(import.meta.dir,'cases.json'),'utf8')).cases.find(c => c.id === 'ai-gateway-billing-capacity-compatibility');
const authPath = 'packages/ai-gateway/src/utils/auth.ts';
const paths = [authPath, 'packages/ai-gateway/src/utils/ttl-single-flight-cache.ts','packages/ai-gateway/src/types.ts'];
const show = (ref,path) => execFileSync('git',['show',`${ref}:${path}`],{cwd:repo,encoding:'utf8'});
const fixed = Object.fromEntries(paths.map(p => [p,show(item.oracle_ref,p)]));
const broken = { ...fixed, [authPath]: show(item.base_ref,authPath) };
const graderPath = 'evals/coding-agent/graders/gateway-billing-capacity.test.js';
const grader = readFileSync(join(repo,graderPath),'utf8');
const root = mkdtempSync(join(tmpdir(),'capacity-calibration-'));
afterAll(() => rmSync(root,{recursive:true,force:true}));
function replace(source,from,to) { expect(source.split(from)).toHaveLength(2); return source.replace(from,to); }
function grade(name,sources) {
  const cwd = join(root,name);
  for (const [p,s] of Object.entries({...sources,[graderPath]:grader})) {
    const file = join(cwd,p); mkdirSync(dirname(file),{recursive:true}); writeFileSync(file,s);
  }
  return spawnSync(process.execPath,['test',graderPath],{cwd,encoding:'utf8',timeout:30000,env:{PATH:dirname(process.execPath)}});
}
function fail(result) {
  expect(result.error).toBeUndefined(); expect(result.signal).toBeNull(); expect(result.status).toBe(1);
  expect(result.stderr).toContain('expect(received)'); expect(result.stderr).not.toContain('Cannot find module'); expect(result.stderr).not.toContain('Unhandled error');
}
const mutation = (name,from,to) => fail(grade(name,{...fixed,[authPath]:replace(fixed[authPath],from,to)}));
test('known broken parent fails actual capacity outcomes',()=>fail(grade('parent',broken)));
test('known historical fix passes all outcomes',()=>expect(grade('reference',fixed).status).toBe(0));
test('equivalent private helper names are accepted',()=>expect(grade('renamed',{...fixed,[authPath]:fixed[authPath].replaceAll('billingPlanMatchesAccessPlan','compatibleCapacity').replaceAll('resolveAccountPlan','accountCapacity')}).status).toBe(0));
test('ignoring contradictory billing cannot pass',()=>mutation('ignore-invalid',"return 'unknown';\n    }\n    accountPlan = billingPlan;","return accessPlan;\n    }\n    accountPlan = billingPlan;"));
test('billing cannot override an incompatible access grant',()=>mutation('wrong-grant','!billingPlanMatchesAccessPlan(billingPlan, accessPlan)','false'));
test('billing labels cannot substitute for active entitlement',()=>mutation('inactive',"user.entitlement?.active === true &&","true &&"));
test('ignoring verified subject cannot transfer another account capacity',()=>mutation('identity','screenpipeUser.clerkUserId === resolvedUserId','true'));
test('caching unknown plan truth is rejected',()=>mutation('unknown-cache',"if (!result.accountPlan || result.accountPlan === 'unknown') return null;",''));
test('removing explicit denial loses preserved free behavior',()=>mutation('denial','if (user.app_entitled === false && user.cloud_subscribed === false)','if (false)'));
test('missing source is setup failure, not a behavioral contrast',()=>{
  const sources = {...fixed};delete sources[authPath];const r=grade('missing',sources);
  expect(r.status).toBe(1);expect(r.stderr).toContain('Cannot find module');expect(r.stderr).toContain('0 pass');
});
