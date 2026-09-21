// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
const repo=resolve(import.meta.dir,'../..'), app='apps/screenpipe-app-tauri';
const item=JSON.parse(readFileSync(join(import.meta.dir,'cases.json'),'utf8')).cases.find(c=>c.id==='app-meeting-summary-handoff');
const note=`${app}/components/meeting-notes/note-view.tsx`, surface=`${app}/components/meeting-notes/meeting-workspace.tsx`;
const root=mkdtempSync(join(tmpdir(),'meeting-handoff-calibration-')), archives=new Map();
const paths=['components','lib','package.json','tsconfig.json'].map(p=>`${app}/${p}`).concat('crates/screenpipe-core/assets/acp/agents.json');
afterAll(()=>rmSync(root,{recursive:true,force:true}));
function change(cwd,path,from,to){const p=join(cwd,path),s=readFileSync(p,'utf8');expect(s.split(from)).toHaveLength(2);writeFileSync(p,s.replace(from,to));}
function grade(name,ref=item.oracle_ref,mutate=()=>{}) {
 const cwd=join(root,name);mkdirSync(cwd);
 if(!archives.has(ref)) archives.set(ref,execFileSync('git',['archive',ref,...paths],{cwd:repo,maxBuffer:128*1024*1024}));
 execFileSync('tar',['-x','-C',cwd],{input:archives.get(ref)});
 for(const f of item.grader.fixtures)writeFileSync(join(cwd,f.destination_path),readFileSync(join(import.meta.dir,f.local_path)));
 symlinkSync(join(repo,app,'node_modules'),join(cwd,app,'node_modules'),'dir');mutate(cwd);
 return spawnSync('/bin/bash',['-c',item.grader.command],{cwd,encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024});
}
function fails(r){expect(r.error).toBeUndefined();expect(r.signal).toBeNull();expect(r.status).toBe(1);expect(r.stdout+r.stderr).toMatch(/AssertionError|Unable to find an element/);expect(r.stdout+r.stderr).not.toMatch(/Failed to resolve import|Failed to load url|Cannot find module|No .* export is defined/);}
test('parent has five intended failures and four preserved outcomes',()=>{const r=grade('parent',item.base_ref);fails(r);expect(r.stdout).toContain('5 failed | 4 passed');},120000);
test('reference passes nine real component outcomes',()=>{const r=grade('reference');expect(r.status).toBe(0);expect(r.stdout).toContain('9 passed');},120000);
test('equivalent helper naming is accepted',()=>{const r=grade('renamed',item.oracle_ref,cwd=>{for(const p of [note,surface])writeFileSync(join(cwd,p),readFileSync(join(cwd,p),'utf8').replaceAll('meetingSummarySaveIsVisible','summaryReadHasCaughtUp'));});expect(r.status).toBe(0);},120000);
test('a correct unused helper cannot conceal the broken note caller',()=>fails(grade('old-caller',item.oracle_ref,cwd=>writeFileSync(join(cwd,note),execFileSync('git',['show',`${item.base_ref}:${note}`],{cwd:repo})))),120000);
test('discarding the completed stream in the surface is rejected',()=>fails(grade('old-surface',item.oracle_ref,cwd=>change(cwd,surface,'(state === "working" || state === "ready")','state === "working"'))),120000);
test('accepting stale reads is rejected',()=>fails(grade('stale',item.oracle_ref,cwd=>change(cwd,surface,'return !awaitedNewSummary || refreshedNote !== currentNote;','return true;'))),120000);
test('marking completion before the note read prevents retries and is rejected',()=>fails(grade('early-mark',item.oracle_ref,cwd=>change(cwd,note,'const meetingResponse = await localFetch(`/meetings/${meeting.id}`);','refreshedSummaryExecutionRef.current = next.execution.id;\n          const meetingResponse = await localFetch(`/meetings/${meeting.id}`);'))),120000);
test('blanket refusal fails legitimate saved-note outcomes',()=>fails(grade('deny-all',item.oracle_ref,cwd=>change(cwd,surface,'return !awaitedNewSummary || refreshedNote !== currentNote;','return false;'))),120000);
test('removing pipe identity filtering is rejected',()=>fails(grade('wrong-pipe',item.oracle_ref,cwd=>change(cwd,note,'if (!pipe || pipe.pipeName !== summaryPipeSlug) return;','if (!pipe) return;'))),120000);
test('missing source remains a setup failure',()=>{const r=grade('missing',item.oracle_ref,cwd=>rmSync(join(cwd,note)));expect(r.status).toBe(1);expect(r.stdout+r.stderr).toMatch(/Failed to resolve import|Failed to load url/);expect(r.stdout).not.toContain('9 passed');},120000);
