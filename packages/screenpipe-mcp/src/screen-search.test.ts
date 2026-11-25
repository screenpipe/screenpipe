// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import path from "node:path";

it("supports image search and exact frame retrieval over the built MCP transport", async () => {
  const root = path.resolve(__dirname, "..");
  execFileSync("bun", ["run", "build"], { cwd: root, stdio: "pipe", timeout: 120000 });
  const requests: URL[] = [];
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  let thumbnailStatus = 200;
  let timestampFrameId = 1;
  const api = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    requests.push(url);
    res.setHeader("Content-Type", "application/json");
    if (req.headers.authorization !== "Bearer fixture-key") {
      res.writeHead(403).end("{}");
      return;
    }
    if (url.pathname === "/frames/1/thumbnail") {
      if (thumbnailStatus !== 200) {
        res.writeHead(thumbnailStatus).end(JSON.stringify({ error: "Frame unavailable" }));
      } else {
        res.writeHead(200, { "Content-Type": "image/jpeg" }).end(jpeg);
      }
      return;
    }
    if (url.pathname === "/frames/1/metadata") {
      res.end(JSON.stringify({ frame_id: timestampFrameId, timestamp: "2026-01-01T12:00:00Z" }));
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
    expect(tools.find(tool => tool.name === "get-screenshot")?.annotations?.readOnlyHint).toBe(true);
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
      expect(text).toContain("(frame_id=1)");
      expect(text).not.toContain("For visual evidence, inspect");
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

    const screen = await client.callTool({ name: "search-content", arguments: {
      content_type: "screen", start_time: "2026-01-01T12:00:00Z",
    } });
    expect(JSON.stringify(screen.content)).toContain("For visual evidence, inspect a returned frame with get-screenshot");
    expect(screen.content).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: "image" })]));

    const beforeScreenshot = requests.length;
    const screenshot = await client.callTool({ name: "get-screenshot", arguments: { frame_id: "1.0" } });
    expect(screenshot.isError).not.toBe(true);
    expect(screenshot.content).toEqual([
      { type: "text", text: "Frame 1 at 2026-01-01T12:00:00Z. Source: screenpipe://frame/1" },
      { type: "image", data: jpeg.toString("base64"), mimeType: "image/jpeg" },
    ]);
    const screenshotRequests = requests.slice(beforeScreenshot);
    expect(screenshotRequests.some(r => r.pathname === "/search")).toBe(false);
    const thumbnail = screenshotRequests.find(r => r.pathname === "/frames/1/thumbnail");
    expect(thumbnail?.searchParams.get("fallback")).toBe("false");
    expect(thumbnail?.searchParams.get("width")).toBe("768");

    for (const status of [404, 403]) {
      thumbnailStatus = status;
      const unavailable = await client.callTool({ name: "get-screenshot", arguments: { frame_id: 1 } });
      expect(unavailable.isError).toBe(true);
      expect(unavailable.content).toEqual([expect.objectContaining({ type: "text" })]);
    }
    thumbnailStatus = 200;
    timestampFrameId = 2;
    const mismatched = await client.callTool({ name: "get-screenshot", arguments: { frame_id: 1 } });
    expect(mismatched.isError).toBe(true);
    expect(mismatched.content).toEqual([expect.objectContaining({ type: "text" })]);

    const requestCount = requests.filter(r => r.pathname.startsWith("/frames/")).length;
    const invalid = await client.callTool({ name: "get-screenshot", arguments: { frame_id: "-1/thumbnail" } });
    expect(invalid.isError).toBe(true);
    expect(requests.filter(r => r.pathname.startsWith("/frames/"))).toHaveLength(requestCount);
  } finally {
    await client.close();
    await transport.close();
    await new Promise<void>(resolve => api.close(() => resolve()));
  }
}, 15000);
