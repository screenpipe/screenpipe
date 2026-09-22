// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

test("E2E dispatcher creates and deletes a WebDriver session", () => {
  // WDIO runs under Node. Bun substitutes its built-in undici shim, which
  // would hide incompatibilities between the installed dispatcher and fetch.
  const result = spawnSync("node", ["--import", "tsx", "--input-type=module", "--eval", `
    import assert from "node:assert/strict";
    import { createServer } from "node:http";
    import { remote } from "webdriverio";
    import { config } from "./e2e/wdio.conf.ts";

    const requests = [];
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      requests.push({ method: req.method, url: req.url, body, length: req.headers["content-length"] });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ value: req.method === "POST"
        ? { sessionId: "transport-check", capabilities: { browserName: "chrome" } }
        : req.method === "GET" ? "transport-window" : null }));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      // Import the real config but never invoke its app/recording hooks.
      const browser = await remote({
        hostname: config.hostname, path: config.path,
        port: server.address().port, logLevel: "error",
        connectionRetryCount: 0, connectionRetryTimeout: 5000,
        capabilities: config.capabilities[0],
      });
      assert.equal(browser.sessionId, "transport-check");
      await browser.deleteSession();
      assert.deepEqual(requests.map(({ method, url }) => [method, url]), [
        ["POST", "/session"], ["GET", "/session/transport-check/window"],
        ["DELETE", "/session/transport-check"],
      ]);
      assert.equal(Number(requests[0].length), Buffer.byteLength(requests[0].body));
      assert.equal(JSON.parse(requests[0].body).capabilities.alwaysMatch.browserName, "chrome");
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  `], {
    cwd: resolve(import.meta.dir, ".."),
    encoding: "utf8",
    timeout: 15000,
  });
  expect({ status: result.status, error: result.error?.message }, result.stdout + result.stderr)
    .toEqual({ status: 0, error: undefined });
}, 20000);
