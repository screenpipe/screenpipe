// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const repo = resolve(import.meta.dir, '../..');
const item = JSON.parse(readFileSync(join(import.meta.dir, 'cases.json'))).cases.find(c => c.id === 'ai-gateway-voice-transcription-budget');
const root = mkdtempSync(join(tmpdir(), 'voice-budget-calibration-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const template = join(root, 'template');
mkdirSync(template);
execFileSync('tar', ['-x', '-C', template], { input: execFileSync('git', ['archive', item.oracle_ref, 'packages/ai-gateway/src'], { cwd: repo, maxBuffer: 16 * 1024 * 1024 }) });
const indexPath = 'packages/ai-gateway/src/index.ts';
const fixed = readFileSync(join(template, indexPath), 'utf8');
const broken = execFileSync('git', ['show', `${item.base_ref}:${indexPath}`], { cwd: repo, encoding: 'utf8' });
const graderPath = 'evals/coding-agent/graders/voice-transcription-budget.test.js';
const grader = readFileSync(join(repo, graderPath));
const marker = "if (path === '/v1/voice/transcribe' && request.method === 'POST') {";
const start = fixed.indexOf(marker), end = fixed.indexOf("if (path === '/v1/voice/query'", start);
expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
const route = fixed.slice(start, end);
function change(from, to) {
  expect(route.split(from)).toHaveLength(2);
  return fixed.slice(0, start) + route.replace(from, to) + fixed.slice(end);
}
function grade(name, source = fixed, unused = false, costSource = null) {
  const cwd = join(root, name); cpSync(template, cwd, { recursive: true });
  if (source === null) rmSync(join(cwd, indexPath)); else writeFileSync(join(cwd, indexPath), source);
  if (costSource !== null) writeFileSync(join(cwd, 'packages/ai-gateway/src/services/cost-tracker.ts'), costSource);
  if (unused) writeFileSync(join(cwd, 'unused-correct-dispatcher.ts'), fixed);
  symlinkSync(join(repo, 'packages/ai-gateway/node_modules'), join(cwd, 'packages/ai-gateway/node_modules'), 'dir');
  mkdirSync(dirname(join(cwd, graderPath)), { recursive: true }); writeFileSync(join(cwd, graderPath), grader);
  const result = spawnSync(process.execPath, ['test', graderPath], { cwd, encoding: 'utf8', timeout: 15000, env: { PATH: dirname(process.execPath) } });
  if (process.env.EVAL_CALIBRATION_RESULTS) {
    const out = resolve(process.env.EVAL_CALIBRATION_RESULTS); mkdirSync(out, { recursive: true });
    writeFileSync(join(out, name + '.stdout'), result.stdout || ''); writeFileSync(join(out, name + '.stderr'), result.stderr || '');
    writeFileSync(join(out, name + '.json'), JSON.stringify({ status: result.status, signal: result.signal, error: result.error?.message || null }) + '\n');
  }
  return result;
}
function fails(r) {
  expect(r.error).toBeUndefined(); expect(r.signal).toBeNull(); expect(r.status).toBe(1);
  expect(r.stderr).toContain('expect(received)'); expect(r.stderr).not.toContain('Cannot find module');
}
test('broken dispatcher fails four budget outcomes and preserves three', () => { const r = grade('parent', broken); fails(r); expect(r.stderr).toContain('4 fail'); expect(r.stderr).toContain('3 pass'); });
test('historical reference passes seven outcomes', () => { const r = grade('reference'); expect(r.status).toBe(0); expect(r.stderr).toContain('7 pass'); });
test('unused correct dispatcher cannot repair caller', () => fails(grade('unused', broken, true)));
test('equivalent private gate binding is accepted', () => {
  const renamed = fixed.replace('transcriptionGateResponse,', 'transcriptionGateResponse as voiceBudgetGate,').replaceAll('transcriptionGateResponse(env,', 'voiceBudgetGate(env,');
  expect(renamed).not.toBe(fixed); expect(grade('equivalent', renamed).status).toBe(0);
});
test('ignoring gate refusal is rejected', () => fails(grade('ignored', change('if (gate) return gate;', 'void gate;'))));
test('provider work before budget refusal is rejected', () => fails(grade('late', change('if (gate) return gate;', 'if (gate) { await handleVoiceTranscription(request, env); return gate; }'))));
test('blanket refusal loses preserved behavior', () => fails(grade('deny', change(marker, marker + '\n return new Response("blocked", {status:429});'))));
test('fabricated transcript without provider effect is rejected', () => fails(grade('fake', change('await handleVoiceTranscription(request, env)', 'Response.json({transcription:"synthetic transcript"})'))));
test('missing dispatcher is setup failure', () => { const r = grade('missing', null); expect(r.status).not.toBe(0); expect(r.stderr).toContain('Cannot find module'); expect(r.stderr).not.toContain('expect(received)'); });
test('equivalent SQL formatting remains accepted', () => {
  const source = readFileSync(join(template, 'packages/ai-gateway/src/services/cost-tracker.ts'), 'utf8');
  const equivalent = source.replaceAll('SELECT ', 'select ').replaceAll('SUM(daily_cost_usd)', 'sum( daily_cost_usd )');
  expect(equivalent).not.toBe(source); expect(grade('equivalent-sql', fixed, false, equivalent).status).toBe(0);
});
test('reading another account bucket is rejected', () => fails(grade('wrong-account', change('transcriptionCostIdentity(request, authResult)', '"user_unrelated"'))));
