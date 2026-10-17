// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { describe, expect, it } from "vitest";
import { enterpriseRecordingContext } from "./recording-context";
const now = Date.parse("2026-10-14T17:00:00Z");
const recorder = { configured: true, running: true, input_tap_running: true, last_event_at: new Date(now - 600_000).toISOString() };
describe("enterprise recording context", () => {
  it("forwards explicit pauses and machine reasons without content", () => {
    expect(enterpriseRecordingContext({ schedule_paused: true, drm_content_paused: false, vision_reason: "no_displays_expected",
      capture_status: { status: "screen_locked", reason: "private free text" }, ui_recorder: recorder, window_title: "private" }, now))
      .toEqual({ schedule_paused: true, drm_content_paused: false, vision_reason: "no_displays_expected", audio_reason: "screen_locked", activity: "idle" });
  });
  it("distinguishes recent interaction from missing or reduced telemetry", () => {
    expect(enterpriseRecordingContext({ ui_recorder: { ...recorder, last_event_at: new Date(now).toISOString() } }, now).activity).toBe("active");
    for (const patch of [{ configured: false }, { running: false }, { input_tap_running: false }, { last_event_at: null }, { last_event_at: "invalid" }, { last_event_at: new Date(now + 1).toISOString() }]) {
      expect(enterpriseRecordingContext({ ui_recorder: { ...recorder, ...patch } }, now).activity).toBe("unknown");
    }
    expect(enterpriseRecordingContext({}, now).activity).toBe("unknown");
  });
  it("does not interpret string booleans or diagnostic prose", () => {
    expect(enterpriseRecordingContext({ schedule_paused: "true", vision_reason: "private window title", capture_status: { status: "x".repeat(100) } }, now)).toEqual({ activity: "unknown" });
  });
});
