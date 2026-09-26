// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { unzipSync } from "fflate";
import { VERSIONED_MANIFEST_SCHEMAS } from "@anthropic-ai/mcpb/schemas";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(__dirname, "..");
const sandbox = mkdtempSync(path.join(tmpdir(), "screenpipe-installer-test-"));
let local: Record<string, Uint8Array>;
let cloud: Record<string, Uint8Array>;
let agent: Record<string, Uint8Array>;
const agentDir = path.join(sandbox, "agent");
const requests: string[] = [];
let api: Server;
let baseUrl: string;
let status = 200;
let seenAuth: string | undefined;
let seenQuery: string | null;
const parse = (archive: Record<string, Uint8Array>, file: string) =>
  JSON.parse(Buffer.from(archive[file]).toString("utf8"));

beforeAll(async () => {
  execFileSync("bun", ["run", "build:installers"], { cwd: root, timeout: 120_000, stdio: "inherit" });
  local = unzipSync(readFileSync(path.join(root, "installers/screenpipe-local.mcpb")));
  cloud = unzipSync(readFileSync(path.join(root, "installers/screenpipe-cloud.zip")));
  agent = unzipSync(readFileSync(path.join(root, "installers/screenpipe-agent.zip")));
  for (const [file, bytes] of Object.entries(agent)) {
    const target = path.join(agentDir, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  for (const [file, bytes] of Object.entries(local)) {
    const target = path.join(sandbox, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  api = createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");
    requests.push(url.pathname);
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "healthy", frame_status: "ok", audio_status: "ok", vision_reason: "ok" }));
      return;
    }
    if (url.pathname !== "/search") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }
    seenAuth = req.headers.authorization;
    seenQuery = url.searchParams.get("q");
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(status === 200 ? {
      data: [{ type: "OCR", content: { text: "synthetic installer evidence", timestamp: "2026-01-02T12:00:00Z", app_name: "Fixture", frame_id: 1 } }],
      pagination: { total: 1, limit: 5, offset: 0 },
    } : { error: "unauthorized" }));
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
}, 130_000);

afterAll(async () => {
  if (api) await new Promise<void>((resolve) => api.close(() => resolve()));
  rmSync(sandbox, { recursive: true, force: true });
});

async function withInstalledClient(run: (client: Client) => Promise<void>) {
  const manifest = parse(local, "manifest.json");
  const config = manifest.server.mcp_config;
  const settings: Record<string, string> = { api_url: baseUrl, api_key: "sp-installer-fixture" };
  const env: Record<string, string> = {
    PATH: "", NODE_PATH: "", SCREENPIPE_DISABLE_TELEMETRY: "1",
    SCREENPIPE_ENTERPRISE_TOKEN: "sk_ent_fixture", SCREENPIPE_TEAM_API_URL: baseUrl,
  };
  for (const [key, value] of Object.entries(config.env)) {
    env[key] = String(value).replace(/\$\{user_config\.(\w+)\}/g, (_, name) => settings[name]);
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: config.args.map((arg: string) => arg.replace("${__dirname}", sandbox)),
    cwd: sandbox, env, stderr: "pipe",
  });
  const client = new Client({ name: "installer-fixture", version: "1.0.0" });
  try {
    await client.connect(transport);
    await run(client);
  } finally {
    await transport.close();
  }
}

