// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHomeWindow, waitForAppReady } from "../helpers/test-utils.js";

// Anything that renders untrusted content in the webview can call Tauri IPC
// directly, bypassing the UI. The shell scope must reject arbitrary commands
// at that boundary, not just at the call sites the UI happens to use.

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

// `program` is the scope entry's `name`, not the binary: the shell plugin
// looks the name up in the capability scope before it spawns anything.
function execute(
  program: string,
  args: string[],
  options: Record<string, unknown> = {},
): Promise<InvokeResult> {
  return invoke("plugin:shell|execute", { program, args, options });
}

function expectScopeRejection(result: InvokeResult): void {
  expect(result.ok).toBe(false);
  expect(result.failure).toMatch(/not allowed/);
}

describe("Webview shell scope", function () {
  this.timeout(120_000);

  const marker = join(tmpdir(), `screenpipe-e2e-shell-scope-${process.pid}`);

  before(async () => {
    rmSync(marker, { force: true });
    await waitForAppReady();
    await openHomeWindow();
  });

  after(() => {
    rmSync(marker, { force: true });
  });

  it("rejects sh -c from the webview", async () => {
    for (const name of ["exec-sh", "sh"]) {
      expectScopeRejection(await execute(name, ["-c", `touch '${marker}'`]));
    }
    expect(existsSync(marker)).toBe(false);
  });

  it("rejects cmd from the webview", async () => {
    expectScopeRejection(await execute("cmd", ["/c", `type nul > "${marker}"`]));
    expect(existsSync(marker)).toBe(false);
  });

  it("rejects open with arbitrary arguments", async () => {
    // `open -h` only prints usage, so a regression here has no side effect.
    expectScopeRejection(await execute("open", ["-h"]));
    expect((await execute("open-app", ["-a", "Terminal"])).ok).toBe(false);
    expect((await execute("open-reveal", ["-R", "-a"])).ok).toBe(false);
  });

  it("does not resolve an allowed launcher through the caller's PATH", async function () {
    if (process.platform !== "darwin") this.skip();
    const directory = mkdtempSync(join(tmpdir(), "screenpipe-shell-path-"));
    const executable = join(directory, "open");
    const executed = `${executable}.executed`;
    try {
      writeFileSync(
        executable,
        '#!/bin/sh\nprintf "unexpected PATH lookup\\n" > "$0.executed"\n',
        { mode: 0o700 },
      );
      // A missing target lets the real open report an error without opening Finder.
      const result = await execute("open-reveal", ["-R", join(directory, "missing")], {
        env: { PATH: directory },
      });
      expect(result.failure).toBe("");
      expect(result.ok).toBe(true);
      expect(existsSync(executed)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("can still check whether Claude and Cursor are installed on macOS", async function () {
    if (process.platform !== "darwin") this.skip();
    for (const path of ["/Applications/Claude.app", "/Applications/Cursor.app"]) {
      const result = await invoke("plugin:fs|exists", { path });
      expect(result.failure).toBe("");
      expect(typeof result.value).toBe("boolean");
    }
  });
});
