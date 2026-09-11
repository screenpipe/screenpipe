// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { WorkflowMap } from "./model";
import type { WorkflowRecording, WorkflowsPlatform } from "./platform";
import styles from "./workflows-app.module.css";

function recordingErrorMessage(error: unknown) {
  const message = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  if (message.includes("inline preview limit") || message.includes("too large for inline preview")) return "This recording is too large for inline playback. Open the captured moment in Timeline.";
  if (message.includes("outside accessible history")) return "This recording is outside the available history or recording access is unavailable.";
  if (message.includes("no longer available")) return "This recording is no longer available. The captured text remains below.";
  return "Recording unavailable. The captured text remains below. Try again or open the captured moment in Timeline.";
}

export function CapturedMomentButton({ frameId, timestamp, open }: {
  frameId: number; timestamp: string; open?: WorkflowsPlatform["openCapturedMoment"];
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!open) return null;
  return <span><button type="button" disabled={busy} onClick={() => {
    setBusy(true); setFailed(false);
    void open(frameId, timestamp).catch(() => setFailed(true)).finally(() => setBusy(false));
  }}>{busy ? "Opening…" : "Open captured moment"}</button>
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
      if (!Number.isFinite(video.duration) || media.offsetSeconds >= video.duration) { failed("The recorded offset is outside this video. Use the captured text below."); return; }
      video.currentTime = media.offsetSeconds;
    }}
    onLoadedData={() => setReady(true)} onSeeked={() => setReady(true)}
    onTimeUpdate={(event) => { if (event.currentTarget.currentTime >= media.offsetSeconds + 12) event.currentTarget.pause(); }}
    onPlay={(event) => { if (event.currentTarget.currentTime >= media.offsetSeconds + 12) event.currentTarget.currentTime = media.offsetSeconds; }}
    onError={() => failed("This video cannot be played here. Use the image or captured text below.")} src={media.url} />
    {!ready && <p role="status">Preparing video…</p>}</>;
}

export function WorkflowReplay({ workflow, loadRecording, releaseRecording, openCapturedMoment }: {
  workflow: WorkflowMap; loadRecording?: WorkflowsPlatform["loadWorkflowRecording"];
  releaseRecording?: WorkflowsPlatform["releaseWorkflowRecording"];
  openCapturedMoment?: WorkflowsPlatform["openCapturedMoment"];
}) {
  const moments = useMemo(() => workflow.stages.flatMap((stage, stageIndex) =>
    stage.evidence.filter((entry) => !["audio", "meeting"].includes(entry.source ?? "") && Number.isFinite(Date.parse(entry.timestamp)))
      .map((entry) => ({ entry, stage, stageIndex })))
    .sort((a, b) => Date.parse(a.entry.timestamp) - Date.parse(b.entry.timestamp)), [workflow]);
  const [requestedIndex, setIndex] = useState(0);
  const index = Math.min(requestedIndex, Math.max(0, moments.length - 1));
  const [opened, setOpened] = useState(false);
  const [media, setMedia] = useState<WorkflowRecording | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const videoFailed = useCallback((message: string) => { setError(message); setMedia(null); }, []);
  const moment = moments[index];
  useEffect(() => {
    setIndex(0); setOpened(false); setMedia(null); setError("");
  }, [workflow.title]);
  useEffect(() => {
    setMedia(null); setError(""); setLoading(false);
    if (!opened || !moment || !loadRecording) return;
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
  }, [opened, moment, loadRecording, releaseRecording, retry]);
  if (!moments.length) return <section className={styles.replay}><strong>No recorded moments linked yet</strong><p>These proposed steps need direct screen evidence. No replay has been generated.</p></section>;
  const screenshot = moment?.stage.screenshot;
  const matchingImage = screenshot && screenshot.app.toLowerCase() === moment.entry.app.toLowerCase()
    && Math.abs(Date.parse(screenshot.timestamp) - Date.parse(moment.entry.timestamp)) <= 120_000 ? screenshot : null;
  return <section className={`${styles.replay} ph-no-capture ph-mask`} aria-label="Workflow recording replay">
    <header><div><strong>Watch the captured moments</strong><p>Separate observations, not a verified end-to-end run. Nothing is uploaded.</p></div>
      <button type="button" onClick={() => setOpened(!opened)}>{opened ? "Hide replay" : "Open replay"}</button></header>
    {opened && <>
      <div className={styles.replayMedia}>
        {loading ? <p role="status">Loading local recording…</p> : media?.kind === "video" ? <RecordingVideo
          key={media.url} media={media} poster={matchingImage?.dataUrl} failed={videoFailed} />
          : media?.kind === "image" || matchingImage ? <img src={media?.url ?? matchingImage?.dataUrl} alt={`Captured moment for ${moment.stage.name}`} />
          : <p>{loadRecording ? "No playable recording for this moment. Captured text is still available." : "Recording playback is available in the desktop app. Captured text is shown below."}</p>}
      </div>
      {error && <p role="alert">{error} <button type="button" onClick={() => setRetry((value) => value + 1)}>Retry</button></p>}
      <div className={styles.replayNavigation}>
        <button type="button" disabled={index === 0} onClick={() => setIndex(index - 1)}>Previous moment</button>
        <span>{index + 1} / {moments.length}</span>
        <button type="button" disabled={index === moments.length - 1} onClick={() => setIndex(index + 1)}>Next moment</button>
      </div>
      <label className={styles.replaySelect}>Captured moment <select value={index} onChange={(event) => setIndex(Number(event.target.value))}>
        {moments.map(({ entry, stage }, i) => <option key={`${entry.timestamp}-${i}`} value={i}>{new Date(entry.timestamp).toLocaleString()} · {stage.name}</option>)}
      </select></label>
      <strong>Proposed step {moment.stageIndex + 1}: {moment.stage.name}</strong>
      <p>{moment.stage.description}</p>
      <small>{new Date(moment.entry.timestamp).toLocaleString()} · {moment.entry.app} · {moment.entry.source ?? "captured text"}</small>
      {(media || matchingImage) && <p><small>{media?.kind === "video" ? "Video near this observation; pauses after 12 seconds. It may include other activity." : "Still image, not a video."} Matched {media?.matchDistanceSeconds ?? matchingImage?.matchDistanceSeconds}s from the text observation.</small> <CapturedMomentButton frameId={(media?.frameId ?? matchingImage?.frameId)!} timestamp={media?.timestamp ?? matchingImage!.timestamp} open={openCapturedMoment} /></p>}
      <details><summary>Original captured text</summary><blockquote>{moment.entry.detail}</blockquote></details>
    </>}
  </section>;
}
