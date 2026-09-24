// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";
import { useEffect, useRef, useState } from "react";
import type { WorkflowStage, WorkflowScreenshot } from "./model";
import type { WorkflowsPlatform } from "./platform";

export function useSourceScreenshot(stage: WorkflowStage, attached: boolean, load: WorkflowsPlatform["loadWorkflowScreenshot"]) {
  const ref = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const sources = JSON.stringify(stage.evidence.filter(e => !["audio", "meeting"].includes(e.source ?? "")
    && e.app && Number.isFinite(Date.parse(e.timestamp))).map(e => [e.timestamp, e.app]));
  const key = `${sources}:${attempt}`;
  const [state, setState] = useState<{ key: string; image?: WorkflowScreenshot; status: "loading" | "unavailable" | "error" | "ready" }>();
  useEffect(() => {
    if (!ref.current || visible) return;
    if (typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: "200px" });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [visible]);
  useEffect(() => {
    if (attached || !load || !visible || sources === "[]") return;
    const controller = new AbortController();
    let disposed = false;
    let image: WorkflowScreenshot | null = null;
    const timeout = setTimeout(() => controller.abort(), 30_000);
    setState({ key, status: "loading" });
    void (async () => {
      let failed = false;
      for (const [timestamp, app] of JSON.parse(sources) as [string, string][]) {
        if (controller.signal.aborted) break;
        try {
          image = await load(timestamp, app, controller.signal);
          if (disposed) { if (image?.dataUrl.startsWith("blob:")) URL.revokeObjectURL(image.dataUrl); return; }
          if (image) { setState({ key, image, status: "ready" }); return; }
        } catch { failed = true; }
      }
      if (!disposed) setState({ key, status: failed || controller.signal.aborted ? "error" : "unavailable" });
    })().finally(() => clearTimeout(timeout));
    return () => {
      disposed = true; controller.abort(); clearTimeout(timeout);
      if (image?.dataUrl.startsWith("blob:")) URL.revokeObjectURL(image.dataUrl);
    };
  }, [sources, key, attached, load, visible]);
  return { ref, image: !attached && state?.key === key ? state.image : undefined,
    status: !load || sources === "[]" ? "unavailable" : state?.key === key ? state.status : "loading",
    canRetry: !!load && sources !== "[]",
    retry: () => setAttempt(value => value + 1) };
}
