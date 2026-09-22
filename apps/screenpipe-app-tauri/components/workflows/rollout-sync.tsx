// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";
import { useEffect } from "react";
import { useFeatureFlagEnabled } from "posthog-js/react";
import { syncWorkflowsRollout, WORKFLOWS_FLAG } from "@/lib/workflows/rollout";

// Unresolved flags are not revocations. Any mounted window with a resolved
// flag can restore the engine grant after a restart, including when home is closed.
export function WorkflowsRolloutSync() {
  const enabled = useFeatureFlagEnabled(WORKFLOWS_FLAG);
  useEffect(() => {
    if (typeof enabled !== "boolean" || process.env.NEXT_PUBLIC_SCREENPIPE_WEB_DEV === "mock") return;
    const controller = new AbortController();
    const sync = () => void syncWorkflowsRollout(enabled, controller.signal).catch(() => {});
    sync();
    const retry = setInterval(sync, 30_000);
    return () => { clearInterval(retry); controller.abort(); };
  }, [enabled]);
  return null;
}
