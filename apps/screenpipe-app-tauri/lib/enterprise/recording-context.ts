// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

const VISION_REASONS = new Set(["ok", "disabled_by_setting", "no_displays_expected", "screenshots_disabled_by_config", "screenshots_disabled_by_power_profile", "permission_denied", "capture_stalled", "not_started", "ocr_unavailable"]);
const AUDIO_REASONS = new Set(["recording", "disabled", "screen_locked", "meeting_detector_unavailable", "waiting_for_meeting", "mic_paused", "no_input_device", "audio_not_started", "audio_stalled", "transcript_paused", "transcript_pending", "waiting_for_voice"]);

/** Coarse recorder context only. Never forward event content or window/app names. */
export function enterpriseRecordingContext(health: Record<string, unknown>, now = Date.now()) {
  const context: Record<string, unknown> = {};
  for (const key of ["schedule_paused", "drm_content_paused"] as const) {
    if (typeof health[key] === "boolean") context[key] = health[key];
  }
  if (typeof health.vision_reason === "string" && VISION_REASONS.has(health.vision_reason)) {
    context.vision_reason = health.vision_reason;
  }
  const capture = health.capture_status as { status?: unknown } | undefined;
  if (typeof capture?.status === "string" && AUDIO_REASONS.has(capture.status)) {
    context.audio_reason = capture.status;
  }
  const recorder = health.ui_recorder as { configured?: boolean; running?: boolean; input_tap_running?: boolean; last_event_at?: string } | undefined;
  const lastEvent = typeof recorder?.last_event_at === "string" ? Date.parse(recorder.last_event_at) : NaN;
  // Disabled/reduced telemetry and clock anomalies cannot establish inactivity.
  context.activity = recorder?.configured === true && recorder.running === true && recorder.input_tap_running === true
    && Number.isFinite(lastEvent) && lastEvent <= now
    ? now - lastEvent > 5 * 60_000 ? "idle" : "active"
    : "unknown";
  return context;
}
