// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { afterEach, describe, expect, it } from "bun:test";
import registerFrameImage from "./frame-image";
import registerContextPruning from "./context-pruning";
import registerPermissions, { __testing as permTesting } from "./screenpipe-permissions";

describe("get_screenshot Pi extension", () => {
  const originalKey = process.env.SCREENPIPE_LOCAL_API_KEY;
  const originalUrl = process.env.SCREENPIPE_LOCAL_API_URL;
  const originalSession = process.env.SCREENPIPE_SESSION_ID;

  afterEach(() => {
    if (originalKey === undefined) delete process.env.SCREENPIPE_LOCAL_API_KEY;
    else process.env.SCREENPIPE_LOCAL_API_KEY = originalKey;
    if (originalUrl === undefined) delete process.env.SCREENPIPE_LOCAL_API_URL;
    else process.env.SCREENPIPE_LOCAL_API_URL = originalUrl;
    if (originalSession === undefined) delete process.env.SCREENPIPE_SESSION_ID;
    else process.env.SCREENPIPE_SESSION_ID = originalSession;
    permTesting.setPermissions(null);
  });

  it("returns text metadata plus base64 image block for authorized frames and surfaces privacy/size errors", async () => {
    const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);
    const calls: Array<{ pathname: string; search: string; auth: string | null; session: string | null }> = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const u = new URL(req.url);
        calls.push({
          pathname: u.pathname,
          search: u.search,
          auth: req.headers.get("authorization"),
          session: req.headers.get("x-screenpipe-session"),
        });
        if (u.pathname === "/frames/12/thumbnail") {
          return new Response(jpegBytes, {
            status: 200,
            headers: { "content-type": "image/jpeg" },
          });
        }
        if (u.pathname === "/frames/13/thumbnail") {
          return Response.json(
            { code: "privacy_pending", error: "Image privacy processing is pending" },
            { status: 503 },
          );
        }
        return new Response(new Uint8Array(1_050_000), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      },
    });

    try {
      process.env.SCREENPIPE_LOCAL_API_URL = `http://127.0.0.1:${server.port}`;
      process.env.SCREENPIPE_LOCAL_API_KEY = "sp-pi-token";
      process.env.SCREENPIPE_SESSION_ID = "sess-7";

      let tool: any;
      registerFrameImage({ registerTool: (t: any) => (tool = t) } as any);
      expect(tool?.name).toBe("get_screenshot");

      const signal = new AbortController().signal;
      const ok = await tool.execute("call-1", { frame_id: 12 }, signal);
      expect(ok.isError).toBeUndefined();
      expect(ok.content).toHaveLength(2);
      expect(JSON.parse(ok.content[0].text)).toMatchObject({
        frame_id: 12,
        mime_type: "image/jpeg",
        bytes: jpegBytes.byteLength,
      });
      expect(ok.content[1]).toEqual({
        type: "image",
        mimeType: "image/jpeg",
        data: Buffer.from(jpegBytes).toString("base64"),
      });
      expect(calls[0]).toEqual({
        pathname: "/frames/12/thumbnail",
        search: "?width=1280&quality=75&fallback=false",
        auth: "Bearer sp-pi-token",
        session: "sess-7",
      });

      const pending = await tool.execute("call-2", { frame_id: 13 }, signal);
      expect(pending.isError).toBe(true);
      expect(pending.content[0].text).toContain("privacy_pending");

      const oversized = await tool.execute("call-3", { frame_id: 14 }, signal);
      expect(oversized.isError).toBe(true);
      expect(oversized.content[0].text).toContain("exceeds");
    } finally {
      server.stop(true);
    }
  });

  it("keeps recent tool-result images intact and prunes completed old images beyond window", async () => {
    const handlers = new Map<string, any>();
    registerContextPruning({
      on: (event: string, fn: any) => handlers.set(event, fn),
    } as any);

    const oldToolResult = {
      role: "toolResult",
      content: [
        { type: "text", text: '{"frame_id":1}' },
        { type: "image", mimeType: "image/jpeg", data: "AAAA".repeat(20_000) },
      ],
    };
    const recentToolResult = {
      role: "toolResult",
      content: [
        { type: "text", text: '{"frame_id":2}' },
        { type: "image", mimeType: "image/jpeg", data: "BBBB".repeat(5_000) },
      ],
    };

    const messages: any[] = [
      { role: "user", content: "old question" },
      oldToolResult,
      { role: "assistant", stopReason: "stop", content: "old answer" },
      { role: "user", content: "new question" },
      ...Array.from({ length: 32 }, (_, idx) => ({
        role: idx % 2 === 0 ? "assistant" : "user",
        stopReason: "stop",
        content: `turn ${idx}`,
      })),
      recentToolResult,
    ];

    const out = await handlers.get("context")({ messages }, { model: { contextWindow: 128_000 } });
    expect(out?.messages[1].content[1]).toEqual({
      type: "text",
      text: "[previous tool image — image/jpeg, processed in earlier turn]",
    });
    expect(out?.messages[out.messages.length - 1].content[1].type).toBe("image");
  });

  it("enforces pipe API permissions on get_screenshot tool calls", async () => {
    permTesting.setPermissions({
      pipe_name: "restricted-pipe",
      allow_rules: [{ type: "api", method: "GET", path: "/search" }],
      deny_rules: [{ type: "api", method: "GET", path: "/frames/*" }],
      use_default_allowlist: true,
      time_range: null,
      days: null,
      pipe_token: "sp_pipe_1",
      pipe_dir: null,
    });
    const handlers = new Map<string, any>();
    registerPermissions({
      on: (event: string, fn: any) => handlers.set(event, fn),
    } as any);

    const blocked = await handlers.get("tool_call")({
      tool: "get_screenshot",
      input: { frame_id: 42 },
    });
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toContain("/frames/42/thumbnail");

    permTesting.setPermissions({
      pipe_name: "default-pipe",
      allow_rules: [],
      deny_rules: [],
      use_default_allowlist: true,
      time_range: null,
      days: null,
      pipe_token: "sp_pipe_2",
      pipe_dir: null,
    });
    const allowed = await handlers.get("tool_call")({
      tool: "get_screenshot",
      input: { frame_id: 42 },
    });
    expect(allowed).toBeUndefined();
  });
});
