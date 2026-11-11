// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { useEffect, useRef } from "react";
import { Star } from "lucide-react";

export interface FocusedRecordingPanelProps {
  phase: "recording" | "paused" | "summary" | "delete-confirm" | "submitted";
  name: string;
  /** Active capture time, frozen by the session owner outside recording. */
  seconds: number;
  micHot: boolean;
  voiceAllowed: boolean;
  busy: boolean;
  error?: string;
  media: { screenFrames: number; audioSeconds: number; audioChunks?: number };
  onNameChange: (name: string) => void;
  onVoice: () => void;
  onPause: () => void;
  onResume: () => void;
  onFinish: () => void;
  onDelete: () => void;
  onKeep: () => void;
  onSubmit: () => void;
  onClose: () => void;
  onNew: () => void;
}
const time = (seconds: number) => {
  const value = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${Math.floor(value / 60).toString().padStart(2, "0")}:${(value % 60).toString().padStart(2, "0")}`;
};
const action = "rounded-md border border-white/30 px-2 py-1.5 hover:bg-white/10 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 disabled:opacity-50";

/** Shared recording action patterns, rendered in the existing desktop star chrome. */
export function FocusedRecordingPanel(p: FocusedRecordingPanelProps) {
  const stage = useRef<HTMLElement>(null);
  const submitted = p.phase === "submitted";
  const capturing = p.phase === "recording" || p.phase === "paused";
  const hot = p.phase === "recording" && p.micHot;
  useEffect(() => {
    if (["summary", "delete-confirm", "submitted"].includes(p.phase)) stage.current?.focus();
  }, [p.phase]);
  return (
    <section ref={stage} tabIndex={-1} aria-label="Focused recording" className="space-y-3 rounded-lg bg-black p-3 text-xs text-white/90">
      <div className="flex items-center gap-1.5 pr-6 font-medium">
        <Star className="h-3.5 w-3.5 shrink-0 fill-current" aria-hidden="true" />
        <span>{p.phase === "recording" ? "Recording workflow" : p.phase === "paused" ? "Recording paused" : p.phase === "delete-confirm" ? "Delete recording?" : submitted ? "Workflow submitted" : "Recording summary"}</span>
        <span className="ml-auto font-normal tabular-nums text-white/60" aria-label="Captured duration">{time(p.seconds)}</span>
      </div>
      <label className="block space-y-1 text-white/60">
        <span>Workflow name</span>
        <input
          value={p.name}
          readOnly={submitted || p.phase === "delete-confirm"}
          disabled={p.busy}
          maxLength={200}
          placeholder="Name this workflow"
          onChange={(e) => p.onNameChange(e.target.value)}
          className="block w-full min-w-0 rounded-md border border-white/30 bg-black px-2 py-1.5 text-white/90 placeholder:text-white/50 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2"
        />
      </label>
      {capturing && (
        <div className="space-y-2">
          <button className={`${action} w-full`} onClick={p.onVoice} aria-pressed={hot} disabled={p.busy || !p.voiceAllowed || p.phase === "paused"}>{hot ? "Voice on" : "Voice off"}</button>
          <div className="grid grid-cols-2 gap-2">
            <button className={action} onClick={p.phase === "paused" ? p.onResume : p.onPause} disabled={p.busy && p.phase === "paused"}>{p.phase === "paused" ? "Resume" : "Pause"}</button>
            <button className={`${action} border-white/70 bg-white text-black hover:bg-white/90`} onClick={p.onFinish} disabled={p.busy && p.phase === "paused"}>Finish</button>
          </div>
        </div>
      )}
      {p.phase === "summary" && (
        <>
          <dl className="space-y-1 text-white/60">
            <div className="flex justify-between gap-2"><dt>Screen</dt><dd>{p.media.screenFrames > 0 ? `${p.media.screenFrames} captured frames` : "No screen captured"}</dd></div>
            <div className="flex justify-between gap-2"><dt>Audio</dt><dd>{(p.media.audioSeconds > 0 || (p.media.audioChunks ?? 0) > 0) ? time(p.media.audioSeconds) : "No audio captured"}</dd></div>
          </dl>
          {!p.name.trim() && <p className="text-white/60">Enter a workflow name to submit.</p>}
          <div className="flex justify-between gap-2">
            <button className="rounded px-1 py-1.5 text-white/60 hover:text-white focus-visible:outline disabled:opacity-50" disabled={p.busy} onClick={p.onDelete}>Delete</button>
            <div className="flex gap-1">
              <button className={action} disabled={p.busy} onClick={p.onResume}>Resume</button>
              <button className={`${action} border-white/70 bg-white text-black hover:bg-white/90`} disabled={p.busy || !p.name.trim()} onClick={p.onSubmit}>{p.busy ? "Submitting…" : "Submit"}</button>
            </div>
          </div>
        </>
      )}
      {p.phase === "delete-confirm" && (
        <>
          <p className="text-white/60">Delete this focused recording? This cannot be undone.</p>
          <div className="flex justify-between gap-2">
            <button className={action} disabled={p.busy} onClick={p.onDelete}>Delete</button>
            <button className={action} disabled={p.busy} onClick={p.onKeep}>Keep recording</button>
          </div>
        </>
      )}
      {submitted && (
        <>
          <p role="status" className="text-white/60">Workflow submitted</p>
          <div className="flex justify-between gap-2">
            <button className="rounded px-1 py-1.5 text-white/60 hover:text-white focus-visible:outline" onClick={p.onClose}>Close</button>
            <button className={action} onClick={p.onNew}>New workflow</button>
          </div>
        </>
      )}
      {p.error && <p role="alert">{p.error}</p>}
    </section>
  );
}
