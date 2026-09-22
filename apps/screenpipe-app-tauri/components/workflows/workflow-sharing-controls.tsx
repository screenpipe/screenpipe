// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useSettings } from "@/lib/hooks/use-settings";
import { useManagedPolicy } from "@/lib/hooks/use-managed-policy";
import { commands } from "@/lib/utils/tauri";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { SHARING_NOTICE_VERSION, sharingRequest, trajectoryCollector, type SharingStatus } from "@/lib/trajectories/collector";

export function WorkflowSharingControls({ compact = false }: { compact?: boolean }) {
  const { settings, updateSettings } = useSettings();
  const { isManagedDeployment } = useManagedPolicy();
  const [status, setStatus] = useState<SharingStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [reload, setReload] = useState(0);
  const current = useRef(settings);
  current.current = settings;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let cancelled = false;
    setStatus(null);
    void sharingRequest("GET").then(value => {
      if (!cancelled) setStatus(value);
    }).catch(() => { if (!cancelled && !compact) setError(current => current || "Sharing is unavailable. Sign in or try again."); });
    return () => { cancelled = true; };
  }, [settings.user?.id, settings.workflowSharing?.epoch, reload, compact]);
  const local = settings.workflowSharing;
  const enabled = !!local && status?.sharing === true && status.accountId === local.accountId && status.epoch === local.epoch;
  const available = !!status?.available && !isManagedDeployment && status.noticeVersion === SHARING_NOTICE_VERSION;

  async function change(sharing: boolean, training: boolean, remove = false) {
    if (busy || (sharing && !available)) return;
    setBusy(true); setError("");
    const before = current.current;
    let stoppedLocally = false;
    try {
      const token = await commands.getCloudToken();
      if (!sharing) {
        trajectoryCollector.stop();
        // Persist refusal before making a fallible network request.
        await updateSettings({ workflowSharing: null,
          ...(before.workflowSharing ? { piiBackend: before.workflowSharing.priorBackend } : {}) });
        stoppedLocally = true;
      }
      if (!token) throw new Error("Sign in to update account sharing.");
      const result = await sharingRequest(remove ? "DELETE" : "PUT", remove ? undefined : {
        sharing, training, noticeVersion: SHARING_NOTICE_VERSION, revision: status?.revision ?? 0,
      }, token);
      if (!mounted.current || await commands.getCloudToken() !== token || current.current.user?.id !== before.user?.id) return;
      if (sharing) {
        if (!result.epoch || !result.sharing || result.accountId !== status?.accountId) throw new Error("Sharing could not be enabled.");
        await updateSettings({ piiBackend: "tinfoil", workflowSharing: {
          accountId: result.accountId, epoch: result.epoch, enabledAt: Date.now(),
          priorBackend: before.workflowSharing?.priorBackend ?? (before.piiBackend === "tinfoil" ? "tinfoil" : "local"),
        } });
      }
      setStatus(result); setConfirmDelete(false);
    } catch {
      if (mounted.current) setError(sharing ? "Could not enable sharing. Try again." : !stoppedLocally ? "Could not save your choice. Sharing may still be on; try again." :
        "Stopped on this device. Account changes are unconfirmed; retry to stop other devices or delete shared chats.");
    } finally { if (mounted.current) setBusy(false); }
  }
  if (compact && !available && !local) return null;
  return <section id="workflow-sharing" style={compact ? {
    "--foreground": "0 0% 9%", "--background": "0 0% 100%",
    "--muted-foreground": "80 4% 45%", "--border": "70 10% 85%",
  } as CSSProperties : undefined} className="space-y-3 rounded-lg border p-4 text-foreground">
    <div className="flex items-center justify-between gap-4">
      <div><label htmlFor={compact ? "workflow-sharing-entry" : "workflow-sharing-setting"} className="text-sm font-medium">Help improve Workflows</label>
        <p className="text-xs text-muted-foreground">Share new Workflows chats to improve skills and evaluations.</p></div>
      <Switch id={compact ? "workflow-sharing-entry" : "workflow-sharing-setting"} checked={enabled} disabled={busy || (!available && !local)} onCheckedChange={value => void change(value, false)} />
    </div>
    <p className="text-xs text-muted-foreground">Only chats inside Workflows. No raw recordings, main Chat conversations, or other apps’ chat history.</p>
    <p className="text-xs text-muted-foreground">AI redacts sensitive information in Tinfoil’s secure cloud before sharing. Redaction can miss details.</p>
    {(enabled || !compact) && <label className="flex items-start gap-2 text-xs">
      <input type="checkbox" className="mt-0.5" checked={enabled && status?.training === true} disabled={busy || !enabled} onChange={event => void change(true, event.target.checked)} />
      <span>Also allow eligible shared chats to train models. Optional.</span>
    </label>}
    {enabled && !compact && <a href="#workflow-cloud-redaction" className="block text-xs underline">Cloud redaction is on. View settings</a>}
    <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Sharing details</summary>
      <p className="mt-2">Replies may quote your private context. Screenpipe keeps shared text for up to 30 days, plus the next hourly cleanup. Cloud redaction is required while sharing is on. Recording settings remain separate. You can stop sharing and delete shared copies in Privacy settings. Model training requires separate permission and an eligibility review; no training export is enabled in this version.</p>
      <a href="https://screenpipe.com/privacy" target="_blank" rel="noreferrer" className="mt-2 inline-block underline">Privacy policy</a>
    </details>
    {!compact && <div className="flex flex-wrap gap-2">
      {!!local && <Button size="sm" variant="outline" disabled={busy} onClick={() => void change(false, false)}>Turn off sharing</Button>}
      <Button size="sm" variant="outline" disabled={busy || !settings.user?.id} onClick={() => confirmDelete ? void change(false, false, true) : setConfirmDelete(true)}>{confirmDelete ? "Confirm deletion and stop sharing" : "Delete shared chats"}</Button>
      {confirmDelete && <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmDelete(false)}>Cancel</Button>}
      {!available && <span className="text-xs text-muted-foreground">Sharing is not available for this account.</span>}
      {confirmDelete && <p className="w-full text-xs text-muted-foreground">Deletes shared copies for this account and stops sharing on all devices. Your local chats stay on this device.</p>}
    </div>}
    {error && <p role="alert" className="text-xs text-destructive">{error} <button className="underline" onClick={() => { setError(""); setReload(value => value + 1); }}>Refresh</button></p>}
  </section>;
}
