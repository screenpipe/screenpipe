// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterEach, expect, test } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { openHomeWindow } from "../e2e/helpers/test-utils";

afterEach(() => { delete (globalThis as any).browser; delete (globalThis as any).$; });

function driver(initial: string, hidden = false, clickFails = false) {
  let url = new URL(initial, "http://tauri.localhost");
  let collapsed = true;
  let reloads = 0;
  const location = {
    get pathname() { return url.pathname; },
    get search() { return url.search; },
    get href() { return url.href; },
    set href(value: string) { reloads++; url = new URL(value, url); },
  };
  const context = createContext({
    URLSearchParams, window: { location }, getComputedStyle: () => ({ visibility: 'visible' }),
    document: { querySelector: (selector: string) => selector === '[data-testid="home-page"]' ? {
      getClientRects: () => hidden || url.searchParams.get("mode") === "workflows" ? [] : [{}],
    } : null },
    __TAURI_INTERNALS__: { invoke: async (command: string, args: any) => {
      if (command === 'plugin:event|emit_to') {
        expect(args.target).toEqual({ kind: 'AnyLabel', label: 'home' });
        expect(args.event).toBe('navigate');
        url = new URL(args.payload.url, url);
      }
    } },
  });
  (globalThis as any).browser = {
    pause: async () => {}, getWindowHandles: async () => ["home"], switchToWindow: async () => {},
    execute: async (callback: Function, ...args: unknown[]) => {
      context.args = args;
      return runInContext(`(${callback.toString()})(...args)`, context);
    },
    executeAsync: (callback: Function, ...args: unknown[]) => new Promise(resolve => {
      context.args = args; context.done = resolve;
      runInContext(`(${callback.toString()})(...args, done)`, context);
    }),
    waitUntil: async (condition: () => Promise<unknown>) => {
      for (let n = 0; n < 3; n++) { const value = await condition(); if (value) return value; }
      throw new Error("Home readiness was not reached");
    },
  };
  (globalThis as any).$ = async (selector: string) => ({
    isExisting: async () => collapsed && selector === '[aria-label="Expand sidebar"]',
    click: async () => { if (clickFails) throw new Error("sidebar click failed"); collapsed = false; },
  });
  return { url: () => url, collapsed: () => collapsed, reloads: () => reloads };
}

test.each(["/home?section=brain", "/home?mode=workflows&section=help", "/settings?section=ai"])(
  "opens a visible Screenpipe chat baseline from %s", async initial => {
    const state = driver(initial);
    await openHomeWindow();
    expect(state.url().pathname).toBe("/home");
    expect(state.url().searchParams.get("section")).toBe("home");
    expect(state.url().searchParams.get("mode")).toBe("screenpipe");
    expect(state.collapsed()).toBe(false);
    expect(state.reloads()).toBe(initial.startsWith('/home') ? 0 : 1);
  },
);
test('keeps an already-visible Home document and its attached harness intact', async () => {
  const state = driver('/home');
  await openHomeWindow();
  expect(state.url().search).toBe('');
  expect(state.reloads()).toBe(0);
});
test("does not treat a hidden Home root as ready", async () => {
  driver("/home?section=home&mode=screenpipe", true);
  await expect(openHomeWindow()).rejects.toThrow("Home readiness");
});
test("reports a sidebar expansion failure", async () => {
  driver("/home?section=home&mode=screenpipe", false, true);
  await expect(openHomeWindow()).rejects.toThrow("sidebar click failed");
});
