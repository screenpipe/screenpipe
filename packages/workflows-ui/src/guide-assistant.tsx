// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";
import { useContext, useEffect, useRef } from "react";
import { guideVideoDraft, guideVideoScenes, type GuideVideoResult } from "./guide-video";
import { preserveGuideBlocks, type WorkflowGuide } from "./guide";
import type { WorkflowMap } from "./model";
import type { WorkflowsPlatform } from "./platform";
import { PageAssistantContext } from "./page-assistant";
import { useGT } from "gt-react";

/** Routes SOP edits through the shell's chat, including history, dictation and stop. */
export function GuideAssistant(props: {
  guide: WorkflowGuide | null;
  videoMode?: boolean;
  onVideoBusyChange?: (busy: boolean) => void;
  showVideo?: (guide: WorkflowGuide, result: GuideVideoResult) => void;
  renderVideo?: (guide: WorkflowGuide, signal: AbortSignal, progress: (text: string) => void) => Promise<void>;
  promptRequest?: { id: string; text: string };
  workflow: WorkflowMap;
  platform: NonNullable<WorkflowsPlatform["guides"]>;
  update: (guide: WorkflowGuide) => Promise<void>;
}) {
  const ui = useGT();
  const register = useContext(PageAssistantContext);
  const current = useRef(props);
  const unsaved = useRef<WorkflowGuide | null>(null);
  current.current = props;
  useEffect(() => {
    if (!register) return;
    const lifetime = new AbortController();
    register({
      context: {
        key: `${props.videoMode ? "video" : "sop"}:${props.workflow.id || props.workflow.title}`,
        title: props.videoMode
          ? ui("Video: {value1}", { value1: props.guide?.title ?? props.workflow.title })
          : ui("SOP: {value1}", { value1: props.guide?.title ?? props.workflow.title }),
        purpose: props.videoMode ? "video" : "sop",
      },
      promptRequest: props.promptRequest,
      onBusyChange: busy => current.current.onVideoBusyChange?.(!!current.current.videoMode && busy),
      ask: async ({ question, signal, onProgress, history }) => {
        const { guide, workflow, platform, update } = current.current;
        if (guide && !current.current.videoMode && !platform.edit)
          throw new Error("SOP editing is unavailable.");
        const run = new AbortController();
        const abort = () => run.abort();
        signal.addEventListener("abort", abort, { once: true });
        lifetime.signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted || lifetime.signal.aborted) abort();
        const runSignal = run.signal;
        try {
          runSignal.throwIfAborted();
          const progress = (text: string) => {
            if (!runSignal.aborted) onProgress({ text, activity: current.current.videoMode ? "working" : "writing" });
          };
          if (current.current.videoMode && guide) {
            if (!platform.video?.edit) throw new Error("Video editing is unavailable.");
            const response = await platform.video.edit(guideVideoDraft(guide, workflow), question, history, runSignal, event => { if (!runSignal.aborted) typeof event === "string" ? progress(event) : onProgress(event); }, guideVideoScenes(guide, workflow));
            const next = { ...guide, video: response.draft };
            try {
              runSignal.throwIfAborted();
              if (current.current.guide !== guide) throw new Error("The SOP or video script changed while the assistant was editing. Your edits were kept. Try again.");
              if (response.changed || response.render || response.result) await update(next);
              runSignal.throwIfAborted();
              if (response.result) {
                if (!current.current.showVideo) throw new Error("Video preview is unavailable.");
                current.current.showVideo(next, response.result);
                return response.message || "Your video is ready on the page.";
              }
            } catch (error) {
              if (response.result) await platform.video.release(response.result).catch(() => {});
              throw error;
            }
            runSignal.throwIfAborted();
            if (response.render) {
              if (!current.current.renderVideo) throw new Error("Video rendering is unavailable.");
              await current.current.renderVideo(next, runSignal, progress);
              return "Your video is ready on the page. Tell me what you’d like to change.";
            }
            return response.changed ? "Saved the video script. Ask me to create the video when you are ready, or choose Create video in the preview." : response.message || "The video script is unchanged.";
          }
          const next = guide
            ? await platform.edit!(
                guide,
                workflow,
                question,
                runSignal,
                progress,
              )
            : (unsaved.current ??
              (await platform.load(workflow)) ??
              (await platform.generate(workflow, runSignal, progress)));
          runSignal.throwIfAborted();
          if (current.current.guide !== guide)
            throw new Error(
              "The SOP changed while the assistant was editing. Your edits were kept. Try again.",
            );
          const preserved = guide ? preserveGuideBlocks(guide, next) : next;
          unsaved.current = preserved;
          await update(preserved);
          unsaved.current = null;
          return guide
            ? "Saved the updated SOP. Review the changes on the page."
            : "Saved your SOP on this device. Review its steps on the page.";
        } finally {
          signal.removeEventListener("abort", abort);
          lifetime.signal.removeEventListener("abort", abort);
        }
      },
    });
    return () => {
      lifetime.abort();
      register(null);
    };
  }, [register, props.workflow.id, props.workflow.title, props.videoMode]);
  // New page actions reach the mounted chat without replacing its run handler.
  useEffect(() => {
    if (!register || !props.promptRequest) return;
    register(page => page && page.promptRequest?.id !== props.promptRequest?.id
      ? { ...page, promptRequest: props.promptRequest } : page);
  }, [register, props.promptRequest]);
  return null;
}
