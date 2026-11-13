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
  it("changes 2→24→4 live without restarting the app", async function () {
    this.timeout(90_000);
    const pidFile = resolve(process.env.SCREENPIPE_E2E_DATA_DIR!, "app.pid");
    const processId = () => Number.parseInt(readFileSync(pidFile, "utf8"), 10);
    const pid = processId();
    await waitForHealth();
    const observations = [];

    for (const fps of [2, 24, 4]) {
      const before = await health();
      await invokeOrThrow("set_screenshot_frame_rate", { fps });
      await browser.pause(5_000);
      const after = await health();
      observations.push({ fps, before: summarize(before), after: summarize(after) });
      expect(processId()).toBe(pid);
    }

    console.log(`SCREENSHOT_RATE_OBSERVATIONS=${JSON.stringify({ pid, observations })}`);
  });
});
