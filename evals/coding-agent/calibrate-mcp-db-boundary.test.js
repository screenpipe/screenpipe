// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import {afterAll,expect,test} from 'bun:test';
import {execFileSync,spawnSync} from 'node:child_process';
import {cpSync,mkdirSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const repo=resolve(import.meta.dir,'../..'),pkg='packages/screenpipe-mcp',index=pkg+'/src/index.ts';
const item=JSON.parse(readFileSync(join(import.meta.dir,'cases.json'),'utf8')).cases.find(c=>c.id==='mcp-live-database-boundary');
const show=ref=>execFileSync('git',['show',`${ref}:${index}`],{cwd:repo,encoding:'utf8'}),fixed=show(item.oracle_ref),broken=show(item.base_ref);
const root=mkdtempSync(join(tmpdir(),'mcp-db-calibration-')),template=join(root,'template');mkdirSync(template);
execFileSync('tar',['-xf','-','-C',template],{input:execFileSync('git',['archive',item.base_ref,pkg],{cwd:repo,maxBuffer:64*1024*1024})});
afterAll(()=>rmSync(root,{recursive:true,force:true}));
function grade(name,source,extra){
 const cwd=join(root,name);cpSync(template,cwd,{recursive:true});
 if(source===null)rmSync(join(cwd,index));else writeFileSync(join(cwd,index),source);
 if(extra)writeFileSync(join(cwd,index+'.unused.ts'),extra);
 for(const f of item.grader.fixtures)writeFileSync(join(cwd,f.destination_path),readFileSync(join(import.meta.dir,f.local_path)));
 symlinkSync(join(repo,pkg,'node_modules'),join(cwd,pkg,'node_modules'),'dir');
 return spawnSync(process.execPath,['run','test','--','src/eval-db-boundary.test.ts'],{cwd:join(cwd,pkg),encoding:'utf8',timeout:45000,env:{PATH:process.env.PATH,HOME:cwd,BUN_BIN:process.execPath,CI:'true',NO_COLOR:'1',SCREENPIPE_DISABLE_TELEMETRY:'1'}});
}
function fails(r){expect(r.error).toBeUndefined();expect(r.signal).toBeNull();expect(r.status).toBe(1);expect(r.stderr).toContain('AssertionError');expect(r.stderr).not.toContain('Could not resolve');}
function replace(s,a,b){expect(s.split(a)).toHaveLength(2);return s.replace(a,b);}
test('parent reaches the forbidden database boundary and preserves five auth paths',()=>{const r=grade('parent',broken);fails(r);expect(r.stdout).toContain('2 failed | 5 passed');expect(r.stderr).toContain('sqlite3');});
test('reference preserves all seven running-process outcomes',()=>{const r=grade('reference',fixed);expect(r.status).toBe(0);expect(r.stdout).toContain('7 passed');});
test('equivalent auth helper naming passes',()=>expect(grade('renamed',fixed.replaceAll('discoverApiKey','resolveLocalKey').replaceAll('ensureApiKey','getLocalKey')).status).toBe(0));
test('unused correct source cannot rescue the broken running entrypoint',()=>fails(grade('unused',broken,fixed)));
test('removing the existence probe cannot conceal a direct SQLite command',()=>{const r=grade('no-probe',replace(broken,'if (fs.existsSync(dbPath)) {','if (true) {'));fails(r);expect(r.stderr).toContain('sqlite3');});
test('direct database file reads are rejected even when their exception is swallowed',()=>fails(grade('read',replace(fixed,'const home = os.homedir();','const home = os.homedir(); try { fs.readFileSync(path.join(home, ".screenpipe", "db.sqlite")); } catch {}'))));
test('removing supported CLI recovery is rejected',()=>fails(grade('no-cli',replace(fixed,'const home = os.homedir();','return ""; const home = os.homedir();'))));
test('blanket keyless requests fail preserved access',()=>fails(grade('deny',replace(fixed,'function ensureApiKey(): Promise<string> {','function ensureApiKey(): Promise<string> { return Promise.resolve("");'))));
test('missing entrypoint is a build failure, not an intended behavioral contrast',()=>{const r=grade('missing',null);expect(r.status).toBe(1);expect(r.stderr).toMatch(/Could not resolve|ModuleNotFound|not found/);expect(r.stderr).not.toContain('AssertionError');});