describe("installable MCP artifacts", () => {
  it("ships a schema-valid local extension with only the required files", () => {
    const manifest = parse(local, "manifest.json");
    expect(VERSIONED_MANIFEST_SCHEMAS["0.3"].safeParse(manifest).success).toBe(true);
    expect(Object.keys(local).sort()).toEqual([
      "LICENSE.md", "README.md", "dist/index.js", "icon.png", "manifest.json", "package.json",
    ]);
    expect(manifest.version).toBe(JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version);
    expect(manifest.user_config.api_key.sensitive).toBe(true);
    expect(manifest.user_config.api_key.default).toBeUndefined();
    expect(manifest.user_config.api_key.required).toBe(false);
    expect(manifest.user_config.api_url.default).toBe("http://127.0.0.1:3030");
    expect(local[manifest.server.entry_point]).toBeDefined();
  });

  it("initializes and searches from the extracted archive with no runtime dependencies", async () => {
    status = 200;
    await withInstalledClient(async (client) => {
      const list = await client.listTools();
      expect(list.tools.some((tool) => tool.name === "search-content")).toBe(true);
      const result = await client.callTool({ name: "search-content", arguments: {
        q: "synthetic", start_time: "2026-01-02T00:00:00Z", end_time: "2026-01-03T00:00:00Z", limit: 5,
      } });
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result)).toContain("synthetic installer evidence");
      expect(seenAuth).toBe("Bearer sp-installer-fixture");
      expect(seenQuery).toBe("synthetic");
    });
  }, 15_000);

  it("reports rejected authentication rather than successful retrieval", async () => {
    status = 401;
    await withInstalledClient(async (client) => {
      const result = await client.callTool({ name: "search-content", arguments: { q: "synthetic", limit: 1 } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain("synthetic installer evidence");
    });
  }, 15_000);

  it("keeps all cloud hosts on the same OAuth endpoint without embedding credentials", () => {
    expect(Object.keys(cloud).sort()).toEqual([
      ".claude-plugin/plugin.json", ".codex-plugin/plugin.json", ".mcp.json",
      "LICENSE.md", "README.md", "assets/icon.png", "mcp.json", "plugin.json",
    ]);
    const portable = parse(cloud, "plugin.json");
    const codex = parse(cloud, ".codex-plugin/plugin.json");
    const claude = parse(cloud, ".claude-plugin/plugin.json");
    for (const manifest of [portable, codex, claude]) {
      expect(manifest.name).toBe("screenpipe-cloud");
      expect(manifest.version).toBe(portable.version);
    }
    const endpoint = "https://screenpipe.com/api/user/data-sync/mcp";
    expect(parse(cloud, "mcp.json").mcpServers).toEqual({ "screenpipe-cloud": { type: "streamable-http", url: endpoint } });
    expect(parse(cloud, ".mcp.json").mcpServers).toEqual({ "screenpipe-cloud": { type: "http", url: endpoint } });
    expect(codex.mcpServers).toBe("./.mcp.json");
    expect(codex.interface.capabilities).toEqual(["Read"]);
    expect(cloud[codex.interface.logo.replace(/^\.\//, "")]).toBeDefined();
  });
});


describe("portable Screenpipe agent bundle", () => {
  it("ships only the runtime, identity, and discoverable skill, without credentials", () => {
    expect(Object.keys(agent).sort()).toEqual([
      "LICENSE.md", "README.md", "dist/index.js", "mcp.json", "plugin.json", "skills/screenpipe/SKILL.md",
    ]);
    expect(parse(agent, "mcp.json").$schema).toBe("https://agent-plugins.org/schemas/1.0.0/mcp.schema.json");
    expect(parse(agent, "mcp.json").mcpServers.screenpipe.env).toBeUndefined();
    expect(parse(agent, "plugin.json").version).toBe(JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version);
  });

  it.each(["hermes", "openclaw"])("%s handshake exposes setup, retrieves attributed evidence, and rejects direct write calls", async (name) => {
    status = 200;
    const config = parse(agent, "mcp.json").mcpServers.screenpipe;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: config.args.map((arg: string) => arg.replace("${PLUGIN_ROOT}", agentDir)),
      cwd: agentDir, stderr: "pipe",
      env: { PATH: "", NODE_PATH: "", SCREENPIPE_DISABLE_TELEMETRY: "1",
        SCREENPIPE_API_URL: baseUrl, SCREENPIPE_LOCAL_API_KEY: "sp-installer-fixture",
        SCREENPIPE_ENTERPRISE_TOKEN: "sk_ent_fixture", SCREENPIPE_TEAM_API_URL: baseUrl },
    });
    const client = new Client({ name, version: "1.0.0" });
    try {
      await client.connect(transport);
      expect(client.getInstructions()).toContain("runs continuously in the background");
      const names = (await client.listTools()).tools.map(t => t.name);
      expect(names).toContain("screenpipe-status");
      expect(names).toContain("activity-summary");
      expect(names).toContain("get-workflow");
      expect(names).not.toContain("team-search");
      const count = requests.length;
      for (const tool of ["control-recording", "create-pipe", "update-memory", "send-notification", "team-search", "export-video"]) {
        expect(names).not.toContain(tool);
        const denied = await client.callTool({ name: tool, arguments: {} });
        expect(denied.isError).toBe(true);
      }
      expect(requests).toHaveLength(count);
      const setup = await client.callTool({ name: "screenpipe-status", arguments: { intent: "setup" } });
      const info = JSON.parse((setup.content as Array<{ text: string }>)[0].text);
      expect(info.state).toBe("available");
      expect(info.download).toContain(`utm_source=${name}`);
      expect(info.data_notice).toContain("cloud provider");
      expect(requests.slice(count)).toEqual(["/health"]);
      const result = await client.callTool({ name: "search-content", arguments: { q: "synthetic", limit: 1 } });
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result)).toContain("From your Screenpipe history");
      expect(JSON.stringify(result)).toContain("synthetic installer evidence");
      expect(JSON.stringify(result)).toContain("screenpipe://frame/1");
      expect(seenAuth).toBe("Bearer sp-installer-fixture");
    } finally { await client.close(); }
  });
});
