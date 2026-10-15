// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";
import { useEffect, useRef, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { teamSharing, type TeamSharingStatus } from "@/lib/workflows/team-sharing";

export function WorkflowTeamSharing({ active, accountId, api = teamSharing }: {
  active: boolean; accountId?: string; api?: typeof teamSharing;
}) {
  const revision = useRef(0);
  const [status, setStatus] = useState<TeamSharingStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    revision.current++;
    setStatus(null); setError(""); setOpen(false); setBusy(false);
    if (active) void api.load().then(value => { if (!cancelled) setStatus(value); }).catch(error => { if (!cancelled) setError(error.message); });
    return () => { cancelled = true; };
  }, [active, accountId, api]);
  async function save(enabled: boolean) {
    const started = revision.current;
    setBusy(true); setError("");
    try {
      await api.set(enabled, status ?? undefined);
      if (started !== revision.current) return;
      if (!enabled) setStatus(current => current ? { ...current, enabled: false } : null);
      else {
        const value = await api.load();
        if (started !== revision.current) return;
        if (!value.enabled) throw new Error("Sharing could not be confirmed. Try again.");
        setStatus(value);
      }
      setOpen(false);
    } catch (error) { if (started === revision.current) setError(error instanceof Error ? error.message : "Could not update team sharing."); }
    finally { if (started === revision.current) setBusy(false); }
  }
  if (!active) return null;
  return <>
    <button type="button" className="whitespace-nowrap rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted" onClick={() => setOpen(true)}>
      Team sharing{status?.enabled ? ": on" : ""}
    </button>
    <Dialog open={open} onOpenChange={value => { if (!busy) setOpen(value); }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Share professional workflows</DialogTitle>
          <DialogDescription>After automatic updates finish, AI checks your workflows and shares professional instructions with your Screenpipe team.</DialogDescription></DialogHeader>
        <label className="flex items-center justify-between gap-4 rounded-lg border p-4 text-sm">
          <span>Automatically share with your team</span>
          <Switch aria-label="Automatically share professional workflows" checked={status?.enabled ?? false} disabled={busy || !status} onCheckedChange={enabled => void save(enabled)} />
        </label>
        <p className="text-xs text-muted-foreground">Personal, mixed and uncertain workflows are not shared with your team. Shared copies contain instructions, without recordings, screenshots or evidence excerpts. AI can misclassify a workflow.</p>
        <p className="text-xs text-muted-foreground">Uses your AI allowance. Turning this off stops new shares. Existing team copies and edits remain in the workspace.</p>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {!status && !error && <p role="status" className="text-xs text-muted-foreground">Checking your team workspace…</p>}
        {error && <Button variant="outline" disabled={busy} onClick={() => void save(false)}>Turn off sharing on this device</Button>}
        <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>{busy ? "Saving…" : "Done"}</Button>
      </DialogContent>
    </Dialog>
  </>;
}
