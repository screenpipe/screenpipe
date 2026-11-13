// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { paidAccountFixture } from "../e2e/helpers/account-fixtures";
import { firstRunAccountFixture } from "../e2e/helpers/onboarding-first-run-account";
const app = resolve(import.meta.dir, "..");
const parse = (path: string) => ts.createSourceFile(path, readFileSync(join(app, path), "utf8"), ts.ScriptTarget.Latest, true);
function find(file: ts.SourceFile, predicate: (node: ts.Node) => boolean): string {
  let result = "";
  const visit = (node: ts.Node) => { if (predicate(node)) result = node.getText(file); else ts.forEachChild(node, visit); };
  visit(file);
  if (!result) throw new Error("actual fixture consumer not found");
  return result;
}
const gate = parse("components/app-entitlement-gate.tsx");
const seed = find(gate, n => ts.isVariableDeclaration(n) && n.name.getText(gate) === "seedUser");
const setter = find(parse("lib/hooks/use-settings.tsx"), n => ts.isFunctionDeclaration(n) && n.name?.text === "setSettingsStripped");
const helper = parse("e2e/helpers/account-fixture-restoration.ts");
const source = ts.createPrinter().printFile(ts.factory.updateSourceFile(helper, helper.statements.filter(n => !ts.isImportDeclaration(n))));
const compile = (s: string) => ts.transpileModule(s, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
type User = Record<string, unknown> | null;
async function harness(original: User, cloud = false) {
  let user = original;
  const storage = new Map<string, string>([["screenpipe_e2e_account_fixture_active", "original"]]);
  const tokens: Array<string | null> = [];
  let consumer = () => {};
  const localStorage = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v); }, removeItem: (k: string) => { storage.delete(k); } };
  const invoke = async (command: string, args: Record<string, unknown>) => {
    if (command === "plugin:store|get_store") { expect(args.path).toBe("/fixtures/.e2e/store.bin"); return 1; }
    if (command === "plugin:store|get") return [{ user }, true];
    throw new Error("unexpected native call");
  };
  const exports: Record<string, Function> = {};
  const context: Record<string, unknown> = {
    exports, basename, join, paidAccountFixture, firstRunAccountFixture, E2E_DATA_DIR: "/fixtures/.e2e", E2E_SEED_FLAGS: cloud ? "cloud-authenticated" : "onboarding",
    E2E_ACCOUNT_USER_KEY: "screenpipe_e2e_account_user", skipNextResumeForE2ESeedRef: { current: false },
    normalizeSettingsArrays: () => {}, console: { warn: () => {} }, localStorage,
    commands: { setCloudToken: async (token: string | null) => { tokens.push(token); return { status: "ok" }; } },
    Event: class { constructor(public type: string) {} },
    window: { localStorage, __TAURI_INTERNALS__: { invoke }, dispatchEvent: () => consumer() },
    invokeOrThrow: async (command: string, args: { token: string | null }) => { if (command === "set_cloud_token") tokens.push(args.token);
      else if (!["plugin:store|set", "plugin:store|save", "pi_stop"].includes(command)) throw new Error("unexpected fixture cleanup call"); },
    browser: {
      switchToWindow: async () => {},
      execute: async (callback: Function, ...args: unknown[]) => callback(...args),
      executeAsync: (callback: Function, ...args: unknown[]) => new Promise(resolve => callback(...args, resolve)),
      waitUntil: async (condition: () => Promise<boolean>) => { for (let i = 0; i < 10; i++) if (await condition()) return; throw new Error("persistence did not complete"); },
    },
  };
  const store = { set: async (_key: string, settings: { user: User }) => { await Promise.resolve(); user = JSON.parse(JSON.stringify(settings.user)); } };
  context.updateSettings = async (updates: { user: User }) => (context.setSettingsStripped as Function)(store, updates);
  runInNewContext(compile(`${setter}\nglobalThis.setSettingsStripped=setSettingsStripped; const ${seed}; globalThis.seedUser=seedUser;`), context);
  consumer = context.seedUser as () => void;
  runInNewContext(compile(source), context);
  return { exports, context, storage, tokens, strip: async () => (context.setSettingsStripped as Function)(store, { user }), user: () => user, replace: (value: User) => { user = value; } };
}
for (const [name, original, cloud] of [
  ["absent", null, false],
  ["paid", paidAccountFixture("brain-canvas"), false],
  ["native cloud seed", { id: null, email: null, subscription_plan: null, token: "e2e-fake-token-onboarding-background-ai-tools", __e2eSkipAccountRefresh: true }, true],
  ["stripped native cloud seed", { id: null, email: null, token: null }, true],
] as const) {
  test(`restores persisted user through actual seed and settings producers: ${name}`, async () => {
    const h = await harness(original, cloud);
    const snapshot = await h.exports.snapshotFixtureAccount();
    h.replace(paidAccountFixture("first-run"));
    h.storage.set("screenpipe_e2e_account_fixture_active", "1");
    await h.exports.restoreFixtureAccount(snapshot, 15_000);
    const expected = original == null ? null : { ...original } as Record<string, unknown>;
    if (expected?.token) delete expected.token;
    expect(h.user()).toEqual(expected);
    expect(h.storage.get("screenpipe_e2e_account_fixture_active")).toBe("original");
    expect(h.storage.has("screenpipe_e2e_account_user")).toBe(false);
    expect(h.tokens.at(-1)).toBe(snapshot.token);
  });
}
test("restores an unconsumed transport key after persisting the original user", async () => {
  const h = await harness(paidAccountFixture("brain-canvas"));
  const originalSeed = JSON.stringify(paidAccountFixture("first-run"));
  h.storage.set("screenpipe_e2e_account_user", originalSeed);
  const snapshot = await h.exports.snapshotFixtureAccount();
  h.replace(null);
  await h.exports.restoreFixtureAccount(snapshot, 15_000);
  expect(h.user()?.id).toBe("e2e-brain-canvas-user");
  expect(h.storage.get("screenpipe_e2e_account_user")).toBe(originalSeed);
});
test.each([
  { id: "non-fixture", token: "e2e-fake-token-test" },
  { id: "e2e-test", token: "not-a-fixture-token" },
  { id: "e2e-test", api_key: "not-a-fixture-key" },
  { id: null, email: "not-a-fixture@example.invalid" },
])("rejects non-fixture account data without exposing it", async user => {
  const h = await harness(user);
  await expect(h.exports.snapshotFixtureAccount()).rejects.toThrow("refusing to snapshot an unavailable or non-fixture account");
  expect(h.tokens).toHaveLength(0);
});

