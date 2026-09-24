// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";
import { PROD_WEB_BASE, screenpipeWebUrl } from "@/lib/web-url";
import { useEffect, useRef, useState } from "react";
import { useSettings } from "@/lib/hooks/use-settings";
import { useManagedPolicy } from "@/lib/hooks/use-managed-policy";
import { commands } from "@/lib/utils/tauri";
import { Button } from "@/components/ui/button";
import { Loader2, MessageSquare, ShieldCheck } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { SHARING_NOTICE_VERSION, sharingRequest, trajectoryCollector, type SharingStatus } from "@/lib/trajectories/collector";

export function WorkflowSharingControls({ compact = false, onDone, onUnavailable, onBusyChange }: {
  compact?: boolean;
  onDone?: () => void;
  onUnavailable?: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { settings, updateSettings } = useSettings();
  const { isManagedDeployment } = useManagedPolicy();
  const [status, setStatus] = useState<SharingStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  const current = useRef(settings);
  current.current = settings;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let cancelled = false;
    setStatus(null);
    void sharingRequest("GET").then(value => {
      if (!cancelled) setStatus(value);
    }).catch(() => { if (!cancelled) setError(current => current || "Sharing is unavailable. Sign in or try again."); });
    return () => { cancelled = true; };
  }, [settings.user?.id, settings.workflowSharing?.epoch, reload, compact]);
  const local = settings.workflowSharing;
  const enabled = !!local && status?.acceptedNoticeVersion === SHARING_NOTICE_VERSION && status.training && status?.sharing === true && status.accountId === local.accountId && status.epoch === local.epoch;
  const available = !!status?.available && !isManagedDeployment && status.noticeVersion === SHARING_NOTICE_VERSION;

  useEffect(() => {
    if (compact && status && !available && !local) onUnavailable?.();
  }, [compact, status, available, local, onUnavailable]);

  async function change(sharing: boolean, remove = false) {
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
        sharing, training: sharing, noticeVersion: SHARING_NOTICE_VERSION, revision: status?.revision ?? 0,
      }, token);
      if (!mounted.current || await commands.getCloudToken() !== token || current.current.user?.id !== before.user?.id) return;
      if (sharing) {
        const account = before.user?.id;
        if (!account) throw new Error("Sign in to update sharing.");
        if (!result.epoch || !result.sharing || !result.training || result.acceptedNoticeVersion !== SHARING_NOTICE_VERSION || result.accountId !== status?.accountId) throw new Error("Sharing could not be enabled.");
        await updateSettings({ piiBackend: "tinfoil", workflowSharingPromptSeen: { ...before.workflowSharingPromptSeen, [account]: SHARING_NOTICE_VERSION }, workflowSharing: {
          accountId: result.accountId, epoch: result.epoch, enabledAt: Date.now(),
          priorBackend: before.workflowSharing?.priorBackend ?? (before.piiBackend === "tinfoil" ? "tinfoil" : "local"),
        } });
      }
      setStatus(result); setConfirmDelete(false);
      if (compact && sharing) onDone?.();
    } catch {
      if (mounted.current) setError(sharing ? "Could not enable sharing. Try again." : !stoppedLocally ? "Could not save your choice. Sharing may still be on; try again." :
        "Stopped on this device. Account changes are unconfirmed; retry to stop other devices or delete shared chats.");
    } finally { if (mounted.current) setBusy(false); }
  }
  return <section id="workflow-sharing" className={compact ? "space-y-5 text-foreground" : "space-y-3 rounded-lg border p-4 text-foreground"}>
    {!compact && <div className="flex items-center justify-between gap-4">
      <div><label htmlFor="workflow-sharing-setting" className="text-sm font-medium">Help improve Screenpipe</label>
        <p className="text-xs text-muted-foreground">Share new Workflows chats to improve workflows and train Screenpipe’s own AI models. Never external providers’ models.</p></div>
      <Switch id="workflow-sharing-setting" checked={enabled} disabled={busy || (!available && !local)} onCheckedChange={value => void change(value)} />
    </div>}
    {compact ? <div className="space-y-4">
      <div className="flex gap-3"><MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" /><div>
        <p className="text-sm font-medium">Workflows chats only</p>
        <p className="mt-1 text-xs text-muted-foreground">No recordings, main Chat, or other apps’ chats. Replies may quote private context.</p>
      </div></div>
      <div className="flex gap-3"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" /><div>
        <p className="text-sm font-medium">Redacted before sharing</p>
        <p className="mt-1 text-xs text-muted-foreground">AI removes sensitive details in Tinfoil’s secure cloud. It can miss details.</p>
      </div></div>
    </div> : <>
      <p className="text-xs text-muted-foreground">Only chats inside Workflows. No raw recordings, main Chat conversations, or other apps’ chat history.</p>
      <p className="text-xs text-muted-foreground">AI redacts sensitive information in Tinfoil’s secure cloud before sharing. Redaction can miss details.</p>
    </>}
    {!!local && !enabled && available && <p className="text-xs text-muted-foreground">Sharing is paused on this version until you accept the updated choice, which includes training Screenpipe’s own models.</p>}
    {enabled && !compact && <a href="#workflow-cloud-redaction" className="block text-xs underline">Cloud redaction is on. View settings</a>}
    <details className="text-xs text-muted-foreground"><summary className="cursor-pointer rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground">Sharing details</summary>
      <p className="mt-2">Replies may quote your private context. Screenpipe keeps shared text for up to 30 days, plus the next hourly cleanup. Cloud redaction is required while sharing is on. Recording settings remain separate. You can stop sharing and delete shared copies in Privacy settings. Training permission covers only Screenpipe’s own models. Previously shared chats keep their original permissions.</p>
      <a href={screenpipeWebUrl("/privacy", PROD_WEB_BASE)} target="_blank" rel="noreferrer" className="mt-2 inline-block underline">Privacy policy</a>
    </details>
    {!compact && <div className="flex flex-wrap gap-2">
      {!!local && <Button size="sm" variant="outline" disabled={busy} onClick={() => void change(false)}>Turn off sharing</Button>}
      <Button size="sm" variant="outline" disabled={busy || !settings.user?.id} onClick={() => confirmDelete ? void change(false, true) : setConfirmDelete(true)}>{confirmDelete ? "Confirm deletion and stop sharing" : "Delete shared chats"}</Button>
      {confirmDelete && <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmDelete(false)}>Cancel</Button>}
      {!available && <span className="text-xs text-muted-foreground">Sharing is not available for this account.</span>}
      {confirmDelete && <p className="w-full text-xs text-muted-foreground">Deletes shared copies for this account and stops sharing on all devices. Your local chats stay on this device.</p>}
    </div>}
    {compact && <>
      {!status && !error && <p role="status" className="text-xs text-muted-foreground">Checking sharing availability…</p>}
      <p className="text-xs text-muted-foreground">Stop sharing or delete shared chats in Privacy settings.</p>
      <div className="grid grid-cols-2 gap-3">
        <Button variant="outline" disabled={busy} onClick={onDone}>Not now</Button>
        <Button disabled={busy || !available} onClick={() => void change(true)}>
          {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}{busy ? "Saving…" : "Allow sharing"}
        </Button>
      </div>
    </>}
    {error && <p role="alert" className="text-xs text-destructive">{error} <button className="underline" onClick={() => { setError(""); setReload(value => value + 1); }}>Refresh</button></p>}
  </section>;
}
