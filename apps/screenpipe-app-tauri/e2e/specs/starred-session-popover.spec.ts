// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { authHeaders, getLocalApiConfig } from "../helpers/api-utils.js";
import { invokeOrThrow, waitForWindowHandle } from "../helpers/tauri.js";
import { t, waitForAppReady } from "../helpers/test-utils.js";

const visible = (label: string) =>
  invokeOrThrow<boolean>("plugin:window|is_visible", { label });

describe("starred session popover", function () {
  this.timeout(t(150_000));

  it("records immediately, pauses, and reopens the same workflow without showing Home", async () => {
    await waitForAppReady();
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
    await browser.pause(t(500));
    await invokeOrThrow("set_cloud_token", { token: "e2e-fake-token-star" });
    await invokeOrThrow("spawn_screenpipe", { overrideArgs: null });
    const config = await getLocalApiConfig();
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
    await invokeOrThrow("show_shortcut_reminder", { shortcut: "Cmd+Ctrl+S" });
    if ((await browser.getWindowHandles()).includes("shortcut-reminder")) {
      await browser.switchToWindow("shortcut-reminder");
      await $('[data-testid="shortcut-reminder-root"]').moveTo();
      await $('[aria-label="Starred work sessions"]').click();
    } else {
      await invokeOrThrow("toggle_starred_sessions");
    }
    await waitForWindowHandle("starred-sessions", t(20_000));
    await browser.switchToWindow("starred-sessions");
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
    const readSession = async () => {
      const response = await fetch(`http://127.0.0.1:${config.port}/focused-recordings/current`, {headers:authHeaders(config.key)});
      expect(response.ok).toBe(true);
      return await response.json() as {id:string;phase:string;intervals:Array<{start:number;end:number|null}>};
    };
    const started = await readSession();
    expect(started.phase).toBe("recording");
    await $('[aria-label="Workflow name"]').setValue("Review an invoice");
    await $("button=Pause").click();
    await $("button=Resume").waitForDisplayed({ timeout: t(15_000) });
    const paused = await readSession();
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
    expect((await readSession()).id).toBe(started.id);
    await $("button=Finish").click();
    await $("button=Save").waitForDisplayed({ timeout: t(15_000) });
    expect((await readSession()).phase).toBe("summary");
    await $('[aria-label="Close session controls"]').click();
    await browser.waitUntil(async () => !(await visible("starred-sessions")), {
      timeout: t(5000),
    });
    await invokeOrThrow("hide_shortcut_reminder");
  });
});
