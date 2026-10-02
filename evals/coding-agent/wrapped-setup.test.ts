// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import {expect,test} from "bun:test";
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {spawnSync} from "node:child_process";
import {classifyGraderError} from "./grader-outcome.mjs";

const collection={status:1,stdout:" RUN v1.6.1 /synthetic\n Test Files 1 failed (1)\n Tests no tests\n",
 stderr:"Failed Suites 1\nError: [vitest] There was an error when mocking a module. If you are using vi.mock factory, check imports.\nCaused by: Error: Failed to load url synthetic-provider (resolved id: synthetic-provider) in /synthetic/fixture.test.ts. Does the file exist?\n"};
test("wrapped missing dependencies need complete collection evidence",()=>{
 expect(classifyGraderError(collection)).toBe("vitest_collection_error");
 expect(classifyGraderError({...collection,stdout:"\x1b[31m"+collection.stdout+"\x1b[0m",stderr:"\x1b[31m"+collection.stderr+"\x1b[0m"})).toBe("vitest_collection_error");
 for(const stdout of ["",collection.stdout.replace(" Tests no tests\n",""),collection.stdout.replace("no tests","1 failed (1)"),collection.stdout+" Tests 1 failed (1)\n",collection.stdout.replace("Test Files 1 failed (1)","Test Files 1 passed (1)")])expect(classifyGraderError({...collection,stdout})).toBeNull();
 for(const stderr of [collection.stderr.replace("Error: [vitest] There was an error when mocking a module.","Error: unrecognized wrapper"),collection.stderr.replace("Caused by: Error: Failed to load url", "Caused by: TypeError: unexpected"),collection.stderr.replace(" Does the file exist?", ""),collection.stderr+"AssertionError: actual result differs\n"])expect(classifyGraderError({...collection,stderr})).toBeNull();
 expect(classifyGraderError({...collection,status:0})).toBeNull();
});
test("wrapped collection errors invalidate corpus verification and stay out of scored trials",()=>{
 const repo=mkdtempSync(join(tmpdir(),"wrapped-setup-control-"));
 const run=(program:string,args:string[])=>{const z=spawnSync(program,args,{cwd:repo,encoding:"utf8",timeout:30000});expect(z.error).toBeUndefined();return z;};
 const git=(...args:string[])=>{const z=run("git",args);expect(z.status).toBe(0);return z.stdout.trim();};
 try{
  git("init","-q");git("config","user.name","Synthetic fixture");git("config","user.email","fixture@example.invalid");git("config","commit.gpgsign","false");
  writeFileSync(join(repo,"state.txt"),"broken");git("add","state.txt");git("commit","-qm","broken");const base=git("rev-parse","HEAD");writeFileSync(join(repo,"state.txt"),"fixed");git("commit","-qam","fixed");const fixed=git("rev-parse","HEAD");
  writeFileSync(join(repo,"grade.mjs"),`import {readFileSync} from 'node:fs';
const broken=readFileSync('state.txt','utf8')==='broken';const id=process.env.SCREENPIPE_EVAL_CASE_ID;
const affected=id==='wrapped-reference'?!broken:broken;
if(affected){process.stdout.write(${JSON.stringify(collection.stdout)});process.stderr.write(${JSON.stringify(collection.stderr)});if(id==='real-assertion'){process.stdout.write('Tests 1 failed (1)\\n');process.stderr.write('AssertionError: expected behavior failed\\n');}process.exit(1);}
process.exit(id==='wrapped-reference'&&broken?1:0);`);
  const cases=["wrapped-baseline","wrapped-reference","real-assertion"].map(id=>({id,name:id,base_ref:base,oracle_ref:fixed,source:{kind:"git_regression",fix_commit:fixed},oracle_paths:["state.txt"],prompt:"Synthetic runner control; no agent trial.",grader:{command:"node grade.mjs",fixtures:[{local_path:"grade.mjs",destination_path:"grade.mjs"}]}}));
  writeFileSync(join(repo,"cases.json"),JSON.stringify({schema_version:1,suite:"wrapped-setup-controls",dataset_version:"1",cases}));
  const runner=new URL("./run.mjs",import.meta.url).pathname;
  const invoke=(dir:string,...args:string[])=>run("node",[runner,"--repo",repo,"--manifest",join(repo,"cases.json"),"--results-dir",join(repo,dir),...args]);
  expect(invoke("verify","--verify").status).toBe(1);
  const results=JSON.parse(readFileSync(join(repo,"verify/verification.json"),"utf8"));
  expect(results.map((r:any)=>[r.baseline.outcome,r.oracle.outcome,r.valid])).toEqual([["error","pass",false],["fail","error",false],["fail","pass",true]]);
  expect(invoke("scoring","--mode","baseline","--case","wrapped-baseline").status).toBe(0);
  const summary=JSON.parse(readFileSync(join(repo,"scoring/summary.json"),"utf8"));
  expect(summary.cases[0]).toMatchObject({errors:1,scored_trials:0,success_rate:null});
 }finally{rmSync(repo,{recursive:true,force:true});}
},45000);
