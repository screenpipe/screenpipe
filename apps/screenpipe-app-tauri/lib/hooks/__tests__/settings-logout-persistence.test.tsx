// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLocalPlanPolicy } from "@/lib/app-entitlement";
import { SettingsProvider, createDefaultSettingsObject, useSettings } from "../use-settings";

const state = vi.hoisted(() => ({
  settings: undefined as any,
  token: null as string | null,
  pauseSave: null as null | (() => Promise<void>),
  signedOut: false,
  lateWrites: [] as string[],
  deferredWrites: [] as (() => void)[],
  events: new Map<string, Set<() => void>>(),
}));
vi.mock("../use-is-enterprise-build", () => ({
  invalidateEnterpriseBuildStatus: () => {}, resolveEnterpriseBuild: async () => false,
  isResolvedConsumerBuild: async () => true,
}));
vi.mock("@tauri-apps/plugin-store", () => ({ Store: { load: async () => ({
  get: async () => structuredClone(state.settings),
  set: async (_: string, value: unknown) => { state.settings = structuredClone(value); },
  save: async () => { const pause = state.pauseSave; state.pauseSave = null; await pause?.(); },
  onKeyChange: async () => () => {},
}) } }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: async () => "/tmp" }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, cb: () => void) => {
    const callbacks = state.events.get(name) ?? new Set();
    state.events.set(name, callbacks); callbacks.add(cb);
    return () => callbacks.delete(cb);
  },
  emit: async (name: string) => { for (const cb of state.events.get(name) ?? []) cb(); },
}));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "windows" }));
vi.mock("@/lib/api", () => ({ configureApi: () => {}, refreshApiConfig: async () => {}, onUnauthorized: () => () => {} }));
vi.mock("@/lib/utils/tauri", () => ({ commands: {
  getScreenpipeBaseDir: async () => ({ status: "ok", data: "/tmp" }),
  getCloudToken: async () => state.token,
  setCloudToken: async (token: string | null) => {
    // Native IPC/persistence is asynchronous. A stale refresh must not issue a
    // token write after logout, since it can finish after the deletion.
    if (token && state.signedOut) {
      state.lateWrites.push(token);
      if (state.lateWrites.length === 1) await new Promise<void>(resolve => state.deferredWrites.push(resolve));

    }
    state.token = token;
    return { status: "ok", data: null };
  },
  reencryptStore: async () => {}, setBrowserCookieAccessState: async () => {},
} }));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function mount() {
  const hook = renderHook(() => useSettings(), { wrapper: SettingsProvider });
  await waitFor(() => expect(hook.result.current.isSettingsLoaded).toBe(true));
  return hook;
}
beforeEach(() => {
  state.settings = { ...createDefaultSettingsObject(), deviceId: "logout-test" };
  state.token = null; state.signedOut = false; state.pauseSave = null;
  state.lateWrites = []; state.deferredWrites = []; state.events.clear();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ user: {
    id: "test-user", email: "logout@example.test", cloud_subscribed: false,
  } }), { status: 200 })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("persists a verified Standard trial when the server clock is over five minutes ahead", async () => {
  const serverCheckedAt = Date.now() + 321_000;
  const trialLength = 7 * 24 * 60 * 60 * 1000;
  const fetchAccount = vi.fn(async () => new Response(JSON.stringify({ user: {
    id: "test-user",
    email: "trial@example.test",
    app_entitled: true,
    cloud_subscribed: false,
    subscription_plan: "standard",
    entitlement: {
      active: true,
      plan: "standard",
      source: "subscription",
      status: "trialing",
      checked_at: new Date(serverCheckedAt).toISOString(),
      current_period_end: new Date(serverCheckedAt + trialLength).toISOString(),
      grace_until: null,
      features: { app: true, cloud: false },
    },
  } }), { status: 200 }));
  vi.stubGlobal("fetch", fetchAccount);
  const hook = await mount();
  const requestStartedAt = Date.now();

  await act(async () => {
    await hook.result.current.loadUser("synthetic-session-token", true);
  });

  const { user } = state.settings;
  expect(getLocalPlanPolicy(user)).toBe("verified-paid");
  const deviceCheckedAt = Date.parse(user.entitlement.checked_at);
  expect(deviceCheckedAt).toBeGreaterThanOrEqual(requestStartedAt);
  expect(deviceCheckedAt).toBeLessThanOrEqual(Date.now());
  expect(Date.parse(user.entitlement.current_period_end) - deviceCheckedAt).toBe(trialLength);
  expect(user.entitlement.grace_until).toBeNull();
  expect(state.token).toBe("synthetic-session-token");
});

describe("logout during account persistence", () => {
  it.each([false, true])("does not restore the native session after signout (unknown plan=%s)", async unknownPlan => {
    if (unknownPlan) vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      user: { id: "test-user", email: "logout@example.test" },
    }), { status: 200 })));
    const hook = await mount();
    const saving = deferred(); const releaseSave = deferred();
    state.pauseSave = async () => { saving.resolve(); await releaseSave.promise; };
    let login!: Promise<void>;
    act(() => { login = hook.result.current.loadUser("synthetic-session-token").catch(() => {}); });
    await act(async () => { await saving.promise; });
    state.signedOut = true;
    let logout!: Promise<void>;
    act(() => { logout = hook.result.current.updateSettings({ user: null as any }); });
    await act(async () => { releaseSave.resolve(); await logout; });
    expect(state.settings.user).toBeNull();
    // Let an incorrectly issued native write finish after logout has completed.
    await act(async () => {
      for (const release of state.deferredWrites) release();
      await login;
    });
    expect(state.token).toBeNull();
    expect(state.lateWrites).toEqual([]);
    expect(state.settings.user).toBeNull();
    await act(async () => { await hook.result.current.reloadStore(); });
    expect(hook.result.current.settings.user).toBeNull();
  });

  it("still persists a deliberate login and clears it on ordinary logout", async () => {
    const hook = await mount();
    await act(async () => { await hook.result.current.loadUser("synthetic-session-token"); });
    expect(state.token).toBe("synthetic-session-token");
    await act(async () => { await hook.result.current.updateSettings({ user: null as any }); });
    expect(state.token).toBeNull(); expect(state.settings.user).toBeNull();
  });
});
