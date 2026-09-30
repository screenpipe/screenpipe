// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";
import { useContext, useEffect, useRef } from "react";
import type { WorkflowGuide } from "./guide";
import type { WorkflowMap } from "./model";
import type { WorkflowsPlatform } from "./platform";
import { PageAssistantContext } from "./page-assistant";
import { useGT } from "gt-react";

/** Routes SOP edits through the shell's chat, including history, dictation and stop. */
export function GuideAssistant(props: {
  guide: WorkflowGuide | null;
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
        key: `sop:${props.workflow.id || props.workflow.title}`,
        title: ui("SOP: {value1}", {
          value1: props.guide?.title ?? props.workflow.title,
        }),
        purpose: "sop",
      },
      promptRequest: props.promptRequest,
      ask: async ({ question, signal, onProgress }) => {
        const { guide, workflow, platform, update } = current.current;
        if (guide && !platform.edit)
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
            if (!runSignal.aborted) onProgress({ text, activity: "writing" });
          };
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
          unsaved.current = next;
          await update(next);
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
  }, [register, props.workflow.id, props.workflow.title]);
  return null;
}
