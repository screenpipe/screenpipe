// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
const repo = resolve(import.meta.dir, '../..'), app = 'apps/screenpipe-app-tauri';
const item = JSON.parse(readFileSync(join(import.meta.dir, 'cases.json'), 'utf8')).cases.find(c => c.id === 'app-card-ask-login-hydration');
const provider = `${app}/components/card-ask-provider.tsx`, hook = `${app}/lib/hooks/use-card-ask.tsx`, gating = `${app}/lib/card-ask/gating.ts`;
const root = mkdtempSync(join(tmpdir(), 'card-login-calibration-')), archives = new Map();
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

    archives.set(ref, execFileSync('git', ['archive', ref, ...paths], {cwd: repo, maxBuffer: 128 * 1024 * 1024}));
  }
  execFileSync('tar', ['-x', '-C', cwd], {input: archives.get(ref)});
  for (const f of item.grader.fixtures) { const dest = join(cwd, f.destination_path); mkdirSync(dirname(dest), {recursive:true}); writeFileSync(dest, readFileSync(join(import.meta.dir, f.local_path))); }
  symlinkSync(join(repo, app, 'node_modules'), join(cwd, app, 'node_modules'), 'dir');
  mutate(cwd);
  const r = spawnSync('/bin/bash', ['-c', item.grader.command], {cwd, encoding:'utf8', timeout:60000, maxBuffer:4*1024*1024, env:{PATH:process.env.PATH, HOME:cwd, CI:'true', TZ:'UTC', NO_COLOR:'1'}});
  if (receipts) { mkdirSync(receipts,{recursive:true}); writeFileSync(join(receipts, name+'.stdout'), r.stdout||''); writeFileSync(join(receipts,name+'.stderr'),r.stderr||''); writeFileSync(join(receipts,name+'.json'),JSON.stringify({ref,command:item.grader.command,exit_code:r.status,signal:r.signal,error:r.error?.message},null,2)); }
  expect(r.error).toBeUndefined(); expect(r.signal).toBeNull(); return r;
}
function passes(r) { expect(r.status).toBe(0); expect(r.stdout).toContain('9 passed'); expect(r.stdout+r.stderr).not.toMatch(/Unhandled|Uncaught/); }
function fails(r) { expect(r.status).toBe(1); expect(r.stdout).toContain('failed'); expect(r.stdout+r.stderr).not.toMatch(/Unhandled|Uncaught|Failed to resolve import|Failed to load url|Cannot find module/); }
test('parent loses delayed account prompts and preserves seven outcomes',()=>{const r=grade('parent',item.base_ref);fails(r);expect(r.stdout).toContain('2 failed | 7 passed');},60000);
test('reference passes all nine outcomes',()=>passes(grade('reference')),60000);
test('equivalent private names and removed test ids pass',()=>passes(grade('equivalent',item.oracle_ref,cwd=>{
 for (const file of [provider,hook]) { const p=join(cwd,file);writeFileSync(p,readFileSync(p,'utf8').replaceAll('activeTrigger','displayTrigger')); }
 const p=join(cwd,`${app}/components/card-ask-modal.tsx`);writeFileSync(p,readFileSync(p,'utf8').replaceAll('data-testid=','data-eval-neutral='));
})),60000);
test('unused correct provider does not hide broken active provider',()=>fails(grade('unused',item.oracle_ref,cwd=>{
 writeFileSync(join(cwd,`${app}/components/unused-card-provider.tsx`),readFileSync(join(cwd,provider)));
 writeFileSync(join(cwd,provider),execFileSync('git',['show',`${item.base_ref}:${provider}`],{cwd:repo}));
})),60000);
test('blanket login silence fails',()=>fails(grade('silent',item.oracle_ref,cwd=>replace(cwd,provider,'emitCardAskTrigger("login");','void 0;'))),60000);
test('payment-method suppression remains required',()=>fails(grade('payer',item.oracle_ref,cwd=>replace(cwd,gating,'if (user.has_payment_method === true) return false;','if (user.has_payment_method === true) return true;'))),60000);
test('lost persistent once-only behavior fails',()=>fails(grade('repeat',item.oracle_ref,cwd=>replace(cwd,hook,'JSON.stringify(shownRef.current),','JSON.stringify([]),'))),60000);
test('missing provider is setup error',()=>{const r=grade('missing',item.oracle_ref,cwd=>rmSync(join(cwd,provider)));expect(r.status).toBe(1);expect(r.stdout+r.stderr).toMatch(/Failed to resolve import|Failed to load url/);},60000);
