// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";
import { useEffect, useRef, useState } from "react";
import type { WorkflowsPlatform } from "./platform";
import { useSourceScreenshot } from "./use-source-screenshot";
import type { WorkflowScreenshot } from "./model";
import styles from "./workflow-guide.module.css";

function LegacySopScreenshot({ src, frameId, load, alt, onLoad, onError }: {
  src: string; frameId: number; alt: string; draggable?: boolean;
  load?: NonNullable<WorkflowsPlatform["guides"]>["loadScreenshot"];
  onLoad?: () => void; onError?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [original, setOriginal] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!ref.current) return;
    if (typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)), { rootMargin: "200px" });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!load || !visible) return;
    const controller = new AbortController();
    let url: string | undefined;
    setFailed(false);
    void load(frameId, controller.signal).then(value => {
      if (controller.signal.aborted) { if (value.startsWith("blob:")) URL.revokeObjectURL(value); return; }
      url = value; setOriginal(value);
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => {
      controller.abort(); setOriginal(undefined);
      if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
    };
  }, [frameId, load, visible]);
  return <div ref={ref}>
    {(original || src) ? <img src={original || src} alt={alt} loading="lazy" draggable={false} onLoad={onLoad}
      onError={() => { if (original) { setOriginal(undefined); setFailed(true); } else { setFailed(true); onError?.(); } }} /> : <p className={styles.muted} role="status">{failed ? "Screenshot unavailable" : "Loading screenshot…"}</p>}
    {failed && src && <p className={styles.muted} role="status">Original screenshot unavailable. Showing the saved preview.</p>}
  </div>;
}


export function SopScreenshot(props: Parameters<typeof LegacySopScreenshot>[0] & { source?: WorkflowScreenshot; loadSource?: WorkflowsPlatform["loadWorkflowScreenshot"] }) {
  return props.source && props.loadSource ? <ExactSopScreenshot {...props} source={props.source} /> : <LegacySopScreenshot {...props} />;
}
function ExactSopScreenshot({ source, loadSource, alt, onLoad, onError }: Parameters<typeof SopScreenshot>[0] & { source: WorkflowScreenshot }) {
  const image = useSourceScreenshot({ evidence: [] }, false, loadSource, source);
  return <figure ref={image.ref}>
    {image.image ? <img src={image.image.dataUrl} alt={alt} draggable={false} onLoad={onLoad} onError={onError} /> : <p className={styles.muted} role="status">{image.status === "loading" ? "Loading source screenshot…" : "This screenshot is no longer available."}{image.canRetry && image.status !== "loading" && <button onClick={image.retry}>Retry screenshot</button>}</p>}
  </figure>;
}
