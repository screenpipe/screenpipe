// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const repo=resolve(import.meta.dir,'../..');
const item=JSON.parse(readFileSync(join(import.meta.dir,'cases.json'))).cases.find(c=>c.id==='ai-gateway-background-request-preservation');
const root=mkdtempSync(join(tmpdir(),'background-request-calibration-'));
afterAll(()=>rmSync(root,{recursive:true,force:true}));
const fixture=readFileSync(join(import.meta.dir,'graders/background-request.fixture.ts.txt'));
function grade(name) {
 const cwd=join(root,name);mkdirSync(cwd);
 const ref=['parent','unused'].includes(name)?item.base_ref:item.oracle_ref;
 execFileSync('tar',['-x','-C',cwd],{input:execFileSync('git',['archive',ref,'packages/ai-gateway/src'],{cwd:repo,maxBuffer:16*1024*1024})});
 const src=join(cwd,'packages/ai-gateway/src'),service=join(src,'services/background-limit-fallback.ts');
 if(name==='unused') writeFileSync(service+'.unused.ts',execFileSync('git',['show',`${item.oracle_ref}:packages/ai-gateway/src/services/background-limit-fallback.ts`],{cwd:repo}));
 if(['budget','tools','blanket'].includes(name)) {
  const original=readFileSync(service,'utf8'),marker='return { ...body, model: BACKGROUND_FALLBACK_MODEL };';expect(original.split(marker)).toHaveLength(2);
  const replacement=name==='budget'?'return { ...body, model: BACKGROUND_FALLBACK_MODEL, max_completion_tokens: 512 };':name==='tools'?'return { ...body, model: BACKGROUND_FALLBACK_MODEL, tools: [] };':'return { ...body, model: BACKGROUND_FALLBACK_MODEL, messages: [] };';
  writeFileSync(service,original.replace(marker,replacement));
 }
 if(name==='disabled') {const original=readFileSync(service,'utf8');expect(original.split('return input.enabled &&')).toHaveLength(2);writeFileSync(service,original.replace('return input.enabled &&','return true &&'));}
 if(name==='equivalent') for(const file of ['services/background-limit-fallback.ts','handlers/chat.ts']) {const path=join(src,file),text=readFileSync(path,'utf8');expect(text).toContain('BACKGROUND_FALLBACK_MODEL');writeFileSync(path,text.replaceAll('BACKGROUND_FALLBACK_MODEL','RECOVERY_MODEL'));}
 if(name==='missing') rmSync(join(src,'handlers/chat.ts'));
 writeFileSync(join(src,'test/eval-background-request.test.ts'),fixture);
 symlinkSync(join(repo,'packages/ai-gateway/node_modules'),join(cwd,'packages/ai-gateway/node_modules'),'dir');
 const result=spawnSync(process.execPath,['test','src/test/eval-background-request.test.ts'],{cwd:join(cwd,'packages/ai-gateway'),encoding:'utf8',timeout:15000,env:{PATH:dirname(process.execPath),HOME:cwd,CI:'true'}});
 if(process.env.EVAL_CALIBRATION_RESULTS) {const out=resolve(process.env.EVAL_CALIBRATION_RESULTS);mkdirSync(out,{recursive:true});for(const ext of ['stdout','stderr'])writeFileSync(join(out,name+'.'+ext),result[ext]||'');writeFileSync(join(out,name+'.json'),JSON.stringify({status:result.status,signal:result.signal,error:result.error?.message||null})+'\n');}
 return result;
}
function fails(r){expect(r.error).toBeUndefined();expect(r.signal).toBeNull();expect(r.status).toBe(1);expect(r.stderr).toContain('expect(received)');expect(r.stderr).not.toContain('Cannot find module');}
test('parent fails four outcomes and preserves nine',()=>{const r=grade('parent');fails(r);expect(r.stderr).toContain('4 fail');expect(r.stderr).toContain('9 pass');});
test('reference passes thirteen outcomes',()=>{const r=grade('reference');expect(r.status).toBe(0);expect(r.stderr).toContain('13 pass');});
test('unused correct service does not repair dispatch',()=>fails(grade('unused')));
test('clamped output budget is rejected',()=>fails(grade('budget')));
test('lost tool schema is rejected',()=>fails(grade('tools')));
test('blanket context loss is rejected',()=>fails(grade('blanket')));
test('disabled lane remains protected',()=>fails(grade('disabled')));
test('equivalent private model binding is accepted',()=>{expect(grade('equivalent').status).toBe(0);});
test('missing handler is setup failure',()=>{const r=grade('missing');expect(r.status).not.toBe(0);expect(r.stderr).toContain('Cannot find module');expect(r.stderr).not.toContain('expect(received)');});
