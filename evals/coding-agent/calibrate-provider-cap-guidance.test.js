// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import {afterAll,expect,test} from 'bun:test';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const repo=resolve(import.meta.dir,'../..');
const item=JSON.parse(readFileSync(join(import.meta.dir,'cases.json'))).cases.find(c=>c.id==='ai-gateway-provider-cap-guidance');
const fixture=readFileSync(join(import.meta.dir,'graders/provider-cap-guidance.fixture.ts.txt'));
const root=mkdtempSync(join(tmpdir(),'provider-cap-calibration-'));
afterAll(()=>rmSync(root,{recursive:true,force:true}));
function grade(name){
 const cwd=join(root,name);mkdirSync(cwd);
 const ref=['parent','unused'].includes(name)?item.base_ref:name==='current'?'HEAD':item.oracle_ref;
 const paths=['packages/ai-gateway/src'];
 const extension='crates/screenpipe-core/assets/extensions/lib';
 if(execFileSync('git',['ls-tree',ref,'--',extension],{cwd:repo,encoding:'utf8'}).trim())paths.push(extension);
 execFileSync('tar',['-x','-C',cwd],{input:execFileSync('git',['archive',ref,...paths],{cwd:repo,maxBuffer:32*1024*1024})});
 const service=join(cwd,'packages/ai-gateway/src/handlers/chat.ts');let source=readFileSync(service,'utf8');
 function change(from,to){expect(source.split(from)).toHaveLength(2);source=source.replace(from,to)}
 if(name==='unused')writeFileSync(service+'.unused.ts',execFileSync('git',['show',`${item.oracle_ref}:packages/ai-gateway/src/handlers/chat.ts`],{cwd:repo}));
 if(name==='leak')change('error.userMessage = `${model} is temporarily at capacity (the provider\'s usage limit was reached). Pick Auto or a model from a different provider, or try again later.`;','error.userMessage = msg;');
 if(name==='blanket')change('if (isProviderUsageCapped(status, msg)) {','if (status === 400) {');
 if(name==='no-fallback')change('const fallbacks = MODEL_FALLBACKS[body.model];','const fallbacks: string[] | undefined = undefined;');
 if(name==='lost-tools')change('const reqBody = { ...body, model };','const reqBody = { ...body, model }; delete reqBody.tools;');
 if(name==='alerts')change('if (isProviderUsageCapped(status, msg)) {','if (isProviderUsageCapped(status, msg)) { captureException(error);');
 if(name==='equivalent'){
  expect(source).toContain('isProviderUsageCapped');source=source.replaceAll('isProviderUsageCapped','providerBudgetUnavailable');
  change('error.userMessage = `${model} is temporarily at capacity (the provider\'s usage limit was reached). Pick Auto or a model from a different provider, or try again later.`;',"error.userMessage = 'The provider reached its usage limit. Try again later or select a different provider.';");
 }
 writeFileSync(service,source);if(name==='missing')rmSync(service);
 writeFileSync(join(cwd,'packages/ai-gateway/src/test/eval-provider-cap.test.ts'),fixture);
 symlinkSync(join(repo,'packages/ai-gateway/node_modules'),join(cwd,'packages/ai-gateway/node_modules'),'dir');
 const result=spawnSync(process.execPath,['--no-env-file','test','src/test/eval-provider-cap.test.ts'],{cwd:join(cwd,'packages/ai-gateway'),encoding:'utf8',timeout:15000,env:{PATH:dirname(process.execPath),HOME:cwd,CI:'true'}});
 if(process.env.EVAL_CALIBRATION_RESULTS){const out=resolve(process.env.EVAL_CALIBRATION_RESULTS);mkdirSync(out,{recursive:true});for(const ext of ['stdout','stderr'])writeFileSync(join(out,name+'.'+ext),result[ext]||'');writeFileSync(join(out,name+'.json'),JSON.stringify({status:result.status,signal:result.signal,error:result.error?.message||null})+'\n')}
 return result;
}
function fails(r){expect(r.error).toBeUndefined();expect(r.signal).toBeNull();expect(r.status).toBe(1);expect(r.stderr).toContain('expect(received)');expect(r.stderr).not.toContain('Cannot find module')}
test('parent fails three guidance outcomes and preserves six',()=>{const r=grade('parent');fails(r);expect(r.stderr).toContain('3 fail');expect(r.stderr).toContain('6 pass')});
for(const name of ['reference','current','equivalent'])test(name+' passes nine outcomes',()=>{const r=grade(name);expect(r.error).toBeUndefined();expect(r.status).toBe(0);expect(r.stderr).toContain('9 pass')});
for(const name of ['unused','leak','blanket','no-fallback','lost-tools','alerts'])test(name+' is rejected',()=>fails(grade(name)));
test('missing handler is a setup error',()=>{const r=grade('missing');expect(r.status).not.toBe(0);expect(r.stderr).toContain('Cannot find module');expect(r.stderr).not.toContain('expect(received)')});
