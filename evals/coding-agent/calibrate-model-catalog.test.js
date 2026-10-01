// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { classifyGraderError } from './grader-outcome.mjs';
const repo=resolve(import.meta.dir,'../..'), app='apps/screenpipe-app-tauri';
const item=JSON.parse(readFileSync(join(import.meta.dir,'cases.json'),'utf8')).cases.find(c=>c.id==='app-model-catalog-session-freshness');
const hook=`${app}/lib/hooks/use-pi-models.ts`, root=mkdtempSync(join(tmpdir(),'model-catalog-calibration-'));
const receipts=process.env.SCREENPIPE_EVAL_CALIBRATION_RECEIPTS;
afterAll(()=>rmSync(root,{recursive:true,force:true}));
function replace(cwd,from,to){const p=join(cwd,hook),text=readFileSync(p,'utf8');expect(text.split(from)).toHaveLength(2);writeFileSync(p,text.replace(from,to));}
function grade(name,ref=item.oracle_ref,mutate=()=>{}){
 const cwd=join(root,name);mkdirSync(cwd);
 // Exact product modules only; no agent, network, native process or user config.
 for(const file of [hook,...(ref==='HEAD'?[`${app}/lib/ai-gateway-url.ts`]:[])]){const dest=join(cwd,file);mkdirSync(dirname(dest),{recursive:true});writeFileSync(dest,execFileSync('git',['show',`${ref}:${file}`],{cwd:repo}));}
 for(const file of ['lib/hooks/use-settings.ts','lib/utils/tauri.ts','lib/http/tauri-fetch.ts']){const dest=join(cwd,app,file);mkdirSync(dirname(dest),{recursive:true});writeFileSync(dest,'throw new Error("unmocked external port");');}
 for(const f of item.grader.fixtures){const dest=join(cwd,f.destination_path);mkdirSync(dirname(dest),{recursive:true});writeFileSync(dest,readFileSync(join(import.meta.dir,f.local_path)));}
 symlinkSync(join(repo,app,'node_modules'),join(cwd,app,'node_modules'),'dir');mutate(cwd);
 const r=spawnSync('/bin/bash',['-c',item.grader.command],{cwd,encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024,env:{PATH:process.env.PATH,HOME:cwd,CI:'true',TZ:'UTC',NO_COLOR:'1'}});
 if(receipts){mkdirSync(receipts,{recursive:true});writeFileSync(join(receipts,name+'.stdout'),r.stdout||'');writeFileSync(join(receipts,name+'.stderr'),r.stderr||'');writeFileSync(join(receipts,name+'.json'),JSON.stringify({ref,command:item.grader.command,exit_code:r.status,signal:r.signal,error:r.error?.message,classification:classifyGraderError(r)},null,2));}
 expect(r.error).toBeUndefined();expect(r.signal).toBeNull();return r;
}
function passes(r){expect(r.status).toBe(0);expect(r.stdout).toContain('10 passed');expect(r.stdout+r.stderr).not.toMatch(/Unhandled|Uncaught/);}
function fails(r){expect(r.status).toBe(1);expect(r.stderr).toContain('AssertionError');expect(classifyGraderError(r)).toBeNull();expect(r.stdout+r.stderr).not.toMatch(/Unhandled|Uncaught|Failed to resolve import|Failed to load url|Cannot find module/);}
test('parent fails session outcomes and preserves nearby behavior',()=>{const r=grade('parent',item.base_ref);fails(r);expect(r.stdout).toContain('5 failed | 5 passed')},60000);
test('reference passes',()=>passes(grade('reference')),60000);
test('current passes',()=>passes(grade('current','HEAD')),60000);
test('declared oracle path repairs parent',()=>passes(grade('oracle-only',item.base_ref,cwd=>{const patch=execFileSync('git',['diff',item.base_ref,item.oracle_ref,'--',...item.oracle_paths],{cwd:repo});execFileSync('git',['apply','--whitespace=nowarn','-'],{cwd,input:patch})})),60000);
test('unused correct hook cannot hide active broken hook',()=>fails(grade('unused',item.oracle_ref,cwd=>{writeFileSync(join(cwd,app,'unused-correct-hook.ts'),readFileSync(join(cwd,hook)));writeFileSync(join(cwd,hook),execFileSync('git',['show',`${item.base_ref}:${hook}`],{cwd:repo}))})),60000);
test('equivalent stale-request guard preserves outcomes',()=>passes(grade('equivalent',item.oracle_ref,cwd=>{const p=join(cwd,hook);writeFileSync(p,readFileSync(p,'utf8').replaceAll('generation !== requestGeneration.current','!(generation === requestGeneration.current)'))})),60000);
test('lost body and header guards are rejected',()=>fails(grade('stale',item.oracle_ref,cwd=>{const p=join(cwd,hook);writeFileSync(p,readFileSync(p,'utf8').replaceAll('if (generation !== requestGeneration.current) return;',''))})),60000);
test('stale completion clearing loading is rejected',()=>fails(grade('loading',item.oracle_ref,cwd=>replace(cwd,'if (generation === requestGeneration.current) setIsLoading(false);','setIsLoading(false);'))),60000);
test('blanket catalog suppression is rejected',()=>fails(grade('empty',item.oracle_ref,cwd=>replace(cwd,'setPiModels(models);','setPiModels([]);'))),60000);
test('lost model names are rejected',()=>fails(grade('metadata',item.oracle_ref,cwd=>replace(cwd,'name: model.name || model.id,','name: model.id,'))),60000);
test('missing hook is a setup failure',()=>{const r=grade('missing',item.oracle_ref,cwd=>rmSync(join(cwd,hook)));expect(r.status).toBe(1);expect(classifyGraderError(r)).toBe('vitest_collection_error')},60000);
