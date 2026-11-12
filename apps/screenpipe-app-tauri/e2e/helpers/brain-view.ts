// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { showWindow } from "./tauri.js";

export async function openBrainSection(): Promise<void> {
  // Library is hidden by default. Native navigation sends the existing Home
  // window a section event, preserving the Canvas test's Pi event listeners.
  await showWindow({ Home: { page: "brain" } });
}

export function assertEvidenceFreshnessTitle(title: string | null): void {
  const text = title?.toLowerCase() ?? "";
  if (!text.includes("data through ") || !text.includes("sources checked ")) {
    throw new Error(`Live View freshness is missing: ${title}`);
  }
}
