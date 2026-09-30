// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import {afterAll,expect,test} from 'bun:test';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const repo=resolve(import.meta.dir,'../..'),root=mkdtempSync(join(tmpdir(),'eval-calibration-'));
const item=JSON.parse(readFileSync(join(import.meta.dir,'cases.json'),'utf8')).cases.find(c=>c.id==="app-continued-pipe-recording-directory");
const source="apps/screenpipe-app-tauri/lib/chat/pi-project-dir.ts",archive=["apps/screenpipe-app-tauri/lib/chat/pi-project-dir.ts", "apps/screenpipe-app-tauri/lib/events/types.ts"];
const show=(ref,path=source)=>execFileSync('git',['show',`${ref}:${path}`],{cwd:repo,encoding:'utf8'}),fixed=show(item.oracle_ref),broken=show(item.base_ref);
afterAll(()=>rmSync(root,{recursive:true,force:true}));
function grade(name,body=fixed,mutate=()=>{}){
 const cwd=join(root,name);mkdirSync(cwd);execFileSync('tar',['-xf','-','-C',cwd],{input:execFileSync('git',['archive',item.base_ref,...archive],{cwd:repo,maxBuffer:32*1024*1024})});
 if(body===null)rmSync(join(cwd,source));else writeFileSync(join(cwd,source),body);
 for(const f of item.grader.fixtures){const dest=join(cwd,f.destination_path);mkdirSync(dirname(dest),{recursive:true});writeFileSync(dest,readFileSync(join(import.meta.dir,f.local_path)));}
 mutate(cwd);return spawnSync(process.execPath,['test',item.grader.fixtures[0].destination_path],{cwd,encoding:'utf8',timeout:15000,env:{PATH:process.env.PATH,HOME:cwd,NO_COLOR:'1'}});
}
function fails(r){expect(r.error).toBeUndefined();expect(r.signal).toBeNull();expect(r.status).toBe(1);expect(r.stderr).toContain('expect(received)');expect(r.stderr).not.toMatch(/Cannot find|ModuleNotFound|SyntaxError|Unhandled error between tests/);expect(r.stderr).toContain('Ran 18 tests across 1 file');}
function replace(s,a,b){expect(s.split(a)).toHaveLength(2);return s.replace(a,b);}
test('parent fails intended outcomes and preserves neighboring behavior',()=>{const r=grade('parent',broken);fails(r);expect(r.stderr).toContain('7 fail');expect(r.stderr).toContain('11 pass');});
test('reference passes all outcomes',()=>{const r=grade('reference');expect(r.status).toBe(0);expect(r.stderr).toContain('18 pass');});
test('an unused correct implementation cannot rescue the caller',()=>fails(grade('unused',broken,cwd=>writeFileSync(join(cwd,source+'.unused.ts'),fixed))));
test('equivalent internal variable naming passes',()=>expect(grade('equivalent',fixed.replaceAll(/\bbaseDir\b/g,'workingRoot')).status).toBe(0));
test('unsafe names cannot reach a pipe directory',()=>fails(grade('unsafe',replace(fixed,'if (\n    pipeName.trim()', 'if (false && (\n    pipeName.trim()').replace('pipeName.includes("\\0")\n  )','pipeName.includes("\\0")\n  ))'))));
test('ordinary sessions cannot use the pipe path',()=>fails(grade('ordinary',replace(fixed,'if (!pipeName) return','if (false) return'))));
test('a stale cached recording root is rejected',()=>fails(grade('cached','let cached: any;\n'+replace(fixed,'await commands.getActiveDataDir()','await (cached ??= commands.getActiveDataDir())'))));
test('failed native lookup retains the default root',()=>fails(grade('fallback',replace(fixed,'} catch {','} catch { baseDir = "/wrong-root";'))));
test('missing source is a setup error',()=>{const r=grade('missing',null);expect(r.status).toBe(1);expect(r.stderr).toMatch(/Cannot find|ModuleNotFound/);expect(r.stderr).not.toContain('expect(received)');});
