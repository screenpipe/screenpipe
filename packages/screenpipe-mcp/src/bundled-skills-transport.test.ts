// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { beforeAll, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildHttpServer } from "./http-server";
import { BUNDLED_SKILLS } from "./generated/bundled-skills";

const root = path.resolve(__dirname, "..");
beforeAll(() => execFileSync("bun", ["run", "build"], { cwd: root, stdio: "pipe", timeout: 120000 }), 120000);

async function checkCatalog(client: Client) {
  expect((await client.listTools()).tools.map(tool => tool.name)).toContain("screenpipe-skills");
  const listed = await client.callTool({ name: "screenpipe-skills" });
  expect(listed.isError).not.toBe(true);
  const catalog = JSON.parse((listed.content as { text: string }[])[0].text);
  expect(catalog.skills.map((skill: { name: string }) => skill.name)).toEqual(BUNDLED_SKILLS.map(skill => skill.name));
  for (const skill of BUNDLED_SKILLS) {
    const result = await client.callTool({ name: "screenpipe-skills", arguments: { name: skill.name } });
    expect(result.isError).not.toBe(true);
    expect((result.content as { text: string }[])[0].text).toBe(skill.markdown);
  }
  expect((await client.callTool({ name: "screenpipe-skills", arguments: { name: "screenpipe-learned-private" } })).isError).toBe(true);
}

it("serves every skill from the isolated built stdio artifact with no source tree or engine", async () => {
  const temp = mkdtempSync(path.join(tmpdir(), "screenpipe-skills-"));
  cpSync(path.join(root, "dist/cli.js"), path.join(temp, "cli.js"));
  const client = new Client({ name: "bundled-skills-test", version: "1.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(temp, "cli.js")], cwd: temp, env: {
    PATH: process.env.PATH || "", HOME: temp, USERPROFILE: temp, SCREENPIPE_LOCAL_API_KEY: "fixture-key", SCREENPIPE_DISABLE_TELEMETRY: "1",
  }, stderr: "pipe" });
  try { await client.connect(transport); await checkCatalog(client); }
  finally { await client.close(); await transport.close(); rmSync(temp, { recursive: true, force: true }); }
}, 15000);

it("serves the same catalog over HTTP without the engine", async () => {
  const server = buildHttpServer({ mcpPort: 0, screenpipePort: 1, host: "127.0.0.1" });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  const client = new Client({ name: "bundled-skills-http-test", version: "1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`));
  try { await client.connect(transport); await checkCatalog(client); await transport.terminateSession(); }
  finally { await client.close(); await transport.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 15000);
