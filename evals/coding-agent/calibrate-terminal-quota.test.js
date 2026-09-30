// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
const repo = resolve(import.meta.dir, '../..'), app = 'apps/screenpipe-app-tauri';
const item = JSON.parse(readFileSync(join(import.meta.dir, 'cases.json'), 'utf8')).cases.find(c => c.id === 'app-terminal-quota-retry');
const provider = `${app}/lib/chat/provider-errors.ts`, hook = `${app}/components/chat/standalone/hooks/use-pi-foreground-events.ts`;
const root = mkdtempSync(join(tmpdir(), 'terminal-quota-calibration-')), archives = new Map();
const receipts = process.env.SCREENPIPE_EVAL_CALIBRATION_RECEIPTS;
afterAll(() => rmSync(root, {recursive: true, force: true}));
function replace(cwd, file, from, to) {
  const p = join(cwd, file), text = readFileSync(p, 'utf8');
  expect(text.split(from)).toHaveLength(2);
  writeFileSync(p, text.replace(from, to));
}
function grade(name, ref = item.oracle_ref, mutate = () => {}) {
  const cwd = join(root, name); mkdirSync(cwd);
  if (!archives.has(ref)) {
    // Archive historical frontend source/config, never node_modules, credentials,
    // native build outputs or future source. No evaluated agent runs here.
    const children = execFileSync('git', ['ls-tree', '--name-only', `${ref}:${app}`], {cwd: repo, encoding: 'utf8'}).trim().split('\n');
    const paths = children.filter(n => !['src-tauri', 'public', 'e2e', '.e2e'].includes(n) && !n.startsWith('.env')).map(n => `${app}/${n}`);
    paths.push('crates/screenpipe-core/assets');
    archives.set(ref, execFileSync('git', ['archive', ref, ...paths], {cwd: repo, maxBuffer: 128 * 1024 * 1024}));
  }
  execFileSync('tar', ['-x', '-C', cwd], {input: archives.get(ref)});
  for (const f of item.grader.fixtures) { const dest = join(cwd, f.destination_path || f.source_path); mkdirSync(dirname(dest), {recursive:true}); writeFileSync(dest, f.local_path ? readFileSync(join(import.meta.dir, f.local_path)) : execFileSync("git", ["show", `${f.source_ref}:${f.source_path}`], {cwd: repo})); }
  symlinkSync(join(repo, app, 'node_modules'), join(cwd, app, 'node_modules'), 'dir');
  mutate(cwd);
  const r = spawnSync('/bin/bash', ['-c', item.grader.command], {cwd, encoding:'utf8', timeout:60000, maxBuffer:4*1024*1024, env:{PATH:process.env.PATH, HOME:cwd, CI:'true', TZ:'UTC', NO_COLOR:'1'}});
  if (receipts) { mkdirSync(receipts,{recursive:true}); writeFileSync(join(receipts, name+'.stdout'), r.stdout||''); writeFileSync(join(receipts,name+'.stderr'),r.stderr||''); writeFileSync(join(receipts,name+'.json'),JSON.stringify({ref,command:item.grader.command,exit_code:r.status,signal:r.signal,error:r.error?.message},null,2)); }
  expect(r.error).toBeUndefined(); expect(r.signal).toBeNull(); return r;
}
function passes(r) { expect(r.status).toBe(0); expect(r.stdout).toContain('83 passed'); expect(r.stdout+r.stderr).not.toMatch(/Unhandled|Uncaught/); }
function fails(r) { expect(r.status).toBe(1); expect(r.stderr).toContain('AssertionError'); expect(r.stdout+r.stderr).not.toMatch(/Unhandled|Uncaught|Failed to resolve import|Failed to load url|Cannot find module/); }
test('parent fails terminal event outcomes, preserving other behavior',()=>{const r=grade('parent',item.base_ref);fails(r);expect(r.stdout).toContain('3 failed | 80 passed');},60000);
test('reference passes actual terminal, transient and success events',()=>passes(grade('reference')),60000);

test('disabled terminal guard cannot pass through a source-name match',()=>fails(grade('disabled-guard',item.oracle_ref,cwd=>replace(cwd,hook,'if (isTerminalQuotaError(piLastErrorRef.current ?? "")) {','if (false && isTerminalQuotaError(piLastErrorRef.current ?? "")) {'))),60000);
test('blanket stop fails preserved provider retries',()=>fails(grade('blanket-stop',item.oracle_ref,cwd=>replace(cwd,hook,'if (isTerminalQuotaError(piLastErrorRef.current ?? "")) {','if (true) {'))),60000);
test('missing actual stop cannot hide behind finalized state',()=>fails(grade('no-stop',item.oracle_ref,cwd=>replace(cwd,hook,'void commands.piStop(sid);','void Promise.resolve(sid);'))),60000);
test('equivalent private detector naming passes',()=>passes(grade('renamed',item.oracle_ref,cwd=>{
  for(const file of [hook,`${app}/components/chat/standalone/hooks/pi-event-handlers.ts`]) {const f=join(cwd,file);writeFileSync(f,readFileSync(f,'utf8').replaceAll('isTerminalQuotaError','terminalUsageFailure'));}
})),60000);
test('blanket response retry suppression fails',()=>fails(grade('no-response-retry',item.oracle_ref,cwd=>replace(cwd,hook,'classifyQuotaError(errorStr) === "rate" &&','false && classifyQuotaError(errorStr) === "rate" &&'))),60000);
test('missing hook source is setup failure',()=>{
 const r=grade('missing',item.oracle_ref,cwd=>rmSync(join(cwd,hook)));expect(r.status).toBe(1);expect(r.stdout+r.stderr).toMatch(/Failed to resolve import|Failed to load url/);
},60000);
