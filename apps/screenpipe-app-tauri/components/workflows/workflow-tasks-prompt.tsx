// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";

import { WorkflowSharingControls } from "./workflow-sharing-controls";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useSettings } from "@/lib/hooks/use-settings";
import { SHARING_NOTICE_VERSION } from "@/lib/trajectories/collector";
import { Clock3, Loader2, RefreshCw } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import styles from "./workflow-tasks-prompt.module.css";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { disableWorkflowTasks, enableWorkflowTask, loadWorkflowTaskSetup, type WorkflowTaskSetup } from "@/lib/workflows/scheduled-discovery";
import { useGT } from "gt-react";


const desktopTasks = { load: loadWorkflowTaskSetup, enable: enableWorkflowTask, disable: disableWorkflowTasks };

export function WorkflowTasksPrompt({ active, tasks = desktopTasks, backendReady = true, canEnable = true, onEnableUnavailable }: {
  active: boolean;
  backendReady?: boolean;
  canEnable?: boolean;
  onEnableUnavailable?: () => void;
  tasks?: { load: () => Promise<WorkflowTaskSetup>; enable: () => Promise<void>; disable: () => Promise<void> };
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
  const revision = useRef(0);
  const [failedTarget, setFailedTarget] = useState<boolean | null>(null);
  const failedIntent = useRef<boolean | null>(null);
  failedIntent.current = failedTarget;

  const close = useCallback(() => setOpen(false), []);
  const finishSharing = useCallback(() => {
    const account = current.current.user?.id;
    if (account) void updateSettings({ workflowSharingPromptSeen: { ...current.current.workflowSharingPromptSeen, [account]: SHARING_NOTICE_VERSION } }).catch(() => {});
    setOpen(false);
  }, [updateSettings]);
  function nextStep() {
    const value = current.current;
    if (value.user?.id && value.workflowSharingPromptSeen?.[value.user.id] !== SHARING_NOTICE_VERSION) {
      setError(""); setStep("sharing");
    } else setOpen(false);
  }
  useEffect(() => { if (open) title.current?.focus(); }, [step, open]);

  // Read again on reconnection, returning from Chat, and external task changes.
  // Slow startup must not leave a permanent error after the recorder recovers.
  useEffect(() => {
    let cancelled = false;
    let loading = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    let offeredSharing = false;
    setOpen(false);
    setSetup(null);
    setStep("tasks");
    setError("");
    async function load() {
      if (loading || enabling.current || cancelled) return;
      if (timer) clearTimeout(timer);
      loading = true;
      const startedRevision = revision.current;
      try {
        const value = await tasks.load();
        if (cancelled || enabling.current || startedRevision !== revision.current) return;
        setSetup(value);
        const target = failedIntent.current;
        if (target === null || (target ? value.enabled : !value.enabled && !value.tasks?.some(task => task.enabled))) {
          setError("");
          setFailedTarget(null);
        }
        attempts = 0;
        const account = current.current.user?.id;
        if (!offeredSharing && value.enabled && account && current.current.workflowSharingPromptSeen?.[account] !== SHARING_NOTICE_VERSION) {
          offeredSharing = true;
          setStep("sharing");
          setOpen(true);
        }
      } catch {
        if (cancelled || enabling.current || startedRevision !== revision.current) return;
        setSetup(null);
        if (++attempts >= 4) setError(ui("Could not check automatic updates. Try again."));
      } finally {
        loading = false;
        if (!cancelled) timer = setTimeout(load, attempts > 0 && attempts < 4 ? 1500 * attempts : 30_000);
      }
    }
    if (active && backendReady) {
      void load();
      window.addEventListener("focus", load);
      window.addEventListener("online", load);
    }
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener("focus", load);
      window.removeEventListener("online", load);
    };
  }, [active, backendReady, tasks, retry]);

  async function save(enabled: boolean) {
    if (enabling.current || (!setup && failedTarget === null)) return;
    if (enabled && !canEnable) { onEnableUnavailable?.(); return; }
    enabling.current = true;
    revision.current++;
    setFailedTarget(null);
    setBusy(true);
    setError("");
    try {
      await (enabled ? tasks.enable() : tasks.disable());
      const confirmed = await tasks.load();
      setSetup(confirmed);
      if (enabled ? !confirmed.enabled : confirmed.tasks?.some(task => task.enabled) || confirmed.enabled) {
        throw new Error("Some task settings did not change.");
      }
      if (enabled) nextStep();
    } catch {
      // A partial write is not success. Re-read the actual group, never make an
      // optimistic all-on/all-off claim or roll a user's off request back on.
      try { setSetup(await tasks.load()); } catch { setSetup(null); }
      setFailedTarget(enabled);
      setError(ui(enabled ? "Could not enable all tasks. Please try again." : "Could not turn off all tasks. Please try again."));
    } finally {
      enabling.current = false;
      setBusy(false);
    }
  }

  const partial = !!setup && !setup.enabled && !!setup.tasks?.some(task => task.enabled);
  return <>
    {active && <div className={styles.control}>
      <label className={styles.label}>
        <span>Automatic updates</span>
        <Switch aria-label={ui("Automatic updates")} checked={setup?.enabled ?? false} disabled={busy || !setup || !backendReady}
          aria-describedby="workflow-schedule-status"
          onCheckedChange={enabled => {
            if (!enabled) { void save(false); return; }
            if (!canEnable) { onEnableUnavailable?.(); return; }
            setError(""); setStep("tasks"); setOpen(true);
          }} />
      </label>
      <span id="workflow-schedule-status" role="status" title={error || undefined} className={styles.status}>
        {busy ? ui("Saving…") : error ? (failedTarget !== null ? ui("Couldn’t save changes") : ui("Couldn’t check status")) : !backendReady ? ui("Connecting…") : !setup ? ui("Checking…") : partial ? ui("Some tasks are off") : ""}
      </span>
      {error && <button className={styles.retry} type="button" aria-label={ui("Retry automatic updates")} title={ui("Try again")}
        disabled={busy || !backendReady} onClick={() => { if (failedTarget !== null) void save(failedTarget); else setRetry(value => value + 1); }}><RefreshCw size={14} /></button>}
    </div>}
    <Dialog open={active && open} onOpenChange={value => {
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
          {step === "tasks" ? "Keep your workflows up to date?" : "Help improve Screenpipe"}
        </DialogTitle>
        <DialogDescription className="text-muted-foreground">
          {step === "tasks" ? "Discover workflows and keep them accurate with automatic updates." : "Share new Workflows chats to improve workflows and train Screenpipe’s own AI models. Never external providers’ models."}
        </DialogDescription>
      </DialogHeader>
      {step === "sharing" ? <WorkflowSharingControls compact onDone={finishSharing} onUnavailable={close} onBusyChange={setBusy} /> : <>
        {setup && <div className="flex items-center gap-3 rounded-lg border p-4">
          <Clock3 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0"><p className="text-sm font-medium">{setup.title}</p><p className="text-xs text-muted-foreground">{setup.schedule} · While Screenpipe is open</p></div>
        </div>}
        <p className="text-xs text-muted-foreground">Uses your AI allowance. Selected screen text and screenshots go to Screenpipe’s AI provider. Recording exclusions apply; personal content may be included.</p>
        <details className="text-xs text-muted-foreground"><summary className="cursor-pointer rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground">How automatic updates work</summary>
          <p className="mt-2">Four agents discover workflows, investigate evidence, review drafts, and maintain accuracy. Dependent tasks resume in both Chat and Workflows.</p>
          <p className="mt-2">Turn updates on or off with <span className="font-medium text-foreground">Automatic updates</span> in Workflows. Turning off pauses future scheduled runs; an update already running can finish.</p>
        </details>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" disabled={busy} onClick={nextStep}>Not now</Button>
          <Button disabled={busy || !setup} onClick={() => void save(true)}>{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />} {busy ? ui("Enabling…") : ui("Enable automatic updates")}</Button>
        </DialogFooter>
      </>}
    </DialogContent>
  </Dialog></>;
}
