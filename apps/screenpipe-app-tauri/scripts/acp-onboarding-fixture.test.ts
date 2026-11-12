// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { createContext, runInContext } from "node:vm";
import { invokeOrThrow } from "../e2e/helpers/tauri";

const cases = new Map<string, () => Promise<void>>();
const cleanup: Array<() => Promise<void>> = [];
const specUrl = new URL('../e2e/specs/acp-onboarding-ux.spec.ts', import.meta.url);
const spec = new Bun.Transpiler({ loader: 'ts' }).transformSync(readFileSync(specUrl, 'utf8'))
  .replace(/^import[\s\S]*?from\s+["'][^"']+["'];?\s*/gm, '')
  .replaceAll('import.meta.url', JSON.stringify(specUrl.href));
runInContext(spec, createContext({
  path, os, randomUUID, mkdtempSync, rmSync, fileURLToPath, process, invokeOrThrow,
  openHomeWindow: async () => {}, waitForAppReady: async () => {}, t: (ms: number) => ms,
  get browser() { return (globalThis as any).browser; },
  describe: (_name: string, run: () => void) => run(), before: () => {},
  afterEach: (run: () => Promise<void>) => cleanup.push(run),
  it: (name: string, run: () => Promise<void>) => cases.set(name, run), expect,
}));

afterEach(async () => {
  try { for (const run of cleanup) await run(); }
  finally { Reflect.deleteProperty(globalThis, "browser"); }
});

function driver(foreignReady = false, listenerAvailable = true) {
  const listeners = new Set<(event: unknown) => void>();
  const calls: string[] = [];
  let project = "";
  const invoke = async (command: string, args: { sessionId: string; projectDir: string }) => {
    calls.push(command);
    if (command === "pi_start") {
      project = args.projectDir;
      expect(path.isAbsolute(project)).toBe(true);
      expect(project.startsWith(path.join(os.tmpdir(), "screenpipe-acp-onboarding-"))).toBe(true);
      expect(existsSync(project)).toBe(true);
      expect(listeners.size).toBe(1);
      for (const listener of listeners) listener({ payload: { sessionId: foreignReady ? "foreign-session" : args.sessionId, event: { type: "acp_ready" } } });
      return { sessionId: args.sessionId, running: true };
    }
  };
  const window = {
    __TAURI_INTERNALS__: { invoke },
    __TAURI__: { event: listenerAvailable ? { listen: async (_name: string, listener: (event: unknown) => void) => {
      listeners.add(listener); return () => listeners.delete(listener);
    } } : {} },
  };
  const context = createContext({ window, document: { querySelector: () => ({ value: "" }) }, globalThis: window });
  const execute = (callback: Function, args: unknown[], done?: Function) => {
    context.args = args; context.done = done;
    return runInContext(`(${callback.toString()})(...args${done ? ", done" : ""})`, context);
  };
  (globalThis as any).browser = {
    execute: async (callback: Function, ...args: unknown[]) => execute(callback, args),
    executeAsync: (callback: Function, ...args: unknown[]) => new Promise(resolve => execute(callback, args, resolve)),
    waitUntil: async (condition: () => Promise<boolean>) => {
      if (!(await condition())) throw new Error("agent ready was not observed for this session");
    },
  };
  return { calls, project: () => project, listeners };
}

test("the actual ACP selection fixture owns a real temporary project and subscribes before start", async () => {
  const state = driver();
  await cases.get("connects the agent on selection, with nothing sent")!();
  expect(state.calls).toEqual(["pi_start"]);
  for (const run of cleanup) await run();
  expect(state.calls).toEqual(["pi_start", "pi_stop"]);
  expect(existsSync(state.project())).toBe(false);
  expect(state.listeners.size).toBe(0);
});

test("a different agent session cannot satisfy selection readiness", async () => {
  driver(true);
  await expect(cases.get("connects the agent on selection, with nothing sent")!()).rejects.toThrow("agent ready was not observed");
});

test("missing event transport fails before starting an agent", async () => {
  const state = driver(false, false);
  await expect(cases.get("connects the agent on selection, with nothing sent")!()).rejects.toThrow();
  expect(state.calls).toEqual([]);
});
