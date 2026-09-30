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
  return <section ref={preview.ref} className={`${styles.evidence} ph-no-capture ph-mask`} aria-label={`References for ${stage.name}`}>
    {!playing && !screenshots.length && <div className={styles.previewStatus} role="status">
      {preview.status === "loading" ? "Loading source screenshot…" : preview.status === "error" ? "Could not load the source screenshot." : "No screenshot available for this step."}
      {preview.canRetry && preview.status !== "loading" && <button type="button" onClick={preview.retry}>Retry screenshot</button>}
    </div>}
    {!playing && screenshots.map((capture, index) => {
      const expanded = !reduced.has(capture.frameId);
      const suffix = screenshots.length > 1 ? ` ${index + 1}` : "";
      return <figure key={capture.frameId} className={`${styles.figure} ${expanded ? styles.expanded : ""}`}>
        <button className={styles.imageButton} type="button" aria-label={`${expanded ? "Reduce" : "Enlarge"} screenshot${suffix} for ${stage.name}`} aria-expanded={expanded} onClick={() => setReduced(previous => {
          const next = new Set(previous); if (expanded) next.add(capture.frameId); else next.delete(capture.frameId); return next;
        })}>
          <img src={capture.dataUrl} alt={`Captured reference${suffix} for ${stage.name}`} loading="lazy" draggable={false} data-lm-disable="true" />
          <span className={styles.zoom}>{expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</span>
        </button>
        <figcaption><span>{!capture.visualVerified ? "Source screenshot · " : ""}{capture.app} · {when(capture.timestamp)}</span>
          {(canReplay || platform.openCapturedMoment) && <button className={styles.recording} title="Open recording" type="button" disabled={opening} onClick={() => void openRecording(capture)} aria-label={`${platform.openCapturedMoment ? "Open" : "View"} recording${suffix} for ${stage.name}`}>{opening ? <Loader2 size={15} aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}</button>}
        </figcaption>
      </figure>;
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
