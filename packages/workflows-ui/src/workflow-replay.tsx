// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, ExternalLink } from "lucide-react";
import type { WorkflowMap } from "./model";
import type { WorkflowRecording, WorkflowsPlatform } from "./platform";
import styles from "./workflows-app.module.css";

function recordingErrorMessage(error: unknown) {
  const message = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  if (message.includes("inline preview limit") || message.includes("too large for inline preview")) return "This recording is too large for inline playback. Open the captured moment in Timeline.";
  if (message.includes("outside accessible history")) return "This recording is outside the available history or recording access is unavailable.";
  if (message.includes("no longer available")) return "This recording is no longer available. ";
  return "Recording unavailable. Try again or open this moment in Timeline.";
}

export function CapturedMomentButton({ frameId, timestamp, open, compact = false }: {
  frameId: number; timestamp: string; open?: WorkflowsPlatform["openCapturedMoment"]; compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!open) return null;
  return <span><button type="button" disabled={busy} aria-label={compact ? "Open captured moment" : undefined} title={compact ? "Open in Timeline" : undefined} onClick={() => {
    setBusy(true); setFailed(false);
    void open(frameId, timestamp).catch(() => setFailed(true)).finally(() => setBusy(false));
  }}>{compact ? <ExternalLink size={16} aria-hidden="true" /> : busy ? "Opening…" : "Open captured moment"}</button>
    {failed && <span role="alert"> Could not open Screenpipe. Check that it is installed and try again.</span>}</span>;
}

function RecordingVideo({ media, poster, failed }: { media: WorkflowRecording; poster?: string; failed: (message: string) => void }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (ready) return;
    const timer = setTimeout(() => failed("This video could not decode. Use the captured image or open this moment in Screenpipe."), 12000);
    return () => clearTimeout(timer);
  }, [ready, failed]);
  return <><video controls muted playsInline preload="auto" poster={poster} aria-label="Local recording"
    onLoadedMetadata={(event) => {
      const video = event.currentTarget;
      if (!Number.isFinite(video.duration) || media.offsetSeconds >= video.duration) { failed("The recorded offset is outside this video. Try another captured moment."); return; }
      video.currentTime = media.offsetSeconds;
    }}
    onLoadedData={() => setReady(true)} onSeeked={() => setReady(true)}
    onTimeUpdate={(event) => { if (event.currentTarget.currentTime >= media.offsetSeconds + 12) event.currentTarget.pause(); }}
    onPlay={(event) => { if (event.currentTarget.currentTime >= media.offsetSeconds + 12) event.currentTarget.currentTime = media.offsetSeconds; }}
    onError={() => failed("This video cannot be played here. Try another captured moment.")} src={media.url} />
    {!ready && <p role="status">Preparing video…</p>}</>;
}

export function WorkflowReplay({ workflow, loadRecording, releaseRecording, openCapturedMoment }: {
  workflow: WorkflowMap; loadRecording?: WorkflowsPlatform["loadWorkflowRecording"];
  releaseRecording?: WorkflowsPlatform["releaseWorkflowRecording"];
  openCapturedMoment?: WorkflowsPlatform["openCapturedMoment"];
}) {
  const moments = useMemo(() => workflow.stages.flatMap((stage) =>
    stage.evidence.filter((entry) => !["audio", "meeting"].includes(entry.source ?? "") && Number.isFinite(Date.parse(entry.timestamp)))
      .map((entry) => ({ entry, stage })))
    .sort((a, b) => Date.parse(a.entry.timestamp) - Date.parse(b.entry.timestamp)), [workflow]);
  const [requestedIndex, setIndex] = useState(0);
  const index = Math.min(requestedIndex, Math.max(0, moments.length - 1));
  const [media, setMedia] = useState<WorkflowRecording | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const videoFailed = useCallback((message: string) => { setError(message); setMedia(null); }, []);
  const moment = moments[index];
  useEffect(() => {
    setIndex(0); setMedia(null); setError("");
  }, [workflow.title]);
  useEffect(() => {
    setMedia(null); setError(""); setLoading(false);
    if (!moment || !loadRecording) return;
    let active = true;
    let objectUrl: string | undefined;
    const release = (url?: string) => {
      if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
      else if (url && releaseRecording) void releaseRecording(url).catch(() => {});
    };
    setLoading(true);
    void loadRecording(moment.entry.timestamp, moment.entry.app).then((result) => {
      objectUrl = result?.url;
      if (!active) { release(objectUrl); return; }
      setMedia(result);
    }).catch((error) => {
      if (active) setError(recordingErrorMessage(error));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; release(objectUrl); };
  }, [moment, loadRecording, releaseRecording, retry]);
  if (!moments.length) return <section className={styles.replay}><p>No recorded moments linked yet</p></section>;
  const screenshot = moment?.stage.screenshot;
  const matchingImage = screenshot?.visualVerified && screenshot.app.toLowerCase() === moment.entry.app.toLowerCase()
    && Date.parse(screenshot.timestamp) === Date.parse(moment.entry.timestamp) ? screenshot : null;
  return <section className={`${styles.replay} ph-no-capture ph-mask`} aria-label="Workflow recording replay">
      <div className={styles.replayMedia}>
        {loading ? <p role="status">Loading local recording…</p> : media?.kind === "video" ? <RecordingVideo
          key={media.url} media={media} poster={matchingImage?.dataUrl} failed={videoFailed} />
          : media?.kind === "image" || matchingImage ? <img src={media?.url ?? matchingImage?.dataUrl} alt={`Captured moment for ${moment.stage.name}`} />
          : <p>{loadRecording ? "No playable recording for this moment." : "Open the desktop app to play this recording."}</p>}
      </div>
      {error && <p role="alert">{error} <button type="button" onClick={() => setRetry((value) => value + 1)}>Retry</button></p>}
      <footer className={styles.replayFooter}>
        <div className={styles.replayCaption}>
          <strong>{matchingImage ? moment.stage.name : "Captured source"}</strong>
          <span>{media?.kind === "image" || (!media && matchingImage) ? "Screenshot · " : ""}{new Date(moment.entry.timestamp).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · {moment.entry.app}</span>
        </div>
        <nav className={styles.replayNavigation} aria-label="Captured moments">
          <button type="button" aria-label="Previous moment" title="Previous moment" disabled={index === 0} onClick={() => setIndex(index - 1)}><ChevronLeft size={18} aria-hidden="true" /></button>
          <span aria-live="polite">{index + 1} / {moments.length}</span>
          <button type="button" aria-label="Next moment" title="Next moment" disabled={index === moments.length - 1} onClick={() => setIndex(index + 1)}><ChevronRight size={18} aria-hidden="true" /></button>
          {(media || matchingImage) && <CapturedMomentButton compact frameId={(media?.frameId ?? matchingImage?.frameId)!} timestamp={media?.timestamp ?? matchingImage!.timestamp} open={openCapturedMoment} />}
        </nav>
      </footer>
  </section>;
}
