// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { createServer } from "node:http";
import { expect, test } from "vitest";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { remote } from "webdriverio";

test("the E2E dispatcher supports WebDriver sessions and commands", async () => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const path = request.url;
    requests.push(`${request.method} ${path}`);
    response.setHeader("Content-Type", "application/json");
    if (request.method === "POST" && path === "/session") {
      response.end(JSON.stringify({
        value: {
          sessionId: "transport-fixture",
          capabilities: { browserName: "chrome" },
        },
      }));
      return;
    }
    if (request.method === "GET" && path === "/session/transport-fixture/window") {
      response.end(JSON.stringify({ value: "home" }));
      return;
    }
    if (request.method === "GET" && path === "/session/transport-fixture/url") {
      response.end(JSON.stringify({ value: "http://tauri.localhost/home" }));
      return;
    }
    if (request.method === "DELETE" && path === "/session/transport-fixture") {
      response.end(JSON.stringify({ value: null }));
      return;
    }
    response.writeHead(404).end(JSON.stringify({ value: { error: "unknown command" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing fixture port");
  const previousDispatcher = getGlobalDispatcher();
  const dispatcher = new Agent();
  // Exercise the same plain-Agent reset as e2e/wdio.conf.ts. Undici 8 wraps
  // the legacy dispatcher API and rejects WebDriver's explicit dispatcher.
  setGlobalDispatcher(dispatcher);
  let session: Awaited<ReturnType<typeof remote>> | undefined;
  try {
    session = await remote({
      hostname: "127.0.0.1",
      port: address.port,
      path: "/",
      logLevel: "silent",
      connectionRetryCount: 0,
      connectionRetryTimeout: 2_000,
      capabilities: {
        browserName: "chrome",
        "wdio:enforceWebDriverClassic": true,
      },
    });
    expect(session.sessionId).toBe("transport-fixture");
    expect(await session.getUrl()).toBe("http://tauri.localhost/home");
    await session.deleteSession();
    session = undefined;
    expect(requests).toEqual([
      "POST /session",
      "GET /session/transport-fixture/window",
      "GET /session/transport-fixture/url",
      "DELETE /session/transport-fixture",
    ]);
  } finally {
    await session?.deleteSession().catch(() => {});
    setGlobalDispatcher(previousDispatcher);
    await dispatcher.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
