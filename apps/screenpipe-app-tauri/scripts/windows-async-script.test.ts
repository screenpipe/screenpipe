// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { afterEach, beforeEach, expect, test } from "bun:test";
import { createContext, runInContext, type Context } from "node:vm";
import {
  installWindowsAsyncScriptTransport,
  type WindowsAsyncScriptDriver,
} from "../e2e/helpers/windows-async-script";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";

class Driver implements WindowsAsyncScriptDriver {
  document: Context = createContext({});
  registeredAsyncDocument?: Context;
  nativeAsyncCalls = 0;
  overwritten = false;
  waitUntil = async (condition: () => Promise<boolean>, options: { timeout: number; interval: number }) => {
    expect(options.timeout).toBe(180_000);
    expect(options.interval).toBe(100);
    for (let attempt = 0; attempt < 20; attempt++) {
      if (await condition()) return;
    }
    throw new Error("bounded test timeout");
  };

  executeScript = async (script: string, args: unknown[]) => {
    // Model the existing protocol's argument deserialization. The workaround
    // must pass element references through this path, not JSON-embed arguments.
    const deserialize = (value: unknown): unknown => {
      if (value && typeof value === "object" && ELEMENT_KEY in value) {
        return { textContent: "fixture element" };
      }
      return Array.isArray(value) ? value.map(deserialize) : value;
    };
    this.document.__args = args.map(deserialize);
    return runInContext(`(function() { ${script}\n }).apply(null, __args)`, this.document);
  };

  executeAsyncScript = async (script: string, args: unknown[]) => {
    this.nativeAsyncCalls++;
    // WebDriver 0.2.1 remembers the label after the WebView2 was destroyed.
    this.registeredAsyncDocument ??= this.document;
    if (this.registeredAsyncDocument !== this.document) {
      throw new Error("Windows async handler lost after window recreation");
    }
    return new Promise((resolve, reject) => {
      this.executeScript(script, [...args, resolve]).catch(reject);
    });
  };

  overwriteCommand(
    _name: "executeAsyncScript",
    command: Parameters<WindowsAsyncScriptDriver["overwriteCommand"]>[1],
  ) {
    this.overwritten = true;
    const original = this.executeAsyncScript;
    this.executeAsyncScript = (script, args) => command(original, script, args);
  }

  requests() {
    return runInContext("Object.keys(globalThis.__SCREENPIPE_E2E_ASYNC_SCRIPTS__ || {})", this.document) as string[];
  }
}

let driver: Driver;

beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  driver = new Driver();
});

afterEach(() => Object.defineProperty(process, "platform", originalPlatform));

test("arbitrary callbacks work after recreating a window with the same label", async () => {
  installWindowsAsyncScriptTransport(driver);
  const script = "var done = arguments[arguments.length - 1]; Promise.resolve().then(() => done({ ok: true, value: arguments[0] }));";
  for (let instance = 0; instance < 2; instance++) {
    driver.document = createContext({});
    expect(await driver.executeAsyncScript(script, ["native response"]))
      .toEqual({ ok: true, value: "native response" });
    expect(driver.requests()).toHaveLength(0);
  }
  expect(driver.nativeAsyncCalls).toBe(0);
});

test("callback values preserve undefined, null, false, and original error objects", async () => {
  installWindowsAsyncScriptTransport(driver);
  for (const value of [undefined, null, false, 0, { ok: false, error: "native access denied" }]) {
    expect(await driver.executeAsyncScript("arguments[1](arguments[0]);", [value])).toEqual(value);
    expect(driver.requests()).toHaveLength(0);
  }
});

test("first completion wins and synchronous script errors reject with cleanup", async () => {
  installWindowsAsyncScriptTransport(driver);
  expect(await driver.executeAsyncScript("arguments[0]('first'); arguments[0]('second'); throw new Error('late');", []))
    .toBe("first");
  await expect(driver.executeAsyncScript("throw new Error('original script error');", []))
    .rejects.toThrow("original script error");
  await expect(driver.executeAsyncScript("throw null;", []))
    .rejects.toThrow("null");
  await expect(driver.executeAsyncScript("throw 'script access denied';", []))
    .rejects.toThrow("script access denied");
  expect(driver.requests()).toHaveLength(0);
});

test("timeout cleans up and late completion cannot restore a request", async () => {
  installWindowsAsyncScriptTransport(driver);
  const timeout = new Error("original bounded timeout");
  driver.waitUntil = async (condition, options) => {
    expect(options.timeout).toBe(180_000);
    expect(await condition()).toBe(false);
    throw timeout;
  };
  await expect(driver.executeAsyncScript("globalThis.lateCompletion = arguments[0];", []))
    .rejects.toBe(timeout);
  expect(driver.requests()).toHaveLength(0);
  runInContext("lateCompletion('late response')", driver.document);
  expect(driver.requests()).toHaveLength(0);
});

test("replaced documents end polling without clearing unrelated requests", async () => {
  installWindowsAsyncScriptTransport(driver);
  driver.waitUntil = async (condition) => {
    driver.document = createContext({ __SCREENPIPE_E2E_ASYNC_SCRIPTS__: { unrelated: { state: "pending" } } });
    expect(await condition()).toBe(true);
  };
  await expect(driver.executeAsyncScript("", []))
    .rejects.toThrow("document was replaced before completion");
  expect(driver.requests()).toEqual(["unrelated"]);
});

test("WDIO serialized source, its name polyfill, and element arguments stay executable", async () => {
  installWindowsAsyncScriptTransport(driver);
  // This is the protocol payload after WDIO has serialized a callback and
  // stripped its element argument. The polyfill belongs to WDIO, not our shim.
  const script = `
    function webdriverioPolyfill() {
      globalThis.__name = (target, value) => Object.defineProperty(target, 'name', { value });
    }
    webdriverioPolyfill();
    return (function(element, done) {
      var read = __name(() => element.textContent, 'read');
      done(read());
    }).apply(null, arguments);
  `;
  expect(await driver.executeAsyncScript(script, [{ [ELEMENT_KEY]: "fixture-element" }]))
    .toBe("fixture element");
});

test("non-Windows drivers retain their original async command", async () => {
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  installWindowsAsyncScriptTransport(driver);
  expect(driver.overwritten).toBe(false);
  expect(await driver.executeAsyncScript("arguments[0]('original transport');", []))
    .toBe("original transport");
  expect(driver.nativeAsyncCalls).toBe(1);
});
