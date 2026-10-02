// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const repo=resolve(import.meta.dir,'../..'),prefix='apps/screenpipe-app-tauri/';
const item=JSON.parse(readFileSync(join(import.meta.dir,'cases.json'),'utf8')).cases.find(c=>c.id==='app-settings-restart-persistence');
const paths=['tsconfig.json','lib/hooks/use-settings.tsx','lib/ai-preset-deletion.ts','lib/active-ai-preset.ts','lib/chat-storage.ts','lib/chat-dedup.ts','lib/chat-merge.ts','lib/chat/ephemeral-side-conversation.ts','lib/chat/external-chat-parser.ts','lib/hooks/managed-settings.ts','lib/desktop-remote-control.ts','lib/app-entitlement.ts','lib/telemetry-env.ts','lib/utils/font-size.ts','lib/live-views/onboarding-activation.ts','lib/utils/sidebar-nav-layout.ts','lib/utils/chat-title.ts','lib/auth-guard.tsx','lib/utils/tauri.ts','lib/hooks/use-is-enterprise-build.ts','components/settings/settings-write-queue.ts','lib/free-plan-retention.ts','components/update-banner.tsx'];
function sources(ref){const available=new Set(execFileSync('git',['ls-tree','-r','--name-only',ref,prefix],{cwd:repo,encoding:'utf8'}).trim().split('\n'));return Object.fromEntries(paths.filter(p=>available.has(prefix+p)).map(p=>[p,execFileSync('git',['show',`${ref}:${prefix}${p}`],{cwd:repo,encoding:'utf8'})]));}
const broken=sources(item.base_ref),fixed=sources(item.oracle_ref);
const fixture='evals/coding-agent/graders/settings-restart-persistence.test.js',grader=readFileSync(join(repo,fixture));
const root=mkdtempSync(join(tmpdir(),'settings-restart-calibration-'));afterAll(()=>rmSync(root,{recursive:true,force:true}));
function grade(name,sources){const cwd=join(root,name);for(const [path,source] of Object.entries(sources)){const file=join(cwd,prefix,path);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,source);}mkdirSync(dirname(join(cwd,fixture)),{recursive:true});writeFileSync(join(cwd,fixture),grader);return spawnSync(process.execPath,['test','../../'+fixture],{cwd:join(cwd,prefix),encoding:'utf8',timeout:30_000,env:{PATH:dirname(process.execPath)}});}
function fails(r){expect(r.error).toBeUndefined();expect(r.signal).toBeNull();expect(r.status).toBe(1);expect(r.stderr).toContain('expect(received)');expect(r.stderr).not.toContain('Cannot find module');expect(r.stderr).not.toContain('Unhandled error');}
function replace(source,old,next){expect(source.split(old)).toHaveLength(2);return source.replace(old,next);}

const settings='lib/hooks/use-settings.tsx',banner='components/update-banner.tsx';
test('parent fails three persistence outcomes and preserves idle restart',()=>{const r=grade('parent',broken);fails(r);expect(r.stderr).toContain('3 fail');expect(r.stderr).toContain('1 pass');});
test('reference passes all four outcomes',()=>{const r=grade('reference',fixed);expect(r.status).toBe(0);expect(r.stderr).toContain('4 pass');});
test('equivalent private handler name is accepted',()=>expect(grade('renamed',{...fixed,[banner]:fixed[banner].replaceAll('handleUpdate','requestUpdateRestart')}).status).toBe(0));
test('unawaited drain cannot authorize early restart',()=>fails(grade('unawaited',{...fixed,[banner]:replace(fixed[banner],'await flushPendingSettingsWrites();','void flushPendingSettingsWrites().catch(() => {});')})));
test('an unused correct banner cannot hide the broken call path',()=>fails(grade('unused',{...broken,'components/unused-correct-banner.tsx':fixed[banner]})));
test('ignoring failed persistence is rejected',()=>fails(grade('ignore-error',{...fixed,[banner]:replace(fixed[banner],'await flushPendingSettingsWrites();','await flushPendingSettingsWrites().catch(() => {});')})));
test('blanket restart refusal violates preserved idle behavior',()=>fails(grade('deny-all',{...fixed,[banner]:replace(fixed[banner],'const handleUpdate = async () => {','const handleUpdate = async () => { return;')})));
test('dropping settings mutations is rejected',()=>fails(grade('drop-writes',{...fixed,[settings]:replace(fixed[settings],'await settingsStore.set(updates);','await Promise.resolve();')})));
test('missing actual settings source remains setup error',()=>{const files={...fixed};delete files[settings];const r=grade('missing',files);expect(r.status).toBe(1);expect(r.stderr).toContain('Cannot find module');expect(r.stderr).toContain('0 pass');});
