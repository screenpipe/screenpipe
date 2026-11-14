// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { useEffect, useRef, useState } from "react";
import { useManagedPolicy } from "@/lib/hooks/use-managed-policy";
import { useSettings } from "@/lib/hooks/use-settings";
import { FocusedRecordingPanel } from "./focused-recording-panel";
import { useFocusedRecording } from "./use-focused-recording";

export function FocusedSessionControls({ onDismiss, visible = true }: { onDismiss?: () => void; visible?: boolean }) {
  const managed = useManagedPolicy();
  const { isSettingsLoaded } = useSettings();
  const ready = isSettingsLoaded && managed.isManagedDeploymentResolved && managed.authenticationState !== "checking";
  const canRecord = !ready || (managed.isManagedAuthenticated && managed.policy.recordingAllowed);
  const audioPolicy = managed.policy.lockedSettings.disableAudio;
  const voiceAllowed = ready && canRecord && audioPolicy !== true && audioPolicy !== "true";
  const recorder = useFocusedRecording({ canRecord, voiceAllowed });
  const [deleting, setDeleting] = useState(false);
  const [activity, setActivity] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const close = useRef(onDismiss); close.current = onDismiss;
  const { session } = recorder;
  useEffect(() => setDeleting(false), [session?.id, session?.phase]);
  useEffect(() => { if (session?.phase === "deleted") close.current?.(); }, [session?.phase]);
  useEffect(() => {
    if (session?.phase !== "submitted" || !visible || !onDismiss || recorder.busy || recorder.error) return;
    const timer = setTimeout(() => {
      const focused = document.activeElement;
      if (focused && root.current?.contains(focused) && focused.matches("button,input,select,textarea,a[href]")) {
        setActivity(value => value + 1);
      } else close.current?.();
    }, 15000);
    return () => clearTimeout(timer);
  }, [session?.phase, visible, onDismiss, recorder.busy, recorder.error, activity]);
  if (!session || session.phase === "deleted") return (
    <section className="space-y-2 rounded-lg bg-black p-3 pr-9 text-xs text-white/90">
      <p role={recorder.error ? "alert" : "status"}>{recorder.error || "Loading recording…"}</p>
      {recorder.error && <button className="rounded-md border border-white/30 px-2 py-1.5" disabled={recorder.busy} onClick={() => void recorder.retry()}>Retry</button>}
    </section>
  );
  return (
    <div ref={root} onPointerMove={() => setActivity(value => value + 1)} onPointerDown={() => setActivity(value => value + 1)} onKeyDown={event => {
      setActivity(value => value + 1);
      if (event.key === "Escape" && deleting) { event.preventDefault(); event.stopPropagation(); setDeleting(false); }
    }} onFocusCapture={() => setActivity(value => value + 1)} onBlurCapture={() => setActivity(value => value + 1)}>
      <FocusedRecordingPanel
        phase={deleting ? "delete-confirm" : session.phase}
        name={recorder.name} seconds={recorder.seconds} micHot={recorder.hot}
        voiceAllowed={voiceAllowed} busy={recorder.busy || !ready}
        error={recorder.error || (!canRecord ? "Recording is unavailable under your workspace policy." : undefined)}
        media={session.media ?? { screenFrames: 0, audioSeconds: 0, audioChunks: 0 }}
        onNameChange={recorder.setName} onVoice={() => void recorder.toggleVoice()}
        onPause={() => void recorder.act("pause")} onResume={() => void recorder.act("resume")}
        onFinish={() => void recorder.act("finish")} onSubmit={() => void recorder.act("submit")}
        onDelete={() => deleting ? void recorder.act("delete") : setDeleting(true)}
        onKeep={() => setDeleting(false)} onClose={() => onDismiss?.()} onNew={() => void recorder.newWorkflow()}
      />
      {recorder.error && <button className="mx-3 mb-3 rounded-md border border-white/30 px-2 py-1.5 text-xs text-white/90 disabled:opacity-50" disabled={recorder.busy} onClick={() => void recorder.retry()}>Retry save</button>}
    </div>
  );
}
