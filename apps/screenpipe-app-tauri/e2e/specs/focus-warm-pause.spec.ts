// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { E2E_DATA_DIR, E2E_SEED_FLAGS, getAppPid } from "../helpers/app-launcher.js";
import { authHeaders, fetchJson, getLocalApiConfig } from "../helpers/api-utils.js";
import { spawnTransientForegroundApp } from "../helpers/seed-capture-activity.js";
import { waitForAppReady } from "../helpers/test-utils.js";

type StreamSample = {
  second: number;
  phase: "warm" | "paused" | "resumed";
  stream_sequence: number | null;
};

function samples(): StreamSample[][] {
  return readdirSync(E2E_DATA_DIR)
    .filter((name) => /^e2e-warm-pause-\d+\.jsonl$/.test(name))
    .map((name) => readFileSync(resolve(E2E_DATA_DIR, name), "utf8")
      .split("\n").slice(0, -1).filter(Boolean).map((line) => JSON.parse(line)))
    .filter((rows) => rows.length > 0);
}

// Run only in a disposable macOS guest with Screen Recording permission:
// SCREENPIPE_E2E_SEED=onboarding,no-audio,focus-warm-pause bun run test:e2e -- --spec e2e/specs/focus-warm-pause.spec.ts
// The seed supplies Warm focus + FullPause inputs. Stream creation, release,
// image capture, and persistence remain the real production implementation.
describe("pause while a display is focus-warm", function () {
  this.timeout(180_000);
  let cleanup: (() => void) | undefined;
  afterEach(() => cleanup?.());

  it("releases the OS stream for the whole pause and records again afterward", async function () {
    if (process.platform !== "darwin" || !E2E_SEED_FLAGS.split(",").includes("focus-warm-pause")) this.skip();
    await waitForAppReady();
    await browser.switchToWindow("home");
    // Authentication is outside this capture regression. Use the existing
    // E2E account event so settings and the native token follow their normal
    // update path, with production account refresh explicitly disabled.
    await browser.execute(() => {
      localStorage.setItem("screenpipe_e2e_account_fixture_active", "1");
      localStorage.setItem("screenpipe_e2e_account_user", JSON.stringify({
        id: "e2e-warm-pause",
        email: "warm-pause@screenpipe.test",
        token: "e2e-fake-token-warm-pause",
        subscription_plan: "free",
        __e2eSkipAccountRefresh: true,
      }));
      window.dispatchEvent(new Event("screenpipe-e2e-seed-account-user"));
    });
    const pid = getAppPid();
    expect(pid).not.toBeNull();
    const cfg = await getLocalApiConfig();
    const health = async () => {
      const response = await fetchJson(`http://127.0.0.1:${cfg.port}/health`, authHeaders(cfg.key));
      expect(response.ok).toBe(true);
      return response.body as { pipeline: { frames_db_written: number; capture_loop_heartbeats: number } };
    };
    await browser.waitUntil(() => samples().some((rows) => rows.at(-1)!.second >= 35), {
      timeout: 90_000, interval: 250,
      timeoutMsg: "real Warm/pause capture receipt never arrived",
    });
    const paused = await health();
    await browser.waitUntil(() => samples().every((rows) => rows.at(-1)!.second >= 55), {
      timeout: 30_000, interval: 250,
    });
    const held = await health();
    expect(held.pipeline.frames_db_written).toBe(paused.pipeline.frames_db_written);
    expect(held.pipeline.capture_loop_heartbeats).toBeGreaterThan(paused.pipeline.capture_loop_heartbeats);
    await browser.waitUntil(() => samples().every((rows) => rows.at(-1)!.second >= 65), {
      timeout: 45_000, interval: 250,
    });
    cleanup = spawnTransientForegroundApp();
    await browser.waitUntil(() => samples().every((rows) => rows.at(-1)!.second >= 85), {
      timeout: 30_000, interval: 250,
    });
    const resumed = await health();
    console.log("Warm/pause capture health", {
      pausedFrames: paused.pipeline.frames_db_written,
      heldFrames: held.pipeline.frames_db_written,
      resumedFrames: resumed.pipeline.frames_db_written,
      pausedHeartbeats: paused.pipeline.capture_loop_heartbeats,
      heldHeartbeats: held.pipeline.capture_loop_heartbeats,
      resumedHeartbeats: resumed.pipeline.capture_loop_heartbeats,
    });
    for (const rows of samples()) {
      expect(rows.filter((row) => row.second >= 5 && row.second < 20)
        .some((row) => row.stream_sequence !== null)).toBe(true);
      // Allow native stop completion, then span several five-second Warm
      // probes: merely releasing once must not let a later probe reopen it.
      const held = rows.filter((row) => row.second >= 30 && row.second < 60);
      expect(held.length).toBe(30);
      expect(held.filter((row) => row.stream_sequence !== null)).toEqual([]);
      const resumed = rows.filter((row) => row.second >= 65 && row.stream_sequence !== null);
      expect(resumed.length).toBeGreaterThan(10);
      expect(resumed.at(-1)!.stream_sequence).toBeGreaterThan(resumed[0].stream_sequence!);
    }
    expect(resumed.pipeline.frames_db_written).toBeGreaterThan(paused.pipeline.frames_db_written);
    expect(resumed.pipeline.capture_loop_heartbeats).toBeGreaterThan(paused.pipeline.capture_loop_heartbeats);
    expect(getAppPid()).toBe(pid);
    const log = readFileSync(resolve(E2E_DATA_DIR, "app.log"), "utf8");
    expect(log).toContain("power_paused=true, drm=false, schedule=false); releasing capture stream before focus probes");
    expect(log).toContain("exiting pause state, capture resumes");
  });
});
