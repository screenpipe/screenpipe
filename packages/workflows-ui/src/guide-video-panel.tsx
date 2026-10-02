// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { DocumentBlockEditor, type DocumentBlock } from "./document-block-editor";
import type { DocumentLayout } from "./document-blocks";
import { createPortal } from "react-dom";
import { ArrowLeft, Download, Film, Loader2 } from "lucide-react";
import { isGuideImage, guideNeedsSourceReview, type WorkflowGuide } from "./guide";
import { GuideSourceReview } from "./guide-source-review";
import { SourceSopScreenshot } from "./source-sop-screenshot";
import { SopScreenshot } from "./sop-screenshot";
import type { WorkflowsPlatform } from "./platform";
import type { WorkflowMap } from "./model";
import { guideVideoScenes, videoScreenshotGaps, type GuideVideoPlatform, type GuideVideoResult } from "./guide-video";
import styles from "./workflow-guide.module.css";

export type GuideVideoHandle = { show: (guide: WorkflowGuide, result: GuideVideoResult) => void; generate: (guide: WorkflowGuide, signal: AbortSignal, progress: (text: string) => void) => Promise<void> };
export const GuideVideoPanel = forwardRef<GuideVideoHandle, {
  guide: WorkflowGuide; workflow: WorkflowMap; platform: GuideVideoPlatform;
  loadSourceScreenshot?: NonNullable<WorkflowsPlatform["guides"]>["loadSourceScreenshot"];
  loadScreenshot?: NonNullable<WorkflowsPlatform["guides"]>["loadScreenshot"];
  save: (guide: WorkflowGuide) => Promise<void>;
  onVideoMode?: (active: boolean) => void;
  onCreate?: () => void;
  onLayoutChange?: (layout: DocumentLayout) => void;
  assistantBusy?: boolean;
  onReconnect?: (guide: WorkflowGuide) => Promise<void>;
  onReset?: () => Promise<void>;
  container?: HTMLElement | null;
  onOpenChange?: (open: boolean) => void;
}> (function GuideVideoPanel({ guide, workflow, platform, loadScreenshot, loadSourceScreenshot, save, onVideoMode, onCreate, onLayoutChange, assistantBusy = false, onReconnect, onReset, container, onOpenChange }, ref) {
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<Array<{ result: GuideVideoResult; source: string; number: number }>>([]);
  const savedVersions = useRef<Array<{ result: GuideVideoResult; source: string; number: number }>>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<GuideVideoResult | null>(null);
  const [renderedSource, setRenderedSource] = useState("");
  const revision = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const lock = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const working = busy || assistantBusy;
  const videoSource = (value: WorkflowGuide) => { const {documentLayout, videoLayout, ...content} = value; return JSON.stringify(content); };
  const source = videoSource(guide);
  let scenes: ReturnType<typeof guideVideoScenes> = [];
  let planError = "";
  try { scenes = guideVideoScenes(guide, workflow); } catch (cause) { planError = (cause as Error).message; }
  const needsSources = guideNeedsSourceReview(guide, workflow);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
      for (const version of savedVersions.current) void platform.release(version.result).catch(() => {});
    };
  }, [platform]);
  useEffect(() => {
    onOpenChange?.(open);
    if (!open) return;
    onVideoMode?.(true);
    panel.current?.focus({ preventScroll: true });
    panel.current?.scrollIntoView?.({ block: "start" });
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape" && event.target instanceof Node && panel.current?.contains(event.target)) { backToSop(); }
    };
    document.addEventListener("keydown", dismiss);
    return () => {
      document.removeEventListener("keydown", dismiss);
    };
  }, [open, onOpenChange, onVideoMode]);
  useImperativeHandle(ref, () => ({ show: showResult, generate: (next, signal, progress) => generate(next, signal, progress) }));
  function showResult(target: WorkflowGuide, next: GuideVideoResult) {
    if (!mounted.current) { void platform.release(next); return; }
    const targetSource = videoSource(target);
    const history = [...savedVersions.current, { result: next, source: targetSource, number: ++revision.current }];
    if (history.length > 3) void platform.release(history.shift()!.result).catch(() => {});
    savedVersions.current = history;
    setVersions(history);
    setOpen(true);
    setResult(next); setRenderedSource(targetSource); setMessage("Video ready to review");
  }
  async function generate(target = guide, signal?: AbortSignal, progress?: (text: string) => void) {
    if (lock.current) throw new Error("A video is already being created. Stop it before starting another.");
    const selected = guideVideoScenes(target, workflow);
    const missing = videoScreenshotGaps(selected);
    signal?.throwIfAborted();
    setOpen(true);
    lock.current = true;
    setBusy(true); setError(""); setMessage("Preparing video");
    const abort = new AbortController();
    controller.current = abort;
    const stop = () => abort.abort();
    signal?.addEventListener("abort", stop, { once: true });
    try {
      if (missing.length) throw new Error(`Add screenshots before creating this video: ${missing.join("; ")}`);
      await save(target);
      abort.signal.throwIfAborted();
      const next = await platform.generate(selected, abort.signal, text => { if (mounted.current) setMessage(text); progress?.(text); });
      if (!mounted.current || abort.signal.aborted) {
        await platform.release(next);
        if (mounted.current) setMessage("Video creation stopped. Your SOP is unchanged.");
        throw new DOMException("Stopped", "AbortError");
      }
      showResult(target, next);

    } catch (cause) {
      if (mounted.current) {
        if (abort.signal.aborted) setMessage("Video creation stopped. Your SOP is unchanged.");
        else {
          setMessage("");
          setError(typeof cause === "string" ? cause : (cause as Error)?.message || "Could not create the video. Try again.");
        }
      }
      throw cause;
    } finally {
      signal?.removeEventListener("abort", stop);
      lock.current = false;
      controller.current = null;
      if (mounted.current) setBusy(false);
    }
  }
  async function download(captions: boolean) {
    if (!result) return;
    setError("");
    try { if (await platform.export(result, guide.title, captions)) setMessage(captions ? "Captions downloaded" : "Video downloaded"); }
    catch { setMessage(""); setError("Could not download. Your preview is still available; try again."); }
  }
  function backToSop() {
    onVideoMode?.(false);
    setOpen(false);
    trigger.current?.focus();
  }
  const content = open && <section ref={panel} tabIndex={-1} id="sop-video-panel" aria-label="Video SOP" className={styles.videoPanel}>
      <button className={styles.videoBack} onClick={backToSop}><ArrowLeft size={16} /> Back to SOP</button>
      <div className={styles.videoHeading}>
        <div><p className={styles.videoEyebrow}>{result ? "Your video" : "Create a video"}</p><h2>{guide.title}</h2>
          <p className={styles.videoDescription}>{guide.steps.length} {guide.steps.length === 1 ? "step" : "steps"} · Narrated walkthrough</p></div>
        <div className={styles.videoActions}>
          <button className={styles.primary} disabled={working || !!planError} onClick={() => onCreate ? onCreate() : void generate().catch(() => {})}>{working ? <Loader2 size={16} className={styles.spin} /> : <Film size={16} />}{working ? "Creating video…" : result ? "Create new video" : error ? "Try again" : "Create video"}</button>
          {busy && !onCreate && <button onClick={() => { controller.current?.abort(); setMessage("Stopping video creation…"); }}>Stop</button>}
        </div>
      </div>
      {message && (!onCreate || !working) && <p role="status" aria-live="polite">{message}</p>}
      {(error || (planError && !needsSources)) && <p role="alert">{error || planError}</p>}
      {needsSources && (onReconnect ? <GuideSourceReview key={`${source}:${workflow.revision}`} guide={guide} workflow={workflow} onApply={onReconnect} /> : <p role="alert">{planError}</p>)}
      <DocumentBlockEditor disabled={working} layout={guide.videoLayout} onChange={layout => onLayoutChange?.(layout)} blocks={[
        ...(result ? [{ id: "generated-video", label: "Generated video", content: <>
          {renderedSource !== source && <p role="status">This preview uses an earlier edit. Create a new video to include your changes.</p>}
          <video key={result.url} controls crossOrigin="anonymous" preload="metadata" src={result.url} aria-label="Narrated SOP preview">
            {result.captionsUrl && <track kind="captions" src={result.captionsUrl} label="Narration" srcLang="en" default />}
          </video>
          <div className={styles.videoActions}>
            <button onClick={() => void download(false)}><Download size={16} /> Download MP4</button>
            <button onClick={() => void download(true)}>Download captions</button>
          </div>
          {versions.length > 1 && <details><summary>Video revisions · {versions.length}</summary><div className={styles.videoActions}>{versions.map((version) => <button key={version.result.path} disabled={working || result === version.result} onClick={() => { setResult(version.result); setRenderedSource(version.source); }}>Version {version.number}</button>)}</div></details>}
          <p>The last three previews stay available while this SOP is open. Download a copy to keep it.</p>
        </> }] : []),
        ...scenes.flatMap((scene, i): DocumentBlock[] => [
          {id: `scene/${scene.id ?? i}/heading`, label: `Scene ${i + 1} heading`, content: <h3>{scene.title}</h3>},
          {id: `scene/${scene.id ?? i}/image`, label: `Scene ${i + 1} image`, content: <div className={styles.videoSceneImage}>
            {(scene.image && isGuideImage(scene.image)) || (scene.imageFrameId && loadScreenshot)
              ? <SopScreenshot src={scene.image && isGuideImage(scene.image) ? scene.image : ""} frameId={scene.imageFrameId ?? 0} load={scene.imageFrameId ? loadScreenshot : undefined} alt={`Screenshot for ${scene.title}`} />
              : scene.imageSources?.length
                ? <SourceSopScreenshot stage={{ evidence: scene.imageSources }} load={loadSourceScreenshot} title={scene.title} alt={`Screenshot for ${scene.title}`} />
                : <p className={styles.muted}>No screenshot for this step</p>}
          </div>},
          {id: `scene/${scene.id ?? i}/text`, label: `Scene ${i + 1} narration`, content: <p>{scene.narration}</p>},
        ]),
      ]} />
      {guide.video && <button disabled={working} onClick={() => { void onReset?.().catch(() => setError("Could not reset the video script. Try again.")); }}>Reset video script from SOP</button>}

    </section>;
  return <>
    <button ref={trigger} className={styles.actionButton} aria-label="Video SOP" aria-expanded={open} aria-controls="sop-video-panel" onClick={() => { if (open) backToSop(); else setOpen(true); }}>
      {working ? <Loader2 size={16} className={styles.spin} aria-hidden="true" /> : <Film size={16} aria-hidden="true" />} {working ? "Creating video…" : "Video SOP"}
    </button>
    {container ? createPortal(content, container) : content}
  </>;
});
