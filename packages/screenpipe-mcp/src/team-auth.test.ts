// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { createServer, type Server } from "node:http";
import * as os from "node:os";
import * as path from "node:path";

const PKG_ROOT = path.resolve(__dirname, "..");
const clients: Client[] = [];
const servers: Server[] = [];
const homes: string[] = [];

beforeAll(() => {
  execFileSync("bun", ["run", "build"], { cwd: PKG_ROOT, timeout: 120_000 });
}, 120_000);

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  })));
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

function newHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sp-mcp-team-auth-"));
  homes.push(home);
  fs.mkdirSync(path.join(home, ".screenpipe"));
  return home;
}

function saveConfig(home: string, token: string, apiBase: string): void {
  fs.writeFileSync(path.join(home, ".screenpipe", "enterprise.json"), JSON.stringify({
    team_api_token: token,
    gateway_url: apiBase,
  }));
}

async function teamApi(validToken: string) {
  const requests: { url: string; authorization: string | undefined }[] = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url || "", authorization: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    if (req.headers.authorization !== `Bearer ${validToken}`) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: "token expired" }));
    } else {
      res.end(JSON.stringify({ devices: [{ device_id: "test-device" }] }));
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test server address");
  return { apiBase: `http://127.0.0.1:${address.port}/api/enterprise/v1`, requests };
}

async function startMcp(home: string, env: Record<string, string> = {}) {
  const client = new Client({ name: "team-auth-test", version: "1.0.0" });
  clients.push(client);
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.join(PKG_ROOT, "dist", "cli.js")],
    env: {
      HOME: home,
      USERPROFILE: home,
      SCREENPIPE_DISABLE_TELEMETRY: "1",
      SCREENPIPE_LOCAL_API_KEY: "sp-test-local-key",
      SCREENPIPE_API_URL: "http://127.0.0.1:59999",
      ...env,
    },
    stderr: "pipe",
  }));
  return client;
}

const devices = (client: Client) => client.callTool({ name: "team-devices", arguments: {} });
const hasTeamTools = async (client: Client) =>
  (await client.listTools()).tools.some((tool) => tool.name === "team-devices");

describe("running MCP team credentials", () => {
  it("uses a replacement file token on the next call and stops using a cleared token", async () => {
    const home = newHome();
    const api = await teamApi("sk_ent_current");
    saveConfig(home, "sk_ent_expired", api.apiBase);
    const client = await startMcp(home);
    expect((await devices(client)).isError).toBe(true);

    saveConfig(home, "sk_ent_current", api.apiBase);
    expect((await devices(client)).isError).not.toBe(true);
    expect(api.requests.map((req) => req.authorization)).toEqual([
      "Bearer sk_ent_expired", "Bearer sk_ent_current",
    ]);

    saveConfig(home, "", api.apiBase);
    expect(await hasTeamTools(client)).toBe(false);
    expect((await devices(client)).isError).toBe(true);
    expect(api.requests).toHaveLength(2);

    saveConfig(home, "sk_ent_current", api.apiBase);
    expect(await hasTeamTools(client)).toBe(true);
    expect((await devices(client)).isError).not.toBe(true);
  });

  it("loads the matching gateway when the file token and gateway change together", async () => {
    const home = newHome();
    const first = await teamApi("sk_ent_first_org");
    const second = await teamApi("sk_ent_second_org");
    saveConfig(home, "sk_ent_first_org", first.apiBase);
    const client = await startMcp(home);
    expect((await devices(client)).isError).not.toBe(true);

    saveConfig(home, "sk_ent_second_org", second.apiBase);
    expect((await devices(client)).isError).not.toBe(true);
    expect(first.requests).toEqual([{ url: "/api/enterprise/v1/devices", authorization: "Bearer sk_ent_first_org" }]);
    expect(second.requests).toEqual([{ url: "/api/enterprise/v1/devices", authorization: "Bearer sk_ent_second_org" }]);
  });

  it("preserves an explicit expired token and explains how to remove the stale override", async () => {
    const home = newHome();
    const api = await teamApi("sk_ent_current");
    saveConfig(home, "sk_ent_current", api.apiBase);
    const client = await startMcp(home, { SCREENPIPE_ENTERPRISE_TOKEN: "sk_ent_expired_override" });
    const result = await devices(client);
    expect(result.isError).toBe(true);
    const message = JSON.stringify(result.content);
    expect(message).toContain("SCREENPIPE_ENTERPRISE_TOKEN");
    expect(message).toContain("enterprise.json");
    expect(message).not.toContain("sk_ent_expired_override");
    expect(api.requests).toEqual([{ url: "/api/enterprise/v1/devices", authorization: "Bearer sk_ent_expired_override" }]);
  });
});
