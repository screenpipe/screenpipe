// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { classifyGraderError } from './grader-outcome.mjs';
const repo=resolve(import.meta.dir,'../..'), app='apps/screenpipe-app-tauri';
const item=JSON.parse(readFileSync(join(import.meta.dir,'cases.json'),'utf8')).cases.find(c=>c.id==='app-permission-recovery-audio-policy');
const root=mkdtempSync(join(tmpdir(),'audio-policy-calibration-')), receipts=process.env.SCREENPIPE_EVAL_CALIBRATION_RECEIPTS;
const helper=`${app}/lib/utils/permission-requirements.ts`;
afterAll(()=>rmSync(root,{recursive:true,force:true}));
function grade(name,ref=item.oracle_ref,mutate=()=>{}){
 const cwd=join(root,name);mkdirSync(cwd);
 const paths=['app/permission-recovery','components','lib','scripts','vitest.config.ts','vitest.setup.ts','gt.config.json','package.json','tsconfig.json'].map(p=>`${app}/${p}`);
 const archive=execFileSync('git',['archive',ref,...paths],{cwd:repo,maxBuffer:64*1024*1024});execFileSync('tar',['-xf','-','-C',cwd],{input:archive});
 for(const f of item.grader.fixtures){const dest=join(cwd,f.destination_path);mkdirSync(dirname(dest),{recursive:true});writeFileSync(dest,readFileSync(join(import.meta.dir,f.local_path)));}
 symlinkSync(join(repo,app,'node_modules'),join(cwd,app,'node_modules'),'dir');mutate(cwd);
 const r=spawnSync('/bin/bash',['-c',item.grader.command],{cwd,encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024,env:{PATH:process.env.PATH,HOME:cwd,CI:'true',TZ:'UTC',NO_COLOR:'1'}});
 if(receipts){mkdirSync(receipts,{recursive:true});for(const stream of ['stdout','stderr'])writeFileSync(join(receipts,name+'.'+stream),r[stream]||'');writeFileSync(join(receipts,name+'.json'),JSON.stringify({ref,command:item.grader.command,exit_code:r.status,signal:r.signal,error:r.error?.message,classification:classifyGraderError(r)},null,2));}
 expect(r.error).toBeUndefined();expect(r.signal).toBeNull();return r;
}
function passes(r){expect(r.status).toBe(0);expect(r.stdout).toContain('14 passed');expect(r.stdout+r.stderr).not.toMatch(/Unhandled|Uncaught/);}
function fails(r){expect(r.status).toBe(1);expect(r.stderr).toMatch(/AssertionError|TestingLibraryElementError|Error: expect/);expect(classifyGraderError(r)).toBeNull();expect(r.stdout+r.stderr).not.toMatch(/Unhandled|Uncaught|Failed to resolve import|Failed to load url|Cannot find module/);}
function helperBody(cwd,body){writeFileSync(join(cwd,helper),'export function isMicrophoneRequired(settings: { disableAudio?: boolean; audioCaptureMode?: string }): boolean { '+body+' }\n');}
test('broken parent fails UI outcomes, without setup failure',()=>fails(grade('parent',item.base_ref)),60000);
test('known reference passes',()=>passes(grade('reference')),60000);
test('current source passes',()=>passes(grade('current','HEAD')),60000);
test('declared UI oracle alone repairs parent',()=>passes(grade('oracle-only',item.base_ref,cwd=>{execFileSync('git',['apply','--whitespace=nowarn','-'],{cwd,input:execFileSync('git',['diff',item.base_ref,item.oracle_ref,'--',...item.oracle_paths],{cwd:repo})})})),60000);
test('unused corrected interfaces cannot hide active broken interfaces',()=>fails(grade('unused',item.base_ref,cwd=>{for(const p of item.oracle_paths){const dst=join(cwd,p+'.unused');mkdirSync(dirname(dst),{recursive:true});writeFileSync(dst,execFileSync('git',['show',`${item.oracle_ref}:${p}`],{cwd:repo}));}})),60000);
test('equivalent audio policy implementation passes',()=>passes(grade('equivalent',item.oracle_ref,cwd=>helperBody(cwd,'if (settings.disableAudio === true) return false; return !/^disabled$/i.test(settings.audioCaptureMode ?? "");'))),60000);
test('always requiring microphone is rejected',()=>fails(grade('always-required',item.oracle_ref,cwd=>helperBody(cwd,'return true;'))),60000);
test('never requiring microphone violates preserved audio-on behavior',()=>fails(grade('never-required',item.oracle_ref,cwd=>helperBody(cwd,'return false;'))),60000);
test('missing interfaces are an infrastructure error',()=>{const r=grade('missing',item.oracle_ref,cwd=>{for(const p of item.oracle_paths.slice(0,3))rmSync(join(cwd,p));});expect(r.status).toBe(1);expect(classifyGraderError(r)).toBe('vitest_collection_error')},60000);

test('one missing interface remains infrastructure when neighboring suites pass',()=>{const r=grade('missing-one',item.oracle_ref,cwd=>rmSync(join(cwd,item.oracle_paths[0])));expect(r.status).toBe(1);expect(r.stdout).toContain('7 passed');expect(r.stdout).not.toMatch(/Tests\s+.*[1-9]\d* failed/);expect(classifyGraderError(r)).toBe('vitest_collection_error')},60000);
