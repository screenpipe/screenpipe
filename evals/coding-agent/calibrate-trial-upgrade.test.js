// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { classifyGraderError } from './grader-outcome.mjs';
const repo=resolve(import.meta.dir,'../..'), app='apps/screenpipe-app-tauri';
const item=JSON.parse(readFileSync(join(import.meta.dir,'cases.json'),'utf8')).cases.find(c=>c.id==='app-trial-upgrade-expiration');
const account=`${app}/components/settings/account-section.tsx`, notice=`${app}/components/plan-expiration-notice.tsx`;
const root=mkdtempSync(join(tmpdir(),'trial-upgrade-calibration-')), archives=new Map();
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
function fails(r){expect(r.status).toBe(1);expect(r.kind).toBeNull();expect(r.stdout).toMatch(/Tests\s+[1-9]\d* failed/);}
test('parent keeps stale trial UI and saved state; seven outcomes preserved',()=>{const r=grade('parent',item.base_ref);fails(r);expect(r.stdout).toContain('2 failed | 7 passed');},60000);
test('reference passes nine account outcomes',()=>passes(grade('reference')),60000);
test('equivalent DOM attributes and separate persistence writes pass',()=>passes(grade('equivalent',item.oracle_ref,cwd=>{
 for(const file of [account,notice]){const p=join(cwd,file);writeFileSync(p,readFileSync(p,'utf8').replaceAll('data-testid=','data-neutral-marker='));}
 replace(cwd,account,'await updateSettings({\n                      user: {','await updateSettings({ user: { ...settings.user, plan_expires_at: null } });\n                    await updateSettings({\n                      user: {');
})),60000);
test('unused correct files do not hide broken active code',()=>fails(grade('unused',item.oracle_ref,cwd=>{
 for(const file of item.oracle_paths){writeFileSync(join(cwd,file+'.unused.txt'),readFileSync(join(cwd,file)));writeFileSync(join(cwd,file),execFileSync('git',['show',`${item.base_ref}:${file}`],{cwd:repo}));}
})),60000);
test('blanket countdown suppression fails preserved manual trial',()=>fails(grade('silent',item.oracle_ref,cwd=>replace(cwd,notice,'if (hasBillingSubscriptionEntitlement(user)) return null;','return null;'))),60000);
test('retained saved expiry fails after activation',()=>fails(grade('stale-saved',item.oracle_ref,cwd=>replace(cwd,account,'plan_expires_at: null,','plan_expires_at: settings.user.plan_expires_at,'))),60000);
test('missing entitlement refresh fails saved state',()=>fails(grade('no-refresh',item.oracle_ref,cwd=>replace(cwd,account,'await loadUser(settings.user.token, true);','void 0;'))),60000);
test('unconfirmed checkout cannot clear manual grant',()=>fails(grade('unconfirmed',item.oracle_ref,cwd=>replace(cwd,account,'if (isActive) {','if (true) {'))),60000);
test('missing active source is collection error',()=>{const r=grade('missing',item.oracle_ref,cwd=>rmSync(join(cwd,account)));expect(r.status).toBe(1);expect(r.kind).toBe('vitest_collection_error');},60000);
