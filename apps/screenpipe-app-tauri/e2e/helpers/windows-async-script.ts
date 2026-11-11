// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { randomUUID } from "node:crypto";

type AsyncScriptCommand = (script: string, args: unknown[]) => Promise<unknown>;

// WebdriverIO can overwrite protocol commands at runtime, but its public
// overwriteCommand types expose only the higher-level browser commands.
export interface WindowsAsyncScriptDriver {
  executeScript: AsyncScriptCommand;
  overwriteCommand(
    name: "executeAsyncScript",
    command: (original: AsyncScriptCommand, script: string, args: unknown[]) => Promise<unknown>,
  ): void;
  waitUntil(
    condition: () => Promise<boolean>,
    options: { timeout: number; interval: number; timeoutMsg: string },
  ): Promise<unknown>;
}

type ScriptResult =
  | { state: "pending" }
  | { state: "complete"; value?: unknown }
  | { state: "error"; message: string }
  | { state: "missing" };

export function installWindowsAsyncScriptTransport(driver: WindowsAsyncScriptDriver): void {
  if (process.platform !== "win32") return;

  // tauri-plugin-webdriver 0.2.1 registers its Windows async message listener
  // once per window label. Recreating the label leaves the new WebView2 without
  // a listener. Poll through synchronous script execution instead. Overwrite
  // the protocol boundary so WDIO still serializes functions and element args.
  driver.overwriteCommand("executeAsyncScript", async (_original, script, args) => {
    const requestId = randomUUID();
    const id = JSON.stringify(requestId);
    let result: ScriptResult = { state: "pending" };
    try {
      await driver.executeScript(`
        var requests = globalThis.__SCREENPIPE_E2E_ASYNC_SCRIPTS__ ||= Object.create(null);
        requests[${id}] = { state: 'pending' };
        var settle = function(result) {
          if (requests[${id}] && requests[${id}].state === 'pending') {
            requests[${id}] = result;
          }
        };
        var done = function(value) { settle({ state: 'complete', value: value }); };
        var args = Array.from(arguments);
        args.push(done);
        try {
          (function() { ${script}\n }).apply(null, args);
        } catch (error) {
          settle({ state: 'error', message: error && error.message ? String(error.message) : String(error) });
        }
      `, args);
      await driver.waitUntil(async () => {
        result = await driver.executeScript(`
          return globalThis.__SCREENPIPE_E2E_ASYNC_SCRIPTS__?.[arguments[0]]
            || { state: 'missing' };
        `, [requestId]) as ScriptResult;
        return result.state !== "pending";
      }, {
        // Matches the Windows ceiling requested in wdio.conf.ts. The plugin
        // ignores session capabilities and otherwise uses its 30-second default.
        timeout: 180_000,
        interval: 100,
        timeoutMsg: "Windows async script did not call its completion callback",
      });
      // TypeScript cannot track assignments made by the polling callback.
      const settled = result as ScriptResult;
      if (settled.state === "missing") {
        throw new Error("async script document was replaced before completion");
      }
      if (settled.state === "error") throw new Error(settled.message);
      if (settled.state === "complete") return settled.value;
      throw new Error("async script polling ended before completion");
    } finally {
      await driver.executeScript(`
        var requests = globalThis.__SCREENPIPE_E2E_ASYNC_SCRIPTS__;
        if (requests) delete requests[arguments[0]];
      `, [requestId]).catch(() => {});
    }
  });
}
