// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
const repo = resolve(import.meta.dir, '../..'), app = 'apps/screenpipe-app-tauri';
const item = JSON.parse(readFileSync(join(import.meta.dir, 'cases.json'), 'utf8')).cases.find(c => c.id === 'app-recording-global-device-resume');
const component = `${app}/components/recording-status.tsx`;
const root = mkdtempSync(join(tmpdir(), 'recording-resume-calibration-')), archives = new Map();
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
test('parent loses three resume outcomes and preserves five outcomes',()=>{const r=grade('parent',item.base_ref);fails(r);expect(r.stdout).toContain('3 failed | 5 passed');},60000);
test('reference passes eight outcomes',()=>passes(grade('reference')),60000);
test('component-only oracle repairs the parent',()=>passes(grade('oracle-only',item.base_ref,cwd=>writeFileSync(join(cwd,component),execFileSync('git',['show',`${item.oracle_ref}:${component}`],{cwd:repo})))),60000);
test('current component passes the historical contract',()=>passes(grade('current','HEAD')),60000);
test('equivalent private names and removed test ids pass',()=>passes(grade('equivalent',item.oracle_ref,cwd=>{
 const p=join(cwd,component);writeFileSync(p,readFileSync(p,'utf8').replaceAll('allPaused','everyDevicePaused').replaceAll('data-testid=','data-eval-neutral='));
})),60000);
test('unused correct component does not hide broken active component',()=>fails(grade('unused',item.oracle_ref,cwd=>{
 writeFileSync(join(cwd,`${app}/components/unused-recording-status.tsx`),readFileSync(join(cwd,component)));
 writeFileSync(join(cwd,component),execFileSync('git',['show',`${item.base_ref}:${component}`],{cwd:repo}));
})),60000);
test('reversed global mode routing fails',()=>fails(grade('reversed-mode',item.oracle_ref,cwd=>replace(cwd,component,'if (!isGloballyPaused)','if (isGloballyPaused)'))),60000);
test('broken global pause fails',()=>fails(grade('broken-pause',item.oracle_ref,cwd=>replace(cwd,component,'await onPauseRecording();','await onResumeRecording?.();'))),60000);
test('lost device rollback fails',()=>fails(grade('broken-rollback',item.oracle_ref,cwd=>replace(cwd,component,'active: device.active','active: !device.active'))),60000);
test('missing component is setup error',()=>{const r=grade('missing',item.oracle_ref,cwd=>rmSync(join(cwd,component)));expect(r.status).toBe(1);expect(r.stdout+r.stderr).toMatch(/Failed to resolve import|Failed to load url/);},60000);
// Current-only preservation checks are deliberately outside the historical grader.
test('current disabled capture hides controls and opens settings',()=>{
 const r=grade('current-disabled','HEAD',cwd=>{
  const f=join(cwd,app,'.eval-hidden/recording-resume.test.tsx');
  writeFileSync(f,readFileSync(f,'utf8')+`
test('disabled capture preserves settings recovery without recording actions',()=>{
 const open=vi.fn();
 const p=mount(paused,true,{allCaptureDisabled:true,onOpenRecordingSettings:open});
 expect(screen.queryByRole('button',{name:/all recording/i})).toBeNull();
 expect(screen.queryByRole('button',{name:/^resume$/i})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:/open settings/i}));
 expect(open).toHaveBeenCalledTimes(1);
 expect(p.pause).not.toHaveBeenCalled();expect(p.resume).not.toHaveBeenCalled();expect(ports.fetch).not.toHaveBeenCalled();
});
`);
 });expect(r.status).toBe(0);expect(r.stdout).toContain('9 passed');
},60000);
