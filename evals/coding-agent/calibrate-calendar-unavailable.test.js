// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
const repo=resolve(import.meta.dir,'../..'), app='apps/screenpipe-app-tauri';
const item=JSON.parse(readFileSync(join(import.meta.dir,'cases.json'),'utf8')).cases.find(c=>c.id==='app-native-calendar-unavailable-poll');
const source=`${app}/lib/utils/calendar.ts`, root=mkdtempSync(join(tmpdir(),'calendar-calibration-'));
const receipts=process.env.SCREENPIPE_EVAL_CALIBRATION_RECEIPTS;
afterAll(()=>rmSync(root,{recursive:true,force:true}));
function replace(cwd,from,to){const p=join(cwd,source),text=readFileSync(p,'utf8');expect(text.split(from)).toHaveLength(2);writeFileSync(p,text.replace(from,to));}
function grade(name,ref=item.oracle_ref,mutate=()=>{}){
 const cwd=join(root,name);mkdirSync(cwd);
 // Only the actual historical module and mocked port modules are extracted.
 // No agent runs; hidden fixtures and dependencies are installed for grading.
 for(const file of [source,`${app}/lib/api.ts`,`${app}/lib/utils/tauri.ts`]){
  const dest=join(cwd,file);mkdirSync(dirname(dest),{recursive:true});writeFileSync(dest,execFileSync('git',['show',`${ref}:${file}`],{cwd:repo,maxBuffer:8*1024*1024}));
 }
 for(const f of item.grader.fixtures){const dest=join(cwd,f.destination_path);mkdirSync(dirname(dest),{recursive:true});writeFileSync(dest,readFileSync(join(import.meta.dir,f.local_path)));}
 symlinkSync(join(repo,app,'node_modules'),join(cwd,app,'node_modules'),'dir');mutate(cwd);
 const r=spawnSync('/bin/bash',['-c',item.grader.command],{cwd,encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024,env:{PATH:process.env.PATH,HOME:cwd,CI:'true',TZ:'UTC',NO_COLOR:'1'}});
 if(receipts){mkdirSync(receipts,{recursive:true});writeFileSync(join(receipts,name+'.stdout'),r.stdout||'');writeFileSync(join(receipts,name+'.stderr'),r.stderr||'');writeFileSync(join(receipts,name+'.json'),JSON.stringify({ref,command:item.grader.command,exit_code:r.status,signal:r.signal,error:r.error?.message},null,2));}
 expect(r.error).toBeUndefined();expect(r.signal).toBeNull();return r;
}
function passes(r){expect(r.status).toBe(0);expect(r.stdout).toContain('9 passed');expect(r.stdout+r.stderr).not.toMatch(/Unhandled|Uncaught/);}
function fails(r){expect(r.status).toBe(1);expect(r.stdout).toContain('failed');expect(r.stdout+r.stderr).not.toMatch(/Unhandled|Uncaught|Failed to resolve import|Failed to load url|Cannot find module/);}
test('parent has two intended failures and seven preserved passes',()=>{const r=grade('parent',item.base_ref);fails(r);expect(r.stdout).toContain('2 failed | 7 passed');},60000);
test('reference passes every outcome',()=>passes(grade('reference')),60000);
test('current source passes every outcome',()=>passes(grade('current','HEAD')),60000);
test('unused corrected source cannot repair the actual caller',()=>{const r=grade('unused',item.base_ref,cwd=>writeFileSync(join(cwd,app,'unused-calendar.ts'),execFileSync('git',['show',`${item.oracle_ref}:${source}`],{cwd:repo})));fails(r);expect(r.stdout).toContain('2 failed | 7 passed');},60000);
test('equivalent private helper names pass',()=>passes(grade('equivalent',item.oracle_ref,cwd=>{const p=join(cwd,source);writeFileSync(p,readFileSync(p,'utf8').replaceAll('fetchNativeProvider','readSystemEvents').replaceAll('fetchNativeCalendar','requestSystemEvents'));})),60000);
test('equivalent availability condition passes',()=>passes(grade('equivalent-condition',item.oracle_ref,cwd=>replace(cwd,'if (statusKnown && !statusAvailable) {','if (statusKnown === true && statusAvailable === false) {'))),60000);
test('blanket native suppression loses healthy recovery',()=>fails(grade('blanket',item.oracle_ref,cwd=>replace(cwd,'if (statusKnown && !statusAvailable) {','if (true) {'))),60000);
test('probing known unavailable status is rejected',()=>fails(grade('always-probe',item.oracle_ref,cwd=>replace(cwd,'if (statusKnown && !statusAvailable) {','if (false) {'))),60000);
test('ignoring explicit disconnected response is rejected',()=>fails(grade('ignore-disconnected',item.oracle_ref,cwd=>replace(cwd,'if (body.connected === false) return null;','void body.connected;'))),60000);
test('dropping another provider loses preserved events',()=>fails(grade('drop-ics',item.oracle_ref,cwd=>replace(cwd,'fetchIcsProvider(hoursBack, hoursAhead),','Promise.resolve({source: "ics" as const, connected:false, ok:true, events:[]}),'))),60000);
test('missing module is setup failure rather than intended behavior',()=>{const r=grade('missing',item.oracle_ref,cwd=>rmSync(join(cwd,source)));expect(r.status).toBe(1);expect(r.stdout+r.stderr).toMatch(/Failed to resolve import|Failed to load url/);},60000);
