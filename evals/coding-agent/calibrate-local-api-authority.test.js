// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
const repo = resolve(import.meta.dir, '../..'), app = 'apps/screenpipe-app-tauri';
const item = JSON.parse(readFileSync(join(import.meta.dir, 'cases.json'), 'utf8')).cases.find(c => c.id === 'app-local-api-authority');
const apiPath = `${app}/lib/api.ts`, actionPath = `${app}/lib/notifications/actions.ts`;
const root = mkdtempSync(join(tmpdir(), 'local-api-authority-calibration-')), archives = new Map();
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
    for (const path of ['packages/workflows-ui', 'crates/screenpipe-core/assets']) { if (execFileSync('git', ['ls-tree', ref, path], {cwd:repo, encoding:'utf8'}).trim()) paths.push(path); }
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
function passes(r) { expect(r.status).toBe(0); expect(r.stdout).toContain('24 passed'); expect(r.stdout+r.stderr).not.toMatch(/Unhandled|Uncaught/); }
function fails(r) { expect(r.status).toBe(1); expect(r.stderr).toContain('AssertionError'); expect(r.stdout+r.stderr).not.toMatch(/Unhandled|Uncaught|Failed to resolve import|Failed to load url|Cannot find module/); }
test('parent fails intended credential and dispatch outcomes',()=>{const r=grade('parent',item.base_ref);fails(r);expect(r.stdout).toContain('14 failed | 10 passed');},60000);
test('historical reference passes twenty-four outcomes',()=>passes(grade('reference')),60000);
test('current source passes twenty-four outcomes',()=>passes(grade('current','HEAD')),60000);
test('equivalent private authority helper naming passes',()=>passes(grade('equivalent',item.oracle_ref,cwd=>{for(const path of [apiPath,actionPath]){const f=join(cwd,path);writeFileSync(f,readFileSync(f,'utf8').replaceAll('isLocalApiUrl','isConfiguredLoopbackTarget'));}})),60000);
test('inactive correct modules cannot hide broken active code',()=>fails(grade('unused',item.oracle_ref,cwd=>{for(const path of [apiPath,actionPath]){writeFileSync(join(cwd,path+'.unused.ts'),readFileSync(join(cwd,path)));writeFileSync(join(cwd,path),execFileSync('git',['show',`${item.base_ref}:${path}`],{cwd:repo}));}})),60000);
test('blanket key suppression fails local preservation',()=>fails(grade('no-auth',item.oracle_ref,cwd=>{const f=join(cwd,apiPath);writeFileSync(f,readFileSync(f,'utf8').replace('_authEnabled = config.auth_enabled;', '_authEnabled = false;'));})),60000);
test('safe fetch alone does not permit external notification dispatch',()=>fails(grade('no-action-guard',item.oracle_ref,cwd=>replace(cwd,actionPath,'if (!isLocalApiUrl(action.url)) {','if (false) {'))),60000);
test('missing API source is setup failure',()=>{const r=grade('missing',item.oracle_ref,cwd=>rmSync(join(cwd,apiPath)));expect(r.status).toBe(1);expect(r.stdout+r.stderr).toMatch(/Failed to resolve import|Failed to load url/);expect(r.stderr).not.toContain('AssertionError');},60000);
