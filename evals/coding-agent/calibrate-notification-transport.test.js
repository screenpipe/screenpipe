// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import {expect,test} from 'bun:test';
import {classifyGraderError} from './grader-outcome.mjs';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,symlinkSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join,dirname} from 'node:path';
const repo=resolve(import.meta.dir,'../..'), prefix='apps/screenpipe-app-tauri/';
const fix='35caddb4562d3bd15fdb0aa3f7928ce20dfed93c',parent='a7d74fb9adf6c9c286ce9cfa33b2e8c9c62135bc';
const files=['lib/live-views/onboarding-follow-up.ts','lib/live-views/onboarding-activation.ts','lib/live-views/time-range.ts','lib/analytics/onboarding-h1-follow-up.ts','lib/notifications/app-server.ts','lib/api.ts','lib/utils/tauri.ts'];
const source='lib/live-views/onboarding-follow-up.ts',client='lib/notifications/app-server.ts';
const runtime=realpathSync(join(repo,prefix,'node_modules'));
const fixtures=[['notification-transport.fixture.ts.txt','eval-notification-transport.test.ts'],['notification-transport.config.mjs','eval-notification-transport.config.mjs'],['notification-localization.fixture.ts.txt','eval-notification-localization.ts']];
function replace(s,from,to){if(!s.includes(from))throw Error('Control mutation drift: '+from);return s.replaceAll(from,to)}
const controls=[
 {name:'parent',ref:parent,passed:3,failed:3},
 {name:'reference',ref:fix,passed:6,failed:0},
 {name:'unused-correct-client',ref:parent,passed:3,failed:3,extra:true},
 {name:'equivalent-private-names',ref:fix,passed:6,failed:0,client:s=>replace(replace(s,'getAppServerBaseUrl','resolveControlAddress'),'appServerBaseUrl','controlAddress')},
 {name:'success-without-delivery',ref:fix,passed:3,failed:3,client:s=>replace(s,'return fetch(`${baseUrl}${normalizedPath}`, init);','return {ok:true} as Response;')},
 {name:'lost-sent-receipt',ref:fix,passed:4,failed:2,source:s=>replace(s,'    markFollowUpSent(activation.viewId, now);','    // intentionally omitted durable receipt')},
 {name:'wrong-engine-endpoint',ref:fix,passed:4,failed:2,client:s=>replace(s,'http://localhost:${config.port || 11435}','http://localhost:3030')},
 {name:'missing-source',ref:fix,passed:0,failed:0,missing:true},
];
for(const control of controls)test(control.name,()=>{
 const root=mkdtempSync(join(tmpdir(),'notification-calibration-')),app=join(root,prefix);
 try{
  for(const path of files){
   if(path===client&&control.ref===parent&&!control.extra)continue;
   const ref=path===client&&control.extra?fix:control.ref;
   let text=execFileSync('git',['show',ref+':'+prefix+path],{cwd:repo,encoding:'utf8'});
   if(path===source&&control.source)text=control.source(text);
   if(path===client&&control.client)text=control.client(text);
   const dest=join(app,path);mkdirSync(dirname(dest),{recursive:true});writeFileSync(dest,text);
  }
  if(control.missing)rmSync(join(app,source));
  for(const [from,to]of fixtures)writeFileSync(join(app,to),readFileSync(join(repo,'evals/coding-agent/graders',from)));
  symlinkSync(runtime,join(app,'node_modules'),'dir');
  const result=spawnSync(process.env.NODE_BIN||'node',['node_modules/vitest/vitest.mjs','run','--config','eval-notification-transport.config.mjs','--reporter=default','--reporter=json','--outputFile=result.json'],{cwd:app,encoding:'utf8',timeout:20000});
  const report=JSON.parse(readFileSync(join(app,'result.json'),'utf8'));
  if(process.env.CALIBRATION_OUTPUT_DIR){const out=process.env.CALIBRATION_OUTPUT_DIR;mkdirSync(out,{recursive:true});writeFileSync(join(out,control.name+'.json'),JSON.stringify({control:control.name,ref:control.ref,exit_code:result.status,signal:result.signal,stdout:result.stdout,stderr:result.stderr,report},null,2)+'\n')}
  expect(result.error).toBeUndefined();expect(result.signal).toBeNull();
  expect(report.numPassedTests).toBe(control.passed);expect(report.numFailedTests).toBe(control.failed);
  expect(result.status===0).toBe(control.failed===0&&!control.missing);
  if(control.missing){expect(classifyGraderError(result)).toBe('vitest_collection_error');expect(report.numTotalTests).toBe(0);expect(JSON.stringify(report)).toMatch(/Failed to load|Cannot find|resolve/)}
  else expect(report.numTotalTests).toBe(6);
 }finally{rmSync(root,{recursive:true,force:true})}
},30000);
