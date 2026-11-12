// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { authHeaders, getLocalApiConfig, waitForLocalApi } from "../helpers/api-utils.js";
import { E2E_DATA_DIR, E2E_SEED_FLAGS } from "../helpers/app-launcher.js";
import { spawnTransientForegroundApp } from "../helpers/seed-capture-activity.js";
import { STAR_ENTRY_SELECTOR, WORKFLOW_NAME_SELECTOR, unfinishedFocusedSession } from "../helpers/focused-recording-controls.js";
import { invokeOrThrow, waitForWindowHandle } from "../helpers/tauri.js";
import { openHomeWindow, t, waitForAppReady } from "../helpers/test-utils.js";

const visible = (label: string) =>
  invokeOrThrow<boolean>("plugin:window|is_visible", { label });

type CaptureSettings = { disableVision: boolean; disableAudio: boolean };
type FixtureSettings = CaptureSettings & { user: { id?: string; token?: string; [key: string]: unknown } | null };
type FocusedSession = { id: string; name: string; phase: string; revision: number; intervals: Array<{ start: number; end: number | null }> };

async function captureSettings(patch: CaptureSettings | null = null): Promise<FixtureSettings> {
  return await browser.executeAsync((path: string, next: CaptureSettings | null, done: (result: { value?: FixtureSettings; error?: string }) => void) => {
    const invoke = (window as any).__TAURI_INTERNALS__.invoke;
    void (async () => {
      const rid = await invoke("plugin:store|get_store", { path });
      if (rid == null) throw new Error("isolated E2E store is not loaded");
      const [settings, exists] = await invoke("plugin:store|get", { rid, key: "settings" });
      if (!exists) throw new Error("isolated E2E settings are missing");
      const user = settings.user ?? null;
      if ((user?.token && !String(user.token).startsWith("e2e-fake-token-")) || (user?.id && !String(user.id).startsWith("e2e-"))) {
        throw new Error("refusing to read or replace a non-fixture account");
      }
      const previous = { disableVision: settings.disableVision, disableAudio: settings.disableAudio, user };
      if (next) {
        await invoke("plugin:store|set", { rid, key: "settings", value: { ...settings, ...next } });
        await invoke("plugin:store|save", { rid });
      }
      done({ value: previous });
    })().catch((error) => done({ error: String(error) }));
  }, join(E2E_DATA_DIR, "store.bin"), patch).then((result) => {
    const value = result as { value?: FixtureSettings; error?: string };
    if (!value.value) throw new Error(value.error ?? "capture settings were not saved");
    return value.value;
  });
}

async function waitForFixtureUser(id: string | null): Promise<void> {
  await browser.waitUntil(async () => (await browser.executeAsync((path: string, done: (id: string | null) => void) => {
    const invoke = (window as any).__TAURI_INTERNALS__.invoke;
    void (async () => {
      const rid = await invoke("plugin:store|get_store", { path });
      const [settings] = await invoke("plugin:store|get", { rid, key: "settings" });
      done(settings?.user?.id ?? null);
    })().catch(() => done(null));
  }, join(E2E_DATA_DIR, "store.bin"))) === id, {
    timeout: t(15_000), interval: 100, timeoutMsg: "synthetic account state did not persist",
  });
}

