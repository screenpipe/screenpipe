// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterEach, expect, test } from "bun:test";
import ts from "typescript";
import { createContext, runInContext } from "node:vm";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { selectOrderedSessions, type SessionRecord } from "../lib/stores/chat-store";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
function fixtureRuntime(spec: string) {
  const root = mkdtempSync(join(tmpdir(), "screenpipe-chat-fixture-"));
  dirs.push(root);
  const file = resolve(import.meta.dir, "../e2e/specs", spec);
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const declarations = source.statements.filter((node) => ts.isVariableStatement(node) || ts.isFunctionDeclaration(node));
  const context: Record<string, any> = {
    join, homedir: () => join(root, "unrelated-home"), E2E_DATA_DIR: root,
    mkdirSync, readFileSync, writeFileSync, rmSync, Date, Set, randomUUID,
  };
  const vmContext = createContext(context);
  runInContext(ts.transpile(declarations.map((node) => node.getText(source)).join("\n"), { target: ts.ScriptTarget.ES2022 }), vmContext);
  const runCase = (name: string) => {
    let callback: ts.Node | undefined;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.getText(source) === "it" && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === name) callback = node.arguments[1];
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (!callback) throw new Error(`Missing E2E case: ${name}`);
    return runInContext(ts.transpile(`(${callback.getText(source)})()`, { target: ts.ScriptTarget.ES2022 }), vmContext);
  };
  return { root, context, runCase, evaluate: (code: string) => runInContext(code, vmContext) };
}

test("crowded imported fixture stays visible without deleting unrelated recent history", () => {
  const { root, context } = fixtureRuntime("chat-agent-activity-sidebar.spec.ts");
  const sessions: Record<string, SessionRecord> = {};
  for (let index = 0; index < 12; index++) {
    context.writeImportedConversation(`owned-${index}`, `Owned task ${index}`, "codex", -index * 4 * 60_000);
    const data = JSON.parse(readFileSync(join(root, "chats", `owned-${index}.json`), "utf8"));
    sessions[data.id] = { ...data, messageCount: data.messages.length };
  }
  for (let index = 0; index < 8; index++) {
    const data = sessions["owned-0"];
    sessions[`unrelated-${index}`] = { ...data, id: `unrelated-${index}`, title: `Earlier task ${index}`, lastUserMessageAt: Date.now() - index, messages: [{ role: "user", content: `Earlier task ${index}`, timestamp: index }] as any };
  }
  const visible = selectOrderedSessions({ sessions }).slice(0, 8);
  expect(visible.map((item) => item.id)).toEqual(Array.from({ length: 8 }, (_, index) => `owned-${index}`));
  expect(Object.keys(sessions)).toHaveLength(20);
});

test("duplicate fixture writes its twin into the isolated app data directory and ranks the original above prior history", () => {
  const { root, context, evaluate } = fixtureRuntime("chat-newchat-duplicate.spec.ts");
  context.writeTwinFile("twin", "fixture user turn");
  const twin = JSON.parse(readFileSync(join(root, "chats", "twin.json"), "utf8"));
  expect(twin.messages[0].id).toBe("e2e-duplicate-first-user-message");
  expect(evaluate("FIRST_USER_TIMESTAMP")).toBeGreaterThanOrEqual(Date.now() - 60_000);
  const timestamp = evaluate("FIRST_USER_TIMESTAMP");
  const original: SessionRecord = { ...twin, id: "original", messageCount: 1, messages: [twin.messages[0]], lastUserMessageAt: timestamp };
  const other: SessionRecord = { ...original, id: "other", messages: [{ ...twin.messages[0], id: "separate-first-turn" }] };
  const ordered = selectOrderedSessions({ sessions: { original, twin: { ...twin, messageCount: 2 }, other } });
  expect(ordered.filter((session) => session.id === "original" || session.id === "twin")).toHaveLength(1);
  expect(ordered.some((session) => session.id === "other")).toBe(true);
});

test("sidebar alignment accepts one matching active tab and rejects a second selected tab", async () => {
  const { context } = fixtureRuntime("chat-sidebar-navigation.spec.ts");
  let activeCount = 1;
  context.window = { __e2eForegroundReady: "fixture-chat" };
  context.document = {
    querySelector: (selector: string) => selector.includes("chat-row-")
      ? { dataset: { testid: "chat-row-fixture-chat" } }
      : selector.includes("aria-selected")
        ? { closest: () => ({ dataset: { chatTabId: "fixture-chat" } }) }
        : { textContent: "Fixture chat" },
    querySelectorAll: (selector: string) => Array.from({ length: selector.includes("aria-selected") ? activeCount : 1 }),
  };
  context.t = (value: number) => value;
  context.browser = {
    execute: (callback: () => unknown) => callback(),
    waitUntil: async (condition: () => Promise<boolean>) => {
      if (!await condition()) throw new Error("chat surfaces disagree");
    },
  };
  await context.waitForAlignedChat("fixture-chat", "Fixture chat");
  activeCount = 2;
  await expect(context.waitForAlignedChat("fixture-chat", "Fixture chat")).rejects.toThrow("chat surfaces disagree");
});

