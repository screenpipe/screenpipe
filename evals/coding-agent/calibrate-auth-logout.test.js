// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import {afterAll,expect,test} from 'bun:test';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const repo=resolve(import.meta.dir,'../..'),app='apps/screenpipe-app-tauri';
const item=JSON.parse(readFileSync(join(import.meta.dir,'cases.json'),'utf8')).cases.find(c=>c.id==='app-auth-logout-pending-load');
const root=mkdtempSync(join(tmpdir(),'auth-logout-calibration-'));
const receipts=process.env.SCREENPIPE_EVAL_CALIBRATION_RECEIPTS;
const provider=`${app}/lib/hooks/use-settings.tsx`;
afterAll(()=>rmSync(root,{recursive:true,force:true}));
function replace(cwd,file,from,to){const p=join(cwd,file),s=readFileSync(p,'utf8');expect(s.split(from)).toHaveLength(2);writeFileSync(p,s.replace(from,to));}
function grade(name,ref=item.oracle_ref,mutate=()=>{}){
 const cwd=join(root,name);mkdirSync(cwd);
 // Exact historical sources only. External dependencies are linked at grading.
 const paths=[`${app}/lib`,`${app}/types`,`${app}/components`,`${app}/tsconfig.json`].filter(path=>execFileSync('git',['ls-tree',ref,'--',path],{cwd:repo,encoding:'utf8'}).trim());
 const archive=execFileSync('git',['archive',ref,'--',...paths],{cwd:repo,maxBuffer:64*1024*1024});
 execFileSync('tar',['-x','-C',cwd],{input:archive});
 for(const f of item.grader.fixtures){const dest=join(cwd,f.destination_path);mkdirSync(dirname(dest),{recursive:true});writeFileSync(dest,readFileSync(join(import.meta.dir,f.local_path)));}
 for(const link of item.grader_dependency_links)symlinkSync(join(repo,link.source_path),join(cwd,link.destination_path),'dir');
 mutate(cwd);
 const r=spawnSync('/bin/bash',['-c',item.grader.command],{cwd,encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024,env:{PATH:process.env.PATH,HOME:cwd,CI:'true',TZ:'UTC',NO_COLOR:'1'}});
 if(receipts){mkdirSync(receipts,{recursive:true});writeFileSync(join(receipts,name+'.stdout'),r.stdout||'');writeFileSync(join(receipts,name+'.stderr'),r.stderr||'');writeFileSync(join(receipts,name+'.json'),JSON.stringify({ref,command:item.grader.command,exit_code:r.status,signal:r.signal,error:r.error?.message},null,2));}
 expect(r.error).toBeUndefined();expect(r.signal).toBeNull();return r;
}
function passes(r){expect(r.status).toBe(0);expect(r.stdout).toContain('6 passed');expect(r.stdout+r.stderr).not.toMatch(/Unhandled|Uncaught|Failed to resolve import/);}
function fails(r){expect(r.status).toBe(1);expect(r.stderr).toMatch(/AssertionError|Error: expect\(/);expect(r.stdout+r.stderr).not.toMatch(/Unhandled|Uncaught|Failed to resolve import|Cannot find module/);}
test('parent restores two signed-out sessions and preserves four outcomes',()=>{const r=grade('parent',item.base_ref);fails(r);expect(r.stdout).toContain('2 failed | 4 passed');},60000);
test('historical fix passes',()=>passes(grade('reference')),60000);
test('current provider passes',()=>passes(grade('current','HEAD')),60000);
test('equivalent private state name passes',()=>passes(grade('equivalent',item.oracle_ref,cwd=>{
 const p=join(cwd,provider);writeFileSync(p,readFileSync(p,'utf8').replaceAll('authGenerationRef','sessionEpoch'));
})),60000);
test('unused corrected provider cannot mask active broken code',()=>fails(grade('unused',item.base_ref,cwd=>{
 writeFileSync(join(cwd,`${app}/unused-provider.tsx`),execFileSync('git',['show',`${item.oracle_ref}:${provider}`],{cwd:repo}));
})),60000);
test('disconnected response fence is rejected',()=>fails(grade('disconnected',item.oracle_ref,cwd=>{
 replace(cwd,provider,'if (authGenerationRef.current !== generation) {','if (false) {');
})),60000);
test('ignoring peer notifications is rejected',()=>fails(grade('peer',item.oracle_ref,cwd=>{
 replace(cwd,provider,'listen("screenpipe-auth-signout",','listen("unrelated-event",');
})),60000);
test('blanket account refusal is rejected',()=>fails(grade('refusal',item.oracle_ref,cwd=>{
 replace(cwd,provider,'const generation = authGenerationRef.current;','return; const generation = authGenerationRef.current;');
})),60000);
test('unrelated settings changes must not invalidate sign-in',()=>fails(grade('preferences',item.oracle_ref,cwd=>{
 replace(cwd,provider,'if ("user" in updates && !updates.user) {','if (true) {');
})),60000);
test('missing provider is an infrastructure failure',()=>{
 const r=grade('missing',item.oracle_ref,cwd=>rmSync(join(cwd,provider)));expect(r.status).toBe(1);expect(r.stdout+r.stderr).toMatch(/Failed to resolve import|Failed to load url/);expect(r.stderr).not.toMatch(/AssertionError/);
},60000);
