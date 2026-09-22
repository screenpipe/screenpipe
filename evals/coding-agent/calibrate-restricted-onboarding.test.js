// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const repo=resolve(import.meta.dir,'../..');
const item=JSON.parse(readFileSync(join(import.meta.dir,'cases.json'),'utf8')).cases.find(c=>c.id==='app-restricted-enterprise-onboarding');
const path=item.oracle_paths[0],appPath='apps/screenpipe-app-tauri';
const show=(ref,p)=>execFileSync('git',['show',`${ref}:${p}`],{cwd:repo,encoding:'utf8'});
const fixed=show(item.oracle_ref,path),broken=show(item.base_ref,path);
const root=mkdtempSync(join(tmpdir(),'restricted-onboarding-'));afterAll(()=>rmSync(root,{recursive:true,force:true}));
execFileSync('tar',['-x','-C',root],{input:execFileSync('git',['archive',item.oracle_ref,appPath],{cwd:repo,maxBuffer:128*1024*1024})});
const app=join(root,appPath),runtime=join(repo,appPath,'node_modules');symlinkSync(runtime,join(app,'node_modules'),'dir');
writeFileSync(join(app,'components/restricted-onboarding.eval.test.tsx'),readFileSync(join(import.meta.dir,'graders/restricted-onboarding.fixture.tsx')));
function replace(s,old,next){expect(s.split(old)).toHaveLength(2);return s.replace(old,next);}
function grade(source){writeFileSync(join(root,path),source);return spawnSync(join(runtime,'.bin/vitest'),['run','--config','vitest.config.ts','components/restricted-onboarding.eval.test.tsx','--maxWorkers=1','--minWorkers=1'],{cwd:app,encoding:'utf8',timeout:60000,env:{...process.env,NODE_OPTIONS:'--localstorage-file=.eval-localstorage'}});}
function fail(r){expect(r.error).toBeUndefined();expect(r.signal).toBeNull();expect(r.status).toBe(1);expect(r.stdout).toContain('failed');expect(r.stderr).not.toContain('Failed to resolve import');expect(r.stderr).not.toContain('Unhandled Errors');}
test('parent exposes restricted onboarding in two sequences and preserves eight',()=>{const r=grade(broken);fail(r);expect(r.stdout).toContain('2 failed');expect(r.stdout).toContain('8 passed');});
test('reference passes all ten UI outcomes',()=>{const r=grade(fixed);expect(r.status).toBe(0);expect(r.stdout).toContain('10 passed');});
test('equivalent local decision naming passes',()=>expect(grade(fixed.replaceAll('shouldGateForEnterpriseApp','restrictedBuildRequired')).status).toBe(0));
test('blanket onboarding refusal is rejected',()=>fail(grade(replace(fixed,'? isManagedDeploymentResolved && shouldGateForEnterpriseApp','? true'))));
test('premature build classification is rejected',()=>fail(grade(replace(fixed,'? isManagedDeploymentResolved && shouldGateForEnterpriseApp','? shouldGateForEnterpriseApp'))));
test('ignoring explicit enterprise restriction loses paid restricted case',()=>fail(grade(replace(fixed,'enterpriseAccount.restrict_consumer_build_access === true','false'))));
test('requiring enterprise app despite paid unrestricted account is rejected',()=>fail(grade(replace(fixed,'(!hasConsumerSubscription ||\n      enterpriseAccount.restrict_consumer_build_access === true)','true'))));
test('tokenless cached organization must not gate onboarding',()=>fail(grade(replace(fixed,'Boolean(user?.token) &&\n    enterpriseAccount?.requires_enterprise_app','true &&\n    enterpriseAccount?.requires_enterprise_app'))));
test('missing component is setup failure',()=>{rmSync(join(root,path));const r=spawnSync(join(runtime,'.bin/vitest'),['run','--config','vitest.config.ts','components/restricted-onboarding.eval.test.tsx','--maxWorkers=1','--minWorkers=1'],{cwd:app,encoding:'utf8',timeout:60000,env:{...process.env,NODE_OPTIONS:'--localstorage-file=.eval-localstorage'}});expect(r.status).toBe(1);expect(r.stderr).toContain('Failed to resolve import');expect(r.stdout).toContain('no tests');});
