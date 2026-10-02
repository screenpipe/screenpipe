// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";
import { useEffect, useRef, useState } from "react";
import type { WorkflowEvidence, WorkflowScreenshot } from "./model";
import type { WorkflowsPlatform } from "./platform";

export function useSourceScreenshot(stage: { evidence: Array<Pick<WorkflowEvidence, "timestamp" | "app" | "source">> }, attached: boolean, load: WorkflowsPlatform["loadWorkflowScreenshot"], capture?: WorkflowScreenshot) {
  const ref = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const sources = capture ? JSON.stringify([[capture.timestamp, capture.app, capture.frameId]]) : JSON.stringify([...new Set(stage.evidence.filter(e => !["audio", "meeting"].includes(e.source ?? "")
    && e.app && Number.isFinite(Date.parse(e.timestamp))).map(e => JSON.stringify([e.timestamp, e.app])))].map(source => JSON.parse(source)));
  const key = `${sources}:${attempt}`;
  const [state, setState] = useState<{ key: string; image?: WorkflowScreenshot; status: "loading" | "unavailable" | "error" | "ready" }>();
  useEffect(() => {
    if (!ref.current) return;
    if (typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => {
      setVisible(entries.some(entry => entry.isIntersecting));
    }, { rootMargin: "200px" });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (attached || !load || !visible || sources === "[]") return;
    const controller = new AbortController();
    let disposed = false;
    let image: WorkflowScreenshot | null = null;
    const timeout = setTimeout(() => controller.abort(), 30_000);
    setState({ key, status: "loading" });
    void (async () => {
      let failed = false;
      for (const [timestamp, app, frameId] of JSON.parse(sources) as [string, string, number?][]) {
        if (controller.signal.aborted) break;
        try {
          image = frameId === undefined ? await load(timestamp, app, controller.signal) : await load(timestamp, app, controller.signal, frameId);
          if (disposed) { if (image?.dataUrl.startsWith("blob:")) URL.revokeObjectURL(image.dataUrl); return; }
          if (image) { setState({ key, image, status: "ready" }); return; }
        } catch { failed = true; }
      }
      if (!disposed) setState({ key, status: failed || controller.signal.aborted ? "error" : "unavailable" });
    })().finally(() => clearTimeout(timeout));
    return () => {
      disposed = true; controller.abort(); clearTimeout(timeout); setState(undefined);
      if (image?.dataUrl.startsWith("blob:")) URL.revokeObjectURL(image.dataUrl);
    };
  }, [sources, key, attached, load, visible]);
  return { ref, image: visible && !attached && state?.key === key ? state.image : undefined,
    status: !load || sources === "[]" ? "unavailable" : state?.key === key ? state.status : "loading",
    canRetry: !!load && sources !== "[]",
    retry: () => setAttempt(value => value + 1) };
}
