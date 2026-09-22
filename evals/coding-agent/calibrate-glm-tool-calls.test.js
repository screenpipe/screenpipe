// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import {afterAll,expect,test} from 'bun:test';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const repo=resolve(import.meta.dir,'../..'),item=JSON.parse(readFileSync(join(import.meta.dir,'cases.json'),'utf8')).cases.find(c=>c.id==='ai-gateway-glm-tool-call-boundary');
const provider='packages/ai-gateway/src/providers/screenpipe-glm.ts',openai='packages/ai-gateway/src/providers/openai.ts',fixture='evals/coding-agent/graders/glm-tool-call-boundary.test.js';
const root=mkdtempSync(join(tmpdir(),'glm-call-calibration-'));afterAll(()=>rmSync(root,{recursive:true,force:true}));
const show=(ref,path)=>execFileSync('git',['show',`${ref}:${path}`],{cwd:repo,encoding:'utf8'});
function grade(name,ref=item.oracle_ref,mutate=()=>{}){
 const cwd=join(root,name);mkdirSync(cwd);const archive=execFileSync('git',['archive',ref,'packages/ai-gateway'],{cwd:repo,maxBuffer:32*1024*1024});execFileSync('tar',['-x','-C',cwd],{input:archive});mkdirSync(dirname(join(cwd,fixture)),{recursive:true});writeFileSync(join(cwd,fixture),readFileSync(join(repo,fixture)));mutate(cwd);
 return spawnSync(process.execPath,['test',fixture],{cwd,encoding:'utf8',timeout:20000,env:{PATH:dirname(process.execPath)}});
}
function change(cwd,path,from,to){const file=join(cwd,path),s=readFileSync(file,'utf8');expect(s.split(from)).toHaveLength(2);writeFileSync(file,s.replace(from,to));}
function fail(r){expect(r.error).toBeUndefined();expect(r.signal).toBeNull();expect(r.status).toBe(1);expect(r.stderr).toContain('expect(received)');expect(r.stderr).not.toContain('Unhandled error');expect(r.stderr).not.toContain('Cannot find');}
test('parent fails fifteen conversions and preserves twenty-seven neighbors',()=>{const r=grade('parent',item.base_ref);fail(r);expect(r.stderr).toContain('15 fail');expect(r.stderr).toContain('27 pass');});
test('reference passes forty-two provider outcomes',()=>{const r=grade('reference');expect(r.status).toBe(0);expect(r.stderr).toContain('42 pass');});
test('equivalent parser name is accepted',()=>{const r=grade('rename',item.oracle_ref,cwd=>writeFileSync(join(cwd,provider),show(item.oracle_ref,provider).replaceAll('parseGlmToolCallContent','parseDeclaredResponse')));expect(r.status).toBe(0);});
test('valid extra finish metadata on native and ordinary completions is accepted',()=>{const r=grade('finish-metadata',item.oracle_ref,cwd=>change(cwd,openai,'\t\t\tchoices: [\n\t\t\t\t{\n\t\t\t\t\tmessage: {','\t\t\tchoices: [\n\t\t\t\t{\n\t\t\t\t\tfinish_reason: response.choices[0].finish_reason,\n\t\t\t\t\tmessage: {'));expect(r.status).toBe(0);});
test('unused correct provider cannot repair unchanged dispatch',()=>fail(grade('unused',item.base_ref,cwd=>writeFileSync(join(cwd,'packages/ai-gateway/src/providers/unused-glm.ts'),show(item.oracle_ref,provider)))));
test('completion conversion bypass is rejected',()=>fail(grade('completion-bypass',item.oracle_ref,cwd=>change(cwd,provider,'const payload: any = await response.json();','return response;\n\t\tconst payload: any = await response.json();'))));
test('stream conversion bypass is rejected',()=>fail(grade('stream-bypass',item.oracle_ref,cwd=>change(cwd,provider,'return normalizeGlmToolCallStream(stream, body.tools);','return stream;'))));
test('unknown JSON tool names cannot become calls',()=>fail(grade('unknown-json',item.oracle_ref,cwd=>change(cwd,provider,"typeof name !== 'string' || !knownTools.has(name)","typeof name !== 'string'"))));
test('unknown XML names cannot borrow a known tool schema',()=>fail(grade('unknown-xml',item.oracle_ref,cwd=>change(cwd,provider,'const tool = knownTools.get(name);','const tool = knownTools.get(name) || knownTools.values().next().value;'))));
test('dropping conversion finish reason is rejected',()=>fail(grade('finish-missing',item.oracle_ref,cwd=>change(cwd,provider,"payload.choices[0].finish_reason = 'tool_calls';","payload.choices[0].finish_reason = 'stop';"))));
test('duplicate IDs for multiple calls are rejected',()=>fail(grade('duplicate-ids',item.oracle_ref,cwd=>change(cwd,provider,"`call_glm_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`","'same-call'"))));
test('string coercion of typed arguments is rejected',()=>fail(grade('string-args',item.oracle_ref,cwd=>change(cwd,provider,'return JSON.parse(value);','return value;'))));
test('blanket parser refusal is rejected',()=>fail(grade('deny-all',item.oracle_ref,cwd=>change(cwd,provider,"if (typeof content !== 'string' || !Array.isArray(tools)) return [];","return [];\n\tif (typeof content !== 'string' || !Array.isArray(tools)) return [];"))));
test('missing provider is setup failure',()=>{const r=grade('missing',item.oracle_ref,cwd=>rmSync(join(cwd,provider)));expect(r.status).toBe(1);expect(r.stderr).toContain('Cannot find module');expect(r.stderr).toContain('0 pass');});
