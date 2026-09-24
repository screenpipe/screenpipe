// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";
import { workflowModelPreference } from "@/lib/workflows/model-choice";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useUsageStatusQuery } from "@/lib/hooks/use-usage-status";
import { workflowAccess } from "@/lib/workflows/access";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { WorkflowTasksPrompt } from "./workflow-tasks-prompt";
import { useHealthCheck } from "@/lib/hooks/use-health-check";
import { useGT } from "gt-react";
import { useUiLocale } from "@/lib/i18n/provider";


export function WorkflowAccess({ active, requested = false, onRequestChange, onAccessChange }: { active: boolean; requested?: boolean; onRequestChange?: (open: boolean) => void; onAccessChange?: (reason: string | undefined) => void }) {

  const query = useUsageStatusQuery(active);
  const { health, isServerDown } = useHealthCheck();
  const backendReady = !!health && !isServerDown;
  const router = useRouter();
  const [mode, setMode] = useState<"intelligent" | "private">("intelligent");
  useEffect(() => {
    const refresh = () => { void workflowModelPreference.load().then(setMode).catch(() => setMode("intelligent")); };
    refresh(); window.addEventListener("workflows:model-changed", refresh);
    window.addEventListener("focus", refresh);
    return () => { window.removeEventListener("workflows:model-changed", refresh); window.removeEventListener("focus", refresh); };
  }, []);
  const access = workflowAccess(query.usage, mode);
  const reason = query.isLoading ? "Checking workflow access…" : access.state === "ready" ? undefined : access.message;
  useEffect(() => { onAccessChange?.(reason); }, [onAccessChange, reason]);
  useEffect(() => { if (requested && access.state === "ready") onRequestChange?.(false); }, [requested, access.state, onRequestChange]);
  if (!active) return null;
  return <><WorkflowTasksPrompt active={active} backendReady={backendReady} canEnable={!query.isLoading && access.state === "ready"} onEnableUnavailable={() => onRequestChange?.(true)} />
    <WorkflowAccessNotice open={requested} onOpenChange={onRequestChange} access={access} refreshing={query.isRefreshing} onRetry={() => void query.refresh()} onAccount={() => router.push("/settings?section=account")} onUsage={() => router.push("/settings?section=usage")} /></>;
}

export function WorkflowAccessNotice({ access, open = false, onOpenChange, refreshing = false, onRetry, onAccount, onUsage }: {
  open?: boolean; onOpenChange?: (open: boolean) => void;
  access: ReturnType<typeof workflowAccess>; refreshing?: boolean; onRetry: () => void; onAccount: () => void; onUsage: () => void;
}) {
  const uiLocale = useUiLocale();
  const ui = useGT();
  if (access.state === "ready") return null;
  const reset = "resetAt" in access && access.resetAt ? new Date(access.resetAt) : null;
  const title = access.state === "upgrade" ? "Update workflows with Business" : access.state === "paused" ? "Workflow updates are paused" : "Couldn’t check workflow access";
  const description = access.state === "upgrade" ? "Automatic workflow discovery requires Business." : access.message;
  const buttonStyle = { fontFamily: "inherit", letterSpacing: 0, background: "#fff", color: "#171815", borderColor: "#dedfd8" };
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-sm" overlayClassName="bg-black/30" style={{ background: "#fff", color: "#171815", fontFamily: "Inter, -apple-system, BlinkMacSystemFont, sans-serif" }}>
      <DialogHeader>
        <DialogTitle style={{ fontFamily: "inherit", letterSpacing: 0 }} className="text-lg normal-case">{title}</DialogTitle>
        <DialogDescription style={{ color: "#73766d" }}>{description}</DialogDescription>
      </DialogHeader>
      {reset && Number.isFinite(reset.getTime()) && <p className="text-xs" style={{ color: "#73766d" }}>Allowance resets {reset.toLocaleString(uiLocale, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}.</p>}
      <DialogFooter>
        {access.state === "unavailable" ? <Button className="normal-case" style={buttonStyle} variant="outline" size="sm" disabled={refreshing} onClick={onRetry}>Try again</Button>
          : <Button className="normal-case" style={buttonStyle} variant="outline" size="sm" onClick={() => { onOpenChange?.(false); onAccount(); }}>{access.state === "upgrade" ? ui("View Business") : ui("Increase capacity")}</Button>}
        {access.state === "paused" && <Button className="normal-case" style={buttonStyle} variant="ghost" size="sm" onClick={() => { onOpenChange?.(false); onUsage(); }}>Manage usage</Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
