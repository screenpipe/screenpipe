// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { paidAccountFixture } from "../e2e/helpers/account-fixtures";

const path = resolve(import.meta.dir, "../e2e/specs/pipe-continuous-chat.spec.ts");
const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
const functions: string[] = [], variables: string[] = [];
let before = "", after = "";
function visit(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && ["apiRequest", "cleanupFixture", "installFixture"].includes(node.name?.text ?? "")) functions.push(node.getText(source));
  if (ts.isVariableDeclaration(node) && ["fixtureDir", "apiBase", "apiHeaders", "fixtureApiReady", "originalAccount"].includes(node.name.getText(source))) variables.push(`let ${node.getText(source)};`);
  if (ts.isCallExpression(node) && ["before", "after"].includes(node.expression.getText(source))) {
    const callback = node.arguments[0];
    if (ts.isArrowFunction(callback)) {
      if (node.expression.getText(source) === "before") before = callback.getText(source);
      else after = callback.getText(source);
    }
  }
  ts.forEachChild(node, visit);
}
visit(source);
if (!before || !after || functions.length !== 3 || variables.length !== 5) throw new Error("actual fixture setup was not found");
const script = ts.transpileModule(`${variables.join("\n")}\n${functions.join("\n")}\nglobalThis.setup=${before};globalThis.teardown=${after};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

for (const mode of ["success", "install-fails", "dispose-fails", "setup-fails"] as const) {
  test(`actual continuous-chat fixture owns its paid premise and restores it: ${mode}`, async () => {
    const original = { user: null, token: null, seed: null, active: null };
    const pipes = new Set(["unrelated-a", "unrelated-b"]);
    const events: string[] = [];
    const requests: string[] = [];
    let paidPolicy = false;
    let installs = 0;
    let restored = false;
    const context: Record<string, unknown> = {
      exports: {}, PIPE_NAME: "e2e-continuous-chat", CHAT_FILE: "/fixtures/.e2e/chats/owned.json", join,
      t: (n: number) => n, tmpdir: () => "/fixtures/tmp",
      mkdtempSync: (prefix: string) => `${prefix}owned`, writeFileSync: () => {}, rmSync: () => {},
      waitForAppReady: async () => { if (mode === "setup-fails") throw new Error("setup unavailable"); },
      openHomeWindow: async () => {}, getLocalApiConfig: async () => ({ port: 11437, key: "fixture-key" }),
      authHeaders: () => ({ Authorization: "Bearer fixture-key" }), waitForLocalApi: async () => {},
      paidAccountFixture: (scenario: "brain-canvas" | "first-run") => paidAccountFixture(scenario, "2026-11-13T00:00:00.000Z"), snapshotFixtureAccount: async () => original,
      // This existing helper's real seed/settings producers have independent
      // regression coverage. Its async completion includes native policy refresh.
      restoreFixtureAccount: async (snapshot: { user: unknown; token: unknown }) => {
        if (snapshot === original) { restored = true; paidPolicy = false; events.push("original-restored"); return; }
        const paid = paidAccountFixture("first-run", "2026-11-13T00:00:00.000Z");
        expect(JSON.stringify(snapshot.user) === JSON.stringify(paid)).toBe(true);
        expect(snapshot.token === paid.token).toBe(true);
        events.push("paid-persisted");
        await new Promise<void>(resolve => setImmediate(resolve));
        paidPolicy = true;
        events.push("paid-policy-refreshed");
      },
      piConversation: { initialize: async () => {}, configureAppPreset: async () => {}, dispose: async () => { if (mode === "dispose-fails") throw new Error("dispose unavailable"); } },
      fetch: async (url: string, options: { method: string; headers: Record<string, string> }) => {
        requests.push(url);
        expect(url.startsWith("http://127.0.0.1:11437/")).toBe(true);
        expect(options.headers.Authorization === "Bearer fixture-key").toBe(true);
        if (url.endsWith("/pipes/install")) {
          installs++;
          expect(paidPolicy).toBe(true);
          expect(events.indexOf("paid-policy-refreshed") > events.indexOf("paid-persisted")).toBe(true);
          if (mode === "install-fails") return new Response(JSON.stringify({ error: "install rejected" }), { status: 503 });
          pipes.add("e2e-continuous-chat");
          return new Response(JSON.stringify({ success: true }));
        }
        expect(url.includes("/pipes/e2e-continuous-chat")).toBe(true);
        if (options.method === "DELETE") pipes.delete("e2e-continuous-chat");
        return new Response(JSON.stringify({ success: true }));
      },
    };
    runInNewContext(script, context);
    const setup = context.setup as () => Promise<void>, teardown = context.teardown as () => Promise<void>;
    if (mode === "install-fails") await expect(setup()).rejects.toThrow("failed to install continuous-chat fixture");
    else if (mode === "setup-fails") await expect(setup()).rejects.toThrow("setup unavailable");
    else await setup();
    if (mode === "dispose-fails") await expect(teardown()).rejects.toThrow("dispose unavailable");
    else await teardown();
    expect(requests.every(url => url.startsWith("http://127.0.0.1:11437/"))).toBe(true);
    if (mode === "setup-fails") expect(requests).toHaveLength(0);
    expect(restored).toBe(mode !== "setup-fails");
    expect(paidPolicy).toBe(false);
    expect(installs).toBe(mode === "setup-fails" ? 0 : 1);
    expect([...pipes]).toEqual(["unrelated-a", "unrelated-b"]);
  });
}
