// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import {afterAll,expect,test} from 'bun:test';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
const repo=resolve(import.meta.dir,'../..'),app='apps/screenpipe-app-tauri';
const item=JSON.parse(readFileSync(join(import.meta.dir,'cases.json'),'utf8')).cases.find(c=>c.id==='app-chat-overlapping-load-isolation');
const root=mkdtempSync(join(tmpdir(),'chat-overlap-')),hook=app+'/components/hooks/use-chat-conversations.ts';
const source=(ref=item.oracle_ref)=>execFileSync('git',['show',`${ref}:${hook}`],{cwd:repo,encoding:'utf8'});
afterAll(()=>rmSync(root,{recursive:true,force:true}));
function prepare(name,ref=item.oracle_ref){
 const cwd=join(root,name);mkdirSync(cwd);
 const paths=['components','lib','vitest.config.ts','vitest.setup.ts','tsconfig.json','scripts/bun-test-files.ts'].map(p=>app+'/'+p);
 execFileSync('tar',['-xf','-','-C',cwd],{input:execFileSync('git',['archive',ref,...paths],{cwd:repo,maxBuffer:64*1024*1024})});
 for(const f of item.grader.fixtures){const dest=join(cwd,f.destination_path);mkdirSync(dirname(dest),{recursive:true});writeFileSync(dest,readFileSync(join(import.meta.dir,f.local_path)));}
 symlinkSync(join(repo,app,'node_modules'),join(cwd,app,'node_modules'),'dir');return cwd;
}
function run(cwd){return spawnSync('node',['node_modules/vitest/vitest.mjs','run','--config','vitest.config.ts','lib/__tests__/save-conversation-race.test.tsx','--pool=forks','--poolOptions.forks.singleFork=true'],{cwd:join(cwd,app),encoding:'utf8',timeout:20000,env:{PATH:process.env.PATH,HOME:cwd,CI:'true',NODE_OPTIONS:'--localstorage-file=.eval-localstorage',NO_COLOR:'1'}});}
function fails(r){expect(r.error).toBeUndefined();expect(r.signal).toBeNull();expect(r.status).toBe(1);expect(r.stderr).toContain('AssertionError');expect(r.stderr).not.toMatch(/Cannot find module|Failed to (load|resolve import)|Unhandled/);}
function replace(s,a,b){expect(s.split(a)).toHaveLength(2);return s.replace(a,b);}
function mutant(name,s){const cwd=prepare(name);writeFileSync(join(cwd,hook),s);return run(cwd);}
function unguardedSettings(s){const start=s.indexOf('    // A temporary side chat must not become the launch-time restore target.',s.indexOf('const loadConversation = async'));const end=s.indexOf('  // ---- branchConversation ----',start);expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start);const body=s.slice(start,end);expect(body.split('if (!isLatestRequest()) return;')).toHaveLength(5);return s.slice(0,start)+body.replaceAll('if (!isLatestRequest()) return;','')+s.slice(end);}
test('historical parent fails3outcomes and preserves12',()=>{const r=run(prepare('parent',item.base_ref));fails(r);expect(r.stdout).toContain('3 failed | 12 passed');});
test('reference preserves all15outcomes',()=>{const r=run(prepare('reference'));expect(r.status).toBe(0);expect(r.stdout).toContain('15 passed');});
test('original false pass cannot overwrite settings and preset after late reads',()=>{const r=mutant('old-bypass',unguardedSettings(source()).replace('if (presetId && isLatestRequest())','if (presetId)'));fails(r);expect(r.stdout).toContain('2 failed | 13 passed');});
test('settings guard removal is independently rejected',()=>{const r=mutant('settings',unguardedSettings(source()));fails(r);expect(r.stdout).toContain('1 failed | 14 passed');});
test('a stale preset emitted before discarding a late settings result is rejected',()=>{
 const r=mutant('preset',replace(source(),'const freshSettings = await store.get<any>("settings");\n        if (!isLatestRequest()) return;','const freshSettings = await store.get<any>("settings");\n        if (!isLatestRequest()) { await emit("chat-preset-restore", { presetId: (conv as ChatConversation).presetId }); return; }'));fails(r);expect(r.stdout).toContain('1 failed | 14 passed');
});
test('equivalent request guard naming passes',()=>expect(mutant('renamed',source().replaceAll('isLatestRequest','stillCurrentNavigation').replaceAll('loadConversationRequestRef','navigationGenerationRef')).status).toBe(0));
test('skipping all navigation is rejected',()=>fails(mutant('no-op',replace(source(),'const loadConversation = async (conv: ChatConversation | ConversationMeta) => {','const loadConversation = async (conv: ChatConversation | ConversationMeta) => { return;'))));
test('unused good hook cannot rescue the old hook',()=>{const cwd=prepare('unused');writeFileSync(join(cwd,hook+'.unused.ts'),source());writeFileSync(join(cwd,hook),source(item.base_ref));fails(run(cwd));});
test('missing hook is a collection error',()=>{const cwd=prepare('missing');rmSync(join(cwd,hook));const r=run(cwd);expect(r.status).toBe(1);expect(r.stderr).toMatch(/Failed to (load|resolve import)|Cannot find module/);expect(r.stdout).toContain('no tests');});
