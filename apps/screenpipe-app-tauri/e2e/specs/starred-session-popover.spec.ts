// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { authHeaders, getLocalApiConfig } from "../helpers/api-utils.js";
import { invokeOrThrow, waitForWindowHandle } from "../helpers/tauri.js";
import { t, waitForAppReady } from "../helpers/test-utils.js";

const visible = (label: string) =>
  invokeOrThrow<boolean>("plugin:window|is_visible", { label });

describe("starred session popover", function () {
  this.timeout(t(150_000));

  it("saves in floating controls, dismisses and reopens without showing Home", async () => {
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
              `http://127.0.0.1:${config.port}/starred-sessions?limit=100`,
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
        timeoutMsg: "starred session storage did not become ready",
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
    // The visibility event remounts controls. Do not retain a WebDriver
    // element across that remount while waiting for the backend.
    await browser.waitUntil(async () => browser.execute(() =>
      Array.from(document.querySelectorAll("button")).some(button =>
        button.textContent?.trim() === "15 min" && !button.disabled)),
      { timeout: t(30_000) });
    expect(await visible("starred-sessions")).toBe(true);
    expect(await browser.getWindowHandles()).not.toContain("home");
    await browser.pause(t(250)); // Let WebKit finish compositing the snapshot.
    await browser.saveScreenshot("e2e/results/starred-session-popover.png");
    await $("button=15 min").click();
    await $("button=End session").waitForDisplayed({ timeout: t(15_000) });
    const closeBounds = await $(
      '[aria-label="Close session controls"]',
    ).getLocation();
    expect(closeBounds.y).toBeGreaterThanOrEqual(0);
    const response = await fetch(
      `http://127.0.0.1:${config.port}/starred-sessions?limit=100`,
      { headers: authHeaders(config.key) },
    );
    expect(response.ok).toBe(true);
    const payload = (await response.json()) as {
      data: Array<{ start: string; end: string }>;
    };
    expect(payload.data).toHaveLength(1);
    expect(
      Date.parse(payload.data[0].end) - Date.parse(payload.data[0].start),
    ).toBe(15 * 60_000);
    await browser.keys("Escape");
    await browser.waitUntil(async () => !(await visible("starred-sessions")), {
      timeout: t(5000),
    });
    await invokeOrThrow("toggle_starred_sessions");
    await $("button=End session").waitForDisplayed({ timeout: t(15_000) });
    await $('[aria-label="Close session controls"]').click();
    await browser.waitUntil(async () => !(await visible("starred-sessions")), {
      timeout: t(5000),
    });
    await invokeOrThrow("hide_shortcut_reminder");
  });
});
