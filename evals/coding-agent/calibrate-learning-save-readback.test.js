// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
const repo=resolve(import.meta.dir,'../..'), source='crates/screenpipe-core/assets/extensions/skill-learning.ts';
const item=JSON.parse(readFileSync(join(import.meta.dir,'cases.json'),'utf8')).cases.find(c=>c.id==='app-learning-save-readback');
const root=mkdtempSync(join(tmpdir(),'calibrate-learning-readback-')),receipts=process.env.SCREENPIPE_EVAL_CALIBRATION_RECEIPTS;
afterAll(()=>rmSync(root,{recursive:true,force:true}));
function replace(cwd,from,to){const p=join(cwd,source),s=readFileSync(p,'utf8');expect(s.includes(from)).toBe(true);writeFileSync(p,s.replaceAll(from,to));}
function grade(name,ref=item.oracle_ref,mutate=()=>{}){
 const cwd=join(root,name);mkdirSync(dirname(join(cwd,source)),{recursive:true});
 writeFileSync(join(cwd,source),execFileSync('git',['show',`${ref}:${source}`],{cwd:repo}));
 for(const f of item.grader.fixtures){const dest=join(cwd,f.destination_path);mkdirSync(dirname(dest),{recursive:true});writeFileSync(dest,readFileSync(join(import.meta.dir,f.local_path)));}
 mutate(cwd);
 const r=spawnSync('/bin/bash',['-c',item.grader.command],{cwd,encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024,env:{PATH:process.env.PATH,HOME:cwd,CI:'true',TZ:'UTC',NO_COLOR:'1'}});
 if(receipts){mkdirSync(receipts,{recursive:true});writeFileSync(join(receipts,name+'.stdout'),r.stdout||'');writeFileSync(join(receipts,name+'.stderr'),r.stderr||'');writeFileSync(join(receipts,name+'.json'),JSON.stringify({ref,command:item.grader.command,exit_code:r.status,signal:r.signal,error:r.error?.message},null,2));}
 expect(r.error).toBeUndefined();expect(r.signal).toBeNull();return r;
}
function passes(r){expect(r.status).toBe(0);expect(r.stderr).toContain('12 pass');expect(r.stderr).toContain('0 fail');}
function fails(r){expect(r.status).toBe(1);expect(r.stderr).toContain('expect(');expect(r.stderr).not.toMatch(/Cannot find module|error: Unexpected|SyntaxError/);}
test('broken parent exposes five false successes and preserves seven outcomes',()=>{const r=grade('parent',item.base_ref);fails(r);expect(r.stderr).toContain('5 fail');expect(r.stderr).toContain('7 pass');});
test('historical reference passes',()=>passes(grade('reference')));
test('current source passes',()=>passes(grade('current','HEAD')));
test('equivalent helper naming passes',()=>passes(grade('equivalent',item.oracle_ref,cwd=>replace(cwd,'saveState','persistLearningReceipt'))));
test('unused correct code cannot hide the broken caller',()=>fails(grade('unused',item.oracle_ref,cwd=>{writeFileSync(join(cwd,'unused-correct.ts'),readFileSync(join(cwd,source)));writeFileSync(join(cwd,source),execFileSync('git',['show',`${item.base_ref}:${source}`],{cwd:repo}));})));
test('blanket save refusal fails preserved successful writes',()=>fails(grade('refuse-all',item.oracle_ref,cwd=>replace(cwd,'    const current = inventory.get(input.name);','    throw new Error("All writes refused");\n    const current = inventory.get(input.name);'))));
test('lost review report fails successful preservation',()=>fails(grade('no-report',item.oracle_ref,cwd=>replace(cwd,'    const output = join(root, "output");','    if (name === "latest-change.md") return;\n    const output = join(root, "output");'))));
test('ignoring returned hashes fails uncertain-write checks',()=>fails(grade('ignore-hash',item.oracle_ref,cwd=>replace(cwd,'if (!skill?.sha256 || saved?.sha256 !== skill.sha256','if (false'))));
test('clearing pending evidence fails durable uncertainty',()=>fails(grade('lose-pending',item.oracle_ref,cwd=>replace(cwd,'async function saveState() { await localFile("learning-state.json", JSON.stringify(state)); }','async function saveState() { const {pending, ...rest} = state; await localFile("learning-state.json", JSON.stringify(rest)); }'))));
test('missing active source remains an infrastructure failure',()=>{const r=grade('missing',item.oracle_ref,cwd=>rmSync(join(cwd,source)));expect(r.status).toBe(1);expect(r.stderr).toContain('Cannot find module');expect(r.stderr).not.toContain('expect(received)');});
