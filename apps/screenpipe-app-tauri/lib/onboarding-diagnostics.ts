// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import posthog from "posthog-js";
import { writeBrowserLogNow } from "@/lib/logging/browser-log";

// Callers supply only fixed labels, random attempt IDs, counts and allowlisted
// error categories. Never pass backend text, credentials, URLs or task content.
export function captureSetupEvent(event: string, properties: Record<string, unknown>) {
  try {
    writeBrowserLogNow(event.endsWith("failed") ? "warn" : "info", `${event} ${JSON.stringify(properties)}`);
  } catch { /* Diagnostics must never consume the user's setup or retry. */ }
  try {
    posthog.capture(event, properties, { send_instantly: true });
  } catch { /* Native support logs remain available if analytics is unavailable. */ }
}

export function completionFailureProperties(error: unknown) {
  try {
    const detail = JSON.parse(error instanceof Error ? error.message : String(error));
    if (["persist", "arm_summary", "open_home", "close_setup"].includes(detail.stage)
      && ["permission_denied", "disk_full", "invalid_state", "operation_failed"].includes(detail.error_code)
      && typeof detail.attempt_id === "string" && /^[0-9a-f-]{36}$/.test(detail.attempt_id)) {
      return { stage: detail.stage, error_code: detail.error_code, native_attempt_id: detail.attempt_id };
    }
  } catch { /* Native IPC can fail before a structured result exists. */ }
  return { stage: "native_command", error_code: "ipc_error" };
}
