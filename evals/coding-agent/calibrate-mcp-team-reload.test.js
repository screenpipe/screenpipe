// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const repo=resolve(import.meta.dir,'../..');
const item=JSON.parse(readFileSync(join(import.meta.dir,'cases.json'),'utf8')).cases.find(c=>c.id==='mcp-team-credential-reload');
const pkg='packages/screenpipe-mcp',index=`${pkg}/src/index.ts`,config=`${pkg}/src/team-config.ts`;
const show=(ref,p)=>execFileSync('git',['-c','core.commitGraph=false','show',`${ref}:${p}`],{cwd:repo,encoding:'utf8'});
const fixed={[index]:show(item.oracle_ref,index),[config]:show(item.oracle_ref,config)};
const broken={[index]:show(item.base_ref,index),[config]:show(item.base_ref,config)};
const root=mkdtempSync(join(tmpdir(),'mcp-team-reload-'));
const template=join(root,'template');mkdirSync(template);
const archive=execFileSync('git',['archive',item.base_ref,pkg],{cwd:repo,maxBuffer:64*1024*1024});
execFileSync('tar',['-xf','-','-C',template],{input:archive});
afterAll(()=>rmSync(root,{recursive:true,force:true}));
function grade(name,sources){
 const cwd=join(root,name);cpSync(template,cwd,{recursive:true});
 for(const [p,s] of Object.entries(sources)){
  if(s===null)rmSync(join(cwd,p));else writeFileSync(join(cwd,p),s);
 }
 writeFileSync(join(cwd,pkg,'src/eval-team-auth.test.ts'),readFileSync(join(import.meta.dir,'graders/mcp-team-reload.fixture.ts')));
 symlinkSync(join(repo,pkg,'node_modules'),join(cwd,pkg,'node_modules'),'dir');
 const r=spawnSync(process.execPath,['run','test','--','src/eval-team-auth.test.ts'],{cwd:join(cwd,pkg),encoding:'utf8',timeout:45_000,env:{PATH:process.env.PATH,HOME:cwd,TZ:'UTC',CI:'true',NO_COLOR:'1',FORCE_COLOR:'0',SCREENPIPE_DISABLE_TELEMETRY:'1'}});
 for(const key of ['stdout','stderr'])r[key]=r[key]?.replace(/\x1b\[[0-9;]*m/g,'');
 return r;
}
function fails(r){expect(r.error).toBeUndefined();expect(r.signal).toBeNull();expect(r.status).toBe(1);expect(r.stderr).toContain('AssertionError');expect(r.stdout).toMatch(/Tests\s+\d+ failed/);expect(r.stderr).not.toContain('Cannot find module');}
function replace(s,old,next){expect(s.split(old)).toHaveLength(2);return s.replace(old,next);}
test('broken parent reaches intended credential and gateway failures',()=>{const r=grade('parent',broken);fails(r);expect(r.stdout).toContain('6 failed | 1 passed (7)');},60_000);
test('historical reference passes real running-process outcomes',()=>{const r=grade('reference',fixed);expect(r.status).toBe(0);expect(r.stdout).toContain('7 passed');},60_000);
test('unused correct config helper beside stale caller is rejected',()=>fails(grade('helper-only',{...broken,[config]:fixed[config]})),60_000);
test('equivalent helper and request snapshot renaming passes',()=>{
 const sources=Object.fromEntries(Object.entries(fixed).map(([p,s])=>[p,s.replaceAll('discoverTeamConfig','loadCurrentTeamSettings').replaceAll('teamConfig','requestSettings')]));expect(grade('renamed',sources).status).toBe(0);
},60_000);
test('one boot-time snapshot cannot masquerade as current request state',()=>{
 const s=fixed[index].replace('// Initialize server','const cachedTeamConfig = discoverTeamConfig(teamApiOverride);\n// Initialize server').replaceAll('const { token } = discoverTeamConfig(teamApiOverride);','const { token } = cachedTeamConfig;').replaceAll('const teamConfig = discoverTeamConfig(teamApiOverride);','const teamConfig = cachedTeamConfig;');
 fails(grade('cached',{...fixed,[index]:s}));
},60_000);
test('blanket team denial fails preserved working access',()=>fails(grade('deny-all',{...fixed,[index]:replace(fixed[index],'if (!teamConfig.token) {','if (true) {')})),60_000);
test('new token paired with stale gateway is rejected',()=>{
 const s=fixed[index].replace('// Initialize server','const cachedTeamGateway = discoverTeamConfig(teamApiOverride).apiBase;\n// Initialize server').replace('`${config.apiBase}${p}`','`${cachedTeamGateway}${p}`');
 fails(grade('gateway-stale',{...fixed,[index]:s}));
},60_000);
test('missing config source is a build error rather than behavior evidence',()=>{
 const r=grade('missing-source',{...fixed,[config]:null});expect(r.status).toBe(1);expect(r.stdout).toContain('skipped');expect(r.stderr).toContain('Could not resolve');expect(r.stderr).not.toContain('AssertionError');
},60_000);
