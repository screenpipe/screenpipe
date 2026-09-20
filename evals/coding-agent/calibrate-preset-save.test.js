// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const repo=resolve(import.meta.dir,'../..'),prefix='apps/screenpipe-app-tauri/';
const item=JSON.parse(readFileSync(join(import.meta.dir,'cases.json'),'utf8')).cases.find(c=>c.id==='app-preset-deletion-save-recovery');
const paths=['tsconfig.json','lib/hooks/use-settings.tsx','lib/ai-preset-deletion.ts','lib/active-ai-preset.ts','lib/chat-storage.ts','lib/chat-dedup.ts','lib/chat-merge.ts','lib/chat/ephemeral-side-conversation.ts','lib/chat/external-chat-parser.ts','lib/hooks/managed-settings.ts','lib/desktop-remote-control.ts','lib/app-entitlement.ts','lib/telemetry-env.ts','lib/utils/font-size.ts','lib/live-views/onboarding-activation.ts','lib/utils/sidebar-nav-layout.ts','lib/utils/chat-title.ts','lib/auth-guard.tsx','lib/utils/tauri.ts','lib/hooks/use-is-enterprise-build.ts','components/settings/settings-write-queue.ts'];
function sources(ref){return Object.fromEntries(paths.filter(p=>ref!==item.base_ref||p!=='lib/ai-preset-deletion.ts').map(p=>[p,execFileSync('git',['-c','core.commitGraph=false','show',`${ref}:${prefix}${p}`],{cwd:repo,encoding:'utf8'})]));}
const broken=sources(item.base_ref),fixed=sources(item.oracle_ref);
const fixture='evals/coding-agent/graders/preset-save-recovery.test.js',grader=readFileSync(join(repo,fixture));
const root=mkdtempSync(join(tmpdir(),'preset-save-calibration-'));afterAll(()=>rmSync(root,{recursive:true,force:true}));
function grade(name,sources){const cwd=join(root,name);for(const [path,source] of Object.entries(sources)){const file=join(cwd,prefix,path);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,source);}mkdirSync(dirname(join(cwd,fixture)),{recursive:true});writeFileSync(join(cwd,fixture),grader);return spawnSync(process.execPath,['test','../../'+fixture],{cwd:join(cwd,prefix),encoding:'utf8',timeout:30_000,env:{PATH:dirname(process.execPath)}});}
function fails(r){expect(r.error).toBeUndefined();expect(r.signal).toBeNull();expect(r.status).toBe(1);expect(r.stderr).toContain('expect(received)');expect(r.stderr).not.toContain('Cannot find module');expect(r.stderr).not.toContain('Unhandled error');}
function replace(source,old,next){expect(source.split(old)).toHaveLength(2);return source.replace(old,next);}
const settings='lib/hooks/use-settings.tsx',helper='lib/ai-preset-deletion.ts',chat='lib/chat-storage.ts';
test('parent has intended failures and preserved settings behavior',()=>{const r=grade('parent',broken);fails(r);expect(r.stderr).toContain('9 fail');expect(r.stderr).toContain('4 pass');});
test('reference passes real settings and conversation persistence outcomes',()=>{const r=grade('reference',fixed);expect(r.status).toBe(0);expect(r.stderr).toContain('13 pass');});
test('equivalent internal helper names are accepted',()=>{const renamed=Object.fromEntries(Object.entries(fixed).map(([p,s])=>[p,s.replaceAll('saveWithPresetReassignment','persistPresetDependencies').replaceAll('reassignConversationPreset','updateConversationPresetDependency')]));expect(grade('renamed',renamed).status).toBe(0);});
test('unused correct helpers cannot conceal broken settings wiring',()=>fails(grade('unwired',{...broken,[helper]:fixed[helper],[chat]:fixed[chat]})));
test('premature settings persistence before dependency success is rejected',()=>fails(grade('early-save',{...fixed,[settings]:replace(fixed[settings],'await saveWithPresetReassignment(current, newSettings, async (reassigned) => {','await setSettingsStripped(store, newSettings); await saveAndEncrypt(store); await saveWithPresetReassignment(current, newSettings, async (reassigned) => {')})));
test('ignoring a task update failure is rejected',()=>fails(grade('ignore-task-failure',{...fixed,[helper]:replace(fixed[helper],'if (!result.ok || resultBody.success !== true) {','if (false) {')})));
test('hidden explicit conversation destinations cannot be skipped',()=>fails(grade('skip-hidden',{...fixed,[helper]:replace(fixed[helper],'if (config.run_in?.chat_id) chatIds.add(config.run_in.chat_id);','/* deliberately omit explicit destinations */')})));
test('overwriting a newer conversation selection is rejected',()=>fails(grade('stale-selection',{...fixed,[chat]:replace(fixed[chat],'if (!conv?.presetId || !removedIds.has(conv.presetId)) return;','if (!conv) return;')})));
test('success without updating active and open selections is rejected',()=>fails(grade('no-active-effects',{...fixed,[helper]:replace(fixed[helper],'const active = readActiveAiPresetId();','return; const active = readActiveAiPresetId();')})));
test('blanket settings refusal cannot pass preserved updates',()=>fails(grade('deny-all',{...fixed,[settings]:replace(fixed[settings],'assertValidAiPresetUpdate(value);','throw new Error("synthetic blanket denial"); assertValidAiPresetUpdate(value);')})));
test('missing actual settings source is a setup failure',()=>{const source={...fixed};delete source[settings];const r=grade('missing',source);expect(r.status).toBe(1);expect(r.stderr).toContain('Cannot find module');expect(r.stderr).toContain('0 pass');});