for (const name of ["agent-handoff", "learning-window", "reset-learning-window"]) {
  test.each([null, paidAccountFixture("brain-canvas")])(`actual first-run ${name} teardown restores the persisted account`, async original => {
    const h = await harness(original);
    const snapshot = await h.exports.snapshotFixtureAccount();
    h.replace(paidAccountFixture("first-run"));
    const spec = parse(`e2e/specs/first-run-${name}.spec.ts`);
    const cleanup = find(spec, n => ts.isArrowFunction(n) && ts.isCallExpression(n.parent) && n.parent.expression.getText(spec) === "after");
    Object.assign(h.context, {
      originalOnboarding: {}, onboardingRid: 1,
      originalAccount: snapshot, originalAccounts: { home: snapshot, chat: snapshot },
      originalView: { learning: null }, originalViews: { home: { learning: null }, chat: { learning: null } },
      restoreFixtureAccount: h.exports.restoreFixtureAccount,
      LEARNING_STORAGE_KEY: "learning", E2E_ACCOUNT_USER_KEY: "screenpipe_e2e_account_user", ACCOUNT_KEY: "screenpipe_e2e_account_user",
      ownedSummaryIds: new Set(), SUMMARY_CHAT_ID: "e2e-owned-summary", SUMMARY_CHAT_PATH: "/fixtures/.e2e/chats/owned.json",
      rmSync: () => {}, t: (n: number) => n,
    });
    await runInNewContext(compile(`(${cleanup})()`), h.context);
    const expected = original == null ? null : { ...original } as Record<string, unknown>;
    if (expected?.token) delete expected.token;
    expect(h.user()).toEqual(expected);
  });
}

test("reports failed persistence while still restoring marker and known token", async () => {
  const h = await harness(paidAccountFixture("brain-canvas"));
  const snapshot = await h.exports.snapshotFixtureAccount();
  h.replace({ ...paidAccountFixture("brain-canvas"), subscription_plan: "free" });
  h.context.updateSettings = async () => {};
  h.storage.set("screenpipe_e2e_account_fixture_active", "1");
  await expect(h.exports.restoreFixtureAccount(snapshot, 15_000)).rejects.toThrow("persistence did not complete");
  expect(h.user()?.subscription_plan).toBe("free");
  expect(h.storage.get("screenpipe_e2e_account_fixture_active")).toBe("original");
  expect(h.storage.has("screenpipe_e2e_account_user")).toBe(false);
  expect(h.tokens.at(-1)).toBe(snapshot.token);
});

for (const [label, original] of [
  ["brain-canvas", paidAccountFixture("brain-canvas")],
  ["first-run", paidAccountFixture("first-run")],
  ["none", firstRunAccountFixture("none")],
  ["lifetime", firstRunAccountFixture("lifetime")],
] as const) {
  test(`restores known stripped token without cloud-authenticated: ${label}`, async () => {
    const h = await harness(original, false);
    await h.strip(); // Execute the actual native-settings token stripping producer.
    expect(h.user()?.token).toBeUndefined();
    const snapshot = await h.exports.snapshotFixtureAccount();
    h.replace(paidAccountFixture("first-run"));
    await h.exports.restoreFixtureAccount(snapshot, 15_000);
    expect(h.tokens.at(-1) === original.token).toBe(true);
  });
}

test.each([false, true])("rejects unknown stripped fixture identities even with a cloud seed", async cloud => {
  const h = await harness({ id: "e2e-unknown-account", token: null }, cloud);
  await expect(h.exports.snapshotFixtureAccount()).rejects.toThrow("cannot restore token for an unsupported stripped fixture account");
  expect(h.tokens).toHaveLength(0);
});