describe("starred session popover", function () {
  this.timeout(t(150_000));
  let previousCapture: FixtureSettings | undefined;
  let previousAccount: { active: string | null; user: string | null } | undefined;
  let restoreToken: string | null = null;
  let stopForeground: (() => void) | undefined;
  let ownedFocusedId: string | undefined;
  let focusedApi: Awaited<ReturnType<typeof getLocalApiConfig>> | undefined;

  afterEach(async () => {
    stopForeground?.();
    try {
      if (ownedFocusedId && focusedApi) {
        await invokeOrThrow("hide_starred_sessions");
        const base = `http://127.0.0.1:${focusedApi.port}`;
        const headers = { ...authHeaders(focusedApi.key), "Content-Type": "application/json" };
        const current = await fetch(`${base}/focused-recordings/current`, { headers });
        expect(current.ok).toBe(true);
        let session = await current.json() as FocusedSession | null;
        // Only this attempt's draft is disposable. A different active draft
        // belongs to another action and must remain untouched.
        if (session?.id === ownedFocusedId && unfinishedFocusedSession(session)) {
          for (const action of session.phase === "summary" ? ["delete"] : ["finish", "delete"]) {
            const response = await fetch(`${base}/focused-recordings/${ownedFocusedId}/action`, {
              method: "POST", headers,
              body: JSON.stringify({ action, confirmed: true, revision: session!.revision, requestId: randomUUID() }),
            });
            expect(response.ok).toBe(true);
            session = await response.json() as FocusedSession;
          }
        }
      }
    } finally {
      try {
        if (previousAccount && previousCapture) {
          // Home was deliberately destroyed in the journey. Its account hook
          // must be mounted again before restoring the shared fixture.
          await openHomeWindow();
          // The account hook consumes its localStorage seed. Restore from the
          // persisted synthetic user, not from that one-shot transport key.
          await browser.execute((user: FixtureSettings["user"]) => {
            localStorage.setItem("screenpipe_e2e_account_user", JSON.stringify(user));
            window.dispatchEvent(new Event("screenpipe-e2e-seed-account-user"));
          }, previousCapture.user);
          await waitForFixtureUser(previousCapture.user?.id ?? null);
          await browser.execute((previous: { active: string | null; user: string | null }) => {
            for (const [key, value] of [
              ["screenpipe_e2e_account_fixture_active", previous.active],
              ["screenpipe_e2e_account_user", previous.user],
            ]) {
              if (value == null) localStorage.removeItem(key!);
              else localStorage.setItem(key!, value);
            }
          }, previousAccount);
        }
      } finally {
        if (previousCapture) {
          await invokeOrThrow("stop_screenpipe");
          await captureSettings(previousCapture);
          try {
            await invokeOrThrow("set_cloud_token", { token: restoreToken });
          } finally {
            await invokeOrThrow("spawn_screenpipe", { overrideArgs: null });
            await waitForLocalApi((await getLocalApiConfig()).port);
          }
        }
      }
    }
    await invokeOrThrow("hide_shortcut_reminder");
  });

  it("records immediately, pauses, and reopens the same workflow without showing Home", async () => {
    if (process.env.GITHUB_ACTIONS !== "true" || basename(E2E_DATA_DIR) !== ".e2e" || !E2E_SEED_FLAGS.split(",").includes("no-recording")) {
      throw new Error("focused capture requires the isolated GitHub Actions E2E desktop; do not enable physical capture locally");
    }
    await waitForAppReady();
    previousCapture = undefined;
    previousAccount = undefined;
    stopForeground = undefined;
    ownedFocusedId = undefined;
    focusedApi = undefined;
    previousCapture = await captureSettings();
    restoreToken = E2E_SEED_FLAGS.split(",").includes("cloud-authenticated")
      // Native persistence can omit the token. Restore the canonical fake
      // seed in that case; never read a credential store to reconstruct it.
      ? "e2e-fake-token-onboarding-background-ai-tools" : null;
    previousAccount = await browser.execute(() => {
      const user = localStorage.getItem("screenpipe_e2e_account_user");
      const token = user ? JSON.parse(user)?.token : null;
      if (token && !String(token).startsWith("e2e-fake-token-")) {
        throw new Error("refusing to replace a non-fixture account");
      }
      return { active: localStorage.getItem("screenpipe_e2e_account_fixture_active"), user };
    });
    restoreToken = previousCapture.user?.token ?? restoreToken;
    // Use the existing test-only account seam, with production refresh disabled.
    await browser.execute(() => {
      localStorage.setItem("screenpipe_e2e_account_fixture_active", "1");
      localStorage.setItem(
        "screenpipe_e2e_account_user",
        JSON.stringify({
          id: "e2e-star",
          email: "star@screenpipe.test",
          token: "e2e-fake-token-star",
          subscription_plan: "free",
          __e2eSkipAccountRefresh: true,
        }),
      );
      window.dispatchEvent(new Event("screenpipe-e2e-seed-account-user"));
    });
    await waitForFixtureUser("e2e-star");
    await invokeOrThrow("set_cloud_token", { token: "e2e-fake-token-star" });
    await invokeOrThrow("stop_screenpipe");
    await captureSettings({ disableVision: false, disableAudio: true });
    await invokeOrThrow("spawn_screenpipe", { overrideArgs: null });
    const config = await getLocalApiConfig();
    focusedApi = config;
    stopForeground = spawnTransientForegroundApp();
    await browser.waitUntil(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${config.port}/health`, { headers: authHeaders(config.key) });
        return (await response.json() as { frame_status?: string }).frame_status === "ok";
      } catch {
        return false;
      }
    }, { timeout: t(45_000), interval: 500, timeoutMsg: "isolated screen capture did not produce frames" });
    await browser.waitUntil(
      async () => {
        try {
          return (
            await fetch(
              `http://127.0.0.1:${config.port}/focused-recordings/current`,
              {
                headers: authHeaders(config.key),
              },
            )
          ).ok;
        } catch {
          return false;
        }
      },
      {
        timeout: t(45_000),
        interval: 500,
        timeoutMsg: "focused recording storage did not become ready",
      },
    );
    const readSession = async () => {
      const response = await fetch(`http://127.0.0.1:${config.port}/focused-recordings/current`, {headers:authHeaders(config.key)});
      expect(response.ok).toBe(true);
      return await response.json() as FocusedSession | null;
    };
    const previousFocused = await readSession();
    expect(unfinishedFocusedSession(previousFocused)).toBe(false);
    await invokeOrThrow("show_shortcut_reminder", { shortcut: "Cmd+Ctrl+S" });
    if ((await browser.getWindowHandles()).includes("shortcut-reminder")) {
      await browser.switchToWindow("shortcut-reminder");
      const reminder = await $('[data-testid="shortcut-reminder-root"]');
      await reminder.waitForDisplayed({ timeout: t(15_000) });
      await reminder.moveTo();
      // Match the established tiny-window hover fallback in the native journey.
      await browser.execute(() => {
        document.querySelector<HTMLElement>('[data-testid="shortcut-reminder-root"]')
          ?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      });
      const starEntry = await $(STAR_ENTRY_SELECTOR);
      await starEntry.waitForDisplayed({ timeout: t(15_000) });
      await starEntry.click();
    } else {
      await invokeOrThrow("toggle_starred_sessions");
    }
    await browser.waitUntil(async () => {
      const session = await readSession();
      ownedFocusedId = session?.phase === "recording" && session.id !== previousFocused?.id ? session.id : undefined;
      return Boolean(ownedFocusedId);
    }, { timeout: t(10_000), interval: 100, timeoutMsg: "star did not create its focused recording" });
    await waitForWindowHandle("starred-sessions", t(20_000));
    await browser.switchToWindow("starred-sessions");
    // A native handle exists before the first WebView has mounted its state
    // and visibility listeners. Load the controls before exercising retention.
    try {
      await $("button=Pause").waitForDisplayed({ timeout: t(30_000) });
    } catch (error) {
      const state = await browser.execute(() => ({ path: location.pathname, ready: document.readyState, text: document.body.innerText.slice(0, 1500), hidden: document.querySelector('[role="dialog"]')?.parentElement?.hidden }));
      throw new Error(`Initial focused controls did not render; nativeVisible=${await visible("starred-sessions")}; phase=${(await readSession())?.phase}; document=${JSON.stringify(state)}`, { cause: error });
    }
    await $(WORKFLOW_NAME_SELECTOR).waitForEnabled({ timeout: t(15_000) });
    // Keep the retained picker as the IPC context while closing Home in this
    // isolated fixture. Reopening must not recreate or reveal Home.
    if ((await browser.getWindowHandles()).includes("home")) {
      await invokeOrThrow("plugin:window|destroy", { label: "home" });
    }
    await invokeOrThrow("hide_starred_sessions");
    await invokeOrThrow("toggle_starred_sessions");
    await $("button=Pause").waitForDisplayed({ timeout: t(30_000) });
    expect(await visible("starred-sessions")).toBe(true);
    expect(await browser.getWindowHandles()).not.toContain("home");
    expect(await $("button=Start").isExisting()).toBe(false);
    const started = (await readSession())!;
    expect(started.phase).toBe("recording");
    const workflowName = await $(WORKFLOW_NAME_SELECTOR);
    await workflowName.waitForDisplayed({ timeout: t(15_000) });
    await workflowName.waitForEnabled({ timeout: t(15_000) });
    await workflowName.setValue("Review an invoice");
    await $("button=Pause").click();
    await $("button=Resume").waitForDisplayed({ timeout: t(15_000) });
    const paused = (await readSession())!;
    expect(paused.id).toBe(started.id);
    expect(paused.phase).toBe("paused");
    expect(paused.intervals.at(-1)?.end).not.toBeNull();
    await browser.saveScreenshot("e2e/results/starred-session-popover.png");
    await browser.keys("Escape");
    await browser.waitUntil(async () => !(await visible("starred-sessions")), {
      timeout: t(5000),
    });
    await invokeOrThrow("toggle_starred_sessions");
    await $("button=Resume").waitForDisplayed({ timeout: t(15_000) });
    expect((await readSession())!.id).toBe(started.id);
    const finish = await $("button=Finish");
    await finish.waitForEnabled({ timeout: t(15_000) });
    await finish.click();
    await $("button=Save").waitForDisplayed({ timeout: t(15_000) });
    const summary = (await readSession())!;
    expect(summary.phase).toBe("summary");
    await $("button=Save").click();
    await browser.waitUntil(async () => {
      const saved = await readSession();
      return saved?.id === started.id && saved.phase === "submitted";
    }, {
      timeout: t(15_000), interval: 100, timeoutMsg: "Save did not persist the local submitted receipt",
    });
    const receipt = (await readSession())!;
    expect(receipt.name).toBe("Review an invoice");
    expect(receipt.intervals).toEqual(summary.intervals);
    const params = new URLSearchParams({
      start_time: new Date(summary.intervals[0].start).toISOString(),
      end_time: new Date(summary.intervals.at(-1)!.end! + 1).toISOString(), limit: "20",
    });
    const saved = await fetch(`http://127.0.0.1:${config.port}/starred-sessions?${params}`, { headers: authHeaders(config.key) });
    expect(saved.ok).toBe(true);
    const { data } = await saved.json() as { data: Array<{ name: string; start: string; end: string }> };
    for (const interval of summary.intervals) {
      expect(data.some((item) => item.name === "Review an invoice" && Date.parse(item.start) === interval.start && Date.parse(item.end) === interval.end)).toBe(true);
    }
    ownedFocusedId = undefined;
    await $("button=Close").click();
    await browser.waitUntil(async () => !(await visible("starred-sessions")), {
      timeout: t(5000),
    });
    expect((await readSession())?.id).toBe(started.id);
    expect((await readSession())?.phase).toBe("submitted");
    await invokeOrThrow("hide_shortcut_reminder");
  });
});
