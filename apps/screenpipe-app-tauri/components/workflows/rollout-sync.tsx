// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";
import { useEffect } from "react";
import { localFetch } from "@/lib/api";
import { useWorkflowsRolloutEnabled } from "@/lib/workflows/rollout";

// The engine starts closed on every restart. Sync in Chat too, so changing
// workspaces doesn't stop explicitly enabled tasks. No task is enabled here.
export function WorkflowsRolloutSync() {
  const enabled = useWorkflowsRolloutEnabled();
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_SCREENPIPE_WEB_DEV === "mock") return;
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
