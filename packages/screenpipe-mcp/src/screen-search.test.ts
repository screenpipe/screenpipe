// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import path from "node:path";

it("advertises screen text and preserves legacy search behavior over the built MCP transport", async () => {
  const root = path.resolve(__dirname, "..");
  execFileSync("bun", ["run", "build"], { cwd: root, stdio: "pipe", timeout: 120000 });
  const requests: URL[] = [];
  const api = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    requests.push(url);
    res.setHeader("Content-Type", "application/json");
    if (req.headers.authorization !== "Bearer fixture-key") {
      res.writeHead(403).end("{}");
      return;
    }
    // A backend that only accepts the legacy name proves MCP translates it.
    const sources = url.searchParams.get("content_type") === "ocr"
      ? ["accessibility", "ocr", undefined] : [];
    res.end(JSON.stringify({
      data: sources.map((source, index) => ({ type: "OCR", content: {
        frame_id: index + 1, app_name: "Fixture", window_name: "Screen text",
        timestamp: "2026-01-01T12:00:00Z", text: `Captured text ${index + 1}`,
        text_source: source, tags: ["project:fixture"], frame: "c3ludGhldGlj",
      } })),
      pagination: { total: sources.length ? 10 : 0, limit: 3, offset: Number(url.searchParams.get("offset") || 0) },
    }));
  });
  await new Promise<void>(resolve => api.listen(0, "127.0.0.1", resolve));
  const address = api.address();
  if (!address || typeof address === "string") throw new Error("No fixture API address");
  const client = new Client({ name: "screen-search-contract", version: "1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.join(root, "dist/cli.js")],
    env: { PATH: process.env.PATH || "", SCREENPIPE_LOCAL_API_URL: `http://127.0.0.1:${address.port}`,
      SCREENPIPE_LOCAL_API_KEY: "fixture-key", SCREENPIPE_DISABLE_TELEMETRY: "1" }, stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const property = tools.find(tool => tool.name === "search-content")!.inputSchema.properties!.content_type as { enum: string[]; description: string };
    expect(property.enum).toEqual(expect.arrayContaining(["screen", "ocr", "accessibility", "all", "audio", "parsed"]));
    expect(property.description).toContain("Use 'screen' for screen text");
    expect(property.description).toContain("legacy alias");
    for (const contentType of ["screen", "ocr"]) {
      const filters = { app_name: "Fixture", window_name: "Screen text", q: "Captured", tags: "project:fixture",
        include_related: true, limit: 3, offset: 3, max_content_length: 100, include_frames: true };
      const result = await client.callTool({ name: "search-content", arguments: {
        content_type: contentType, start_time: "2026-01-01T00:00:00Z", end_time: "2026-01-02T00:00:00Z", ...filters,
      } });
      expect(result.isError).not.toBe(true);
      const text = JSON.stringify(result.content);
      expect(text).toContain("[Screen·a11y]");
      expect(text).toContain("[Screen·ocr]");
      expect(text).toContain("[Screen] Fixture");
      expect(text).toContain("offset=6");
      expect(result.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "image", data: "c3ludGhldGlj" })]));
      const params = requests.at(-1)!.searchParams;
      expect(params.get("content_type")).toBe("ocr");
      for (const [key, value] of Object.entries(filters)) expect(params.get(key)).toBe(String(value));
      expect(Date.parse(params.get("start_time")!)).toBe(Date.parse("2026-01-01T00:00:00Z"));
      expect(Date.parse(params.get("end_time")!)).toBe(Date.parse("2026-01-02T00:00:00Z"));
    }
    for (const contentType of ["all", "accessibility", "audio", "input", "memory", "parsed", undefined]) {
      await client.callTool({ name: "search-content", arguments: {
        start_time: "2026-01-01", ...(contentType ? { content_type: contentType } : {}),
      } });
      expect(requests.at(-1)!.searchParams.get("content_type")).toBe(contentType ?? null);
    }
  } finally {
    await client.close();
    await transport.close();
    await new Promise<void>(resolve => api.close(() => resolve()));
  }
}, 15000);
