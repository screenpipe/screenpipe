// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
const repo = resolve(import.meta.dir, '../..'), app = 'apps/screenpipe-app-tauri';
const item = JSON.parse(readFileSync(join(import.meta.dir, 'cases.json'), 'utf8')).cases.find(c => c.id === 'app-acp-billing-saved-recovery');
const provider = `${app}/lib/chat/provider-errors.ts`, hook = `${app}/components/chat/standalone/hooks/use-pi-foreground-events.ts`;
const root = mkdtempSync(join(tmpdir(), 'acp-billing-calibration-')), archives = new Map();
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
    paths.push('packages/workflows-ui', 'crates/screenpipe-core/assets');
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
function passes(r) { expect(r.status).toBe(0); expect(r.stdout).toContain('12 passed'); expect(r.stdout+r.stderr).not.toMatch(/Unhandled|Uncaught/); }
function fails(r) { expect(r.status).toBe(1); expect(r.stderr).toContain('AssertionError'); expect(r.stdout+r.stderr).not.toMatch(/Unhandled|Uncaught|Failed to resolve import|Failed to load url|Cannot find module/); }
test('parent fails seven intended outcomes and preserves five',()=>{const r=grade('parent',item.base_ref);fails(r);expect(r.stdout).toContain('7 failed | 5 passed');},60000);
test('reference preserves all twelve outcomes',()=>passes(grade('reference')),60000);
test('equivalent recovery prose and helper naming pass',()=>passes(grade('equivalent',item.oracle_ref,cwd=>{
  replace(cwd,provider,'Add credits in ${billing}, then send your message again.','Purchase credits through ${billing}, then submit the request again.');
  replace(cwd,provider,'To continue now, choose another AI preset.','Switch to a different AI preset to continue.');
  const f=join(cwd,provider);writeFileSync(f,readFileSync(f,'utf8').replaceAll('buildAgentBillingMessage','accountRecoveryGuidance'));
})),60000);
test('unused correct helper cannot hide a broken active caller',()=>fails(grade('unused',item.oracle_ref,cwd=>{
  writeFileSync(join(cwd,`${app}/lib/chat/unused-correct-provider.ts`),readFileSync(join(cwd,provider)));
  for(const f of [provider,hook])writeFileSync(join(cwd,f),execFileSync('git',['show',`${item.base_ref}:${f}`],{cwd:repo}));
})),60000);
test('billing 429 cannot fall through to automatic throttling retry',()=>fails(grade('billing-retry',item.oracle_ref,cwd=>replace(cwd,hook,'if (buildProviderErrorPresentation(error, getActivePreset())?.kind === "agent_billing") {','if (false) {'))),60000);
test('blanket retry suppression fails preserved transient behavior',()=>fails(grade('blanket',item.oracle_ref,cwd=>replace(cwd,hook,'return classifyHostedQuotaError(error);','return "none";'))),60000);
test('discarding durable saved messages fails',()=>fails(grade('lost-save',item.oracle_ref,cwd=>replace(cwd,hook,'.actions.setMessages(finalizedSessionId, nextMessages as any);','.actions.setMessages(finalizedSessionId, []);'))),60000);
test('missing provider source is a setup error, not a regression',()=>{
 const r=grade('missing',item.oracle_ref,cwd=>rmSync(join(cwd,provider)));expect(r.status).toBe(1);expect(r.stdout).toContain('no tests');expect(r.stdout+r.stderr).toMatch(/Failed to resolve import|Failed to load url/);
},60000);
