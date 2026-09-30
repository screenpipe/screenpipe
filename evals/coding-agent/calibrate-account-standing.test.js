// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const repo=resolve(import.meta.dir,'../..');
const item=JSON.parse(readFileSync(join(import.meta.dir,'cases.json'))).cases.find(c=>c.id==='ai-gateway-account-standing-provenance');
const root=mkdtempSync(join(tmpdir(),'standing-calibration-'));
afterAll(()=>rmSync(root,{recursive:true,force:true}));
const fixture=readFileSync(join(import.meta.dir,'graders/account-standing.fixture.ts.txt'));
function grade(name) {
 const cwd=join(root,name);mkdirSync(cwd);
 const ref=['parent','unused'].includes(name)?item.base_ref:item.oracle_ref;
 execFileSync('tar',['-x','-C',cwd],{input:execFileSync('git',['archive',ref,'packages/ai-gateway/src'],{cwd:repo,maxBuffer:16*1024*1024})});
 const src=join(cwd,'packages/ai-gateway/src');
 if(name==='unused') for(const path of ['utils/auth.ts','utils/rate-limiter.ts']) writeFileSync(join(src,path+'.unused.ts'),execFileSync('git',['show',`${item.oracle_ref}:packages/ai-gateway/src/${path}`],{cwd:repo}));
 if(['permissive','blanket'].includes(name)) {
  const path=join(src,'utils/rate-limiter.ts'),text=readFileSync(path,'utf8'),marker='  const clerkUserId = authResult?.clerkUserId;';
  expect(text.split(marker)).toHaveLength(2);
  writeFileSync(path,text.replace(marker,(name==='permissive'?'  return {allowed:true};':"  return {allowed:false,response:new Response('',{status:403})};")+'\n'+marker));
 }
 if(name==='equivalent') for(const file of ['utils/auth.ts','utils/rate-limiter.ts','types.ts']) {
  const path=join(src,file),text=readFileSync(path,'utf8');expect(text).toContain('clerkUserIdVerified');writeFileSync(path,text.replaceAll('clerkUserIdVerified','requestSubjectVerified'));
 }
 if(name==='missing') rmSync(join(src,'index.ts'));
 writeFileSync(join(src,'test/eval-standing-http.test.ts'),fixture);
 symlinkSync(join(repo,'packages/ai-gateway/node_modules'),join(cwd,'packages/ai-gateway/node_modules'),'dir');
 const result=spawnSync(process.execPath,['test','src/test/eval-standing-http.test.ts'],{cwd:join(cwd,'packages/ai-gateway'),encoding:'utf8',timeout:15000,env:{PATH:dirname(process.execPath),HOME:cwd,CI:'true'}});
 if(process.env.EVAL_CALIBRATION_RESULTS) {
  const out=resolve(process.env.EVAL_CALIBRATION_RESULTS);mkdirSync(out,{recursive:true});
  for(const ext of ['stdout','stderr'])writeFileSync(join(out,name+'.'+ext),result[ext]||'');
  writeFileSync(join(out,name+'.json'),JSON.stringify({status:result.status,signal:result.signal,error:result.error?.message||null})+'\n');
 }
 return result;
}
function fails(r){expect(r.error).toBeUndefined();expect(r.signal).toBeNull();expect(r.status).toBe(1);expect(r.stderr).toContain('expect(received)');expect(r.stderr).not.toContain('Cannot find module');}
test('parent fails ten complete outcomes and preserves two',()=>{const r=grade('parent');fails(r);expect(r.stderr).toContain('10 fail');expect(r.stderr).toContain('2 pass');});
test('reference passes twelve HTTP outcomes',()=>{const r=grade('reference');expect(r.status).toBe(0);expect(r.stderr).toContain('12 pass');});
test('unused correct admission cannot repair callers',()=>fails(grade('unused')));
test('permissive admission loses denial and provenance outcomes',()=>fails(grade('permissive')));
test('blanket refusal loses preserved model listing',()=>fails(grade('blanket')));
test('equivalent private provenance field remains accepted',()=>{expect(grade('equivalent').status).toBe(0);});
test('missing router is classified as setup failure',()=>{const r=grade('missing');expect(r.status).not.toBe(0);expect(r.stderr).toContain('Cannot find module');expect(r.stderr).not.toContain('expect(received)');});
