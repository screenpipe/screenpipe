// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { classifyGraderError } from './grader-outcome.mjs';
const repo=resolve(import.meta.dir,'../..'), app='apps/screenpipe-app-tauri';
const item=JSON.parse(readFileSync(join(import.meta.dir,'cases.json'),'utf8')).cases.find(c=>c.id==='app-workflow-sharing-entry-consent');
const source=`${app}/components/workflows/workflow-tasks-prompt.tsx`;
const root=mkdtempSync(join(tmpdir(),'sharing-entry-calibration-')), archives=new Map();
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
function passes(r){expect(r.status).toBe(0);expect(r.stdout).toContain('9 passed');expect(r.kind).toBeNull();}
function fails(r){expect(r.status).toBe(1);expect(r.kind).toBeNull();expect(r.stdout).toMatch(/Tests\s+[1-9]\d* failed/);expect(r.stderr).not.toContain('TypeError:');}
test('parent fails intended entry outcomes while preserved controls pass',()=>{const r=grade('parent',item.base_ref);fails(r);expect(r.stdout).toContain('3 passed');},60000);
test('reference passes',()=>passes(grade('reference')),60000);
test('current passes',()=>passes(grade('current','HEAD')),60000);
test('equivalent active condition passes',()=>passes(grade('equivalent',item.oracle_ref,cwd=>replace(cwd,source,'if (active && account &&','if (account && active &&'))),60000);
test('unused fixed component cannot repair parent',()=>fails(grade('unused',item.base_ref,cwd=>writeFileSync(join(cwd,source+'.unused.txt'),execFileSync('git',['show',`${item.oracle_ref}:${source}`],{cwd:repo})))),60000);
test('recorder-gated choice fails',()=>fails(grade('recorder',item.oracle_ref,cwd=>replace(cwd,source,'if (active && account &&','if (active && backendReady && account &&'))),60000);
test('skip without account notice fails',()=>fails(grade('skip',item.oracle_ref,cwd=>replace(cwd,source,'if (account) void updateSettings','if (false) void updateSettings'))),60000);
test('disabled positive consent fails preserved behavior',()=>fails(grade('grant',item.oracle_ref,cwd=>replace(cwd,`${app}/components/workflows/workflow-sharing-controls.tsx`,'onClick={() => void change(true)}','onClick={() => {}}'))),60000);
test('missing component is infrastructure failure',()=>{const r=grade('missing',item.oracle_ref,cwd=>rmSync(join(cwd,source)));expect(r.status).toBe(1);expect(r.kind).toBe('vitest_collection_error');},60000);
test('skip cannot silently grant local sharing',()=>fails(grade('skip-grant',item.oracle_ref,cwd=>replace(cwd,source,'void updateSettings({ workflowSharingPromptSeen:','void updateSettings({ workflowSharing: { accountId: account, epoch: "forged", priorBackend: "local" }, workflowSharingPromptSeen:'))),60000);
test('a different account notice cannot suppress the current choice',()=>fails(grade('global-notice',item.oracle_ref,cwd=>replace(cwd,source,'value.workflowSharingPromptSeen?.[account] !== SHARING_NOTICE_VERSION','!Object.values(value.workflowSharingPromptSeen || {}).includes(SHARING_NOTICE_VERSION)'))),60000);
