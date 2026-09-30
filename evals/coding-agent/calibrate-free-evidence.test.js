// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const repo=resolve(import.meta.dir,'../..');
const item=JSON.parse(readFileSync(join(import.meta.dir,'cases.json'),'utf8')).cases.find(c=>c.id==='app-complete-free-entitlement-evidence');
const sourcePath='apps/screenpipe-app-tauri/lib/app-entitlement.ts';
const graderPath='evals/coding-agent/graders/free-evidence.test.ts';
const show=ref=>execFileSync('git',['show',`${ref}:${sourcePath}`],{cwd:repo,encoding:'utf8'});
const fixed=show(item.oracle_ref),broken=show(item.base_ref),grader=readFileSync(join(repo,graderPath),'utf8');
const root=process.env.EVAL_CALIBRATION_DIR?resolve(process.env.EVAL_CALIBRATION_DIR):mkdtempSync(join(tmpdir(),'free-evidence-'));
mkdirSync(root,{recursive:true});afterAll(()=>{if(!process.env.EVAL_CALIBRATION_DIR)rmSync(root,{recursive:true,force:true});});
function grade(name,source,unused=false){
 const cwd=join(root,name);for(const [p,s] of Object.entries({[graderPath]:grader,...(source===null?{}:{[sourcePath]:source}),...(unused?{'apps/screenpipe-app-tauri/lib/unused-correct.ts':fixed}:{})})){const f=join(cwd,p);mkdirSync(dirname(f),{recursive:true});writeFileSync(f,s);}
 const r=spawnSync(process.execPath,['test',graderPath],{cwd,encoding:'utf8',timeout:30000,env:{PATH:dirname(process.execPath)}});
 if(process.env.EVAL_CALIBRATION_DIR){writeFileSync(join(root,name+'.stdout'),r.stdout||'');writeFileSync(join(root,name+'.stderr'),r.stderr||'');writeFileSync(join(root,name+'.json'),JSON.stringify({exit_code:r.status,signal:r.signal,error:r.error?.message??null}));}return r;
}
function failure(r){expect(r.error).toBeUndefined();expect(r.signal).toBeNull();expect(r.status).toBe(1);expect(r.stderr).toContain('expect(received)');expect(r.stderr).not.toContain('Cannot find module');expect(r.stderr).not.toContain('Unhandled error');expect(r.stderr).toMatch(/[1-9][0-9]* pass/);}
function success(r){expect(r.error).toBeUndefined();expect(r.signal).toBeNull();expect(r.status).toBe(0);expect(r.stderr).toContain('26 pass');}
function change(from,to){expect(fixed.split(from)).toHaveLength(2);return fixed.replace(from,to);}
test('known broken parent fails behavior and preserves neighbors',()=>failure(grade('parent',broken)));
test('historical fix passes every outcome',()=>success(grade('reference',fixed)));
test('equivalent private names are accepted',()=>success(grade('equivalent',fixed.replaceAll('legacyVerifiedFree','completeOldDenial').replaceAll('hasVerifiedFreePlan','freeEvidenceValid'))));
test('unused correct implementation cannot mask broken exports',()=>failure(grade('unused',broken,true)));
test('legacy denial cannot be ignored',()=>failure(grade('no-legacy',change('legacyVerifiedFree ||','false ||'))));
test('missing cloud truth cannot be accepted',()=>failure(grade('missing-cloud',change('user.cloud_subscribed !== false','user.cloud_subscribed === true'))));
test('app feature evidence cannot be omitted',()=>failure(grade('missing-feature',change('typeof entitlement.features?.app !== "boolean" ||','false ||').replace('entitlement.features.cloud === true','entitlement.features?.cloud === true'))));
test('whitespace token cannot authenticate',()=>failure(grade('whitespace',change('user.token.trim().length > 0','user.token.length > 0'))));
test('unknown free source cannot be trusted',()=>failure(grade('unknown-source',change('source !== "none" ||','["manual", "enterprise", "lifetime", "dev"].includes(source) ||'))));
test('missing source is setup failure',()=>{const r=grade('missing',null);expect(r.status).toBe(1);expect(r.stderr).toContain('Cannot find module');expect(r.stderr).toContain('0 pass');});
