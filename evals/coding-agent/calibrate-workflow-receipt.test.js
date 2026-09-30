// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import {afterAll,expect,test} from 'bun:test';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const repo=resolve(import.meta.dir,'../..'),root=mkdtempSync(join(tmpdir(),'workflow-receipt-calibration-'));
const item=JSON.parse(readFileSync(join(import.meta.dir,'cases.json'),'utf8')).cases.find(c=>c.id==='app-workflow-save-receipt-boundary');
const source='crates/screenpipe-core/assets/extensions/workflow-workspace.ts';
const show=ref=>execFileSync('git',['show',`${ref}:${source}`],{cwd:repo,encoding:'utf8'}),fixed=show(item.oracle_ref),broken=show(item.base_ref);
afterAll(()=>rmSync(root,{recursive:true,force:true}));
function grade(name,body,unused){
 const cwd=join(root,name);mkdirSync(cwd);execFileSync('tar',['-xf','-','-C',cwd],{input:execFileSync('git',['archive',item.base_ref,source,'crates/screenpipe-core/assets/extensions/lib/glm-protocol.ts'],{cwd:repo,maxBuffer:32*1024*1024})});
 if(body===null)rmSync(join(cwd,source));else writeFileSync(join(cwd,source),body);
 if(unused)writeFileSync(join(cwd,source+'.unused.ts'),unused);
 for(const f of item.grader.fixtures){const dest=join(cwd,f.destination_path);mkdirSync(dirname(dest),{recursive:true});writeFileSync(dest,readFileSync(join(import.meta.dir,f.local_path)));}
 return spawnSync(process.execPath,['test',item.grader.fixtures[0].destination_path],{cwd,encoding:'utf8',timeout:15000,env:{PATH:process.env.PATH,HOME:cwd,NO_COLOR:'1'}});
}
function fails(r){expect(r.error).toBeUndefined();expect(r.signal).toBeNull();expect(r.status).toBe(1);expect(r.stderr).toContain('expect(received)');expect(r.stderr).not.toMatch(/Cannot find|ModuleNotFound|Export named .* not found/);expect(r.stderr).toContain('Ran 14 tests across 1 file');expect(r.stderr).not.toMatch(/\n \d+ errors?\n/);}
function replace(s,a,b){expect(s.split(a)).toHaveLength(2);return s.replace(a,b);}
test('parent fails eleven workflow outcomes and preserves three',()=>{const r=grade('parent',broken);fails(r);expect(r.stderr).toContain('11 fail');expect(r.stderr).toContain('3 pass');});
test('reference passes fourteen outcomes',()=>{const r=grade('reference',fixed);expect(r.status).toBe(0);expect(r.stderr).toContain('14 pass');});
test('unused extension cannot repair the registered tool',()=>fails(grade('unused',broken,fixed)));
test('equivalent internal request function name passes',()=>expect(grade('equivalent',fixed.replaceAll(/\bcall\b/g,'requestWorkspace')).status).toBe(0));
test('returning error-shaped success instead of rejecting is caught',()=>fails(grade('swallow',replace(fixed,'throw new Error(`Workflow operation failed: ${error.message}`);','return {isError:true,content:[{type:"text",text:error.message}],details:{saved:false}};'))));
test('old large inline threshold loses medium transport context',()=>fails(grade('threshold',replace(fixed,'text.length > 8_000','text.length > 24_000'))));
test('world-readable snapshots are rejected',()=>fails(grade('permissions',replace(fixed,'{mode:0o600}','{mode:0o644}'))));
test('discarding remaining-work state is rejected',()=>fails(grade('remaining',fixed.replaceAll('remaining:', 'discarded:'))));
test('successful save must survive a failed follow-up read',()=>fails(grade('follow-up',replace(fixed,'result = {...result, remaining: {unavailable:true, next:','throw new Error("follow-up read failed"); result = {...result, remaining: {unavailable:true, next:'))));
test('retrying successful mutation after read failure is rejected',()=>fails(grade('repeat-save',replace(fixed,'result = {...result, remaining: {unavailable:true, next:','await call("/workflows/workspace", {...input,task}); result = {...result, remaining: {unavailable:true, next:'))));
test('missing extension remains an import failure',()=>{const r=grade('missing',null);expect(r.status).toBe(1);expect(r.stderr).toMatch(/Cannot find|ModuleNotFound/);expect(r.stderr).not.toContain('expect(received)');});

// A correct implementation may validate optimistic-concurrency inputs before I/O.
test('valid revision guards do not turn fixture omissions into product failures',()=>{
 const guarded=replace(fixed,'const permissions =',`
 if (input.action !== "context" && input.action !== "start" && (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 0)) throw new Error("expected revision required");
 if (input.action === "publish" && (!Number.isSafeInteger(input.catalog_revision) || input.catalog_revision < 0)) throw new Error("catalog revision required");
 const permissions =`);
 const r=grade('revision-guard',guarded);
 expect(r.status).toBe(0);expect(r.stderr).toContain('14 pass');
});
