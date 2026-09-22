// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";

import { WorkflowSharingControls } from "./workflow-sharing-controls";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useSettings } from "@/lib/hooks/use-settings";
import { SHARING_NOTICE_VERSION } from "@/lib/trajectories/collector";
import { Clock3, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { enableWorkflowTask, loadWorkflowTaskSetup, type WorkflowTaskSetup } from "@/lib/workflows/scheduled-discovery";
import { useGT } from "gt-react";


const desktopTasks = { load: loadWorkflowTaskSetup, enable: enableWorkflowTask };

export function WorkflowTasksPrompt({ active, tasks = desktopTasks }: {
  active: boolean;
  tasks?: { load: () => Promise<WorkflowTaskSetup>; enable: () => Promise<void> };
}) {

  const ui = useGT();
  const { settings, updateSettings } = useSettings();
  const current = useRef(settings);
  current.current = settings;
  const [step, setStep] = useState<"tasks" | "sharing">("tasks");
  const title = useRef<HTMLHeadingElement>(null);
  const [open, setOpen] = useState(false);
  const [setup, setSetup] = useState<WorkflowTaskSetup | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const enabling = useRef(false);

  const close = useCallback(() => setOpen(false), []);
  const finishSharing = useCallback(() => {
    const account = current.current.user?.id;
    if (account) void updateSettings({ workflowSharingPromptSeen: { ...current.current.workflowSharingPromptSeen, [account]: SHARING_NOTICE_VERSION } }).catch(() => {});
    setOpen(false);
  }, [updateSettings]);
  function nextStep() {
    const value = current.current;
    if (value.user?.id && !value.workflowSharing && value.workflowSharingPromptSeen?.[value.user.id] !== SHARING_NOTICE_VERSION) {
      setError(""); setStep("sharing");
    } else setOpen(false);
  }
  useEffect(() => { if (open) title.current?.focus(); }, [step, open]);

  useEffect(() => {
    let cancelled = false;
    setOpen(false);
    setSetup(null);
    setStep("tasks");
    setError("");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    async function load() {
      try {
        const value = await tasks.load();
        if (cancelled) return;
        setSetup(value);
        setError("");
        setOpen(!value.enabled);
      } catch {
        if (cancelled) return;
        // Recorder startup is not a consent failure. Retry quietly first.
        if (++attempts < 4) timer = setTimeout(load, 1500 * attempts);
        else setError(ui("Could not check scheduled tasks. Try again when Screenpipe is connected."));
      }
    }
    if (active) void load();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [active, tasks, retry]);

  async function enable() {
    if (enabling.current || !setup) return;
    enabling.current = true;
    setBusy(true);
    setError("");
    try {
      await tasks.enable();
      nextStep();
    } catch {
      setError(ui("Could not enable all tasks. Please try again."));
    } finally {
      enabling.current = false;
      setBusy(false);
    }
  }

  if (active && error && !setup) return <div role="status" className="mx-6 mt-4 flex items-center justify-between gap-3 rounded-lg border p-3 text-sm"><span>{error}</span><Button variant="outline" onClick={() => setRetry(value => value + 1)}>Try again</Button></div>;
  return <Dialog open={active && open} onOpenChange={value => {
    if (enabling.current || busy) return;
    if (!value && step === "sharing") finishSharing(); else setOpen(value);
  }}>
    <DialogContent onOpenAutoFocus={event => { event.preventDefault(); title.current?.focus(); }} style={{
      "--foreground": "0 0% 9%", "--background": "0 0% 100%", "--muted-foreground": "80 4% 42%",
      "--border": "70 10% 85%", "--primary": "0 0% 9%", "--primary-foreground": "0 0% 100%",
      "--accent": "70 10% 95%", "--accent-foreground": "0 0% 9%",
      colorScheme: "light", background: "#fff", color: "#171815", fontFamily: "Inter, -apple-system, BlinkMacSystemFont, sans-serif",
    } as CSSProperties} className="max-w-md [&_button]:normal-case [&_button]:tracking-normal [&_button]:font-[inherit]" overlayClassName="bg-black/30" hideCloseButton={busy}>
      <DialogHeader className="text-left">
        <DialogTitle ref={title} tabIndex={-1} style={{ fontFamily: "inherit", letterSpacing: 0 }} className="text-xl normal-case outline-none">
          {step === "tasks" ? "Keep your workflows up to date?" : "Help improve Workflows?"}
        </DialogTitle>
        <DialogDescription className="text-muted-foreground">
          {step === "tasks" ? "Discover workflows and keep them accurate with daily updates." : "Share new Workflows chats to improve skills and evaluations."}
        </DialogDescription>
      </DialogHeader>
      {step === "sharing" ? <WorkflowSharingControls compact onDone={finishSharing} onUnavailable={close} onBusyChange={setBusy} /> : <>
        {setup && <div className="flex items-center gap-3 rounded-lg border p-4">
          <Clock3 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0"><p className="text-sm font-medium">{setup.title}</p><p className="text-xs text-muted-foreground">{setup.schedule} · While Screenpipe is open</p></div>
        </div>}
        <p className="text-xs text-muted-foreground">Uses your AI allowance. Selected screen text and screenshots go to Screenpipe’s AI provider. Recording exclusions apply; personal content may be included.</p>
        <details className="text-xs text-muted-foreground"><summary className="cursor-pointer rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground">How daily updates work</summary>
          <p className="mt-2">Four agents discover workflows, investigate evidence, review drafts, and maintain accuracy. Dependent tasks resume in both Chat and Workflows.</p>
          <p className="mt-2">Turn updates off in <span className="font-medium text-foreground">Chat → Scheduled tasks</span>.</p>
        </details>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" disabled={busy} onClick={nextStep}>Not now</Button>
          <Button disabled={busy || !setup} onClick={enable}>{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />} {busy ? ui("Enabling…") : ui("Enable daily updates")}</Button>
        </DialogFooter>
      </>}
    </DialogContent>
  </Dialog>;
}
