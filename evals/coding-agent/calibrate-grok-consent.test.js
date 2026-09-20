// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const repo=resolve(import.meta.dir,'../..'),source='apps/screenpipe-app-tauri/lib/grokbot-installer.mjs';
const item=JSON.parse(readFileSync(join(import.meta.dir,'cases.json'),'utf8')).cases.find(c=>c.id==='grok-installer-explicit-consent');
const show=ref=>execFileSync('git',['-c','core.commitGraph=false','show',`${ref}:${source}`],{cwd:repo,encoding:'utf8'});
const broken=show(item.base_ref),fixed=show(item.oracle_ref);
const fixture='evals/coding-agent/graders/grok-installer-consent.test.js',grader=readFileSync(join(repo,fixture));
const root=mkdtempSync(join(tmpdir(),'grok-consent-calibration-'));afterAll(()=>rmSync(root,{recursive:true,force:true}));
function grade(name,text){const cwd=join(root,name);for(const [p,s] of [[source,text],[fixture,grader]]){if(s===null)continue;mkdirSync(dirname(join(cwd,p)),{recursive:true});writeFileSync(join(cwd,p),s);}return spawnSync(process.execPath,['test',fixture],{cwd,encoding:'utf8',timeout:30_000,env:{PATH:dirname(process.execPath)}});}
function fails(r){expect(r.error).toBeUndefined();expect(r.signal).toBeNull();expect(r.status).toBe(1);expect(r.stderr).toContain('expect(received)');expect(r.stderr).not.toContain('Cannot find module');expect(r.stderr).not.toContain('Unhandled error');}
function replace(s,old,next){expect(s.split(old)).toHaveLength(2);return s.replace(old,next);}
test('historical parent fails passive access but preserves explicit actions',()=>{const r=grade('parent',broken);fails(r);expect(r.stderr).toContain('2 fail');expect(r.stderr).toContain('13 pass');});
test('reference passes all boundary and preserved outcomes',()=>{const r=grade('reference',fixed);expect(r.status).toBe(0);expect(r.stderr).toContain('15 pass');});
test('equivalent parameter name and error wording pass',()=>{const r=grade('equivalent',fixed.replaceAll('input','params').replace('Grok Bot credential access requires an explicit connect or disconnect action.','Explicit authorization is needed.'));expect(r.status).toBe(0);});
test('refusal after probing files cannot pass',()=>fails(grade('late-refusal',replace(fixed,'export async function runInstaller(input) {',"export async function runInstaller(input) { if (input.action === 'status') { existsSync(appDataPath(input.home, process.platform, {})); throw Error('Refused'); }"))));
test('allowing status again is rejected',()=>fails(grade('status-bypass',replace(fixed,'if (!["connect", "disconnect"].includes(input.action))','if (!["status", "connect", "disconnect"].includes(input.action))'))));
test('blanket denial cannot replace consent handling',()=>fails(grade('deny-all',replace(fixed,'export async function runInstaller(input) {',"export async function runInstaller(input) { throw Error('Refused');"))));
test('claiming connected without installation is rejected',()=>fails(grade('fake-connect',replace(fixed,'export async function runInstaller(input) {',"export async function runInstaller(input) { if (input.action === 'connect') return { detected: true, connected: true };"))));
test('claiming disconnected without removal is rejected',()=>fails(grade('fake-disconnect',replace(fixed,'export async function runInstaller(input) {',"export async function runInstaller(input) { if (input.action === 'disconnect') return { detected: true, connected: false };"))));
test('missing source is a setup failure',()=>{const r=grade('missing',null);expect(r.status).toBe(1);expect(r.stderr).toContain('Cannot find module');expect(r.stderr).toContain('0 pass');});
