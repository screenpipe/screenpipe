// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import {afterAll,expect,test} from 'bun:test';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const repo=resolve(import.meta.dir,'../..'),root=mkdtempSync(join(tmpdir(),'image-cache-calibration-'));
const item=JSON.parse(readFileSync(join(import.meta.dir,'cases.json'),'utf8')).cases.find(c=>c.id==='ai-gateway-image-cache-boundary');
const source='packages/ai-gateway/src/providers/openai.ts';
const show=ref=>execFileSync('git',['show',`${ref}:${source}`],{cwd:repo,encoding:'utf8'}),fixed=show(item.oracle_ref),broken=show(item.base_ref);
afterAll(()=>rmSync(root,{recursive:true,force:true}));
function grade(name,body,unused){
 const cwd=join(root,name);mkdirSync(cwd);execFileSync('tar',['-xf','-','-C',cwd],{input:execFileSync('git',['archive',item.base_ref,'packages/ai-gateway/src'],{cwd:repo,maxBuffer:32*1024*1024})});
 if(body===null)rmSync(join(cwd,source));else writeFileSync(join(cwd,source),body);
 if(unused)writeFileSync(join(cwd,source+'.unused.ts'),unused);
 for(const f of item.grader.fixtures){const dest=join(cwd,f.destination_path);mkdirSync(dirname(dest),{recursive:true});writeFileSync(dest,readFileSync(join(import.meta.dir,f.local_path)));}
 return spawnSync(process.execPath,['test',item.grader.fixtures[0].destination_path],{cwd,encoding:'utf8',timeout:15000,env:{PATH:process.env.PATH,HOME:cwd,NO_COLOR:'1'}});
}
function fails(r){expect(r.error).toBeUndefined();expect(r.signal).toBeNull();expect(r.status).toBe(1);expect(r.stderr).toContain('expect(received)');expect(r.stderr).not.toMatch(/Cannot find|ModuleNotFound|SyntaxError/);}
function replace(s,a,b){expect(s.split(a)).toHaveLength(2);return s.replace(a,b);}
test('parent fails eight image boundaries and preserves six outcomes',()=>{const r=grade('parent',broken);fails(r);expect(r.stderr).toContain('8 fail');expect(r.stderr).toContain('6 pass');});
test('reference passes all fourteen provider outcomes',()=>{const r=grade('reference',fixed);expect(r.status).toBe(0);expect(r.stderr).toContain('14 pass');});
test('equivalent predicate naming passes',()=>expect(grade('renamed',fixed.replaceAll('isCacheableContentPart','canCacheTextPart')).status).toBe(0));
test('unused correct provider cannot rescue the broken entrypoint',()=>fails(grade('unused',broken,fixed)));
for(const stream of [false,true])test(`reintroducing image markers in ${stream?'streaming':'nonstreaming'} is rejected`,()=>{
 const target='await applyGpt56PromptCaching(params, body.gpt56HistoryCacheEligible === true);';expect(fixed.split(target)).toHaveLength(3);
 const body=fixed.replaceAll(target,target+` if(params.stream === ${stream} && body.gpt56HistoryCacheEligible) for(const m of params.messages) if(Array.isArray(m.content)) for(const p of m.content) if(p.type==='image_url') (p as any).prompt_cache_breakpoint={mode:'explicit'};`);fails(grade('readd-'+stream,body));
});
test('dropping images from completion requests is rejected',()=>fails(grade('drop',replace(fixed,'const messages = this.formatMessages(body.messages);','const messages = this.formatMessages(body.messages).map(m=>({...m,content:Array.isArray(m.content)?m.content.filter(p=>p.type!=="image_url"):m.content}));'))));
test('turning off all caching is rejected',()=>fails(grade('disable',replace(fixed,'function markLastCacheableContent(message: ChatCompletionMessageParam): boolean {','function markLastCacheableContent(message: ChatCompletionMessageParam): boolean { return false;'))));
test('missing provider is an import error',()=>{const r=grade('missing',null);expect(r.status).toBe(1);expect(r.stderr).toMatch(/Cannot find|ModuleNotFound/);expect(r.stderr).not.toContain('expect(received)');});
