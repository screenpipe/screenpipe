// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, ArrowUp, ArrowDown, Trash2, Play, X, Maximize2 } from "lucide-react";
import type { WorkflowMap, WorkflowStage, WorkflowScreenshot } from "./model";
import type { WorkflowsPlatform } from "./platform";
import { WorkflowReplay } from "./workflow-replay";
import { verifiedStageScreenshots } from "./screenshots";
import { useSourceScreenshot } from "./use-source-screenshot";
import styles from "./workflow-step-evidence.module.css";

const when = (value: string) => Number.isFinite(Date.parse(value))
  ? new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Date unavailable";

export function WorkflowStepEvidence({ workflow, stage, platform, onImageLayoutChange }: {
  workflow: WorkflowMap; stage: WorkflowStage; platform: WorkflowsPlatform;
  onImageLayoutChange?: (layout: NonNullable<WorkflowStage["imageLayout"]>) => void;
}) {
  const [selectedImage, setSelectedImage] = useState<number | null>(null);
  const [previewHeight, setPreviewHeight] = useState(0);
  const [selected, setSelected] = useState<WorkflowScreenshot | null>(null);
  const [playing, setPlaying] = useState(false);
  const playerRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (playing) playerRef.current?.scrollIntoView?.({ block: "start" }); }, [playing]);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState(false);
  const replay = useMemo(() => ({ ...workflow, stages: [selected ? {
    ...stage, evidence: [{ timestamp: selected.timestamp, app: selected.app, detail: "", source: "screen" }],
  } : stage] }), [workflow, stage, selected]);
  useEffect(() => { setPlaying(false); setSelected(null); setOpenError(false); }, [workflow.id, workflow.title, stage.id, stage.name]);
  const attached = verifiedStageScreenshots(stage);
  const preview = useSourceScreenshot(stage, attached.length > 0, platform.loadWorkflowScreenshot);
  const available = attached.length ? attached : preview.image ? [preview.image] : [];
  const layout = stage.imageLayout ?? { order: [], hidden: [], beforeText: false };
  const ordered = [...available].sort((a, b) => {
    const rank = (id: number) => { const index = layout.order.indexOf(id); return index < 0 ? layout.order.length : index; };
    return rank(a.frameId) - rank(b.frameId);
  });
  const screenshots = ordered.filter(image => !layout.hidden.includes(image.frameId));
  const removeImage = (id: number) => {
    onImageLayoutChange?.({ ...layout, hidden: [...new Set([...layout.hidden, id])] });
    setSelectedImage(null);
  };
  const moveImage = (index: number, direction: -1 | 1) => {
    const next = index + direction;
    if (next < 0 || next >= screenshots.length) {
      onImageLayoutChange?.({ ...layout, beforeText: direction === -1 });
    } else {
      const order = screenshots.map(image => image.frameId);
      [order[index], order[next]] = [order[next], order[index]];
      onImageLayoutChange?.({ ...layout, order });
    }
  };
  const screenshot = screenshots[0];
  const canReplay = platform.loadWorkflowRecording && (screenshots.length > 0 || stage.evidence.some(e => !["audio", "meeting"].includes(e.source ?? "") && Number.isFinite(Date.parse(e.timestamp))));
  const openRecording = async (capture = screenshot) => {
    if (platform.loadWorkflowRecording) { setSelected(capture ?? null); setPlaying(true); return; }
    if (!capture || !platform.openCapturedMoment) return;
    setOpening(true); setOpenError(false);
    try {
      await platform.openCapturedMoment(capture.frameId, capture.timestamp);
    } catch { setOpenError(true); }
    finally { setOpening(false); }
  };
  return <section ref={preview.ref} onKeyDown={event => {
    if (event.key === "Escape") { setSelectedImage(null); event.stopPropagation(); }
  }} onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) setSelectedImage(null); }} onLoad={() => setPreviewHeight(preview.ref.current?.getBoundingClientRect().height ?? 0)} style={!attached.length && !screenshots.length && previewHeight ? { minHeight: previewHeight } : undefined} className={`${styles.evidence} ph-no-capture ph-mask`} aria-label={`References for ${stage.name}`}>
    {!playing && !available.length && <div className={styles.previewStatus} role="status">
      {preview.status === "loading" ? "Loading source screenshot…" : preview.status === "error" ? "Could not load the source screenshot." : "No screenshot available for this step."}
      {preview.canRetry && preview.status !== "loading" && <button type="button" onClick={preview.retry}>Retry screenshot</button>}
    </div>}
    {!playing && screenshots.map((capture, index) => {
      const suffix = screenshots.length > 1 ? ` ${index + 1}` : "";
      return <EvidenceFigure key={`${capture.frameId}:${capture.timestamp}`} capture={capture} stage={stage} platform={platform} suffix={suffix} selected={selectedImage === capture.frameId} opening={opening}
        select={() => setSelectedImage(capture.frameId)}
        actions={onImageLayoutChange ? { remove: () => removeImage(capture.frameId), up: () => moveImage(index, -1), down: () => moveImage(index, 1),
          upDisabled: index === 0 && layout.beforeText, downDisabled: index === screenshots.length - 1 && !layout.beforeText } : undefined}
        replay={canReplay || !!platform.openCapturedMoment ? () => void openRecording(capture) : undefined}
        resolved={capture === preview.image} />;
    })}
    {!playing && onImageLayoutChange && layout.hidden.length > 0 && <button type="button" className={styles.restore} onClick={() => onImageLayoutChange({ ...layout, hidden: [] })}>Restore deleted images</button>}
    {playing && <div ref={playerRef} className={styles.player}>
      <button type="button" className={styles.close} aria-label={`Close recording for ${stage.name}`} title="Close recording" onClick={() => setPlaying(false)}><X size={15} /></button>
      <WorkflowReplay workflow={replay} loadRecording={platform.loadWorkflowRecording} releaseRecording={platform.releaseWorkflowRecording} openCapturedMoment={platform.openCapturedMoment} />
    </div>}
    <div className={styles.links}>
      {!screenshots.length && canReplay && !playing && <button className={styles.recording} title="View recording" type="button" disabled={opening} onClick={() => void openRecording()} aria-label={`View recording for ${stage.name}`}>{opening ? <Loader2 size={15} aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}</button>}
      {openError && <span role="alert">Could not open this capture. Try again.</span>}
    </div>
  </section>;
}

