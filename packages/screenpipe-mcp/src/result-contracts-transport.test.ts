// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import path from "node:path";

// End-to-end over the built stdio transport: zero-hit replies must disclose
// their coverage, errors must stay distinct from zero matches, and numeric
// arguments serialized as floats ("268.0") must reach the engine as integers.
it("discloses zero-hit coverage, separates errors, and normalizes meeting ids over the built MCP", async () => {
  const root = path.resolve(__dirname, "..");
  execFileSync("bun", ["run", "build"], { cwd: root, stdio: "pipe", timeout: 120000 });
  const requests: URL[] = [];
  let searchStatus = 200;
  const meeting = {
    id: 268, title: "Fixture meeting", note: "ok", meeting_app: "Google Meet",
    meeting_start: "2026-01-01T12:00:00Z", meeting_end: "2026-01-01T12:30:00Z",
  };
  const api = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    requests.push(url);
    res.setHeader("Content-Type", "application/json");
    if (req.headers.authorization !== "Bearer fixture-key") {
      res.writeHead(403).end("{}");
      return;
    }
    const pathname = url.pathname;
    if (pathname === "/search" && url.searchParams.get("browser_url") === "meet.google.com") {
      const data = [301, 302, 303, 304].map(frame_id => ({
        type: "OCR",
        content: {
          frame_id, timestamp: "2026-01-01T12:15:00Z", browser_url: "https://meet.google.com/abc-defg-hij",
          text_source: "accessibility",
        },
      }));
      res.end(JSON.stringify({ data, pagination: { total: data.length } }));
      return;
    }
    if (pathname === "/search" || pathname === "/search/keyword") {
      res.writeHead(searchStatus);
      // Zero hits: /search uses {data, pagination}, /search/keyword a bare array.
      res.end(pathname === "/search"
        ? JSON.stringify({ data: [], pagination: { total: 0, limit: 10, offset: 0 } })
        : "[]");
      return;
    }
    if (pathname === "/meetings") {
      res.end(JSON.stringify([meeting, ...Array.from({ length: 10 }, (_, i) => ({
        ...meeting, id: 269 + i, meeting_app: "manual",
      }))]));
      return;
    }
    if (pathname === "/meetings/268") {
      res.end(JSON.stringify(meeting));
      return;
    }
    if (pathname === "/meetings/268/transcript") {
      // 500 short segments: a normalized offset of 400 should show 401-500.
      res.end(JSON.stringify(Array.from({ length: 500 }, (_, i) => ({
        capturedAt: `2026-01-01T12:00:00Z`, speakerName: "Ada", transcript: `segment ${i + 1}`,
      }))));
      return;
    }
    res.end("{}"); // absorb telemetry / other read-only calls
  });
  await new Promise<void>(resolve => api.listen(0, "127.0.0.1", resolve));
  const address = api.address();
  if (!address || typeof address === "string") throw new Error("No fixture API address");
  const client = new Client({ name: "result-contracts", version: "1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.join(root, "dist/cli.js")],
    env: { PATH: process.env.PATH || "", SCREENPIPE_LOCAL_API_URL: `http://127.0.0.1:${address.port}`,
      SCREENPIPE_LOCAL_API_KEY: "fixture-key", SCREENPIPE_DISABLE_TELEMETRY: "1" }, stderr: "pipe",
  });
  try {
    await client.connect(transport);

    // 1. search-content zero hit: successful result, not an error, with coverage.
    const sc = await client.callTool({ name: "search-content", arguments: {
      q: "zephyrium", start_time: "2026-11-01T00:00:00Z", end_time: "2026-11-16T00:00:00Z",
      app_name: "cmux", limit: 10, offset: 0,
    } });
    expect(sc.isError).not.toBe(true);
    const scText = JSON.stringify(sc.content);
    expect(scText).toContain("No results for search-content");
    expect(scText).toContain("zero results; this is not an error");
    expect(scText).toContain("Coverage:");
    expect(scText).toContain("query=zephyrium");
    expect(scText).toContain("app=cmux");
    expect(scText).toContain("limit=10");
    expect(scText).toContain("offset=0");
    expect(scText).toContain("content_type=all");

    // 2. keyword-search zero hit: same contract on the other search tool.
    const kw = await client.callTool({ name: "keyword-search", arguments: {
      q: "zephyrium", start_time: "2026-11-01T00:00:00Z", app_name: "cmux", limit: 10,
    } });
    expect(kw.isError).not.toBe(true);
    const kwText = JSON.stringify(kw.content);
    expect(kwText).toContain("No results for keyword-search");
    expect(kwText).toContain("zero results; this is not an error");
    expect(kwText).toContain("Coverage:");
    expect(kwText).toContain("query=zephyrium");
    expect(kwText).toContain("fuzzy_match=false");

    // 3. A backend failure must stay an error, never a zero-hit reply.
    searchStatus = 500;
    const err = await client.callTool({ name: "keyword-search", arguments: { q: "zephyrium" } });
    expect(err.isError).toBe(true);
    expect(JSON.stringify(err.content)).not.toContain("zero results; this is not an error");
    searchStatus = 200;

    // 4. get-meeting with float-string id/offset: id must be normalized to 268,
    //    never requested as /meetings/268.0, and no error returned.
    const gm = await client.callTool({ name: "get-meeting", arguments: {
      id: "268.0", include_transcript: true, transcript_offset: "400.0",
    } });
    expect(gm.isError).not.toBe(true);
    expect(requests.some(r => r.pathname === "/meetings/268")).toBe(true);
    expect(requests.some(r => r.pathname === "/meetings/268.0")).toBe(false);
    // transcript_offset "400.0" must be coerced to a whole number, not NaN.
    expect(JSON.stringify(gm.content)).toContain("showing 401-500");
    expect(JSON.stringify(gm.content)).not.toContain("screen_refs");
    expect(requests.some(r => r.searchParams.has("browser_url"))).toBe(false);

    // 5. A genuinely bad id returns a clear local error, not a 400 from the engine.
    const bad = await client.callTool({ name: "get-meeting", arguments: { id: "268.5" } });
    expect(JSON.stringify(bad.content)).toContain("id must be a positive integer");

    // Screen evidence is opt-in, bounded, and uses the same screenshot and accessibility frame ID.
    const list = await client.callTool({ name: "list-meetings", arguments: { include_screen_refs: true } });
    const listText = (list.content as Array<{ text: string }>)[0].text;
    expect(listText).toContain('"frame_id":301');
    expect(listText).toContain('"screenshot_uri":"screenpipe://frame/301"');
    expect(listText).not.toContain('"frame_id":302');
    expect(listText).toContain('"screen_refs_status":"not_checked"');
    expect(requests.find(r => r.pathname === "/meetings")?.searchParams.has("include_screen_refs")).toBe(false);

    const withFrames = await client.callTool({ name: "get-meeting", arguments: {
      id: 268, include_screen_refs: true, include_transcript: true, transcript_offset: 400,
    } });
    const detailText = (withFrames.content as Array<{ text: string }>)[0].text;
    const detail = JSON.parse(detailText.split("\n\nTranscript")[0]);
    expect(detail.screen_refs_status).toBe("matched");
    expect(detail.screen_refs.map((ref: { frame_id: number }) => ref.frame_id)).toEqual([301, 302, 303]);
    expect(detailText).toContain("showing 401-500");
  } finally {
    await client.close();
    await transport.close();
    await new Promise<void>(resolve => api.close(() => resolve()));
  }
}, 30000);