test("activity fixture cleanup stops owned native sessions and preserves foreign sessions", async () => {
  const { root, context } = fixtureRuntime("chat-agent-activity-sidebar.spec.ts");
  context.writeImportedConversation("owned-live-codex", "Fixture task", "codex", 0);
  const running = new Set(["owned-live-codex", "foreign-session"]);
  context.invokeOrThrow = async (command: string, args: { sessionId: string }) => {
    expect(command).toBe("pi_stop");
    // Stop must precede deleting the evidence needed to identify its owner.
    expect(JSON.parse(readFileSync(join(root, "chats", `${args.sessionId}.json`), "utf8")).id).toBe(args.sessionId);
    running.delete(args.sessionId);
  };
  await context.cleanup();
  expect([...running]).toEqual(["foreign-session"]);
});

test("reload fixture requests transcript hydration even when the restored foreground id already matches", async () => {
  const { context } = fixtureRuntime("chat-renderer-reload-hydration.spec.ts");
  context.window = { __e2eForegroundReady: "restored-chat" };
  let hydrated = false;
  context.__TAURI__ = { event: { emit: async (event: string, payload: { conversationId: string; targetWindow: string }) => {
    expect(event).toBe("chat-load-conversation");
    expect(payload.conversationId).toBe("restored-chat");
    expect(payload.targetWindow).toBe("home");
    hydrated = true;
  } } };
  context.t = (value: number) => value;
  context.browser = {
    execute: (callback: () => unknown) => callback(),
    waitUntil: async (condition: () => Promise<boolean>) => {
      expect(await condition()).toBe(true);
    },
  };
  context.browser.executeAsync = (callback: (...args: any[]) => void, ...args: unknown[]) =>
    new Promise((resolve) => callback(...args, resolve));
  await context.loadConversation("restored-chat");
  expect(hydrated).toBe(true);
});

test("activity cleanup reports native stop failure and retains owned cleanup evidence", async () => {
  const { root, context } = fixtureRuntime("chat-agent-activity-sidebar.spec.ts");
  context.writeImportedConversation("owned-stop-error", "Fixture task", "codex", 0);
  context.invokeOrThrow = async () => { throw new Error("native stop rejected"); };
  await expect(context.cleanup()).rejects.toThrow("native stop rejected");
  expect(JSON.parse(readFileSync(join(root, "chats", "owned-stop-error.json"), "utf8")).id).toBe("owned-stop-error");
});


test("floating Chat isolation snapshots existing Home tabs instead of assuming a fresh working set", async () => {
  const { context, runCase } = fixtureRuntime("chat-window.spec.ts");
  context.expect = expect;
  context.t = (value: number) => value;
  context.document = { querySelectorAll: () => ["prior-one", "prior-two"].map((id) => ({ dataset: { chatTabId: id } })) };
  context.browser = {
    switchToWindow: async () => {},
    execute: (callback: () => unknown) => callback(),
    waitUntil: async (condition: () => Promise<boolean>) => { if (!await condition()) throw new Error("fresh-tab assumption"); },
  };
  context.showWindow = async () => { throw new Error("fixture-native-boundary"); };
  await expect(runCase("does not open the floating window's chat as a second Home tab")).rejects.toThrow("fixture-native-boundary");
});


test("workspace fixture preserves pre-existing tabs while exercising its exact two-tab working set", async () => {
  const { context, runCase, evaluate } = fixtureRuntime("chat-workspace-tabs.spec.ts");
  const ids = evaluate("[CHAT_A, CHAT_B]");
  evaluate('previousHomeTabs = ["prior-tab"]');
  context.expect = expect;
  context.document = { querySelectorAll: () => ["prior-tab", ...ids].map((id) => ({ dataset: { chatTabId: id } })) };
  context.browser = { execute: (callback: () => unknown) => callback() };
  context.$ = () => { throw new Error("fixture-pointer-boundary"); };
  await expect(runCase("keeps multiple chats open, swaps the split pane, and closes non-destructively")).rejects.toThrow("fixture-pointer-boundary");
  const priorNavigation = fixtureRuntime("chat-sidebar-navigation.spec.ts");
  expect(ids).not.toContain(priorNavigation.evaluate("CHAT_A"));
  expect(ids).not.toContain(priorNavigation.evaluate("CHAT_B"));
});
