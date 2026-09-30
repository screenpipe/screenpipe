// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
const repo = resolve(import.meta.dir, '../..'), app = 'apps/screenpipe-app-tauri';
const item = JSON.parse(readFileSync(join(import.meta.dir, 'cases.json'), 'utf8')).cases.find(c => c.id === 'app-business-capacity-plan-picker');
const options = `${app}/components/settings/account-plan-options.tsx`, section = `${app}/components/settings/account-section.tsx`;
const root = mkdtempSync(join(tmpdir(), 'capacity-plan-calibration-')), archives = new Map();
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
function passes(r) { expect(r.status).toBe(0); expect(r.stdout).toContain('8 passed'); expect(r.stdout+r.stderr).not.toMatch(/Unhandled|Uncaught/); }
function fails(r) { expect(r.status).toBe(1); expect(r.stdout).toContain('failed'); expect(r.stdout+r.stderr).not.toMatch(/Unhandled|Uncaught|Failed to resolve import|Failed to load url|Cannot find module/); }
test('parent fails capacity outcomes and preserves login/account outcomes',()=>{const r=grade('parent',item.base_ref);fails(r);expect(r.stdout).toContain('6 failed | 2 passed');},60000);
test('reference passes all eight outcomes',()=>passes(grade('reference')),60000);
test('equivalent helper names, test ids and query ordering pass',()=>passes(grade('equivalent',item.oracle_ref,cwd=>{
 for(const file of [options,section]) { const f=join(cwd,file);writeFileSync(f,readFileSync(f,'utf8').replaceAll('openCapacityBilling','openPlanBilling').replaceAll('data-testid=','data-eval-neutral=')); }
 replace(cwd,section,'billingUrl.searchParams.set("target_plan", targetPlan);\n    billingUrl.searchParams.set("interval", "month");','billingUrl.searchParams.set("interval", "month");\n    billingUrl.searchParams.set("target_plan", targetPlan);');
})),60000);
test('unused correct module cannot hide broken active presentation',()=>fails(grade('unused',item.oracle_ref,cwd=>{
 writeFileSync(join(cwd,`${app}/components/settings/unused-correct-plans.tsx`),readFileSync(join(cwd,options)));
 for(const f of [options,section])writeFileSync(join(cwd,f),execFileSync('git',['show',`${item.base_ref}:${f}`],{cwd:repo}));
})),60000);
test('wrong outgoing billing target fails',()=>fails(grade('wrong-target',item.oracle_ref,cwd=>replace(cwd,section,'const billingUrl = new URL(BILLING_URL);\n    billingUrl.searchParams.set("target_plan", targetPlan);','const billingUrl = new URL(BILLING_URL);\n    billingUrl.searchParams.set("target_plan", "pro");'))),60000);
test('missing navigation effect fails',()=>fails(grade('no-navigation',item.oracle_ref,cwd=>replace(cwd,section,'await openExternalUrl(billingUrl.toString());\n  };\n\n  const selectPlan','void billingUrl;\n  };\n\n  const selectPlan'))),60000);
test('all plans marked current fails',()=>fails(grade('all-current',item.oracle_ref,cwd=>replace(cwd,options,'const isCurrent = plan.id === current;','const isCurrent = true;'))),60000);
test('lost preserved web account navigation fails',()=>fails(grade('lost-account',item.oracle_ref,cwd=>replace(cwd,section,'openExternalUrl(ACCOUNT_URL)','Promise.resolve()'))),60000);
test('missing source is setup error',()=>{const r=grade('missing',item.oracle_ref,cwd=>rmSync(join(cwd,options)));expect(r.status).toBe(1);expect(r.stdout+r.stderr).toMatch(/Failed to resolve import|Failed to load url/);},60000);
