// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const repo=resolve(import.meta.dir,'../..'),prefix='apps/screenpipe-app-tauri/';
const item=JSON.parse(readFileSync(join(import.meta.dir,'cases.json'),'utf8')).cases.find(c=>c.id==='app-device-settings-identity');
const paths=['tsconfig.json','lib/hooks/use-settings.tsx','lib/ai-preset-deletion.ts','lib/active-ai-preset.ts','lib/chat-storage.ts','lib/chat-dedup.ts','lib/chat-merge.ts','lib/chat/ephemeral-side-conversation.ts','lib/chat/external-chat-parser.ts','lib/hooks/managed-settings.ts','lib/desktop-remote-control.ts','lib/app-entitlement.ts','lib/telemetry-env.ts','lib/utils/font-size.ts','lib/live-views/onboarding-activation.ts','lib/utils/sidebar-nav-layout.ts','lib/utils/chat-title.ts','lib/auth-guard.tsx','lib/utils/tauri.ts','lib/hooks/use-is-enterprise-build.ts','components/settings/settings-write-queue.ts'];
function sources(ref){const available=new Set(execFileSync('git',['ls-tree','-r','--name-only',ref,prefix],{cwd:repo,encoding:'utf8'}).trim().split('\n'));return Object.fromEntries(paths.filter(p=>available.has(prefix+p)).map(p=>[p,execFileSync('git',['show',`${ref}:${prefix}${p}`],{cwd:repo,encoding:'utf8'})]));}
const broken=sources(item.base_ref),fixed=sources(item.oracle_ref);
const fixture='evals/coding-agent/graders/device-settings-identity.test.js',grader=readFileSync(join(repo,fixture));
const root=mkdtempSync(join(tmpdir(),'local-presets-calibration-'));afterAll(()=>rmSync(root,{recursive:true,force:true}));
function grade(name,sources){const cwd=join(root,name);for(const [path,source] of Object.entries(sources)){const file=join(cwd,prefix,path);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,source);}mkdirSync(dirname(join(cwd,fixture)),{recursive:true});writeFileSync(join(cwd,fixture),grader);return spawnSync(process.execPath,['test','../../'+fixture],{cwd:join(cwd,prefix),encoding:'utf8',timeout:30_000,env:{PATH:dirname(process.execPath)}});}
function fails(r){expect(r.error).toBeUndefined();expect(r.signal).toBeNull();expect(r.status).toBe(1);expect(r.stderr).toContain('expect(received)');expect(r.stderr).not.toContain('Cannot find module');expect(r.stderr).not.toContain('Unhandled error');}
function replace(source,old,next){expect(source.split(old)).toHaveLength(2);return source.replace(old,next);}

const settings='lib/hooks/use-settings.tsx';

test('parent fails identity outcomes with ordinary reset preserved',()=>{const r=grade('parent',broken);fails(r);expect(r.stderr).toContain('8 fail');expect(r.stderr).toContain('1 pass');});
test('reference passes all nine outcomes',()=>{const r=grade('reference',fixed);expect(r.status).toBe(0);expect(r.stderr).toContain('9 pass');});
test('equivalent guard expression passes',()=>expect(grade('equivalent',{...fixed,[settings]:replace(fixed[settings],'if (key === "deviceId") return;','if (["deviceId"].includes(key)) return;')}).status).toBe(0));
test('unused correct module cannot fix actual reset actions',()=>fails(grade('unused',{...broken,'unused-settings.tsx':fixed[settings]})));
test('fresh default random identity is rejected',()=>fails(grade('default',{...fixed,[settings]:replace(fixed[settings],'deviceId: "",','deviceId: crypto.randomUUID(),')})));
test('full reset identity loss is rejected',()=>fails(grade('full-reset',{...fixed,[settings]:replace(fixed[settings],'{ ...createDefaultSettingsObject(), deviceId: current.deviceId }','createDefaultSettingsObject()')})));
test('individual identity reset is rejected',()=>fails(grade('individual',{...fixed,[settings]:replace(fixed[settings],'if (key === "deviceId") return;','')})));
test('blanket reset refusal fails preserved ordinary field behavior',()=>fails(grade('all-noop',{...fixed,[settings]:replace(fixed[settings],'if (key === "deviceId") return;','return;')})));
test('constant replacement identity is rejected',()=>fails(grade('constant',{...fixed,[settings]:replace(fixed[settings],'deviceId: current.deviceId','deviceId: "constant-device"')})));
test('missing real module is an import failure',()=>{const src={...fixed};delete src[settings];const r=grade('missing',src);expect(r.status).toBe(1);expect(r.stderr).toContain('Cannot find module');expect(r.stderr).toContain('0 pass');});
