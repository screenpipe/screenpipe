// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const repo=resolve(import.meta.dir,'../..');
const item=JSON.parse(readFileSync(join(import.meta.dir,'cases.json'))).cases.find(c=>c.id==='ai-gateway-paid-tts-dispatch');
const root=mkdtempSync(join(tmpdir(),'paid-tts-calibration-'));
afterAll(()=>rmSync(root,{recursive:true,force:true}));
const template=join(root,'template');mkdirSync(template);
const archive=execFileSync('git',['archive',item.oracle_ref,'packages/ai-gateway/src'],{cwd:repo,maxBuffer:16*1024*1024});
execFileSync('tar',['-x','-C',template],{input:archive});
const indexPath='packages/ai-gateway/src/index.ts';
const fixed=readFileSync(join(template,indexPath),'utf8');
const broken=execFileSync('git',['show',`${item.base_ref}:${indexPath}`],{cwd:repo,encoding:'utf8'});
const graderPath='evals/coding-agent/graders/paid-tts-dispatch.test.js';
const grader=readFileSync(join(repo,graderPath));
const gate="if (path === '/v1/text-to-speech' && request.method === 'POST') {\n\t\t\tconst gate = paidHostedAiRouteError(authResult);\n\t\t\tif (gate) return gate;";
function change(from,to){expect(fixed.split(from)).toHaveLength(2);return fixed.replace(from,to);}
function grade(name,source=fixed,unused=false){
 const cwd=join(root,name);cpSync(template,cwd,{recursive:true});
 if(source===null)rmSync(join(cwd,indexPath));else writeFileSync(join(cwd,indexPath),source);
 if(unused)writeFileSync(join(cwd,'unused-correct-dispatcher.ts'),fixed);
 symlinkSync(join(repo,'packages/ai-gateway/node_modules'),join(cwd,'packages/ai-gateway/node_modules'),'dir');
 mkdirSync(dirname(join(cwd,graderPath)),{recursive:true});writeFileSync(join(cwd,graderPath),grader);
 return spawnSync(process.execPath,['test',graderPath],{cwd,encoding:'utf8',timeout:15000,env:{PATH:dirname(process.execPath)}});
}
function fails(r){expect(r.error).toBeUndefined();expect(r.signal).toBeNull();expect(r.status).toBe(1);expect(r.stderr).toContain('expect(received)');expect(r.stderr).not.toContain('Cannot find module');}
test('broken parent fails three access outcomes and preserves four',()=>{const r=grade('parent',broken);fails(r);expect(r.stderr).toContain('3 fail');expect(r.stderr).toContain('4 pass');});
test('historical reference passes seven outcomes',()=>{const r=grade('reference');expect(r.status).toBe(0);expect(r.stderr).toContain('7 pass');});
test('unused correct dispatcher does not repair actual caller',()=>fails(grade('unused',broken,true)));
test('equivalent private binding name passes',()=>{const s=fixed.replace('paidHostedAiRouteError,','paidHostedAiRouteError as paidSpeechGate,').replaceAll('paidHostedAiRouteError(authResult)','paidSpeechGate(authResult)');expect(grade('rename',s).status).toBe(0);});
test('ignoring the real gate is rejected',()=>fails(grade('ignored',change(gate,gate.replace('if (gate) return gate;','void gate;')))));
test('provider work before a refusal is rejected',()=>fails(grade('late',change(gate,gate.replace('if (gate) return gate;','if (gate) { await handleTextToSpeech(request, env); return gate; }')))));
test('blanket refusal loses paid preserved behavior',()=>fails(grade('deny',change(gate,gate+'\n\t\t\treturn new Response("blocked",{status:401});'))));
test('response-only audio without provider effect is rejected',()=>fails(grade('fake',change('return await handleTextToSpeech(request, env);','return new Response(new Uint8Array([82,73,70,70,4,0,0,0,87,65,86,69]), {headers:{"content-type":"audio/wav"}});'))));
test('missing dispatcher is setup failure',()=>{const r=grade('missing',null);expect(r.status).not.toBe(0);expect(r.stderr).toContain('Cannot find module');expect(r.stderr).not.toContain('expect(received)');});
