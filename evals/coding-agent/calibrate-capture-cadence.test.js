// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { classifyGraderError } from './grader-outcome.mjs';
const repo=resolve(import.meta.dir,'../..'),prefix='apps/screenpipe-app-tauri/';
const item=JSON.parse(readFileSync(join(import.meta.dir,'cases.json'),'utf8')).cases.find(c=>c.id==='app-capture-cadence-durable-before-restart');
const component='components/settings/recording-settings.tsx',queue='components/settings/settings-write-queue.ts';
const paths=['tsconfig.json',component,queue,'components/settings/apply-restart-bar.tsx'];
function sources(ref){const available=new Set(execFileSync('git',['ls-tree','-r','--name-only',ref,prefix],{cwd:repo,encoding:'utf8'}).trim().split('\n'));return Object.fromEntries(paths.filter(p=>available.has(prefix+p)).map(p=>[p,execFileSync('git',['show',`${ref}:${prefix}${p}`],{cwd:repo,encoding:'utf8'})]));}
const broken=sources(item.base_ref),fixed=sources(item.oracle_ref),current=sources('HEAD');
const fixture='evals/coding-agent/graders/capture-cadence.test.js',grader=readFileSync(join(repo,fixture));
const root=mkdtempSync(join(tmpdir(),'capture-cadence-calibration-'));
const receipts=process.env.SCREENPIPE_EVAL_CALIBRATION_RECEIPTS;
afterAll(()=>rmSync(root,{recursive:true,force:true}));
function grade(name,sources){const cwd=join(root,name);for(const [path,source] of Object.entries(sources)){const file=join(cwd,prefix,path);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,source);}mkdirSync(dirname(join(cwd,fixture)),{recursive:true});writeFileSync(join(cwd,fixture),grader);const r=spawnSync(process.execPath,['test','../../'+fixture],{cwd:join(cwd,prefix),encoding:'utf8',timeout:30_000,env:{PATH:dirname(process.execPath),CI:'true',TZ:'UTC'}});const kind=classifyGraderError(r);if(receipts){mkdirSync(receipts,{recursive:true});for(const stream of ['stdout','stderr'])writeFileSync(join(receipts,name+'.'+stream),r[stream]||'');writeFileSync(join(receipts,name+'.json'),JSON.stringify({exit_code:r.status,signal:r.signal,error:r.error?.message,error_kind:kind},null,2));}expect(r.error).toBeUndefined();expect(r.signal).toBeNull();return {...r,kind};}
function passes(r){expect(r.status).toBe(0);expect(r.stderr).toContain('4 pass');expect(r.kind).toBeNull();}
function fails(r){expect(r.status).toBe(1);expect(r.kind).toBeNull();expect(r.stderr).toContain('expect(received)');expect(r.stderr).not.toContain('Cannot find module');expect(r.stderr).not.toContain('Unhandled error');}
function replace(source,from,to){expect(source.split(from)).toHaveLength(2);return source.replace(from,to);}
test('parent fails three intended outcomes and preserves Auto cadence',()=>{const r=grade('parent',broken);fails(r);expect(r.stderr).toContain('3 fail');expect(r.stderr).toContain('1 pass');});
test('reference passes',()=>passes(grade('reference',fixed)));
test('current caller passes',()=>passes(grade('current',current)));
test('equivalent inline queue and private names pass without the helper module',()=>{let source=replace(fixed[component],'import {\n  createSettingsWriteQueue,\n  enqueueSettingsWrite,\n  flushSettingsWrites,\n} from "./settings-write-queue";',fixed[queue].replaceAll('export ',''));source=source.replaceAll('createSettingsWriteQueue','newSaveTail').replaceAll('enqueueSettingsWrite','appendSave').replaceAll('flushSettingsWrites','waitForSaves').replaceAll('handleUpdate','applySavedCadence');const files={...fixed,[component]:source};delete files[queue];passes(grade('equivalent',files));});
test('an unused correct caller does not repair the parent',()=>fails(grade('unused',{...broken,'components/settings/unused-correct.tsx':fixed[component],[queue]:fixed[queue]})));
test('unawaited drain fails',()=>fails(grade('unawaited',{...fixed,[component]:replace(fixed[component],'await flushSettingsWrites(settingsWriteQueueRef.current);','void flushSettingsWrites(settingsWriteQueueRef.current).catch(() => {});')})));
test('swallowed persistence failure fails',()=>fails(grade('swallow',{...fixed,[component]:replace(fixed[component],'await flushSettingsWrites(settingsWriteQueueRef.current);','await flushSettingsWrites(settingsWriteQueueRef.current).catch(() => {});')})));
test('blanket handoff refusal fails preserved behavior',()=>fails(grade('deny',{...fixed,[component]:replace(fixed[component],'const handleUpdate = async () => {','const handleUpdate = async () => { return;')})));
test('changing Auto to numeric zero fails',()=>fails(grade('auto',{...fixed,[component]:replace(fixed[component],'(value ?? 0) === 0 ? null : (value as number) * 1000','(value ?? 0) === 0 ? 0 : (value as number) * 1000')})));
test('missing caller is a setup error',()=>{const files={...fixed};delete files[component];const r=grade('missing',files);expect(r.status).toBe(1);expect(r.kind).toBe('bun_unhandled_error');expect(r.stderr).toContain('0 pass');});
