// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
const root=mkdtempSync(join(tmpdir(),'eval-fingerprints-'));
const repo=join(root,'repo');mkdirSync(repo);
const runnerRoot=join(root,'runner');mkdirSync(runnerRoot);
for(const p of ['run.mjs','grader-outcome.mjs'])copyFileSync(join(import.meta.dir,p),join(runnerRoot,p));
afterAll(()=>rmSync(root,{recursive:true,force:true}));
const git=(...args:string[])=>execFileSync('git',args,{cwd:repo,encoding:'utf8'}).trim();
const hash=(bytes:any)=>createHash('sha256').update(bytes).digest('hex');
const correct='import {readFileSync} from "node:fs"; process.exit(readFileSync("state.txt","utf8")==="broken" ? 1 : 0);\n';
git('init','-q');git('config','user.name','Synthetic eval control');git('config','user.email','fixture@example.invalid');git('config','commit.gpgsign','false');
writeFileSync(join(repo,'state.txt'),'broken');writeFileSync(join(repo,'git-grader.mjs'),correct);git('add','state.txt','git-grader.mjs');git('commit','-qm','synthetic broken state');const base=git('rev-parse','HEAD');
writeFileSync(join(repo,'state.txt'),'fixed');git('commit','-qam','synthetic reference');const fix=git('rev-parse','HEAD');
writeFileSync(join(repo,'git-grader.mjs'),'process.exit(0);\n');git('commit','-qam','synthetic alternative grader');const other=git('rev-parse','HEAD');git('checkout','-q','--detach',fix);git('branch','fixture-source',fix);
writeFileSync(join(repo,'local-grader.mjs'),correct);
const cases=['local','git'].map(id=>({id,name:id,base_ref:base,oracle_ref:fix,oracle_paths:['state.txt'],source:{kind:'git_regression',fix_commit:fix},prompt:'Synthetic fingerprint control; no model runs.',grader:{timeout_seconds:5,command:'exec node hidden.mjs',fixtures:[id==='local'?{local_path:'local-grader.mjs',destination_path:'hidden.mjs'}:{source_ref:'fixture-source',source_path:'git-grader.mjs',destination_path:'hidden.mjs'}]}}));
const manifest=join(repo,'cases.json');writeFileSync(manifest,JSON.stringify({schema_version:1,suite:'synthetic-fingerprint-controls',dataset_version:'1',cases}));
let seq=0;
function run(runner=join(runnerRoot,'run.mjs'),extra:string[]=[]){
 const output=join(root,`out-${++seq}`);
 const result=spawnSync('node',[runner,'--repo',repo,'--manifest',manifest,'--mode','baseline','--results-dir',output,...extra],{cwd:repo,encoding:'utf8',timeout:20000});
 expect(result.error).toBeUndefined();expect(result.status).toBe(0);
 return {report:JSON.parse(readFileSync(join(output,'summary.json'),'utf8')),output};
}
test('executed grader and shared harness bytes identify reports without changing scoring',()=>{
 const first=run();const second=run();
 // First establish the observable collision: same committed repo and manifest,
 // changed hidden grader, different outcome. The new execution fingerprint must differ.
 writeFileSync(join(repo,'local-grader.mjs'),'process.exit(0);\n');const changed=run();
 expect(first.report.trials.find((t:any)=>t.case_id==='local').outcome).toBe('fail');
 expect(changed.report.trials.find((t:any)=>t.case_id==='local').outcome).toBe('pass');
 expect(changed.report.dataset_fingerprint).toBe(first.report.dataset_fingerprint);
 expect(changed.report.runtime.repo_head).toBe(first.report.runtime.repo_head);
 expect(changed.report.runtime.fingerprint).toBe(first.report.runtime.fingerprint);
 expect(first.report.evaluation_fingerprint).toMatch(/^[a-f0-9]{64}$/);
 expect(changed.report.evaluation_fingerprint).not.toBe(first.report.evaluation_fingerprint);
 expect(second.report.evaluation_fingerprint).toBe(first.report.evaluation_fingerprint);
 expect(second.report.runtime.fingerprint).toBe(first.report.runtime.fingerprint);
 const trial=changed.report.trials.find((t:any)=>t.case_id==='local');
 expect(trial.grader_provenance.fixtures[0]).toMatchObject({destination_path:'hidden.mjs',sha256:hash('process.exit(0);\n')});
 expect(trial.evaluation_fingerprint).not.toBe(first.report.trials.find((t:any)=>t.case_id==='local').evaluation_fingerprint);
 expect(trial.harness_provenance.files['grader-outcome.mjs']).toBe(hash(readFileSync(join(runnerRoot,'grader-outcome.mjs'))));
 expect(changed.report.provenance_complete).toBe(true);
 // Restore exact bytes: output paths, elapsed time and run IDs are not identity.
 writeFileSync(join(repo,'local-grader.mjs'),correct);const restored=run();
 expect(restored.report.evaluation_fingerprint).toBe(first.report.evaluation_fingerprint);
 // Git fixture aliases are resolved and content-recorded without moving HEAD.
 git('update-ref','refs/heads/fixture-source',other);const moved=run();
 expect(moved.report.runtime.repo_head).toBe(first.report.runtime.repo_head);
 expect(moved.report.evaluation_fingerprint).not.toBe(first.report.evaluation_fingerprint);
 const gitTrial=moved.report.trials.find((t:any)=>t.case_id==='git');
 expect(gitTrial.grader_provenance.fixtures[0]).toMatchObject({source_commit:other,sha256:hash('process.exit(0);\n')});
 git('update-ref','refs/heads/fixture-source',fix);
 // Imported classifier implementation must count even when repo is elsewhere.
 const originalHelper=readFileSync(join(runnerRoot,'grader-outcome.mjs'),'utf8');
 writeFileSync(join(runnerRoot,'grader-outcome.mjs'),originalHelper+'\n// synthetic implementation version\n');const helper=run();
 expect(helper.report.runtime.fingerprint).not.toBe(first.report.runtime.fingerprint);
 expect(helper.report.evaluation_fingerprint).not.toBe(first.report.evaluation_fingerprint);
 writeFileSync(join(runnerRoot,'grader-outcome.mjs'),originalHelper);
 const originalRunner=readFileSync(join(runnerRoot,'run.mjs'),'utf8');
 writeFileSync(join(runnerRoot,'run.mjs'),originalRunner+'\n// synthetic runner version\n');const changedRunner=run();
 expect(changedRunner.report.evaluation_fingerprint).not.toBe(first.report.evaluation_fingerprint);
 writeFileSync(join(runnerRoot,'run.mjs'),originalRunner);
 const copied=join(root,'copied');mkdirSync(copied);for(const p of ['run.mjs','grader-outcome.mjs'])copyFileSync(join(runnerRoot,p),join(copied,p));
 expect(run(join(copied,'run.mjs')).report.evaluation_fingerprint).toBe(first.report.evaluation_fingerprint);
 const selected=run(undefined,['--case','local']);expect(selected.report.evaluation_fingerprint).not.toBe(first.report.evaluation_fingerprint);
 expect(selected.report.trials).toHaveLength(1);
 // Verification has no summary.json; its actual per-trial provenance must persist.
 const output=join(root,'verified');const verified=spawnSync('node',[join(runnerRoot,'run.mjs'),'--repo',repo,'--manifest',manifest,'--verify','--results-dir',output],{cwd:repo,encoding:'utf8',timeout:20000});
 expect(verified.status).toBe(0);const records=JSON.parse(readFileSync(join(output,'verification.json'),'utf8'));
 for(const record of records){expect(record.valid).toBe(true);expect(record.baseline.evaluation_fingerprint).toMatch(/^[a-f0-9]{64}$/);expect(record.oracle.evaluation_fingerprint).toBe(record.baseline.evaluation_fingerprint);}
 // A setup failure must not acquire a complete execution fingerprint.
 git('config','remote.origin.promisor','true');
 git('config','remote.origin.url',join(root,'missing-extraction-source'));
 const unavailable=run();
 expect(unavailable.report.provenance_complete).toBe(false);
 expect(unavailable.report.evaluation_fingerprint).toBeNull();
 for(const trial of unavailable.report.trials){expect(trial.outcome).toBe('error');expect(trial.grader_provenance).toBeUndefined();}
},60000);
