// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const repo=resolve(import.meta.dir,'../..'),prefix='apps/screenpipe-app-tauri/';
const item=JSON.parse(readFileSync(join(import.meta.dir,'cases.json'),'utf8')).cases.find(c=>c.id==='app-consumer-stale-managed-settings');
const paths=['tsconfig.json','lib/hooks/use-settings.tsx','lib/ai-preset-deletion.ts','lib/active-ai-preset.ts','lib/chat-storage.ts','lib/chat-dedup.ts','lib/chat-merge.ts','lib/chat/ephemeral-side-conversation.ts','lib/chat/external-chat-parser.ts','lib/hooks/managed-settings.ts','lib/desktop-remote-control.ts','lib/app-entitlement.ts','lib/free-plan-retention.ts','lib/telemetry-env.ts','lib/utils/font-size.ts','lib/live-views/onboarding-activation.ts','lib/utils/sidebar-nav-layout.ts','lib/utils/chat-title.ts','lib/auth-guard.tsx','lib/utils/tauri.ts','lib/hooks/use-is-enterprise-build.ts','components/settings/settings-write-queue.ts'];
function sources(ref){const available=new Set(execFileSync('git',['ls-tree','-r','--name-only',ref,prefix],{cwd:repo,encoding:'utf8'}).trim().split('\n'));return Object.fromEntries(paths.filter(p=>available.has(prefix+p)).map(p=>[p,execFileSync('git',['show',`${ref}:${prefix}${p}`],{cwd:repo,encoding:'utf8'})]));}
const broken=sources(item.base_ref),fixed=sources(item.oracle_ref),current=sources('HEAD');
const fixtures=['evals/coding-agent/graders/stale-policy.test.js','evals/coding-agent/graders/stale-policy.mjs'];
const root=mkdtempSync(join(tmpdir(),'stale-policy-calibration-'));afterAll(()=>rmSync(root,{recursive:true,force:true}));
function grade(name,src){const cwd=join(root,name);for(const [path,source] of Object.entries(src)){const f=join(cwd,prefix,path);mkdirSync(dirname(f),{recursive:true});writeFileSync(f,source);}for(const path of fixtures){const f=join(cwd,path);mkdirSync(dirname(f),{recursive:true});writeFileSync(f,readFileSync(join(repo,path)));}const r=spawnSync(process.execPath,['../../'+fixtures[1]],{cwd:join(cwd,prefix),encoding:'utf8',timeout:45_000,env:{PATH:dirname(process.execPath)}});if(process.env.EVAL_CALIBRATION_RESULTS_DIR){mkdirSync(process.env.EVAL_CALIBRATION_RESULTS_DIR,{recursive:true});writeFileSync(join(process.env.EVAL_CALIBRATION_RESULTS_DIR,name+'.json'),JSON.stringify({status:r.status,signal:r.signal,error:r.error?.message,stdout:r.stdout,stderr:r.stderr},null,2)+'\n');}return r;}
function fails(r){expect(r.error).toBeUndefined();expect(r.signal).toBeNull();expect(r.status).toBe(1);expect(r.stderr).toContain('expect(received)');expect(r.stderr).not.toContain('Cannot find');expect(r.stderr).not.toContain('TypeError');expect(r.stderr).not.toContain('Unhandled error');}
function passes(r){expect(r.error).toBeUndefined();expect(r.signal).toBeNull();expect(r.status).toBe(0);expect(r.stderr.match(/4 pass/g)).toHaveLength(3);expect(r.stderr).not.toContain('Unhandled error');}
function replace(s,old,next){expect(s.split(old)).toHaveLength(2);return s.replace(old,next);}
const settings='lib/hooks/use-settings.tsx',authority='lib/hooks/use-is-enterprise-build.ts';
test('parent fails three consumer outcomes and preserves nine',()=>{const r=grade('parent',broken);fails(r);expect(r.stderr).toContain('3 fail');expect(r.stderr.match(/4 pass/g)).toHaveLength(2);expect(r.stderr).toContain('1 pass');},60000);
test('reference passes twelve caller outcomes',()=>passes(grade('reference',fixed)),60000);
test('current source passes the same persistence contract',()=>passes(grade('current',current)),60000);
test('equivalent private bindings pass',()=>passes(grade('equivalent',{...fixed,[settings]:fixed[settings].replaceAll('activeManagedValues','effectivePolicyForBuild'),[authority]:fixed[authority].replaceAll('cachedResult','confirmedBuild')})),60000);
test('unused correct store does not repair real entry point',()=>fails(grade('unused',{...broken,'unused-settings.tsx':fixed[settings]})),60000);
test('adding only the correct authority helper cannot fix persistence',()=>fails(grade('helper-only',{...broken,[authority]:fixed[authority]})),60000);
test('blanket consumer classification fails managed preservation',()=>fails(grade('blanket',{...fixed,[settings]:replace(fixed[settings],'return (await isResolvedConsumerBuild()) ? undefined : managed;','return undefined;')})),60000);
test('failed IPC cannot release managed policy',()=>fails(grade('fail-open',{...fixed,[authority]:replace(fixed[authority],'  } catch {\n    return false;\n  }\n}\n\n/**\n * Tri-state','  } catch {\n    return true;\n  }\n}\n\n/**\n * Tri-state')})),60000);
test('dropping durable save fails persistence outcomes',()=>fails(grade('no-save',{...fixed,[settings]:replace(fixed[settings],'\tawait store.save();','\t// no durable save')})),60000);
test('blanket update refusal fails ordinary edits',()=>fails(grade('no-edit',{...fixed,[settings]:replace(fixed[settings],'const updateSettings = async (updates: Partial<Settings>) => {','const updateSettings = async (updates: Partial<Settings>) => { return;')})),60000);
test('missing entry point remains an import error',()=>{const src={...fixed};delete src[settings];const r=grade('missing',src);expect(r.status).toBe(1);expect(r.stderr).toContain('Cannot find module');expect(r.stderr.match(/0 pass/g)).toHaveLength(3);expect(r.stderr).not.toContain('expect(received)');},60000);
