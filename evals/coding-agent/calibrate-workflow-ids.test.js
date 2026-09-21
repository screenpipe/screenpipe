// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const repo=resolve(import.meta.dir,'../..'),path='packages/screenpipe-mcp/src/workflow-tools.ts';
const item=JSON.parse(readFileSync(join(import.meta.dir,'cases.json'),'utf8')).cases.find(c=>c.id==='mcp-maintained-workflow-retrieval');
const source=ref=>execFileSync('git',['show',`${ref}:${path}`],{cwd:repo,encoding:'utf8'});
const broken=source(item.base_ref),fixed=source(item.oracle_ref),fixture='evals/coding-agent/graders/mcp-workflow-ids.test.js';
const grader=readFileSync(join(repo,fixture)),root=mkdtempSync(join(tmpdir(),'workflow-ids-calibration-'));afterAll(()=>rmSync(root,{recursive:true,force:true}));
function grade(name,code,unused){const cwd=join(root,name);mkdirSync(dirname(join(cwd,path)),{recursive:true});if(code!==null)writeFileSync(join(cwd,path),code);if(unused)writeFileSync(join(cwd,dirname(path),'unused.ts'),unused);mkdirSync(dirname(join(cwd,fixture)),{recursive:true});writeFileSync(join(cwd,fixture),grader);return spawnSync(process.execPath,['test','./'+fixture],{cwd,encoding:'utf8',timeout:10_000,env:{PATH:dirname(process.execPath)}});}
function fails(r){expect(r.error).toBeUndefined();expect(r.signal).toBeNull();expect(r.status).toBe(1);expect(r.stderr).toMatch(/[1-9][0-9]* fail/);expect(r.stderr).not.toContain('Cannot find module');expect(r.stderr).not.toContain('Unhandled error');}
function change(old,next){expect(fixed.split(old)).toHaveLength(2);return fixed.replace(old,next);}
test('broken parent fails seven intended outcomes, preserving ten',()=>{const r=grade('broken',broken);fails(r);expect(r.stderr).toContain('7 fail');expect(r.stderr).toContain('10 pass');});
test('reference passes seventeen outcomes',()=>{const r=grade('fixed',fixed);expect(r.status).toBe(0);expect(r.stderr).toContain('17 pass');});
test('equivalent private constant name passes',()=>expect(grade('equivalent',fixed.replaceAll('WORKFLOW_ID','VALID_CATALOG_ID')).status).toBe(0));
test('unused correct module cannot repair retrieval',()=>fails(grade('unused',broken,fixed)));
test('accepting every ID fails malformed request boundaries',()=>fails(grade('no-id-guard',change('typeof args.id !== "string" || args.id.trim() !== args.id || !WORKFLOW_ID.test(args.id)','false'))));
test('UUID-only fix fails preserved legacy retrieval',()=>fails(grade('uuid-only',change('[0-9a-f]{64}|',''))));
test('wrong identity fails response and request outcomes',()=>fails(grade('wrong-id',change('endpoint = `/workflows/${args.id}?','endpoint = `/workflows/wf-${"b".repeat(64)}?'))));
test('ignoring explicit false fails automation boundary',()=>fails(grade('auto-true',change('args.include_automation !== false','true'))));
test('nonboolean options must not reach backend',()=>fails(grade('nonboolean',change('if (args.include_automation !== undefined && typeof args.include_automation !== "boolean")','if (false)'))));
test('removing pagination validation fails preserved refusal',()=>fails(grade('pagination',change('throw new Error(`Invalid ${key}`);\n      params.set','{}\n      params.set'))));
test('reporting provider HTTP failure as success fails',()=>fails(grade('http-success',change('if (!response.ok)','if (false)'))));
test('response-only empty catalog fails successful retrieval',()=>fails(grade('empty-success',change('JSON.stringify(data)','JSON.stringify({ data: [] })'))));
test('blanket refusal fails valid reads',()=>fails(grade('deny',change('let endpoint: string;','throw new Error("denied"); let endpoint: string;'))));
test('missing module is setup failure, never behavioral evidence',()=>{const r=grade('missing',null);expect(r.status).toBe(1);expect(r.stderr).toContain('Cannot find module');expect(r.stderr).toContain('0 pass');});
