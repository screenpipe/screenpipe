// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import {afterAll,expect,test} from 'bun:test';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
const repo=resolve(import.meta.dir,'../..');
const item=JSON.parse(readFileSync(join(import.meta.dir,'cases.json'),'utf8')).cases.find(c=>c.id==='app-mcp-home-config-scope');
const root=mkdtempSync(join(tmpdir(),'mcp-home-scope-'));
const prefix='apps/screenpipe-app-tauri/';
const source=(path,ref=item.oracle_ref)=>execFileSync('git',['show',`${ref}:${prefix}${path}`],{cwd:repo,encoding:'utf8'});
afterAll(()=>rmSync(root,{recursive:true,force:true}));
function prepare(name,ref=item.oracle_ref){
 const cwd=join(root,name);mkdirSync(cwd);
 for(const path of ['lib/ai-tools-mcp.ts','lib/grokbot-connection.ts']){const dest=join(cwd,path);mkdirSync(dirname(dest),{recursive:true});writeFileSync(dest,source(path,ref));}
 for(const f of item.grader.fixtures){const dest=join(cwd,f.destination_path.slice(prefix.length));mkdirSync(dirname(dest),{recursive:true});writeFileSync(dest,readFileSync(join(import.meta.dir,f.local_path)));}
 symlinkSync(join(repo,prefix,'node_modules'),join(cwd,'node_modules'),'dir');return cwd;
}
function run(cwd){return spawnSync('node',['node_modules/vitest/vitest.mjs','run','lib/__tests__/eval-mcp-home-scope.test.ts','--config','eval-mcp-home-scope.config.mjs'],{cwd,encoding:'utf8',timeout:20000,env:{PATH:process.env.PATH,HOME:cwd,CI:'true',TZ:'UTC',NO_COLOR:'1'}});}
function fails(r){expect(r.error).toBeUndefined();expect(r.signal).toBeNull();expect(r.status).toBe(1);expect(r.stderr).toMatch(/AssertionError|Error: forbidden path|Error: missing/);expect(r.stderr).not.toMatch(/Failed to (load|resolve import)|Unhandled/);}
function replace(s,a,b){expect(s.split(a)).toHaveLength(2);return s.replace(a,b);}
function mutant(name,text){const cwd=prepare(name);writeFileSync(join(cwd,'lib/ai-tools-mcp.ts'),text);return run(cwd);}
test('parent fails three home-config outcomes and preserves ten neighbors',()=>{const r=run(prepare('parent',item.base_ref));fails(r);expect(r.stdout).toContain('3 failed | 10 passed');});
test('reference passes all thirteen outcomes',()=>{const r=run(prepare('reference'));expect(r.status).toBe(0);expect(r.stdout).toContain('13 passed');});
test('unused correct source cannot repair the public caller',()=>{const cwd=prepare('unused',item.base_ref);writeFileSync(join(cwd,'lib/unused-fixed-config.ts'),source('lib/ai-tools-mcp.ts'));fails(run(cwd));});
test('equivalent private variable naming passes',()=>{const s=source('lib/ai-tools-mcp.ts');const equivalent=replace(s,'async function writeConfigAtomic(configPath: string, text: string): Promise<void> {\n  const dir = await dirname(configPath);','async function writeConfigAtomic(configPath: string, text: string): Promise<void> {\n  const configParent = await dirname(configPath);').replace('if (dir !== await join(await homeDir()))','if (configParent !== await join(await homeDir()))').replace('await mkdir(dir, { recursive: true });','await mkdir(configParent, { recursive: true });');expect(mutant('rename',equivalent).status).toBe(0);});
test('silently suppressing writes is rejected',()=>fails(mutant('no-write',replace(source('lib/ai-tools-mcp.ts'),'await writeFile(tmpPath, new TextEncoder().encode(text));','void text;'))));
test('dropping the prior config backup is rejected',()=>fails(mutant('no-backup',replace(source('lib/ai-tools-mcp.ts'),'await copyFile(configPath, `${configPath}.screenpipe-backup-${ts}`);','void ts;'))));
test('missing source is a setup error',()=>{const cwd=prepare('missing');rmSync(join(cwd,'lib/ai-tools-mcp.ts'));const r=run(cwd);expect(r.status).toBe(1);expect(r.stderr).toMatch(/Failed to (?:load|resolve import)|Cannot find module/);expect(r.stdout).toContain('no tests');});
