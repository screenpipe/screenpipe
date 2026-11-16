// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { invokeOrThrow } from "../helpers/tauri.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface Health {
  frame_status?: string;
  pipeline?: {
    capture_attempts?: number;
    frames_captured?: number;
    frames_db_written?: number;
  };
}

function summarize(value: Health) {
  return {
    frameStatus: value.frame_status,
    captureAttempts: value.pipeline?.capture_attempts,
    framesCaptured: value.pipeline?.frames_captured,
    framesDbWritten: value.pipeline?.frames_db_written,
  };
}

async function health(): Promise<Health> {
  const response = await fetch(`http://127.0.0.1:${process.env.SCREENPIPE_PORT}/health`);
  if (!response.ok) throw new Error(`health returned ${response.status}`);
  return response.json() as Promise<Health>;
}

async function waitForHealth(): Promise<Health> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      return await health();
    } catch (error) {
      lastError = error;
      await browser.pause(500);
    }
  }
  throw lastError;
}

describe("Windows screenshot acquisition frame rate", () => {
  it("persists the UI rate, changes 2→24→4 live, and pauses retained frames", async function () {
    this.timeout(240_000);
    await browser.setTimeout({ script: 180_000 });
    const pidFile = resolve(process.env.SCREENPIPE_E2E_DATA_DIR!, "app.pid");
    const processId = () => Number.parseInt(readFileSync(pidFile, "utf8"), 10);
    const pid = processId();
    await waitForHealth();
    const observations = [];

    await browser.execute(() => { window.location.href = "/settings?section=recording"; });
    const input = await $('[data-testid="screenshot-frame-rate-input"]');
    await input.waitForDisplayed({ timeout: 20_000 });
    await input.setValue("2");
    await browser.keys("Enter");
    await browser.pause(1_000);
    await browser.refresh();
    const reloaded = await $('[data-testid="screenshot-frame-rate-input"]');
    await reloaded.waitForDisplayed({ timeout: 20_000 });
    expect(await reloaded.getValue()).toBe("2");

    for (const fps of [2, 24, 4]) {
      const before = await health();
      await invokeOrThrow("set_screenshot_frame_rate", { fps });
      await browser.pause(5_000);
      const after = await health();
      observations.push({ fps, before: summarize(before), after: summarize(after) });
      expect(processId()).toBe(pid);
    }

    const beforePause = await health();
    const stopStarted = Date.now();
    await invokeOrThrow("stop_capture");
    const stopMs = Date.now() - stopStarted;
    await browser.pause(5_000);
    const paused = await health();
    expect(paused.pipeline?.frames_db_written).toBe(beforePause.pipeline?.frames_db_written);
    expect(await invokeOrThrow<boolean>("is_capture_paused")).toBe(true);

    await invokeOrThrow("start_capture");
    expect(await invokeOrThrow<boolean>("is_capture_paused")).toBe(false);
    await browser.waitUntil(async () => {
      const resumed = await health();
      return (resumed.pipeline?.frames_db_written ?? 0) > (paused.pipeline?.frames_db_written ?? 0);
    }, { timeout: 30_000, interval: 1_000, timeoutMsg: "retained frame count did not resume" });
    const resumed = await health();

    console.log(`SCREENSHOT_RATE_OBSERVATIONS=${JSON.stringify({ pid, observations, stopMs, beforePause: summarize(beforePause), paused: summarize(paused), resumed: summarize(resumed), persistedRate: await reloaded.getValue() })}`);
  });
});
