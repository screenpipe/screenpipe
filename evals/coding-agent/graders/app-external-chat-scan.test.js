// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterEach, beforeEach, expect, mock, setSystemTime, test } from 'bun:test';
import { posix } from 'node:path';
const home='/synthetic-chat-home';
const now=new Date(2026,7,21,12).getTime();
const day=86400000, cutoff=now-7*day, maxBytes=32*1024*1024;
let state;
function forbidden(name){return ()=>{state.effects.push(name);throw Error('Unexpected discovery effect: '+name);};}
globalThis.fetch=forbidden('network');
mock.module('@tauri-apps/api/event',()=>({emit:forbidden('emit')}));
mock.module('@tauri-apps/api/path',()=>({homeDir:async()=>home,join:async(...p)=>posix.join(...p)}));
mock.module('@tauri-apps/plugin-fs',()=>({
 exists:async p=>state.dirs.has(p)||state.files.has(p),
 readDir:async p=>{state.reads.push(p);if(state.unreadable.has(p)||!state.dirs.has(p))throw Error('Synthetic unreadable directory');return structuredClone(state.dirs.get(p));},
 stat:async p=>{state.stats.push(p);if(state.unreadable.has(p)||!state.files.has(p))throw Error('Synthetic unreadable file');return {...state.files.get(p)};},
 readTextFile:forbidden('read transcript'),writeTextFile:forbidden('write source'),remove:forbidden('delete source'),
}));
mock.module('@/lib/chat-storage',()=>({loadConversationFile:forbidden('load conversation'),saveConversationFile:forbidden('save conversation'),deleteConversationFile:forbidden('delete conversation'),invalidateConversationListCache:forbidden('invalidate')}));
mock.module('@/lib/chat/external-chat-parser',()=>({parseExternalChatTranscript:forbidden('parse transcript'),parseExternalChatTranscriptSnapshot:forbidden('parse snapshot'),externalChatConversationId:forbidden('conversation id')}));
const {scanExternalChatHistory}=await import('../../../apps/screenpipe-app-tauri/lib/chat/external-chat-import');
function dir(path){if(state.dirs.has(path))return;state.dirs.set(path,[]);const parent=posix.dirname(path);if(parent!==path){dir(parent);state.dirs.get(parent).push({name:posix.basename(path),isDirectory:true});}}
function file(path,mtime=now,size=1024){const parent=posix.dirname(path);dir(parent);state.dirs.get(parent).push({name:posix.basename(path),isDirectory:false});state.files.set(path,{size,mtime:new Date(mtime)});return path;}
function datePath(time){const d=new Date(time);return `${home}/.codex/sessions/${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;}
function source(result,name){return result.sources.find(x=>x.source===name);}
function paths(result,name){return source(result,name).candidates.map(x=>x.path).sort();}
async function scan(){const before=JSON.stringify([...state.files]);const result=await scanExternalChatHistory({nowMs:now});expect(JSON.stringify([...state.files])).toBe(before);expect(result.totalCandidates).toBe(result.sources.reduce((n,s)=>n+s.candidates.length,0));for(const source of result.sources)for(const candidate of source.candidates){const recorded=state.files.get(candidate.path);expect(recorded).toBeDefined();expect(candidate).toMatchObject({source:source.source,sourceId:posix.basename(candidate.path).replace(/\.jsonl$/i,''),size:recorded.size,modifiedAt:recorded.mtime.getTime()});}return result;}
beforeEach(()=>{state={dirs:new Map(),files:new Map(),unreadable:new Set(),reads:[],stats:[],effects:[]};setSystemTime(now);});
afterEach(()=>{expect(state.effects).toEqual([]);setSystemTime();});
test('large recent Codex history returns the latest hundred without inspecting older history',async()=>{
 const recent=Array.from({length:150},(_,i)=>file(`${datePath(now)}/rollout-${String(i).padStart(3,'0')}.jsonl`,now-150+i));
 const ancient=file(`${datePath(now-200*day)}/old.jsonl`,now-200*day);
 const result=await scan();expect(paths(result,'codex')).toEqual(recent.slice(50).sort());expect(source(result,'codex')).toMatchObject({availableCount:150,omittedByLimit:50,skippedTooLarge:0});expect(result.lookbackDays).toBe(7);
 expect(state.stats.length).toBeLessThanOrEqual(100);expect(state.reads.some(p=>p===posix.dirname(ancient))).toBe(false);expect(state.stats).not.toContain(ancient);
});
test('seven-day boundary includes the exact cutoff and excludes older files',async()=>{
 const exact=file(`${datePath(cutoff)}/exact.jsonl`,cutoff), recent=file(`${datePath(cutoff)}/recent.jsonl`,cutoff+1);file(`${datePath(cutoff)}/expired.jsonl`,cutoff-1);
 expect(paths(await scan(),'codex')).toEqual([exact,recent].sort());
});
test('Claude recency filtering preserves readable projects and excludes subagents',async()=>{
 const root=`${home}/.claude/projects`;dir(`${root}/unreadable`);state.unreadable.add(`${root}/unreadable`);
 const wanted=file(`${root}/readable/recent.JSONL`);file(`${root}/readable/old.jsonl`,cutoff-1);file(`${root}/readable/subagents/child.jsonl`);file(`${root}/readable/note.txt`);
 expect(paths(await scan(),'claude-code')).toEqual([wanted]);expect(state.reads).not.toContain(`${root}/readable/subagents`);
});
test('oversized Codex files do not consume the eligible-file cap',async()=>{
 const wanted=[];for(let i=0;i<108;i++){const oversized=i>=105;const path=file(`${datePath(now)}/rollout-${String(i).padStart(3,'0')}.jsonl`,now-108+i,oversized?maxBytes+1:1024);if(i>=5&&!oversized)wanted.push(path);}
 const result=await scan();expect(paths(result,'codex')).toEqual(wanted.sort());expect(source(result,'codex')).toMatchObject({skippedTooLarge:3,omittedByLimit:5,availableCount:108});expect(state.stats.length).toBeLessThanOrEqual(103);
});
test('exact size limit remains eligible and oversized Claude files are reported',async()=>{
 const root=`${home}/.claude/projects/project`;const wanted=file(`${root}/limit.jsonl`,now,maxBytes);file(`${root}/oversized.jsonl`,now,maxBytes+1);
 const result=await scan();expect(paths(result,'claude-code')).toEqual([wanted]);expect(source(result,'claude-code').skippedTooLarge).toBe(1);
});
test('unreadable Codex files and missing dates do not hide other recent files',async()=>{
 const bad=file(`${datePath(now)}/unreadable.jsonl`);state.unreadable.add(bad);const wanted=file(`${datePath(now-day)}/recent.jsonl`);file(`${datePath(now)}/notes.txt`);file(`${datePath(now)}/nested/child.jsonl`);
 expect(paths(await scan(),'codex')).toEqual([wanted]);
});
test('missing sources produce an empty discovery result',async()=>{
 const result=await scan();expect(result.totalCandidates).toBe(0);expect(paths(result,'claude-code')).toEqual([]);expect(paths(result,'codex')).toEqual([]);expect(state.stats).toEqual([]);
});
test('repeated discovery reflects new files and retains both independent sources',async()=>{
 const claude=file(`${home}/.claude/projects/project/session.jsonl`);expect(paths(await scan(),'claude-code')).toEqual([claude]);
 const codex=file(`${datePath(now)}/session.jsonl`);const result=await scan();expect(paths(result,'claude-code')).toEqual([claude]);expect(paths(result,'codex')).toEqual([codex]);expect(result.totalCandidates).toBe(2);
});
