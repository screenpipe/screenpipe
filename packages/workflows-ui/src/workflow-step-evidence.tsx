// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Maximize2, Minimize2, Play, X } from "lucide-react";
import type { WorkflowMap, WorkflowStage, WorkflowScreenshot } from "./model";
import type { WorkflowsPlatform } from "./platform";
import { WorkflowReplay } from "./workflow-replay";
import { verifiedStageScreenshots } from "./screenshots";
import { useSourceScreenshot } from "./use-source-screenshot";
import styles from "./workflow-step-evidence.module.css";

const when = (value: string) => Number.isFinite(Date.parse(value))
  ? new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Date unavailable";

export function WorkflowStepEvidence({ workflow, stage, platform }: {
  workflow: WorkflowMap; stage: WorkflowStage; platform: WorkflowsPlatform;
}) {
  const [reduced, setReduced] = useState<Set<number>>(() => new Set());
  const [previewHeight, setPreviewHeight] = useState(0);
  const [selected, setSelected] = useState<WorkflowScreenshot | null>(null);
  const [playing, setPlaying] = useState(false);
  const playerRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (playing) playerRef.current?.scrollIntoView?.({ block: "start" }); }, [playing]);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState(false);
  const replay = useMemo(() => ({ ...workflow, stages: [selected ? {
    ...stage, evidence: stage.evidence.filter(e => e.app.toLowerCase() === selected.app.toLowerCase()
      && Date.parse(e.timestamp) === Date.parse(selected.timestamp)),
  } : stage] }), [workflow, stage, selected]);
  const attached = verifiedStageScreenshots(stage);
  const preview = useSourceScreenshot(stage, attached.length > 0, platform.loadWorkflowScreenshot);
  const screenshots = attached.length ? attached : preview.image ? [preview.image] : [];
  const screenshot = screenshots[0];
  const canReplay = platform.loadWorkflowRecording && stage.evidence.some(e => !["audio", "meeting"].includes(e.source ?? "") && Number.isFinite(Date.parse(e.timestamp)));
  const openRecording = async (capture = screenshot) => {
    if (!platform.openCapturedMoment) { setSelected(capture ?? null); setPlaying(true); return; }
    setOpening(true); setOpenError(false);
    let media: Awaited<ReturnType<NonNullable<WorkflowsPlatform["loadWorkflowRecording"]>>> = null;
    try {
      if (capture) await platform.openCapturedMoment(capture.frameId, capture.timestamp);
      else {
        const entry = stage.evidence.find(e => !["audio", "meeting"].includes(e.source ?? "") && Number.isFinite(Date.parse(e.timestamp)));
        if (!entry || !platform.loadWorkflowRecording) throw new Error("Missing capture");
        media = await platform.loadWorkflowRecording(entry.timestamp, entry.app);
        if (!media) throw new Error("Capture unavailable");
        await platform.openCapturedMoment(media.frameId, media.timestamp);
      }
    } catch { setOpenError(true); }
    finally {
      setOpening(false);
      if (media?.url.startsWith("blob:")) URL.revokeObjectURL(media.url);
      else if (media?.url && platform.releaseWorkflowRecording) void platform.releaseWorkflowRecording(media.url).catch(() => {});
    }
  };
  return <section ref={preview.ref} onLoad={() => setPreviewHeight(preview.ref.current?.getBoundingClientRect().height ?? 0)} style={!attached.length && !screenshots.length && previewHeight ? { minHeight: previewHeight } : undefined} className={`${styles.evidence} ph-no-capture ph-mask`} aria-label={`References for ${stage.name}`}>
    {!playing && !screenshots.length && <div className={styles.previewStatus} role="status">
      {preview.status === "loading" ? "Loading source screenshot…" : preview.status === "error" ? "Could not load the source screenshot." : "No screenshot available for this step."}
      {preview.canRetry && preview.status !== "loading" && <button type="button" onClick={preview.retry}>Retry screenshot</button>}
    </div>}
    {!playing && screenshots.map((capture, index) => {
      const expanded = !reduced.has(capture.frameId);
      const suffix = screenshots.length > 1 ? ` ${index + 1}` : "";
      return <EvidenceFigure key={`${capture.frameId}:${capture.timestamp}`} capture={capture} stage={stage} platform={platform} suffix={suffix} expanded={expanded} opening={opening}
        toggle={() => setReduced(previous => { const next = new Set(previous); if (expanded) next.add(capture.frameId); else next.delete(capture.frameId); return next; })}
        replay={canReplay || !!platform.openCapturedMoment ? () => void openRecording(capture) : undefined}
        resolved={capture === preview.image} />;
    })}
    {playing && <div ref={playerRef} className={styles.player}>
      <button type="button" className={styles.close} aria-label={`Close recording for ${stage.name}`} title="Close recording" onClick={() => setPlaying(false)}><X size={15} /></button>
      <WorkflowReplay workflow={replay} loadRecording={platform.loadWorkflowRecording} releaseRecording={platform.releaseWorkflowRecording} openCapturedMoment={platform.openCapturedMoment} />
    </div>}
    <div className={styles.links}>
      {!screenshots.length && (canReplay || (screenshot && platform.openCapturedMoment)) && !playing && <button className={styles.recording} title="Open recording" type="button" disabled={opening} onClick={() => void openRecording()} aria-label={`${platform.openCapturedMoment ? "Open" : "View"} recording for ${stage.name}`}>{opening ? <Loader2 size={15} aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}</button>}
      {openError && <span role="alert">Could not open this capture. Try again.</span>}
    </div>
  </section>;
}

