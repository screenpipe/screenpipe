// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import {afterAll,expect,test} from 'bun:test';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const repo=resolve(import.meta.dir,'../..'),root=mkdtempSync(join(tmpdir(),'certificate-calibration-'));
const item=JSON.parse(readFileSync(join(import.meta.dir,'cases.json'),'utf8')).cases.find(c=>c.id==='app-expired-certificate-recovery');
const source='apps/screenpipe-app-tauri/lib/chat/provider-errors.ts';
const show=ref=>execFileSync('git',['show',`${ref}:${source}`],{cwd:repo,encoding:'utf8'}),fixed=show(item.oracle_ref),broken=show(item.base_ref);
afterAll(()=>rmSync(root,{recursive:true,force:true}));
function grade(name,body,unused){
 const cwd=join(root,name);mkdirSync(cwd);execFileSync('tar',['-xf','-','-C',cwd],{input:execFileSync('git',['archive',item.base_ref,source],{cwd:repo,maxBuffer:32*1024*1024})});
 if(body===null)rmSync(join(cwd,source));else writeFileSync(join(cwd,source),body);
 if(unused)writeFileSync(join(cwd,source+'.unused.ts'),unused);
 for(const f of item.grader.fixtures){const dest=join(cwd,f.destination_path);mkdirSync(dirname(dest),{recursive:true});writeFileSync(dest,readFileSync(join(import.meta.dir,f.local_path)));}
 return spawnSync(process.execPath,['test',item.grader.fixtures[0].destination_path],{cwd,encoding:'utf8',timeout:15000,env:{PATH:process.env.PATH,HOME:cwd,NO_COLOR:'1'}});
}
function fails(r){expect(r.error).toBeUndefined();expect(r.signal).toBeNull();expect(r.status).toBe(1);expect(r.stderr).toContain('expect(received)');expect(r.stderr).not.toMatch(/Cannot find|ModuleNotFound|SyntaxError/);}
function replace(s,a,b){expect(s.split(a)).toHaveLength(2);return s.replace(a,b);}
test('parent fails five certificate outcomes and preserves six others',()=>{const r=grade('parent',broken);fails(r);expect(r.stderr).toContain('5 fail');expect(r.stderr).toContain('6 pass');});
test('reference passes all eleven outcomes',()=>{const r=grade('reference',fixed);expect(r.status).toBe(0);expect(r.stderr).toContain('11 pass');});
test('unused correct module cannot rescue broken exported interfaces',()=>fails(grade('unused',broken,fixed)));
test('equivalent case-insensitive exact predicate passes',()=>{const body=replace(fixed,'normalized === "error: certificate has expired"','/^error: certificate has expired$/i.test(errorStr)');expect(grade('equivalent',body).status).toBe(0);});
test('treating every unknown error as connectivity is rejected',()=>fails(grade('blanket',replace(fixed,'function isConnectionLikeError(errorStr: string): boolean {','function isConnectionLikeError(errorStr: string): boolean { return true;'))));
test('raw copy without recovery is rejected',()=>fails(grade('raw',replace(fixed,'export function buildCloudConnectionMessage(): string {','export function buildCloudConnectionMessage(): string { return "Error: certificate has expired";'))));
test('nonretryable connection presentation is rejected',()=>fails(grade('no-retry',replace(fixed,'return message ? { kind: "provider", message, retryable: true } : null;','return message ? { kind: "provider", message, retryable: false } : null;'))));
test('divergent message interface is rejected',()=>fails(grade('message',replace(fixed,'return buildProviderErrorPresentation(errorStr, preset)?.message ?? null;','return null;'))));
test('missing module is an import error',()=>{const r=grade('missing',null);expect(r.status).toBe(1);expect(r.stderr).toMatch(/Cannot find|ModuleNotFound/);expect(r.stderr).not.toContain('expect(received)');});
