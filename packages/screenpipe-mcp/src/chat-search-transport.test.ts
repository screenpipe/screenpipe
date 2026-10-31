// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildHttpServer } from "./http-server";

it.each(["stdio", "http"])("discovers and calls read-only chat search through %s", async mode => {
  const root = path.resolve(__dirname, "..");
  if (mode === "stdio") execFileSync("bun", ["run", "build"], { cwd: root, stdio: "pipe", timeout: 120000 });
  const requests: Array<{ url?: string; auth?: string; body: string }> = [];
  let status = 200;
  const api = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, auth: req.headers.authorization, body });
    if (req.url !== "/chats/search") { res.writeHead(404); res.end("{}"); return; }
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ results: [{ source: "claude", id: "chat-1", preview: "earlier decision" }], warnings: ["older chats not scanned"], coverage: "bounded_recent_chats" }));
  });
  await new Promise<void>(resolve => api.listen(0, "127.0.0.1", resolve));
  const address = api.address(); if (!address || typeof address === "string") throw new Error("missing API address");
  vi.stubEnv("SCREENPIPE_API_URL", `http://127.0.0.1:${address.port}`);
  vi.stubEnv("SCREENPIPE_LOCAL_API_KEY", "fixture-key");
  vi.stubEnv("SCREENPIPE_DISABLE_TELEMETRY", "1");
  const http = mode === "http" ? buildHttpServer({ mcpPort: 0, screenpipePort: address.port, host: "127.0.0.1" }) : null;
  if (http) await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  const httpAddress = http?.address();
  const transport = mode === "stdio"
    ? new StdioClientTransport({ command: process.execPath, args: [path.join(root, "dist/cli.js")], env: { PATH: process.env.PATH || "", SCREENPIPE_LOCAL_API_URL: `http://127.0.0.1:${address.port}`, SCREENPIPE_LOCAL_API_KEY: "fixture-key", SCREENPIPE_DISABLE_TELEMETRY: "1" }, stderr: "pipe" })
    : new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${typeof httpAddress === "object" && httpAddress ? httpAddress.port : 0}/mcp`));
  const client = new Client({ name: "chat-search-contract", version: "1" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    expect(listed.tools.find(tool => tool.name === "search-chats")?.annotations?.readOnlyHint).toBe(true);
    expect(listed.tools.some(tool => /send.to.chat/.test(tool.name))).toBe(false);
    const result = await client.callTool({ name: "search-chats", arguments: { query: "decision", sources: ["claude"], limit: 3 } });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).toContain("older chats not scanned");
    const search = requests.find(req => req.url === "/chats/search")!;
    expect(search.auth).toBe("Bearer fixture-key");
    expect(JSON.parse(search.body)).toEqual({ query: "decision", sources: ["claude"], limit: 3 });
    const recent = await client.callTool({ name: "search-chats" });
    expect(recent.isError).not.toBe(true);
    const latest = requests.filter(req => req.url === "/chats/search").at(-1)!;
    expect(JSON.parse(latest.body)).toEqual({ query: "", sources: [], limit: 10 });
    status = 404;
    // Both transport error envelopes must signal failure, never an empty history.
    try {
      const unavailable = await client.callTool({ name: "search-chats", arguments: {} });
      expect(unavailable.isError).toBe(true);
    } catch (error) { expect(String(error)).toMatch(/404|Chat search|backend/i); }
  } finally {
    await client.close(); await transport.close();
    if (http) await new Promise<void>(resolve => http.close(() => resolve()));
    await new Promise<void>(resolve => api.close(() => resolve()));
    vi.unstubAllEnvs();
  }
}, 20000);
