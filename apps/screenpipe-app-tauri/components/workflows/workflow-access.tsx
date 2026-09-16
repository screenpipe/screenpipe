// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useUsageStatusQuery } from "@/lib/hooks/use-usage-status";
import { workflowAccess } from "@/lib/workflows/access";
import { Button } from "@/components/ui/button";
import { WorkflowTasksPrompt } from "./workflow-tasks-prompt";

export function WorkflowAccess({ active, onAccessChange }: { active: boolean; onAccessChange?: (reason: string | undefined) => void }) {
  const query = useUsageStatusQuery(active);
  const router = useRouter();
  const access = workflowAccess(query.usage);
  const reason = query.isLoading ? "Checking workflow access…" : access.state === "ready" ? undefined : access.message;
  useEffect(() => { onAccessChange?.(reason); }, [onAccessChange, reason]);
  if (!active || query.isLoading) return null;
  if (access.state === "ready") return <WorkflowTasksPrompt active={active} />;
  return <WorkflowAccessNotice access={access} refreshing={query.isRefreshing} onRetry={() => void query.refresh()} onAccount={() => router.push("/settings?section=account")} onUsage={() => router.push("/settings?section=usage")} />;
}

export function WorkflowAccessNotice({ access, refreshing = false, onRetry, onAccount, onUsage }: {
  access: ReturnType<typeof workflowAccess>; refreshing?: boolean; onRetry: () => void; onAccount: () => void; onUsage: () => void;
}) {
  if (access.state === "ready") return null;
  const reset = "resetAt" in access && access.resetAt ? new Date(access.resetAt) : null;
  return <div role="status" style={{ fontFamily: "inherit", letterSpacing: 0, background: "var(--panel, #fff)", color: "var(--ink, #171815)", borderColor: "var(--line, #dedfd8)" }} className="mx-6 mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-background p-4 text-sm">
    <div><p>{access.message}</p>{reset && Number.isFinite(reset.getTime()) && <p className="mt-1 text-xs" style={{ color: "var(--muted, #73766d)" }}>Allowance resets {reset.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}.</p>}</div>
    <div className="flex gap-2">
      {access.state === "unavailable" ? <Button className="normal-case font-sans" style={{ fontFamily: "inherit", letterSpacing: 0, background: "var(--panel, #fff)", color: "var(--ink, #171815)", borderColor: "var(--line, #dedfd8)" }} variant="outline" size="sm" disabled={refreshing} onClick={onRetry}>Try again</Button>
        : <Button className="normal-case font-sans" style={{ fontFamily: "inherit", letterSpacing: 0, background: "var(--panel, #fff)", color: "var(--ink, #171815)", borderColor: "var(--line, #dedfd8)" }} variant="outline" size="sm" onClick={onAccount}>{access.state === "upgrade" ? "View Business" : "Increase capacity"}</Button>}
      <Button className="normal-case font-sans" style={{ fontFamily: "inherit", letterSpacing: 0, background: "var(--panel, #fff)", color: "var(--ink, #171815)", borderColor: "var(--line, #dedfd8)" }} variant="ghost" size="sm" onClick={onUsage}>Manage usage</Button>
    </div>
  </div>;
}
