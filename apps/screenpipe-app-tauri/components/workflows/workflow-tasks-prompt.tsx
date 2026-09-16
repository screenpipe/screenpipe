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
        else setError("Could not check scheduled tasks. Try again when Screenpipe is connected.");
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
      setOpen(false);
    } catch {
      setError("Could not enable all tasks. Please try again.");
    } finally {
      enabling.current = false;
      setBusy(false);
    }
  }

  if (active && error && !setup) return <div role="status" className="mx-6 mt-4 flex items-center justify-between gap-3 rounded-lg border p-3 text-sm"><span>{error}</span><Button variant="outline" onClick={() => setRetry(value => value + 1)}>Try again</Button></div>;
  return <Dialog open={active && open} onOpenChange={value => { if (!enabling.current) setOpen(value); }}>
    <DialogContent style={{ background: "#fff", color: "#171815", fontFamily: "Inter, -apple-system, BlinkMacSystemFont, sans-serif" }} className="max-w-md" overlayClassName="bg-black/30" hideCloseButton={busy}>
      <DialogHeader>
        <DialogTitle style={{ fontFamily: "inherit", letterSpacing: 0 }} className="font-sans text-xl normal-case">Keep your workflows up to date?</DialogTitle>
        <DialogDescription style={{ color: "#73766d" }}>Enable five background tasks to organize activity, find recurring workflows, enrich steps, measure time, and review results.</DialogDescription>
      </DialogHeader>
      {setup && <div style={{ borderColor: "#dedfd8" }} className="flex items-center gap-3 rounded-lg border border-border p-4">
        <Clock3 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0"><p className="text-sm font-medium">{setup.title}</p><p className="text-xs text-muted-foreground">{setup.schedule}</p></div>
      </div>}
      <p style={{ color: "#73766d" }} className="text-sm text-muted-foreground">Uses your AI allowance and sends selected captured text and screenshots to Screenpipe’s AI provider. Recording exclusions apply; personal content may still be included.</p>
      <p style={{ color: "#73766d" }} className="text-sm text-muted-foreground">Runs daily and resumes dependent work in both Chat and Workflows while Screenpipe is open. Turn it off anytime in <span style={{ color: "#171815" }} className="font-medium text-foreground">Chat → Scheduled tasks</span>.</p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter className="gap-2 sm:gap-0">
        <Button style={{ background: "#fff", borderColor: "#dedfd8", color: "#171815", fontFamily: "inherit", textTransform: "none", letterSpacing: 0 }} variant="outline" disabled={busy} onClick={() => setOpen(false)}>Not now</Button>
        {setup ? <Button style={{ background: "#171815", color: "#fff", fontFamily: "inherit", textTransform: "none", letterSpacing: 0 }} disabled={busy} onClick={enable}>{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} {busy ? "Enabling…" : "Enable tasks"}</Button>
          : <Button onClick={() => setRetry(value => value + 1)}>Try again</Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
