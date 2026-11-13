// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { basename, join } from "node:path";
import { E2E_DATA_DIR, E2E_SEED_FLAGS } from "./app-launcher.js";
import { invokeOrThrow } from "./tauri.js";
import { paidAccountFixture } from "./account-fixtures.js";
import { firstRunAccountFixture } from "./onboarding-first-run-account.js";

export type FixtureAccountSnapshot = {
  user: Record<string, unknown> | null;
  seed: string | null;
  active: string | null;
  token: string | null;
};

export async function snapshotFixtureAccount(): Promise<FixtureAccountSnapshot> {
  if (basename(E2E_DATA_DIR) !== ".e2e") throw new Error("account fixture requires the isolated E2E store");
  const canonicalAccounts = [
    paidAccountFixture("brain-canvas"), paidAccountFixture("first-run"),
    firstRunAccountFixture("none"), firstRunAccountFixture("lifetime"),
  ].map(({ id, token }) => ({ id, token }));
  const result = await browser.executeAsync((path: string, cloudSeed: boolean, canonical: Array<{ id: string; token: string }>, done: (value: { snapshot?: FixtureAccountSnapshot; error?: string }) => void) => {
    const invoke = (window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args: object) => Promise<unknown> } }).__TAURI_INTERNALS__.invoke;
    void (async () => {
      const rid = await invoke("plugin:store|get_store", { path });
      if (rid == null) throw new Error();
      const [settings, exists] = await invoke("plugin:store|get", { rid, key: "settings" }) as [{ user?: Record<string, unknown> | null }, boolean];
      if (!exists) throw new Error();
      const validate = (user: Record<string, unknown> | null) => {
        if (user == null) return;
        if (typeof user !== "object" || Array.isArray(user) || user.api_key != null) throw new Error();
        const fakeToken = typeof user.token === "string" && user.token.startsWith("e2e-fake-token-");
        if (user.token != null && !fakeToken) throw new Error();
        // Native cloud-authenticated starts from User::default(), with no id
        // or plan; only its canonical fake token/refresh marker is added.
        const nativeDefault = Object.entries(user).every(([key, value]) => value == null
          || (key === "token" && fakeToken) || (key === "__e2eSkipAccountRefresh" && value === true));
        if (!(typeof user.id === "string" && user.id.startsWith("e2e-")) && !nativeDefault) throw new Error();
      };
      const user = settings.user ?? null;
      validate(user);
      const seed = localStorage.getItem("screenpipe_e2e_account_user");
      if (seed != null) validate(JSON.parse(seed));
      let token: string | null = null;
      if (typeof user?.token === "string") token = user.token;
      else if (user?.id != null) {
        const known = canonical.find(account => account.id === user.id);
        if (!known) {
          done({ error: "cannot restore token for an unsupported stripped fixture account" });
          return;
        }
        token = known.token;
      } else if (user != null && cloudSeed) {
        token = "e2e-fake-token-onboarding-background-ai-tools";
      }
      done({ snapshot: {
        user, seed, active: localStorage.getItem("screenpipe_e2e_account_fixture_active"), token,
      } });
    })().catch(() => done({ error: "refusing to snapshot an unavailable or non-fixture account" }));
  }, join(E2E_DATA_DIR, "store.bin"), E2E_SEED_FLAGS.split(",").includes("cloud-authenticated"), canonicalAccounts);
  if (!result.snapshot) throw new Error(result.error ?? "fixture account snapshot failed");
  return result.snapshot;
}

export async function restoreFixtureAccount(snapshot: FixtureAccountSnapshot, timeout: number): Promise<void> {
  try {
    // The real hook consumes this key and persists settings.user, including null.
    await browser.execute((user: FixtureAccountSnapshot["user"]) => {
      localStorage.setItem("screenpipe_e2e_account_user", JSON.stringify(user));
      window.dispatchEvent(new Event("screenpipe-e2e-seed-account-user"));
    }, snapshot.user);
    await browser.waitUntil(async () => browser.executeAsync((path: string, expected: FixtureAccountSnapshot["user"], done: (equal: boolean) => void) => {
      const invoke = (window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args: object) => Promise<unknown> } }).__TAURI_INTERNALS__.invoke;
      const same = (left: unknown, right: unknown): boolean => {
        if (left === right) return true;
        if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
        const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
        return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => same(a[key], b[key]));
      };
      void (async () => {
        const rid = await invoke("plugin:store|get_store", { path });
        const [settings, exists] = await invoke("plugin:store|get", { rid, key: "settings" }) as [{ user?: unknown }, boolean];
        // Successful settings persistence strips the token into native storage.
        // Compare all account metadata; restore the known synthetic token below.
        const withoutToken = (user: unknown) => {
          if (!user || typeof user !== "object") return user;
          const copy = { ...user } as Record<string, unknown>;
          delete copy.token;
          return copy;
        };
        done(exists && same(withoutToken(settings.user ?? null), withoutToken(expected)));
      })().catch(() => done(false));
    }, join(E2E_DATA_DIR, "store.bin"), snapshot.user), {
      timeout, interval: 100, timeoutMsg: "original synthetic persisted account was not restored",
    });
  } finally {
    try {
      await invokeOrThrow("set_cloud_token", { token: snapshot.token });
    } finally {
      await browser.execute((saved: FixtureAccountSnapshot) => {
        for (const [key, value] of Object.entries({
          screenpipe_e2e_account_fixture_active: saved.active,
          screenpipe_e2e_account_user: saved.seed,
        })) {
          if (value == null) localStorage.removeItem(key);
          else localStorage.setItem(key, value);
        }
      }, snapshot);
    }
  }
}
