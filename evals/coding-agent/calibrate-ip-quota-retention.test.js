// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
const repo = resolve(import.meta.dir, '../..');
const item = JSON.parse(readFileSync(join(import.meta.dir,'cases.json'),'utf8')).cases.find(c => c.id === 'ai-gateway-active-ip-quota-retention');
const sourcePath = 'packages/ai-gateway/src/services/runtime-state-maintenance.ts';
const show = ref => execFileSync('git',['show',`${ref}:${sourcePath}`],{cwd:repo,encoding:'utf8'});
const broken=show(item.base_ref), fixed=show(item.oracle_ref), current=show('HEAD');
const root=mkdtempSync(join(tmpdir(),'ip-quota-calibration-'));
afterAll(()=>rmSync(root,{recursive:true,force:true}));
function grade(name,source,unused=false) {
  const dir=join(root,name); const write=(path,text)=>{mkdirSync(dirname(join(dir,path)),{recursive:true});writeFileSync(join(dir,path),text);};
  if(source!==null) write(sourcePath,source);
  if(unused) write(sourcePath.replace('.ts','.unused.ts'),fixed);
  const fixture=item.grader.fixtures[0];write(fixture.destination_path,readFileSync(join(import.meta.dir,fixture.local_path),'utf8'));
  const r=spawnSync(process.execPath,['--no-env-file','test',fixture.destination_path],{cwd:dir,encoding:'utf8',timeout:15000,env:{PATH:dirname(process.execPath)}});
  if(process.env.EVAL_CALIBRATION_RESULTS_DIR){mkdirSync(process.env.EVAL_CALIBRATION_RESULTS_DIR,{recursive:true});writeFileSync(join(process.env.EVAL_CALIBRATION_RESULTS_DIR,name+'.json'),JSON.stringify({status:r.status,signal:r.signal,error:r.error?.message,stdout:r.stdout,stderr:r.stderr},null,2));}
  expect(r.error).toBeUndefined();expect(r.signal).toBeNull();return r;
}
function pass(r){expect(r.status).toBe(0);expect(r.stderr).toContain('8 pass');}
function fail(r){expect(r.status).toBe(1);expect(r.stderr).toContain('expect(received)');expect(r.stderr).not.toContain('Cannot find module');}
test('parent loses active quotas: four failures and four preserved outcomes',()=>{const r=grade('parent',broken);fail(r);expect(r.stderr).toContain('4 fail');expect(r.stderr).toContain('4 pass');});
test('historical reference preserves every outcome',()=>pass(grade('reference',fixed)));
test('current maintenance preserves every outcome',()=>pass(grade('current',current)));
test('unused correct maintenance cannot bypass actual cleanup',()=>fail(grade('unused',broken,true)));
test('equivalent SQL case and private bindings are accepted',()=>pass(grade('equivalent',fixed.replaceAll('statements','maintenanceBatch').replaceAll('DELETE FROM','delete from').replaceAll('SELECT device_id','select device_id'))));
test('no-op maintenance is rejected',()=>fail(grade('no-op','export async function pruneRuntimeState() {}')));
test('blanket removal is rejected',()=>fail(grade('blanket',"export async function pruneRuntimeState(env) { await env.DB.prepare('DELETE FROM usage').run(); }")));
test('removing the batch bound is rejected',()=>{expect(fixed).toContain('5_000');fail(grade('unbounded',fixed.replace('5_000','50_000')));});
test('missing source remains a setup error',()=>{const r=grade('missing',null);expect(r.status).not.toBe(0);expect(r.stderr).toContain('Cannot find module');expect(r.stderr).not.toContain('expect(received)');});