function EvidenceFigure({ capture, stage, platform, suffix, expanded, opening, toggle, replay, resolved }: {
  capture: WorkflowScreenshot; stage: WorkflowStage; platform: WorkflowsPlatform; suffix: string;
  expanded: boolean; opening: boolean; toggle: () => void; replay?: () => void; resolved: boolean;
}) {
  const load = resolved ? undefined : platform.loadWorkflowScreenshot;
  const preview = useSourceScreenshot(stage, !load, load, capture);
  // Desktop images always resolve through the recorder, including legacy embedded images.
  const url = load ? preview.image?.dataUrl : capture.dataUrl;
  const [failed, setFailed] = useState(false);
  const [ratio, setRatio] = useState("16 / 10");
  useEffect(() => setFailed(false), [url]);
  return <figure ref={preview.ref} className={`${styles.figure} ${expanded ? styles.expanded : ""}`}>
    {url && !failed ? <button className={styles.imageButton} type="button" aria-label={`${expanded ? "Reduce" : "Enlarge"} screenshot${suffix} for ${stage.name}`} aria-expanded={expanded} onClick={toggle}>
      <img src={url} alt={`Captured reference${suffix} for ${stage.name}`} loading="lazy" decoding="async" draggable={false} data-lm-disable="true" onLoad={event => { const image = event.currentTarget; if (image.naturalWidth && image.naturalHeight) setRatio(`${image.naturalWidth} / ${image.naturalHeight}`); }} onError={() => setFailed(true)} />
      <span className={styles.zoom}>{expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</span>
    </button> : <div className={styles.previewStatus} role="status" style={preview.status === "loading" && !failed ? { aspectRatio: ratio } : undefined}>
      {failed || preview.status === "error" ? "Could not load the source screenshot." : preview.status === "loading" ? "Loading source screenshot…" : "This screenshot is no longer available."}
      {(failed || preview.status === "error") && load && <button onClick={() => { setFailed(false); preview.retry(); }}>Retry screenshot</button>}
    </div>}
    <figcaption><span>{!capture.visualVerified ? "Source screenshot · " : ""}{capture.app} · {when(capture.timestamp)}</span>
      {replay && <button className={styles.recording} title="Open recording" type="button" disabled={opening} onClick={replay} aria-label={`${platform.openCapturedMoment ? "Open" : "View"} recording${suffix} for ${stage.name}`}>{opening ? <Loader2 size={15} aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}</button>}
    </figcaption>
  </figure>;
}
