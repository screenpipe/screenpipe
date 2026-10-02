// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import {afterAll,expect,test} from 'bun:test';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {resolve,join,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
const repo=resolve(import.meta.dir,'../..'),root=mkdtempSync(join(tmpdir(),'public-allowance-'));
const item=JSON.parse(readFileSync(join(import.meta.dir,'cases.json'),'utf8')).cases.find(c=>c.id==='app-public-hosted-ai-allowance');
const cap='packages/ai-gateway/src/services/cost-cap.ts',controls='packages/ai-gateway/src/services/hosted-ai-cost-controls.ts';
const source=(path,ref=item.oracle_ref)=>execFileSync('git',['show',`${ref}:${path}`],{cwd:repo,encoding:'utf8'});
afterAll(()=>rmSync(root,{recursive:true,force:true}));
function prepare(name,ref=item.base_ref,oracle=true){const cwd=join(root,name);mkdirSync(cwd);const archive=execFileSync('git',['archive',ref,'packages/ai-gateway/src'],{cwd:repo,maxBuffer:64*1024*1024});execFileSync('tar',['-xf','-','-C',cwd],{input:archive});if(oracle)for(const f of item.oracle_paths)writeFileSync(join(cwd,f),source(f));for(const f of item.grader.fixtures){const out=join(cwd,f.destination_path);mkdirSync(dirname(out),{recursive:true});writeFileSync(out,readFileSync(join(import.meta.dir,f.local_path)));}symlinkSync(join(repo,'packages/ai-gateway/node_modules'),join(cwd,'packages/ai-gateway/node_modules'),'dir');return cwd;}
function run(cwd){const r=spawnSync(process.execPath,['test','src/services/eval-public-allowance.test.ts'],{cwd:join(cwd,'packages/ai-gateway'),encoding:'utf8',timeout:20000,env:{PATH:process.env.PATH,HOME:cwd,TZ:'UTC',CI:'true'}});if(process.env.SCREENPIPE_EVAL_CALIBRATION_RECEIPTS){mkdirSync(process.env.SCREENPIPE_EVAL_CALIBRATION_RECEIPTS,{recursive:true});writeFileSync(join(process.env.SCREENPIPE_EVAL_CALIBRATION_RECEIPTS,basename(cwd)+'.json'),JSON.stringify({status:r.status,signal:r.signal,error:r.error?.message,stdout:r.stdout,stderr:r.stderr},null,2));}return r;}
function fails(r){expect(r.error).toBeUndefined();expect(r.signal).toBeNull();expect(r.status).toBe(1);expect(r.stderr).toContain('error: expect(');expect(r.stderr).not.toMatch(/Cannot find module|error: (?:Unexpected|Could not resolve)/);}
function replace(s,a,b){expect(s.split(a)).toHaveLength(2);return s.replace(a,b);}
function mutant(name,path,text){const cwd=prepare(name);writeFileSync(join(cwd,path),text);return run(cwd);}
test('parent fails seven ceilings and preserves eight outcomes',()=>{const r=run(prepare('parent',item.base_ref,false));fails(r);expect(r.stderr).toContain('8 pass\n 7 fail');});
test('reference passes all fifteen outcomes',()=>{const r=run(prepare('reference'));expect(r.status).toBe(0);expect(r.stderr).toContain('15 pass\n 0 fail');});
test('current contract passes all fifteen outcomes',()=>{const r=run(prepare('current','HEAD',false));expect(r.status).toBe(0);expect(r.stderr).toContain('15 pass\n 0 fail');});
test('unused correct controls cannot repair admission',()=>{const cwd=prepare('unused');writeFileSync(join(cwd,controls+'.unused.ts'),source(controls));writeFileSync(join(cwd,controls),source(controls,item.base_ref));fails(run(cwd));});
test('equivalent private helper naming passes',()=>expect(mutant('equivalent',controls,source(controls).replace(/\bclampWindowsToIncludedAllowance\b/g,'boundedIncludedWindows')).status).toBe(0));
test('claimed admission without a persisted hold fails',()=>fails(mutant('no-hold',cap,replace(source(cap),'if (isZeroCostModel(model)) return { allowed: true, reservation: null };','return { allowed: true, reservation: null };'))));
test('blanket refusal loses healthy admission',()=>fails(mutant('blanket',cap,replace(source(cap),'if (isZeroCostModel(model)) return { allowed: true, reservation: null };','return { allowed: false, response: new Response("monthly_cost_limit_exceeded", {status:429}) };'))));
test('ignoring stricter private windows fails',()=>fails(mutant('private-bypass',controls,replace(source(controls),'Math.min(total, includedAllowance)','includedAllowance'))));
test('missing admission module is setup failure',()=>{const cwd=prepare('missing');rmSync(join(cwd,cap));const r=run(cwd);expect(r.status).toBe(1);expect(r.stderr).toContain('Cannot find module');expect(r.stderr).not.toContain('error: expect(');});
