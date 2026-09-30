// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
const repo = resolve(import.meta.dir, '../..'), source = 'packages/ai-gateway/src/providers/screenpipe-glm.ts';
const fixture = 'evals/coding-agent/graders/ai-gateway-glm-tool-history.test.js';
const item = JSON.parse(readFileSync(join(import.meta.dir, 'cases.json'), 'utf8')).cases.find(c => c.id === 'ai-gateway-glm-bounded-tool-history');
const root = mkdtempSync(join(tmpdir(), 'glm-history-calibration-')), archives = new Map();
afterAll(() => rmSync(root, { recursive: true, force: true }));
function grade(name, ref = item.oracle_ref, mutate = () => {}) {
  const cwd = join(root, name); mkdirSync(cwd);
  if (!archives.has(ref)) archives.set(ref, execFileSync('git', ['-c', 'core.commitGraph=false', 'archive', ref, 'packages/ai-gateway'], { cwd: repo, maxBuffer: 32 * 1024 * 1024 }));
  execFileSync('tar', ['-x', '-C', cwd], { input: archives.get(ref) });
  mkdirSync(dirname(join(cwd, fixture)), { recursive: true }); writeFileSync(join(cwd, fixture), readFileSync(join(repo, fixture))); mutate(cwd);
  return spawnSync(process.execPath, ['test', fixture], { cwd, encoding: 'utf8', timeout: 20_000, env: { PATH: dirname(process.execPath) } });
}
function change(cwd, from, to) { const path = join(cwd, source), text = readFileSync(path, 'utf8'); expect(text.split(from)).toHaveLength(2); writeFileSync(path, text.replace(from, to)); }
function fails(result) { expect(result.error).toBeUndefined(); expect(result.signal).toBeNull(); expect(result.status).toBe(1); expect(result.stderr).toContain('expect(received)'); expect(result.stderr).not.toContain('Cannot find'); expect(result.stderr).not.toContain('Unhandled error'); }
test('broken parent fails twelve wire outcomes and preserves fourteen neighbors', () => { const r = grade('parent', item.base_ref); fails(r); expect(r.stderr).toContain('12 fail'); expect(r.stderr).toContain('14 pass'); });
test('reference passes streaming and non-streaming requests', () => { const r = grade('reference'); expect(r.status).toBe(0); expect(r.stderr).toContain('26 pass'); });
test('different valid head-tail allocation is accepted', () => { expect(grade('equivalent', item.oracle_ref, cwd => change(cwd, 'available * 0.82', 'available * 0.65')).status).toBe(0); });
test('unused compaction helper cannot conceal completion bypass', () => fails(grade('completion-bypass', item.oracle_ref, cwd => change(cwd, 'super.createCompletion(normalizeGlmRequest(body))', 'super.createCompletion(body)'))));
test('streaming must also dispatch compacted history', () => fails(grade('stream-bypass', item.oracle_ref, cwd => change(cwd, 'super.createStreamingCompletion(normalizeGlmRequest(body))', 'super.createStreamingCompletion(body)'))));
test('truncating user or assistant text is rejected', () => fails(grade('all-roles', item.oracle_ref, cwd => change(cwd, "message.role !== 'tool' || typeof message.content !== 'string'", "typeof message.content !== 'string'"))));
test('dropping the result tail is rejected', () => fails(grade('lost-tail', item.oracle_ref, cwd => change(cwd, 'content.slice(-tailChars)', "''"))));
test('altering a tool result exactly at the bound is rejected', () => fails(grade('boundary', item.oracle_ref, cwd => change(cwd, 'content.length <= GLM_MAX_TOOL_RESULT_CHARS', 'content.length < GLM_MAX_TOOL_RESULT_CHARS'))));
test('ordinary clients cannot be compacted indiscriminately', () => fails(grade('always-compact', item.oracle_ref, cwd => change(cwd, "body.messages.some(isGlmCatalogMessage)\n\t\t|| (Array.isArray(body.tools) && body.tools.some(isSubagentTool))", 'true'))));
test('losing tool-result identity is rejected', () => fails(grade('lost-identity', item.oracle_ref, cwd => change(cwd, 'return { ...message, content: compactGlmToolResultText(message.content) };', 'return { role: message.role, content: compactGlmToolResultText(message.content) };'))));
test('missing provider remains setup failure', () => { const r = grade('missing', item.oracle_ref, cwd => rmSync(join(cwd, source))); expect(r.status).toBe(1); expect(r.stderr).toContain('Cannot find module'); expect(r.stderr).toContain('0 pass'); });
