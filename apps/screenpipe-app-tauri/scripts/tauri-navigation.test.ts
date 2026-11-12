// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { afterEach, beforeEach, expect, test } from "bun:test";
import { createContext, runInContext, type Context } from "node:vm";
import { invokeOrThrow, showWindow } from "../e2e/helpers/tauri";
import { openHomeWindow } from "../e2e/helpers/test-utils";
import { installWindowsAsyncScriptTransport, type WindowsAsyncScriptDriver } from "../e2e/helpers/windows-async-script";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
let calls: string[];
let route: string;
let handles: string[];
let current: string;
let nativeError: string | null;
let replaceDocument: boolean;

class NavigationDriver implements WindowsAsyncScriptDriver {
  document!: Context;
  constructor() { this.newDocument(); }
  newDocument() {
    this.document = createContext({
      __TAURI_INTERNALS__: { invoke: async (command: string) => {
        calls.push(command);
        if (nativeError) throw new Error(nativeError);
        if (replaceDocument) this.newDocument();
      } },
    });
  }
  executeScript = async (script: string, args: unknown[]) => {
    this.document.__args = args;
    return runInContext(`(function() { ${script}\n }).apply(null, __args)`, this.document);
  };
  executeAsyncScript = async (_script: string, _args: unknown[]): Promise<unknown> => {
    throw new Error("native Windows async listener must not be used");
  };
  overwriteCommand(_name: "executeAsyncScript", command: Parameters<WindowsAsyncScriptDriver["overwriteCommand"]>[1]) {
    const original = this.executeAsyncScript;
    this.executeAsyncScript = (script, args) => command(original, script, args);
  }
  waitUntil = async (condition: () => Promise<boolean>) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      if (await condition()) return;
    }
    throw new Error("target window route was not reached");
  };
}

beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  calls = []; route = "http://tauri.localhost/home?section=brain";
  handles = ["home"]; current = "home"; nativeError = null; replaceDocument = true;
  const driver = new NavigationDriver();
  installWindowsAsyncScriptTransport(driver);
  (globalThis as any).browser = {
    executeAsync: (callback: Function, ...args: unknown[]) =>
      driver.executeAsyncScript(`return (${callback.toString()}).apply(null, arguments);`, args),
    getWindowHandles: async () => handles,
    switchToWindow: async (label: string) => { current = label; },
    getUrl: async () => current === "home" ? route : "http://tauri.localhost/onboarding",
    waitUntil: driver.waitUntil,
  };
});

afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  delete (globalThis as any).browser;
});

test("a completed Home navigation survives document replacement without invoking twice", async () => {
  await showWindow({ Home: { page: "brain" } });
  expect(calls).toEqual(["show_window"]);
});

test("direct show_window callers verify the native Home handle after losing their callback", async () => {
  current = "onboarding";
  await invokeOrThrow("show_window", { window: { Home: { page: null } } });
  expect(current).toBe("home");
  expect(calls).toEqual(["show_window"]);
});

test.each([
  ["wrong route", "http://tauri.localhost/settings", ["home"]],
  ["wrong section", "http://tauri.localhost/home?section=pipes", ["home"]],
  ["missing native handle", "http://tauri.localhost/home?section=brain", ["onboarding"]],
] as const)("lost navigation callback still fails with %s", async (_name, actualRoute, actualHandles) => {
  route = actualRoute; handles = [...actualHandles];
  await expect(showWindow({ Home: { page: "brain" } })).rejects.toThrow();
  expect(calls).toEqual(["show_window"]);
});

test("a real native rejection is not replaced by an already-matching route", async () => {
  nativeError = "access denied";
  await expect(showWindow({ Home: { page: "brain" } })).rejects.toThrow("access denied");
  expect(calls).toEqual(["show_window"]);
});

test("arbitrary writes keep document-loss failures and are never retried", async () => {
  await expect(invokeOrThrow("update_settings", { value: true })).rejects.toThrow("document was replaced");
  expect(calls).toEqual(["update_settings"]);
});


test("openHomeWindow propagates a native failure through the shared invocation", async () => {
  nativeError = "Home access denied";
  await expect(openHomeWindow()).rejects.toThrow("Home access denied");
  expect(calls).toEqual(["show_window"]);
});

test("other show_window targets retain document-loss failures", async () => {
  await expect(showWindow("Onboarding")).rejects.toThrow("document was replaced");
  expect(calls).toEqual(["show_window"]);
});