function EvidenceFigure({ capture, stage, platform, suffix, selected, opening, select, actions, replay, resolved }: {
  capture: WorkflowScreenshot; stage: WorkflowStage; platform: WorkflowsPlatform; suffix: string;
  selected: boolean; opening: boolean; select: () => void; replay?: () => void; resolved: boolean;
  actions?: { remove: () => void; up: () => void; down: () => void; upDisabled: boolean; downDisabled: boolean };
}) {
  const load = resolved ? undefined : platform.loadWorkflowScreenshot;
  const preview = useSourceScreenshot(stage, !load, load, capture);
  // Desktop images always resolve through the recorder, including legacy embedded images.
  const url = load ? preview.image?.dataUrl : capture.dataUrl;
  const [failed, setFailed] = useState(false);
  const [ratio, setRatio] = useState("16 / 10");
  const viewer = useRef<HTMLDialogElement>(null);
  useEffect(() => setFailed(false), [url]);
  return <figure ref={preview.ref} className={`${styles.figure} ${selected ? styles.selected : ""}`}>
    {url && !failed ? <div className={styles.imageSurface}><button className={styles.imageButton} type="button" aria-label={`Select screenshot${suffix} for ${stage.name}`} aria-pressed={selected} onClick={select}
      onKeyDown={event => { if (selected && actions && ["Delete", "Backspace"].includes(event.key)) { event.preventDefault(); event.stopPropagation(); actions.remove(); } }}>
      <img src={url} alt={`Captured reference${suffix} for ${stage.name}`} loading="lazy" decoding="async" draggable={false} data-lm-disable="true" onLoad={event => { const image = event.currentTarget; if (image.naturalWidth && image.naturalHeight) setRatio(`${image.naturalWidth} / ${image.naturalHeight}`); }} onError={() => setFailed(true)} />
    </button>
      <button type="button" className={styles.enlarge} aria-label={`Enlarge screenshot${suffix} for ${stage.name}`} title="Enlarge screenshot" onClick={() => viewer.current?.showModal()}><Maximize2 size={16} /></button>
      <dialog ref={viewer} className={styles.viewer} aria-label={`Enlarged screenshot${suffix} for ${stage.name}`}
        onKeyDown={event => event.stopPropagation()}
        onClick={event => { if (event.target === event.currentTarget) event.currentTarget.close(); }}>
        <div className={styles.viewerToolbar}><button type="button" autoFocus aria-label="Close screenshot" onClick={() => viewer.current?.close()}><X size={18} /></button></div>
        <img src={url} alt={`Captured reference${suffix} for ${stage.name}`} draggable={false} />
      </dialog>
    </div> : <div className={styles.previewStatus} role="status" style={preview.status === "loading" && !failed ? { aspectRatio: ratio } : undefined}>
      {failed || preview.status === "error" ? "Could not load the source screenshot." : preview.status === "loading" ? "Loading source screenshot…" : "This screenshot is no longer available."}
      {(failed || preview.status === "error") && load && <button onClick={() => { setFailed(false); preview.retry(); }}>Retry screenshot</button>}
    </div>}
    {selected && actions && <div className={styles.imageActions} role="toolbar" aria-label="Selected image">
      <button type="button" onClick={actions.up} disabled={actions.upDisabled} aria-label="Move image up"><ArrowUp size={15} />Move up</button>
      <button type="button" onClick={actions.down} disabled={actions.downDisabled} aria-label="Move image down"><ArrowDown size={15} />Move down</button>
      <button type="button" onClick={actions.remove} aria-label="Delete image"><Trash2 size={15} />Delete</button>
    </div>}
    <figcaption><span>{!capture.visualVerified ? "Source screenshot · " : ""}{capture.app} · {when(capture.timestamp)}</span>
      {replay && <button className={styles.recording} title={platform.loadWorkflowRecording ? "View recording" : "Open in Timeline"} type="button" disabled={opening} onClick={replay} aria-label={`${platform.loadWorkflowRecording ? "View" : "Open"} recording${suffix} for ${stage.name}`}>{opening ? <Loader2 size={15} aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}</button>}
    </figcaption>
  </figure>;
}
