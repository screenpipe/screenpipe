// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";
import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { syncWorkflowsRollout, useWorkflowsRolloutEnabled } from "@/lib/workflows/rollout";

// Only the home window owns the process-wide grant. Other windows may have
// unresolved PostHog state and must not revoke it. Both workspaces live at /home.
export function WorkflowsRolloutSync() {
  const pathname = usePathname();
  const enabled = useWorkflowsRolloutEnabled();
  useEffect(() => {
    if (pathname !== "/home" || process.env.NEXT_PUBLIC_SCREENPIPE_WEB_DEV === "mock") return;
    const controller = new AbortController();
    const sync = () => void syncWorkflowsRollout(enabled, controller.signal).catch(() => {});
    sync();
    const retry = setInterval(sync, 30_000);
    return () => { clearInterval(retry); controller.abort(); };
  }, [enabled, pathname]);
  return null;
}
