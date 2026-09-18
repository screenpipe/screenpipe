// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";
import { useMemo } from "react";
import { listen } from "@tauri-apps/api/event";
import { ConfidentialVerificationBadge, type ConfidentialVerificationSource } from "@screenpipe/workflows-ui";
export function PrivateModelVerification({ sessionId, preset }: { sessionId: string | null; preset?: { model?: string; provider?: string } | null }) {
  const source = useMemo<ConfidentialVerificationSource>(() => ({
    subscribe: listener => listen<{ source: string; sessionId: string; event: Record<string, unknown> }>("agent_event", ({ payload }) => {
      if (sessionId && payload.source === "pi" && payload.sessionId === sessionId) listener(payload);
    }),
  }), [sessionId]);
  if (preset?.provider !== "screenpipe-cloud" || preset.model !== "glm-5.3-flash-reap50-iq3m") return null;
  return <ConfidentialVerificationBadge key={sessionId} source={source} />;
}
