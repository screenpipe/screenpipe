// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const repo=resolve(import.meta.dir,'../..');
const item=JSON.parse(readFileSync(join(import.meta.dir,'cases.json'))).cases.find(c=>c.id==='ai-gateway-trusted-runner-admission');
const root=mkdtempSync(join(tmpdir(),'trusted-runner-calibration-'));
afterAll(()=>rmSync(root,{recursive:true,force:true}));
const template=join(root,'reference');mkdirSync(template);
execFileSync('tar',['-x','-C',template],{input:execFileSync('git',['archive',item.oracle_ref,'packages/ai-gateway/src'],{cwd:repo,maxBuffer:16*1024*1024})});
const index='packages/ai-gateway/src/index.ts',free='packages/ai-gateway/src/services/free-chat-limit.ts',auth='packages/ai-gateway/src/utils/auth.ts';
const sources=Object.fromEntries([index,free,auth].map(p=>[p,readFileSync(join(template,p),'utf8')]));
const broken=Object.fromEntries([index,free].map(p=>[p,execFileSync('git',['show',`${item.base_ref}:${p}`],{cwd:repo,encoding:'utf8'})]));
const fixture='packages/ai-gateway/src/test/eval-trusted-runner.test.ts';
const bytes=readFileSync(join(import.meta.dir,'graders/trusted-runner-admission.fixture.ts.txt'));
function replace(path,from,to){expect(sources[path].split(from)).toHaveLength(2);return sources[path].replace(from,to);}
function grade(name,changes={},unused=false){
 const cwd=join(root,name);cpSync(template,cwd,{recursive:true});
 for(const [p,value] of Object.entries(changes)){if(value===null)rmSync(join(cwd,p));else writeFileSync(join(cwd,p),value);}
 if(unused)writeFileSync(join(cwd,'unused-correct-entrypoint.ts'),sources[index]);
 symlinkSync(join(repo,'packages/ai-gateway/node_modules'),join(cwd,'packages/ai-gateway/node_modules'),'dir');
 writeFileSync(join(cwd,fixture),bytes);
 const result=spawnSync(process.execPath,['test',fixture],{cwd,encoding:'utf8',timeout:15000,env:{PATH:dirname(process.execPath)}});
 const receipts=process.env.EVAL_CALIBRATION_RESULTS_DIR;
 if(receipts){mkdirSync(receipts,{recursive:true});writeFileSync(join(receipts,name+'.stdout'),result.stdout??'');writeFileSync(join(receipts,name+'.stderr'),result.stderr??'');}
 return result;
}
function fails(r){expect(r.error).toBeUndefined();expect(r.signal).toBeNull();expect(r.status).toBe(1);expect(r.stderr).toContain('expect(received)');expect(r.stderr).not.toContain('Cannot find module');}
test('parent fails five intended outcomes and preserves nine',()=>{const r=grade('parent',broken);fails(r);expect(r.stderr).toContain('5 fail');expect(r.stderr).toContain('9 pass');});
test('reference passes fourteen outcomes',()=>{const r=grade('fixed');expect(r.status).toBe(0);expect(r.stderr).toContain('14 pass');});
test('unused correct entrypoint cannot repair the route',()=>fails(grade('unused',broken,true)));
test('only the outer guard repaired is insufficient',()=>fails(grade('outer-only',{[free]:broken[free]})));
test('only the Free gate repaired is insufficient',()=>fails(grade('inner-only',{[index]:broken[index]})));
test('equivalent explicit service predicate passes',()=>{const r=grade('equivalent',{[index]:replace(index,'(!authResult.userId && authResult.service !== true)','!(authResult.userId || authResult.service === true)'),[free]:replace(free,'auth.service === true && hasPaidHostedAiPlan(auth)','hasPaidHostedAiPlan(auth) && auth.service === true')});expect(r.status).toBe(0);});
test('client headers cannot manufacture service authority',()=>fails(grade('header-bypass',{[auth]:replace(auth,'env.AI_GATEWAY_SERVICE_TOKEN && token === env.AI_GATEWAY_SERVICE_TOKEN',"env.AI_GATEWAY_SERVICE_TOKEN && (token === env.AI_GATEWAY_SERVICE_TOKEN || request.headers.get('x-device-id') === 'cloud-runner')")})));
test('credential prefix acceptance is rejected',()=>fails(grade('prefix',{[auth]:replace(auth,'token === env.AI_GATEWAY_SERVICE_TOKEN','token.startsWith(env.AI_GATEWAY_SERVICE_TOKEN)')})));
test('blanket service refusal is rejected',()=>fails(grade('deny',{[index]:replace(index,"if (path === '/v1/chat/completions' && request.method === 'POST') {","if (path === '/v1/chat/completions' && request.method === 'POST') {\n if (authResult.service) return new Response('denied',{status:401});")})));
test('fabricated successful response without provider effect is rejected',()=>fails(grade('fake',{[index]:replace(index,"if (path === '/v1/chat/completions' && request.method === 'POST') {","if (path === '/v1/chat/completions' && request.method === 'POST') {\n if (authResult.service) return Response.json({choices:[{message:{content:'synthetic accepted response'}}]});")})));
test('ignoring rate refusal is rejected',()=>fails(grade('rate',{[index]:sources[index].replaceAll('if (!rateLimit.allowed && rateLimit.response) {','if (false && !rateLimit.allowed && rateLimit.response) {')})));
test('missing route is setup error, not intended baseline failure',()=>{const r=grade('missing',{[index]:null});expect(r.status).not.toBe(0);expect(r.stderr).toContain('Cannot find module');expect(r.stderr).not.toContain('expect(received)');});
