// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";

import { useEffect, useRef, useState } from "react";
import { Clock3, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { enableWorkflowTask, loadWorkflowTaskSetup, type WorkflowTaskSetup } from "@/lib/workflows/scheduled-discovery";

const desktopTasks = { load: loadWorkflowTaskSetup, enable: enableWorkflowTask };

export function WorkflowTasksPrompt({ active, tasks = desktopTasks }: {
  active: boolean;
  tasks?: { load: () => Promise<WorkflowTaskSetup>; enable: () => Promise<void> };
}) {
  const [open, setOpen] = useState(false);
  const [setup, setSetup] = useState<WorkflowTaskSetup | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const enabling = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setOpen(false);
    setSetup(null);
    setError("");
    if (active) void tasks.load().then(value => {
      if (cancelled) return;
      setSetup(value);
      setOpen(!value.enabled);
    }).catch(() => {
      if (cancelled) return;
      setError("Could not check scheduled tasks. Try again when Screenpipe is connected.");
      setOpen(true);
    });
    return () => { cancelled = true; };
  }, [active, tasks, retry]);

  async function enable() {
    if (enabling.current || !setup) return;
    enabling.current = true;
    setBusy(true);
    setError("");
    try {
      await tasks.enable();
      setOpen(false);
    } catch {
      setError("Could not enable the task. Please try again.");
    } finally {
      enabling.current = false;
      setBusy(false);
    }
  }

  return <Dialog open={active && open} onOpenChange={value => { if (!enabling.current) setOpen(value); }}>
    <DialogContent className="max-w-md" overlayClassName="bg-black/30" hideCloseButton={busy}>
      <DialogHeader>
        <DialogTitle className="font-sans text-xl normal-case">Keep your workflows up to date?</DialogTitle>
        <DialogDescription>Enable a background task to discover workflows and update them as you work.</DialogDescription>
      </DialogHeader>
      {setup && <div className="flex items-center gap-3 rounded-lg border border-border p-4">
        <Clock3 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0"><p className="text-sm font-medium">{setup.title}</p><p className="text-xs text-muted-foreground">{setup.schedule}</p></div>
      </div>}
      <p className="text-sm text-muted-foreground">Uses your AI settings to review captured activity. With cloud AI, selected text and screenshots are sent to the provider.</p>
      <p className="text-sm text-muted-foreground">Runs in both Chat and Workflows while Screenpipe is open. Turn it off anytime in <span className="font-medium text-foreground">Chat → Scheduled tasks</span>.</p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter className="gap-2 sm:gap-0">
        <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>Not now</Button>
        {setup ? <Button disabled={busy} onClick={enable}>{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} {busy ? "Enabling…" : "Enable task"}</Button>
          : <Button onClick={() => setRetry(value => value + 1)}>Try again</Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
