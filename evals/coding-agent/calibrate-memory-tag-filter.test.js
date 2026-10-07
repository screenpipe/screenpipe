// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { classifyGraderError } from './grader-outcome.mjs';
const repo = resolve(import.meta.dir, '../..');
const item = JSON.parse(readFileSync(join(import.meta.dir,'cases.json'))).cases.find(c=>c.id==='app-memory-tag-filter-malformed-json');
const source = item.oracle_paths[0];
const git = (...args) => execFileSync('git',args,{cwd:repo,encoding:'utf8',maxBuffer:128*1024*1024});
const parent=git('show',`${item.base_ref}:${source}`), fixed=git('show',`${item.oracle_ref}:${source}`);
const fixture=readFileSync(join(import.meta.dir,'graders/memory-tag-filter.rs'));
const hash=x=>createHash('sha256').update(x).digest('hex');
function change(text,from,to,count=1){expect(text.split(from).length-1).toBe(count);return text.split(from).join(to);}
test('memory tag grader rejects broken, bypass and preserved-behavior regressions',()=>{
 const root=mkdtempSync(join(tmpdir(),'memory-tag-calibration-'));
 try {
  const archive=execFileSync('git',['archive',item.base_ref],{cwd:repo,maxBuffer:128*1024*1024});
  execFileSync('tar',['-x','-C',root],{input:archive});
  writeFileSync(join(root,'crates/screenpipe-db/tests/eval_memory_tag_filter.rs'),fixture);
  const guarded="json_each(CASE WHEN json_valid({tags_col}) THEN {tags_col} ELSE '[]' END)";
  const controls=[
   ['parent',parent,'fail'],['reference',fixed,'pass'],
   ['equivalent',change(fixed,'json_valid({tags_col}) THEN','json_valid({tags_col}) = 1 THEN',2),'pass'],
   ['unused',parent,'fail'],
   ['count-only',fixed.replace(guarded,'json_each({tags_col})'),'fail'],
   ['list-only',(()=>{const at=fixed.lastIndexOf(guarded);expect(at).toBeGreaterThan(0);return fixed.slice(0,at)+fixed.slice(at).replace(guarded,'json_each({tags_col})');})(),'fail'],
   ['ignore-tags',change(fixed,'.bind(&tags_all_json)','.bind("[]")',2),'fail'],
   ['blanket-filter',change(fixed,'.bind(&tags_all_json)',String.raw`.bind("[\"missing\"]")`,2),'fail'],
   ['missing',null,'error'],
  ];
  for(const [name,text,expected] of controls){
   if(text===null)rmSync(join(root,source));else writeFileSync(join(root,source),text);
   if(name==='unused')writeFileSync(join(root,'unused-correct.rs'),fixed);else rmSync(join(root,'unused-correct.rs'),{force:true});
   // Calibration alone reuses its own target. No evaluated agent runs here.
   const result=spawnSync('/bin/bash',['-c',item.grader.command],{cwd:root,encoding:'utf8',timeout:item.grader.timeout_seconds*1000,maxBuffer:8*1024*1024});
   const kind=classifyGraderError(result);const observed=result.error||result.signal||kind?'error':result.status===0?'pass':'fail';
   if(process.env.SCREENPIPE_EVAL_CALIBRATION_RECEIPTS){const dir=resolve(process.env.SCREENPIPE_EVAL_CALIBRATION_RECEIPTS);mkdirSync(dir,{recursive:true});writeFileSync(join(dir,`${name}.json`),JSON.stringify({expected,observed,command:item.grader.command,status:result.status,signal:result.signal,error:result.error?.message??null,error_kind:kind,source_sha256:text===null?null:hash(text),fixture_sha256:hash(fixture),stdout:result.stdout,stderr:result.stderr},null,2));}
   expect(result.error).toBeUndefined();expect(result.signal).toBeNull();expect(observed).toBe(expected);
   if(expected==='pass')expect(result.stdout).toContain('6 passed; 0 failed');
   if(expected==='fail'){expect(result.status).toBe(101);expect(result.stdout).toContain('test result: FAILED.');}
   if(name==='parent')expect(result.stdout).toContain('2 passed; 4 failed');
   if(name==='missing')expect(kind).toBe('rust_compile_error');
  }
 }finally{rmSync(root,{recursive:true,force:true});}
},1500000);
