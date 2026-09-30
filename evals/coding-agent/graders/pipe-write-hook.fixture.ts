// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const originalCwd = process.cwd();
const source = join(originalCwd, 'crates/screenpipe-core/assets/extensions/screenpipe-permissions.ts');
const root = mkdtempSync(join(tmpdir(), 'pipe-write-hook-'));
const outside = join(root, '../outside-synthetic.txt');
writeFileSync(join(root, '.screenpipe-permissions.json'), JSON.stringify({ pipe_name: 'report', pipe_dir: root, allow_rules: [], deny_rules: [], use_default_allowlist: false }));
process.chdir(root);
afterAll(() => { process.chdir(originalCwd); rmSync(root, { recursive: true, force: true }); });
const { default: extension } = await import(pathToFileURL(source).href);

const handlers = new Map<string, (event: unknown) => Promise<any>>();
extension({ on: (name: string, handler: (event: unknown) => Promise<any>) => handlers.set(name, handler) } as any);
const call = async (tool: string, input: unknown, alternate = false) => {
  const handler = handlers.get('tool_call');
  expect(handler).toBeFunction();
  return handler!({ [alternate ? 'name' : 'tool']: tool, input });
};
const denied: [string, string, unknown, boolean?][] = [
  ['built-in write outside', 'write', { file_path: outside, content: 'synthetic' }],
  ['alternate edit event outside', 'edit', { path: outside }, true],
  ['traversal outside', 'write', { path: '../outside.txt' }],
  ['missing write target', 'write', {}],
  ['second rm target outside', 'bash', { command: `rm -f ./inside.txt ${outside}` }],
  ['second touch target outside', 'bash', { command: `touch ./inside.txt ${outside}` }],
  ['expanded redirect', 'bash', { command: 'echo synthetic > "$HOME/outside.txt"' }],
  ['opaque interpreter', 'bash', { command: 'python3 task.py' }],
  ['nested shell outside', 'bash', { command: `sh -c "rm -f ${outside}"` }],
  ['compound outside', 'bash', { command: `echo synthetic > ./inside.txt && rm -f ${outside}` }],
];
for (const [name, tool, input, alternate] of denied) {
  test(name, async () => { expect((await call(tool, input, alternate))?.block).toBe(true); });
}
const allowed: [string, string, unknown][] = [
  ['relative file write', 'write', { path: './report.txt', content: 'synthetic' }],
  ['absolute in-root edit', 'edit', { file_path: root + '/report.txt' }],
  ['read outside remains available', 'read', { file_path: outside }],
  ['shell redirect inside', 'bash', { command: 'echo synthetic > ./report.txt' }],
  ['multiple permitted targets', 'bash', { command: 'rm -f ./one.txt ./two.txt' }],
  ['literal dollar within single quotes', 'bash', { command: "echo synthetic > './$HOME.txt'" }],
  ['read-only shell', 'bash', { command: 'cat /synthetic/documents/read.txt' }],
  ['interpreter version query', 'bash', { command: 'python3 --version' }],
];
for (const [name, tool, input] of allowed) {
  test(name, async () => { expect((await call(tool, input))?.block).not.toBe(true); });
}
