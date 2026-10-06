// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { localFetch } from "@/lib/api";
import { commands } from "./tauri";

/** Only call from an explicit Start meeting / Resume recording action. */
export async function resumeMeetingCapture(): Promise<void> {
  // Native start is serialized and idempotent when capture is already running.
  // Always await it: capture intent can be true even after a failed startup,
  // and Quit retains the HTTP API while stopping the capture session.
  const result = await commands.startCapture();
  if (result.status === "error") throw new Error(result.error);
}

export async function startMeetingWithCapture(
  body: Record<string, string | number>,
): Promise<Response> {
  await resumeMeetingCapture();
  return localFetch("/meetings/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
