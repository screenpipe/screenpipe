// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const repo=resolve(import.meta.dir,'../..'),prefix='apps/screenpipe-app-tauri/';
const item=JSON.parse(readFileSync(join(import.meta.dir,'cases.json'),'utf8')).cases.find(c=>c.id==='app-local-preset-preservation');
const paths=['tsconfig.json','lib/hooks/use-settings.tsx','lib/ai-preset-deletion.ts','lib/active-ai-preset.ts','lib/chat-storage.ts','lib/chat-dedup.ts','lib/chat-merge.ts','lib/chat/ephemeral-side-conversation.ts','lib/chat/external-chat-parser.ts','lib/hooks/managed-settings.ts','lib/desktop-remote-control.ts','lib/app-entitlement.ts','lib/telemetry-env.ts','lib/utils/font-size.ts','lib/live-views/onboarding-activation.ts','lib/utils/sidebar-nav-layout.ts','lib/utils/chat-title.ts','lib/auth-guard.tsx','lib/utils/tauri.ts','lib/hooks/use-is-enterprise-build.ts','components/settings/settings-write-queue.ts'];
function sources(ref){const available=new Set(execFileSync('git',['ls-tree','-r','--name-only',ref,prefix],{cwd:repo,encoding:'utf8'}).trim().split('\n'));return Object.fromEntries(paths.filter(p=>available.has(prefix+p)).map(p=>[p,execFileSync('git',['show',`${ref}:${prefix}${p}`],{cwd:repo,encoding:'utf8'})]));}
const broken=sources(item.base_ref),fixed=sources(item.oracle_ref);
const fixture='evals/coding-agent/graders/local-preset-preservation.test.js',grader=readFileSync(join(repo,fixture));
const root=mkdtempSync(join(tmpdir(),'local-presets-calibration-'));afterAll(()=>rmSync(root,{recursive:true,force:true}));
function grade(name,sources){const cwd=join(root,name);for(const [path,source] of Object.entries(sources)){const file=join(cwd,prefix,path);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,source);}mkdirSync(dirname(join(cwd,fixture)),{recursive:true});writeFileSync(join(cwd,fixture),grader);return spawnSync(process.execPath,['test','../../'+fixture],{cwd:join(cwd,prefix),encoding:'utf8',timeout:30_000,env:{PATH:dirname(process.execPath)}});}
function fails(r){expect(r.error).toBeUndefined();expect(r.signal).toBeNull();expect(r.status).toBe(1);expect(r.stderr).toContain('expect(received)');expect(r.stderr).not.toContain('Cannot find module');expect(r.stderr).not.toContain('Unhandled error');}
function replace(source,old,next){expect(source.split(old)).toHaveLength(2);return source.replace(old,next);}

const settings='lib/hooks/use-settings.tsx';
test('parent reproduces settings failures and preserves neighbors',()=>{const r=grade('parent',broken);fails(r);expect(r.stderr).toContain('8 fail');expect(r.stderr).toContain('4 pass');});
test('reference passes persistence and recovery outcomes',()=>{const r=grade('reference',fixed);expect(r.status).toBe(0);expect(r.stderr).toContain('12 pass');});
test('equivalent validation helper naming is accepted',()=>expect(grade('renamed',{...fixed,[settings]:fixed[settings].replaceAll('assertValidAiPresetUpdate','checkPresetShape')}).status).toBe(0));
test('correct unused normalization cannot hide a broken persistence path',()=>{
 const start=fixed[settings].indexOf('export function normalizeSettingsArrays('),end=fixed[settings].indexOf('// Store singleton',start);
 const unused=fixed[settings].slice(start,end).replaceAll('normalizeSettingsArrays','unusedNormalization').replaceAll('assertValidAiPresetUpdate','unusedValidation');fails(grade('unused',{...broken,[settings]:broken[settings]+'\n'+unused}));
});
test('reintroduced cloud seeding is rejected',()=>fails(grade('cloud-seed',{...fixed,[settings]:replace(fixed[settings],'let needsUpdate = normalizeSettingsArrays(settings);','let needsUpdate = normalizeSettingsArrays(settings); if (!settings.aiPresets.some(p => p.provider === "screenpipe-cloud")) { settings.aiPresets.unshift(makeDefaultPresets(false)[0]); needsUpdate = true; }')})));
test('silently repairing invalid writes instead of rejecting is rejected',()=>fails(grade('repair-write',{...fixed,[settings]:fixed[settings].replace('assertValidAiPresetUpdate(updates);','if ("aiPresets" in updates && (!Array.isArray(updates.aiPresets) || !updates.aiPresets.length)) updates.aiPresets = makeDefaultPresets(false);')})));
test('account changes cannot replace local settings with defaults',()=>fails(grade('account-defaults',{...fixed,[settings]:replace(fixed[settings],'if ("user" in value) {','if ("user" in value) { newSettings.aiPresets = makeDefaultPresets(false);')})));
test('blanket update refusal fails preserved edits',()=>{const r=grade('deny-all',{...fixed,[settings]:replace(fixed[settings],'assertValidAiPresetUpdate(updates);','throw new Error("synthetic refusal");')});expect(r.status).toBe(1);expect(r.signal).toBeNull();expect(r.stderr).toContain("3 fail");expect(r.stderr).toContain("9 pass");expect(r.stderr).toContain("error: synthetic refusal");expect(r.stderr).not.toContain("Unhandled error");});
test('missing actual settings module is setup failure',()=>{const source={...fixed};delete source[settings];const r=grade('missing',source);expect(r.status).toBe(1);expect(r.stderr).toContain('Cannot find module');expect(r.stderr).toContain('0 pass');});
