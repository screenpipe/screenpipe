// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";
import { useEffect } from "react";
import { localFetch } from "@/lib/api";
import { useWorkflowsRolloutDecision } from "@/lib/workflows/rollout";
import { isPrimaryWindow } from "@/lib/utils/is-primary-window";

// The engine starts closed on every restart. Sync in Chat too, so changing
// workspaces doesn't stop explicitly enabled tasks. No task is enabled here.
export function WorkflowsRolloutSync() {
  const enabled = useWorkflowsRolloutDecision();
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_SCREENPIPE_WEB_DEV === "mock") return;
    // Auxiliary webviews have independent PostHog initialization. They must not
    // revoke the primary window's decision, nor may an unresolved flag do so.
    if (!isPrimaryWindow() || enabled === undefined) return;
    const controller = new AbortController();
    const sync = () => void localFetch("/workflows/rollout", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }), signal: controller.signal,
    }).catch(() => {});
    sync();
    const retry = setInterval(sync, 30_000);
    return () => { clearInterval(retry); controller.abort(); };
  }, [enabled]);
  return null;
}
