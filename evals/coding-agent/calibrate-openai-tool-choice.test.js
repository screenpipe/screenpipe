// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import {afterAll,expect,test} from 'bun:test';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const repo=resolve(import.meta.dir,'../..'),item=JSON.parse(readFileSync(join(import.meta.dir,'cases.json'),'utf8')).cases.find(c=>c.id==='app-openai-stream-tool-choice');
const provider='packages/ai-gateway/src/providers/openai.ts',fixture='evals/coding-agent/graders/openai-tool-choice.test.js';
const root=mkdtempSync(join(tmpdir(),'openai-choice-calibration-'));afterAll(()=>rmSync(root,{recursive:true,force:true}));
const show=(ref,path)=>execFileSync('git',['show',`${ref}:${path}`],{cwd:repo,encoding:'utf8'});
function grade(name,ref=item.oracle_ref,mutate=()=>{}){
 const cwd=join(root,name);mkdirSync(cwd);const archive=execFileSync('git',['archive',ref,'packages/ai-gateway'],{cwd:repo,maxBuffer:32*1024*1024});execFileSync('tar',['-x','-C',cwd],{input:archive});mkdirSync(dirname(join(cwd,fixture)),{recursive:true});writeFileSync(join(cwd,fixture),readFileSync(join(repo,fixture)));mutate(cwd);
 const result=spawnSync(process.execPath,['test',fixture],{cwd,encoding:'utf8',timeout:20000,env:{PATH:dirname(process.execPath)}});
 if(process.env.EVAL_CALIBRATION_OUTPUT){const o=resolve(process.env.EVAL_CALIBRATION_OUTPUT);mkdirSync(o,{recursive:true});for(const k of ['stdout','stderr'])writeFileSync(join(o,name+'.'+k),result[k]??'');writeFileSync(join(o,name+'.json'),JSON.stringify({status:result.status,signal:result.signal,error:result.error?.message??null}));} return result;
}
function change(cwd,path,from,to){const file=join(cwd,path),s=readFileSync(file,'utf8');expect(s.split(from)).toHaveLength(2);writeFileSync(file,s.replace(from,to));}
function fail(r){expect(r.error).toBeUndefined();expect(r.signal).toBeNull();expect(r.status).toBe(1);expect(r.stderr).toContain('expect(received)');expect(r.stderr).not.toContain('Unhandled error');expect(r.stderr).not.toContain('Cannot find');}
function pass(r){expect(r.error).toBeUndefined();expect(r.status).toBe(0);expect(r.stderr).toContain('12 pass');}
function streamChoice(cwd,replacement){const p=join(cwd,provider),s=readFileSync(p,'utf8'),needle="tool_choice: body.tool_choice as ChatCompletionCreateParams['tool_choice'],",index=s.lastIndexOf(needle);expect(index).toBeGreaterThan(s.indexOf(needle));writeFileSync(p,s.slice(0,index)+replacement+s.slice(index+needle.length));}
test('parent loses five streaming policies and preserves seven outcomes',()=>{const r=grade('parent',item.base_ref);fail(r);expect(r.stderr).toContain('5 fail');expect(r.stderr).toContain('7 pass');});
test('reference passes',()=>pass(grade('reference')));
test('current passes',()=>pass(grade('current','HEAD')));
test('declared provider-only oracle repairs parent',()=>pass(grade('oracle-only',item.base_ref,d=>writeFileSync(join(d,provider),show(item.oracle_ref,provider)))));
test('unused correct provider cannot repair dispatch',()=>fail(grade('unused',item.base_ref,d=>writeFileSync(join(d,provider+'.unused.ts'),show(item.oracle_ref,provider)))));
test('equivalent conditional property passes',()=>pass(grade('equivalent',item.oracle_ref,d=>streamChoice(d,'...(body.tool_choice === undefined ? {} : { tool_choice: body.tool_choice }),'))));
test('forcing automatic tool policy is rejected',()=>fail(grade('forced-auto',item.oracle_ref,d=>streamChoice(d,"tool_choice: 'auto',"))));
test('forcing required tool policy is rejected',()=>fail(grade('forced-required',item.oracle_ref,d=>streamChoice(d,"tool_choice: 'required',"))));
test('losing schemas is rejected',()=>fail(grade('lost-tools',item.oracle_ref,d=>{const p=join(d,provider);writeFileSync(p,readFileSync(p,'utf8').replaceAll("tools: body.tools as ChatCompletionCreateParams['tools'],",'tools: [],'));})));
test('losing native stream fragments is rejected',()=>fail(grade('lost-fragments',item.oracle_ref,d=>change(d,provider,'const toolCalls = choice?.delta?.tool_calls;','const toolCalls = undefined;'))));
test('missing provider is setup failure',()=>{const r=grade('missing',item.oracle_ref,d=>rmSync(join(d,provider)));expect(r.status).toBe(1);expect(r.stderr).toContain('Cannot find module');expect(r.stderr).toContain('0 pass');});
