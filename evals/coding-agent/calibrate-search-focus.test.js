// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
const repo = resolve(import.meta.dir, '../..'), app = 'apps/screenpipe-app-tauri';
const item = JSON.parse(readFileSync(join(import.meta.dir, 'cases.json'), 'utf8')).cases.find(c => c.id === 'app-search-focus-lifecycle');
const hook = `${app}/app/search/page.tsx`;
const root = mkdtempSync(join(tmpdir(), 'search-focus-calibration-')), archives = new Map();
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
function passes(r) { expect(r.status).toBe(0); expect(r.stdout).toContain('10 passed'); expect(r.stdout+r.stderr).not.toMatch(/Unhandled|Uncaught/); }
function fails(r) { expect(r.status).toBe(1); expect(r.stderr).toMatch(/AssertionError|TestingLibraryElementError|Error: expect\(element\)\.toHaveFocus\(\)/); expect(r.stdout+r.stderr).not.toMatch(/Unhandled|Uncaught|Failed to resolve import|Failed to load url|Cannot find module/); }
test('parent fails three hidden-focus outcomes and preserves seven',()=>{const r=grade('parent',item.base_ref);fails(r);expect(r.stdout).toContain('3 failed | 7 passed');},60000);
test('historical reference passes ten outcomes',()=>passes(grade('reference')),60000);
test('current page and focus hook pass ten outcomes',()=>passes(grade('current','HEAD')),60000);
test('keeping the child mounted but inactive is an equivalent solution',()=>passes(grade('equivalent',item.oracle_ref,cwd=>{
 replace(cwd,hook,'{isSearchActive && (\n\t\t\t\t<SearchModal','<SearchModal');
 replace(cwd,hook,'\t\t\t\t\tisOpen\n','\t\t\t\t\tisOpen={isSearchActive}\n');
 replace(cwd,hook,'\n\t\t\t)}','');
})),60000);
test('unused correct page cannot hide the broken imported page',()=>fails(grade('unused',item.oracle_ref,cwd=>{
 writeFileSync(join(cwd,`${app}/unused-correct-search.tsx`),readFileSync(join(cwd,hook)));
 writeFileSync(join(cwd,hook),execFileSync('git',['show',`${item.base_ref}:${hook}`],{cwd:repo}));
})),60000);
test('blanket inactivity fails normal visible behavior',()=>fails(grade('always-hidden',item.oracle_ref,cwd=>replace(cwd,hook,'{isSearchActive && (','{false && ('))),60000);
test('ignoring hidden notification leaves active focus work',()=>fails(grade('no-hide',item.oracle_ref,cwd=>replace(cwd,hook,'listen("search-hidden",','listen("unused-hidden",'))),60000);
test('discarding reset queries fails preserved search context',()=>fails(grade('no-query',item.oracle_ref,cwd=>replace(cwd,hook,'const q = event.payload?.query ?? "";','const q = "";'))),60000);
test('suppressing close fails native handoff',()=>fails(grade('no-close',item.oracle_ref,cwd=>replace(cwd,hook,'onClose={handleClose}','onClose={() => {}}'))),60000);
test('suppressing navigation fails result handoff',()=>fails(grade('no-navigate',item.oracle_ref,cwd=>replace(cwd,hook,'onNavigateToTimestamp={handleNavigate}','onNavigateToTimestamp={() => {}}'))),60000);
test('suppressing the real focus watchdog fails visible recovery',()=>fails(grade('no-focus-guard',item.oracle_ref,cwd=>replace(cwd,`${app}/components/rewind/hooks/use-search-focus.ts`,'const interval = setInterval(() => focusInput(), 500);','const interval = setInterval(() => {}, 500);'))),60000);
test('missing active page is setup failure, not regression evidence',()=>{const r=grade('missing',item.oracle_ref,cwd=>rmSync(join(cwd,hook)));expect(r.status).toBe(1);expect(r.stdout).toContain('no tests');expect(r.stdout+r.stderr).toMatch(/Failed to resolve import|Failed to load url/);},60000);
