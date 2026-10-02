// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { classifyGraderError } from './grader-outcome.mjs';
const repo=resolve(import.meta.dir,'../..'), app='apps/screenpipe-app-tauri';
const item=JSON.parse(readFileSync(join(import.meta.dir,'cases.json'),'utf8')).cases.find(c=>c.id==='app-auth-verification-schedule');
const source=`${app}/lib/auth-guard.tsx`;
const root=mkdtempSync(join(tmpdir(),'auth-schedule-calibration-')), archives=new Map();
const receipts=process.env.SCREENPIPE_EVAL_CALIBRATION_RECEIPTS;
afterAll(()=>rmSync(root,{recursive:true,force:true}));
function replace(cwd,file,from,to){const p=join(cwd,file),s=readFileSync(p,'utf8');expect(s.split(from)).toHaveLength(2);writeFileSync(p,s.replace(from,to));}
function grade(name,ref=item.oracle_ref,mutate=()=>{}){
 const cwd=join(root,name);mkdirSync(cwd);
 if(!archives.has(ref)){
  const children=execFileSync('git',['ls-tree','--name-only',`${ref}:${app}`],{cwd:repo,encoding:'utf8'}).trim().split('\n');
  const paths=children.filter(n=>!['src-tauri','public','e2e','.e2e'].includes(n)&&!n.startsWith('.env')).map(n=>`${app}/${n}`);
  archives.set(ref,execFileSync('git',['archive',ref,...paths],{cwd:repo,maxBuffer:128*1024*1024}));
 }
 execFileSync('tar',['-x','-C',cwd],{input:archives.get(ref)});
 for(const f of item.grader.fixtures){const dest=join(cwd,f.destination_path);mkdirSync(dirname(dest),{recursive:true});writeFileSync(dest,readFileSync(join(import.meta.dir,f.local_path)));}
 symlinkSync(join(repo,app,'node_modules'),join(cwd,app,'node_modules'),'dir');mutate(cwd);
 const r=spawnSync('/bin/bash',['-c',item.grader.command],{cwd,encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024,env:{PATH:process.env.PATH,HOME:cwd,CI:'true',TZ:'UTC',NO_COLOR:'1'}});
 const kind=classifyGraderError(r);
 if(receipts){mkdirSync(receipts,{recursive:true});writeFileSync(join(receipts,name+'.stdout'),r.stdout||'');writeFileSync(join(receipts,name+'.stderr'),r.stderr||'');writeFileSync(join(receipts,name+'.json'),JSON.stringify({ref,command:item.grader.command,exit_code:r.status,signal:r.signal,error:r.error?.message,error_kind:kind},null,2));}
 expect(r.error).toBeUndefined();expect(r.signal).toBeNull();return {...r,kind};
}
function passes(r){expect(r.status).toBe(0);expect(r.stdout).toContain('12 passed');expect(r.kind).toBeNull();}
function fails(r){expect(r.status).toBe(1);expect(r.kind).toBeNull();expect(r.stdout).toMatch(/Tests\s+[1-9]\d* failed/);}
test('parent fails scheduling and preserves nine outcomes',()=>{const r=grade('parent',item.base_ref);fails(r);expect(r.stdout).toContain('3 failed | 9 passed');},60000);
test('reference passes all outcomes',()=>passes(grade('reference')),60000);
test('current source passes all outcomes',()=>passes(grade('current','HEAD')),60000);
test('equivalent recursive timer preserves the schedule',()=>passes(grade('equivalent',item.oracle_ref,cwd=>{
 replace(cwd,source,'const interval = setInterval(verify, CHECK_INTERVAL_MS);','let interval: ReturnType<typeof setTimeout>; const tick = () => { verify(); interval = setTimeout(tick, CHECK_INTERVAL_MS); }; interval = setTimeout(tick, CHECK_INTERVAL_MS);');
 replace(cwd,source,'clearInterval(interval);','clearTimeout(interval);');
})),60000);
test('unused fixed module cannot bypass the active broken guard',()=>fails(grade('unused',item.oracle_ref,cwd=>{
 writeFileSync(join(cwd,source+'.unused.txt'),readFileSync(join(cwd,source)));writeFileSync(join(cwd,source),execFileSync('git',['show',`${item.base_ref}:${source}`],{cwd:repo}));
})),60000);
test('blanket verification suppression fails',()=>fails(grade('disabled',item.oracle_ref,cwd=>replace(cwd,source,'await loadUser(token);','return;'))),60000);
test('lost periodic verification fails',()=>fails(grade('periodic',item.oracle_ref,cwd=>replace(cwd,source,'setInterval(verify, CHECK_INTERVAL_MS)','setInterval(() => {}, CHECK_INTERVAL_MS)'))),60000);
test('stale refresh callback fails',()=>fails(grade('stale',item.oracle_ref,cwd=>replace(cwd,source,'verifyTokenRef.current = verifyToken;','// retain stale callback'))),60000);
test('missing account reset fails',()=>fails(grade('token-reset',item.oracle_ref,cwd=>replace(cwd,source,'}, [settings.user?.token]);','}, []);'))),60000);
test('stale-account rejection cannot clear current login',()=>fails(grade('old-401',item.oracle_ref,cwd=>replace(cwd,source,'if (tokenRef.current !== token) return;',''))),60000);
test('permission failure cannot clear account',()=>fails(grade('403',item.oracle_ref,cwd=>replace(cwd,source,'if (msg.includes(" 401 ")) {','if (msg.includes(" 401 ") || msg.includes(" 403 ")) {'))),60000);
test('missing native credential cleanup fails',()=>fails(grade('native',item.oracle_ref,cwd=>replace(cwd,source,'await commands.setCloudToken(null);',''))),60000);
test('missing source remains collection failure',()=>{const r=grade('missing',item.oracle_ref,cwd=>rmSync(join(cwd,source)));expect(r.status).toBe(1);expect(r.kind).toBe('vitest_collection_error');},60000);
