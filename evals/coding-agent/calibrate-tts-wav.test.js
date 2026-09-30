// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const repo=resolve(import.meta.dir,'../..'),path='packages/ai-gateway/src/utils/voice-utils.ts';
const item=JSON.parse(readFileSync(join(import.meta.dir,'cases.json'),'utf8')).cases.find(c=>c.id==='ai-gateway-tts-wav-response');
const source=(ref,p=path)=>execFileSync('git',['show',`${ref}:${p}`],{cwd:repo,encoding:'utf8'});
const broken=source(item.base_ref),fixed=source(item.oracle_ref),fixture='evals/coding-agent/graders/tts-wav.test.js';
const grader=readFileSync(join(repo,fixture)),root=mkdtempSync(join(tmpdir(),'tts-wav-calibration-'));afterAll(()=>rmSync(root,{recursive:true,force:true}));
function grade(name,code,unused){const cwd=join(root,name);const put=(p,b)=>{mkdirSync(dirname(join(cwd,p)),{recursive:true});writeFileSync(join(cwd,p),b);};for(const p of ['packages/ai-gateway/src/handlers/voice.ts','packages/ai-gateway/src/utils/cors.ts','packages/ai-gateway/src/types.ts'])put(p,source(item.base_ref,p));if(code!==null)put(path,code);if(unused)put('packages/ai-gateway/src/utils/unused.ts',unused);put(fixture,grader);return spawnSync(process.execPath,['test','./'+fixture],{cwd,encoding:'utf8',timeout:15_000,maxBuffer:8*1024*1024,env:{PATH:dirname(process.execPath)}});}
function fails(r){expect(r.error).toBeUndefined();expect(r.signal).toBeNull();expect(r.status).toBe(1);expect(r.stderr).toMatch(/[1-9][0-9]* fail/);expect(r.stderr).not.toContain('Cannot find module');expect(r.stderr).not.toContain('Unhandled error');}
function change(old,next){expect(fixed.split(old)).toHaveLength(2);return fixed.replace(old,next);}
test('parent exposes intended format failures with preserved refusals',()=>{const r=grade('parent',broken);fails(r);expect(r.stderr).toMatch(/[1-9][0-9]* pass/);});
test('reference preserves all15outcomes',()=>{const r=grade('reference',fixed);expect(r.status).toBe(0);expect(r.stderr).toContain('15 pass');});
test('equivalent signature helper naming passes',()=>expect(grade('equivalent',fixed.replaceAll('hasWavHeader','isRequestedWaveContainer')).status).toBe(0));
test('unused correct utility cannot repair caller',()=>fails(grade('unused',broken,fixed)));
test('omitting explicit container fails provider contract',()=>fails(grade('container',change("url.searchParams.set('container', 'wav');",''))));
test('accepting arbitrary bytes fails malformed results',()=>fails(grade('accept-bytes',change("if (encoding === 'linear16' && !hasWavHeader(audioBuffer))",'if (false)'))));
test('dropping returned provider bytes fails successful responses',()=>fails(grade('drop-bytes',change('return audioBuffer;','return new ArrayBuffer(0);'))));
test('forcing WAV validation for mp3 loses preserved behavior',()=>fails(grade('force-wav',change("encoding === 'linear16' && !hasWavHeader(audioBuffer)",'!hasWavHeader(audioBuffer)'))));
test('blanket refusal cannot satisfy the grader',()=>fails(grade('deny',change('return audioBuffer;','return null;'))));
test('missing utility is setup failure',()=>{const r=grade('missing',null);expect(r.status).toBe(1);expect(r.stderr).toContain('Could not resolve');expect(r.stderr).toContain('Unhandled error between tests');expect(r.stderr).toContain('0 pass');});
