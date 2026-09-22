// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const repo=resolve(import.meta.dir,'../..');
const item=JSON.parse(readFileSync(join(import.meta.dir,'cases.json'),'utf8')).cases.find(c=>c.id==='ai-gateway-enterprise-allowance');
const auth='packages/ai-gateway/src/utils/auth.ts',gateway='packages/ai-gateway/src/services/cloudflare-ai-gateway.ts';
const paths=[auth,gateway,'packages/ai-gateway/src/utils/ttl-single-flight-cache.ts','packages/ai-gateway/src/services/cost-tracker.ts','packages/ai-gateway/src/services/hosted-ai-policy.ts','packages/ai-gateway/src/services/hosted-ai-settlement-ledger.ts'];
const show=(ref,p)=>execFileSync('git',['show',`${ref}:${p}`],{cwd:repo,encoding:'utf8'});
const fixed=Object.fromEntries(paths.map(p=>[p,show(item.oracle_ref,p)])),broken=Object.fromEntries(paths.map(p=>[p,show(item.base_ref,p)]));
const fixture='evals/coding-agent/graders/enterprise-allowance.test.js',grader=readFileSync(join(repo,fixture),'utf8');
const root=mkdtempSync(join(tmpdir(),'enterprise-allowance-calibration-'));afterAll(()=>rmSync(root,{recursive:true,force:true}));
function replace(s,a,b){expect(s.split(a)).toHaveLength(2);return s.replace(a,b);}
function grade(name,sources){const cwd=join(root,name);for(const [p,s] of Object.entries({...sources,[fixture]:grader})){const f=join(cwd,p);mkdirSync(dirname(f),{recursive:true});writeFileSync(f,s);}return spawnSync(process.execPath,['test',fixture],{cwd,encoding:'utf8',timeout:30000,env:{PATH:dirname(process.execPath)}});}
function fails(r){expect(r.error).toBeUndefined();expect(r.signal).toBeNull();expect(r.status).toBe(1);expect(r.stderr).toContain('expect(received)');expect(r.stderr).not.toMatch(/Cannot find module|Unhandled error/);}
test('parent has five intended failures and fifteen preserved outcomes',()=>{const r=grade('parent',broken);fails(r);expect(r.stderr).toContain('5 fail');expect(r.stderr).toContain('15 pass');});
test('reference passes twenty joined auth/context/connection outcomes',()=>{const r=grade('reference',fixed);expect(r.status).toBe(0);expect(r.stderr).toContain('20 pass');});
test('equivalent auth helper naming is accepted',()=>{expect(grade('renamed',{...fixed,[auth]:fixed[auth].replaceAll('resolveAccountPlan','deriveVerifiedAccountPlan')}).status).toBe(0);});
test('gateway fix cannot hide the unchanged auth caller',()=>fails(grade('old-auth',{...fixed,[auth]:broken[auth]})));
test('auth fix cannot hide the unchanged gateway mapping',()=>fails(grade('old-gateway',{...fixed,[gateway]:broken[gateway]})));
test('truthy enterprise strings cannot grant enterprise allowance',()=>fails(grade('truthy',{...fixed,[auth]:replace(fixed[auth],'user.is_enterprise_user === true ?','Boolean(user.is_enterprise_user) ?')})));
test('enterprise flag cannot bypass entitlement checks',()=>fails(grade('early',{...fixed,[auth]:replace(fixed[auth],'function resolveAccountPlan(user: ScreenpipeUserData): AccountPlan {','function resolveAccountPlan(user: ScreenpipeUserData): AccountPlan {\n if(user.is_enterprise_user === true) return "enterprise";')})));
test('blanket Ultra mapping fails consumer preservation',()=>fails(grade('all-ultra',{...fixed,[gateway]:replace(fixed[gateway],"if (auth.accountPlan === 'enterprise') return 'business_ultra';","if (true) return 'business_ultra';")})));
test('correct context without correct serialized wire metadata is rejected',()=>fails(grade('bad-header',{...fixed,[gateway]:replace(fixed[gateway],"'cf-aig-metadata': JSON.stringify(context),","'cf-aig-metadata': JSON.stringify({ ...context, plan: 'business' }),")})));
test('missing auth source remains setup failure',()=>{const sources={...fixed};delete sources[auth];const r=grade('missing',sources);expect(r.status).toBe(1);expect(r.stderr).toContain('Cannot find module');expect(r.stderr).toContain('0 pass');});
