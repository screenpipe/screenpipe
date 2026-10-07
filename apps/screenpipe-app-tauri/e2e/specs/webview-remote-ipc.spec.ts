// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { existsSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { openHomeWindow, t, waitForAppReady } from "../helpers/test-utils.js";

// Tauri injects its IPC bridge into every page, including outside websites
// that end up in an app window (a clicked link, the agent browser, a login
// window). Only the app's own pages may reach plugins. This loads a page from
// another localhost port, which the old `http://localhost:*` remote entry
// trusted, and calls plugins from it.

// `failure`, not `error`: tauri-plugin-webdriver reports a script result that
// carries a string `error` field as a WebDriver error.
type InvokeResult = { ok: boolean; value: unknown; failure: string };

async function invoke(command: string, args: Record<string, unknown>): Promise<InvokeResult> {
  return (await browser.executeAsync(
    (cmd: string, payload: Record<string, unknown>, done: (result: InvokeResult) => void) => {
      const internals = (window as unknown as {
        __TAURI_INTERNALS__?: { invoke: (c: string, a: unknown) => Promise<unknown> };
      }).__TAURI_INTERNALS__;
      if (!internals) {
        done({ ok: false, value: null, failure: "no tauri internals" });
        return;
      }
      internals
        .invoke(cmd, payload)
        .then((value) => done({ ok: true, value, failure: "" }))
        .catch((error) => done({ ok: false, value: null, failure: String(error) }));
    },
    command,
    args,
  )) as InvokeResult;
}

async function navigate(url: string): Promise<void> {
  await browser.execute((target: string) => {
    window.location.href = target;
  }, url);
  await browser.waitUntil(
    async () => {
      try {
        return (await browser.execute(
          (target: string) => window.location.href.startsWith(target) && document.readyState === "complete",
          url,
        )) as boolean;
      } catch {
        // Transient while the old document is torn down — retry.
        return false;
      }
    },
    { timeout: t(30_000), interval: 250, timeoutMsg: `webview did not load ${url}` },
  );
}

describe("Webview remote IPC", function () {
  this.timeout(120_000);

  const marker = join(homedir(), `screenpipe-e2e-remote-ipc-${process.pid}`);
  let server: Server;
  let remoteUrl = "";
  let appUrl = "";

  before(async () => {
    rmSync(marker, { recursive: true, force: true });
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>remote</title><p>remote page</p>");
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    remoteUrl = `http://localhost:${(server.address() as AddressInfo).port}/`;

    await waitForAppReady();
    await openHomeWindow();
    appUrl = await browser.getUrl();
    await navigate(remoteUrl);
  });

  after(async () => {
    rmSync(marker, { recursive: true, force: true });
    if (appUrl) await navigate(appUrl);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("still injects the IPC bridge into the remote page", async () => {
    // Without the bridge the rejections below would pass for the wrong reason.
    expect((await invoke("plugin:fs|exists", { path: marker })).failure).not.toBe("no tauri internals");
  });

  it("rejects fs and store calls from the remote page", async () => {
    const calls: [string, Record<string, unknown>][] = [
      ["plugin:fs|exists", { path: marker }],
      ["plugin:fs|read_dir", { path: homedir() }],
      ["plugin:fs|mkdir", { path: marker, options: {} }],
      ["plugin:store|load", { path: `${marker}.json`, options: {} }],
    ];
    for (const [command, args] of calls) {
      const result = await invoke(command, args);
      expect(result.ok).toBe(false);
      expect(result.failure).toMatch(/not allowed/);
    }
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(`${marker}.json`)).toBe(false);
  });

  it("still allows the same fs call from the app's own page", async () => {
    await navigate(appUrl);
    const result = await invoke("plugin:fs|exists", { path: marker });
    expect(result.failure).toBe("");
    expect(result.value).toBe(false);
  });
});
