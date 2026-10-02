// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
// Run with Node >=22: node scripts/openclaw-smoke.mjs OPENCLAW_PACKAGE GENERATED_CONFIG
// Uses OpenClaw's actual runtime, synthetic HTTP data, and an isolated state directory.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
const [openclawPackage, configPath] = process.argv.slice(2);
assert(openclawPackage && configPath, 'provide OpenClaw package and generated config paths');
const state = await mkdtemp(join(tmpdir(), 'screenpipe-openclaw-'));
process.env.OPENCLAW_STATE_DIR = state;
process.env.OPENCLAW_CONFIG_PATH = join(state, 'openclaw.json');
let requests = [];
const api = createServer((req, res) => {
  if (req.headers.authorization !== 'Bearer sp-fixture-only') {
    res.writeHead(401); res.end('unauthorized'); return;
  }
  const url = new URL(req.url, 'http://localhost');
  requests.push(url);
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ data: [{ type: 'OCR', content: { text: 'openclaw-fixture-result', timestamp: '2026-10-01T12:00:00Z', frame_id: 1 } }], pagination: { limit: 5, offset: 0, total: 1 } }));
});
await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
let runtime;
try {
  const cfg = JSON.parse(await readFile(configPath, 'utf8'));
  assert(!cfg.mcpServers, 'legacy root config must be absent');
  const server = cfg.mcp.servers.screenpipe;
  assert.equal(server.transport, 'stdio');
  assert.equal(server.env.SCREENPIPE_MCP_CLIENT, 'openclaw');
  server.command = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim();
  server.args = [fileURLToPath(new URL('../dist/index.js', import.meta.url))];
  server.env = { ...server.env, SCREENPIPE_LOCAL_API_KEY: 'sp-fixture-only', SCREENPIPE_LOCAL_API_URL: `http://127.0.0.1:${api.address().port}`, SCREENPIPE_DISABLE_TELEMETRY: 'true' };
  await writeFile(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(cfg));
  const cli = resolve(openclawPackage, 'openclaw.mjs');
  const validation = JSON.parse(execFileSync(process.execPath, [cli, 'config', 'validate', '--json'], { encoding: 'utf8', env: process.env }));
  assert.equal(validation.valid, true);
  const { createSessionMcpRuntime } = await import(pathToFileURL(resolve(openclawPackage, 'dist/agents/agent-bundle-mcp-runtime.js')));
  runtime = createSessionMcpRuntime({ cfg, workspaceDir: state, agentDir: state, sessionId: 'screenpipe-smoke' });
  const catalog = await runtime.getCatalog();
  assert(catalog.tools.some(t => t.originalName === 'search-content' || t.name === 'search-content' || t.toolName === 'search-content'), 'search-content must be advertised');
  const result = await runtime.callTool('screenpipe', 'search-content', { q: 'fixture', start_time: '2026-10-01T00:00:00Z', end_time: '2026-10-02T00:00:00Z', limit: 5 });
  assert(JSON.stringify(result).includes('openclaw-fixture-result'), JSON.stringify(result));
  assert(requests.some(url => url.pathname === '/search' && url.searchParams.get('start_time') === '2026-10-01T00:00:00Z' && url.searchParams.get('limit') === '5'));
  server.env.SCREENPIPE_LOCAL_API_KEY = 'sp-invalid-fixture';
  await runtime.dispose(); await runtime.joinCleanup();
  runtime = createSessionMcpRuntime({ cfg, workspaceDir: state, agentDir: state, sessionId: 'screenpipe-smoke-invalid-key' });
  const denied = await runtime.callTool('screenpipe', 'search-content', { q: 'fixture', limit: 1 });
  assert(JSON.stringify(denied).includes('401'), JSON.stringify(denied));
  console.log(JSON.stringify({ configValid: true, tools: catalog.tools.length, boundedSearch: true, authFailureVisible: true }));
} finally {
  if (runtime) { await runtime.dispose(); await runtime.joinCleanup(); }
  await new Promise(resolve => api.close(resolve));
  await rm(state, { recursive: true, force: true });
}
