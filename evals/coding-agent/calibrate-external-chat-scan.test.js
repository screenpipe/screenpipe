// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const repo=resolve(import.meta.dir,'../..');
const item=JSON.parse(readFileSync(join(import.meta.dir,'cases.json'),'utf8')).cases.find(c=>c.id==='app-external-chat-scan-boundary');
const sourcePath='apps/screenpipe-app-tauri/lib/chat/external-chat-import.ts';
const graderPath='evals/coding-agent/graders/app-external-chat-scan.test.js';
const show=ref=>execFileSync('git',['show',`${ref}:${sourcePath}`],{cwd:repo,encoding:'utf8'});
const broken=show(item.base_ref),fixed=show(item.oracle_ref),grader=readFileSync(join(repo,graderPath),'utf8');
const root=mkdtempSync(join(tmpdir(),'chat-scan-calibration-'));
afterAll(()=>rmSync(root,{recursive:true,force:true}));
function replace(source,from,to){expect(source.split(from)).toHaveLength(2);return source.replace(from,to);}
function grade(name,source,extra={}){
 const cwd=join(root,name);const files={[graderPath]:grader,...extra};if(source!==null)files[sourcePath]=source;
 for(const [p,s] of Object.entries(files)){const f=join(cwd,p);mkdirSync(dirname(f),{recursive:true});writeFileSync(f,s);}
 return spawnSync(process.execPath,['test',graderPath],{cwd,encoding:'utf8',timeout:30000,env:{PATH:dirname(process.execPath)}});
}
function fail(r){expect(r.error).toBeUndefined();expect(r.signal).toBeNull();expect(r.status).toBe(1);expect(r.stderr).toContain('expect(received)');expect(r.stderr).not.toContain('Cannot find module');expect(r.stderr).not.toContain('Unhandled error');}
function mutation(name,from,to){fail(grade(name,replace(fixed,from,to)));}
test('parent fails five intended outcomes and preserves three',()=>{const r=grade('parent',broken);fail(r);expect(r.stderr).toContain('3 pass');expect(r.stderr).toContain('5 fail');});
test('reference passes all eight outcomes',()=>{const r=grade('reference',fixed);expect(r.status).toBe(0);expect(r.stderr).toContain('8 pass');});
test('unused correct source cannot repair actual discovery',()=>fail(grade('unused',broken,{'unused-fixed.ts':fixed})));
test('equivalent private names and comparator implementation pass',()=>{let s=fixed.replaceAll('calendarDatesInWindow','recentCalendarDates').replaceAll('eligibleCount','acceptedFiles');s=replace(s,'b.sortKey.localeCompare(a.sortKey)','a.sortKey === b.sortKey ? 0 : a.sortKey < b.sortKey ? 1 : -1');expect(grade('equivalent',s).status).toBe(0);});
test('scanning every file and truncating later is rejected',()=>mutation('unbounded','if (eligibleCount >= MAX_EXTERNAL_CHATS_PER_SOURCE) break;','if (false) break;'));
test('oversized files cannot consume the eligible cap',()=>mutation('oversized-cap','if (candidate.size <= MAX_EXTERNAL_CHAT_FILE_BYTES) eligibleCount += 1;','eligibleCount += 1;'));
test('excluding the exact cutoff is rejected',()=>mutation('cutoff','candidate.modifiedAt < cutoffMs','candidate.modifiedAt <= cutoffMs'));
test('stale Claude history is rejected',()=>mutation('stale-claude','candidate && candidate.modifiedAt >= cutoffMs','candidate'));
test('blanket empty discovery cannot pass preserved outcomes',()=>mutation('empty','const candidates = eligible.slice(0, MAX_EXTERNAL_CHATS_PER_SOURCE);','const candidates = [];'));
test('reading transcript contents during discovery is rejected',()=>mutation('read-content','const info = await stat(path);','await readTextFile(path);\n    const info = await stat(path);'));
test('missing source remains setup failure',()=>{const r=grade('missing',null);expect(r.status).toBe(1);expect(r.stderr).toContain('Cannot find module');expect(r.stderr).toContain('0 pass');});
