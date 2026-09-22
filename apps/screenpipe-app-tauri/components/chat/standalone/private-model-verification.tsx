// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";
import { useMemo } from "react";
import { listen } from "@tauri-apps/api/event";
import { ConfidentialVerificationDetails, useConfidentialVerification, type ConfidentialVerificationSource } from "@screenpipe/workflows-ui";
export function usePrivateModelVerification({ sessionId, preset }: { sessionId: string | null; preset?: { model?: string; provider?: string } | null }) {
  const source = useMemo<ConfidentialVerificationSource>(() => ({
    subscribe: listener => listen<{ source: string; sessionId: string; event: Record<string, unknown> }>("agent_event", ({ payload }) => {
      if (sessionId && payload.source === "pi" && payload.sessionId === sessionId) listener(payload);
    }),
  }), [sessionId]);
  const isPrivate = preset?.provider === "screenpipe-cloud" && preset.model === "glm-5.3-flash-reap50-iq3m";
  // Keep observing while the model popover is unmounted.
  const current = useConfidentialVerification(isPrivate ? source : undefined);
  return isPrivate ? <ConfidentialVerificationDetails current={current} showLabel /> : null;
}
