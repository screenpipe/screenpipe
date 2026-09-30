// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import {afterAll, expect, test} from 'bun:test';
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const repo=resolve(import.meta.dir,'../..');
const item=JSON.parse(readFileSync(join(import.meta.dir,'cases.json'))).cases.find(c=>c.id==='app-attachment-owner-handoff');
const root=mkdtempSync(join(tmpdir(),'attachment-owner-calibration-'));
afterAll(()=>rmSync(root,{recursive:true,force:true}));
function grade(name){
 const cwd=join(root,name),desktop=join(cwd,'apps/screenpipe-app-tauri');mkdirSync(cwd);
 const ref=['parent','unused'].includes(name)?item.base_ref:item.oracle_ref;
 execFileSync('tar',['-x','-C',cwd],{input:execFileSync('git',['archive',ref,'apps/screenpipe-app-tauri/components','apps/screenpipe-app-tauri/lib','apps/screenpipe-app-tauri/package.json','apps/screenpipe-app-tauri/tsconfig.json'],{cwd:repo,maxBuffer:32*1024*1024})});
 const hook=join(desktop,'components/chat/standalone/hooks/use-chat-attachments.ts');
 const replace=(before,after)=>{const text=readFileSync(hook,'utf8');expect(text.split(before)).toHaveLength(2);writeFileSync(hook,text.replace(before,after));};
 if(name==='unused')writeFileSync(hook+'.unused.ts',execFileSync('git',['show',`${item.oracle_ref}:apps/screenpipe-app-tauri/components/chat/standalone/hooks/use-chat-attachments.ts`],{cwd:repo}));
 if(name==='unscoped')replace('if (scopeDrops && "position" in event.payload)', 'if (false && "position" in event.payload)');
 if(name==='wrong-owner')replace('updateSessionDraftField<K, T>(owner, key, update)','updateSessionDraftField<K, T>(sessionIdRef?.current ?? owner, key, update)');
 if(name==='blanket')replace('const handleFilePicker = useCallback(async () => {','const handleFilePicker = useCallback(async () => { return;');
 if(name==='equivalent'){const text=readFileSync(hook,'utf8');expect(text).toContain('captureAttachmentWriters');writeFileSync(hook,text.replaceAll('captureAttachmentWriters','captureOriginalDraftSetters'));}
 if(name==='missing')rmSync(hook);
 for(const fixture of item.grader.fixtures){const dest=join(cwd,fixture.destination_path);mkdirSync(dirname(dest),{recursive:true});writeFileSync(dest,readFileSync(join(import.meta.dir,fixture.local_path)));}
 symlinkSync(join(repo,'apps/screenpipe-app-tauri/node_modules'),join(desktop,'node_modules'),'dir');
 const result=spawnSync(process.execPath,['x','--no-install','vitest','run','--config','eval-attachment-owner.config.mjs'],{cwd:desktop,encoding:'utf8',timeout:60000,env:{PATH:process.env.PATH,HOME:cwd,CI:'true',NO_COLOR:'1'}});
 if(process.env.EVAL_CALIBRATION_RESULTS){const out=resolve(process.env.EVAL_CALIBRATION_RESULTS);mkdirSync(out,{recursive:true});for(const ext of ['stdout','stderr'])writeFileSync(join(out,name+'.'+ext),result[ext]||'');writeFileSync(join(out,name+'.json'),JSON.stringify({status:result.status,signal:result.signal,error:result.error?.message||null})+'\n');}
 return result;
}
function fails(r){expect(r.error).toBeUndefined();expect(r.signal).toBeNull();expect(r.status).toBe(1);expect(r.stderr).toContain('AssertionError');expect(r.stderr).not.toContain('Failed to resolve import');}
test('parent has three intended failures with five preserved outcomes',()=>{const r=grade('parent');fails(r);expect(r.stdout).toContain('3 failed');expect(r.stdout).toContain('5 passed');});
test('reference passes eight outcomes',()=>{const r=grade('reference');expect(r.status).toBe(0);expect(r.stdout).toContain('8 passed');});
test('unused correct code does not fix the hook',()=>fails(grade('unused')));
test('window-wide drop bypass fails pane ownership',()=>fails(grade('unscoped')));
test('late current-chat write fails original ownership',()=>fails(grade('wrong-owner')));
test('blanket picker suppression loses valid attachments',()=>fails(grade('blanket')));
test('equivalent private helper name passes',()=>expect(grade('equivalent').status).toBe(0));
test('missing hook is a setup failure, not baseline behavior',()=>{const r=grade('missing');expect(r.status).not.toBe(0);expect(r.stderr).toContain('Failed to resolve import');expect(r.stderr).not.toContain('AssertionError');});
