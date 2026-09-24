// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, beforeEach, expect, test } from "bun:test";
import { invokeWindows as invoke } from "../e2e/helpers/tauri";

const g = globalThis as any;
const savedBrowser = g.browser;
const savedInternals = g.__TAURI_INTERNALS__;
const savedTauri = g.__TAURI__;
afterAll(() => {
  g.browser = savedBrowser;
  g.__TAURI_INTERNALS__ = savedInternals;
  g.__TAURI__ = savedTauri;
  delete g.__screenpipeE2EInvokes;
});
beforeEach(() => {
  delete g.__screenpipeE2EInvokes;
  g.__TAURI__ = undefined;
  g.__TAURI_INTERNALS__ = { invoke: async () => "native result" };
  g.browser = {
    getTimeouts: async () => ({ script: 30 }),
    execute: async (fn: Function, ...args: unknown[]) => fn(...args),
    executeAsync: () => { throw new Error("broken per-label async handler used"); },
    waitUntil: async (condition: () => Promise<boolean>, options: { timeout: number; timeoutMsg: string }) => {
      const deadline = Date.now() + options.timeout;
      while (true) {
        // Match WebdriverIO: errors inside a condition are retried.
        try { if (await condition()) return; } catch {}
        if (Date.now() >= deadline) throw new Error(options.timeoutMsg);
        await new Promise(resolve => setTimeout(resolve, 1));
      }
    },
  };
});

test("Windows invoke resolves native values and cleans up per-document state", async () => {
  expect(await invoke("get_onboarding_status")).toEqual({ ok: true, value: "native result" });
  expect(Object.keys(g.__screenpipeE2EInvokes)).toHaveLength(0);
  // Recreated webview has fresh document state with the same window label.
  delete g.__screenpipeE2EInvokes;
  g.__TAURI_INTERNALS__ = { invoke: async () => ({ fresh: true }) };
  expect(await invoke("get_onboarding_status")).toEqual({ ok: true, value: { fresh: true } });
});

test("Windows invoke reports a real native rejection rather than timing out", async () => {
  g.__TAURI_INTERNALS__.invoke = () => Promise.reject(new Error("native denied"));
  expect(await invoke("denied")).toEqual({ ok: false, error: "Error: native denied" });
  expect(Object.keys(g.__screenpipeE2EInvokes)).toHaveLength(0);
});

test("Windows invoke bounds a pending native call and cleans up", async () => {
  g.__TAURI_INTERNALS__.invoke = () => new Promise(() => {});
  await expect(invoke("pending")).rejects.toThrow("pending: native invocation timed out");
  expect(Object.keys(g.__screenpipeE2EInvokes)).toHaveLength(0);
});

test("Windows invoke detects document replacement while a command is pending", async () => {
  g.__TAURI_INTERNALS__.invoke = () => {
    delete g.__screenpipeE2EInvokes;
    return new Promise(() => {});
  };
  await expect(invoke("replaced")).rejects.toThrow("invoking webview was replaced");
});
