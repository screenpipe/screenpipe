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
  guide: WorkflowGuide;
  workflow: WorkflowMap;
  platform: NonNullable<WorkflowsPlatform["guides"]>;
  update: (guide: WorkflowGuide) => void;
}) {
  const ui = useGT();
  const register = useContext(PageAssistantContext);
  const current = useRef(props);
  current.current = props;
  useEffect(() => {
    if (!register) return;
    const lifetime = new AbortController();
    register({
      context: { key: `sop:${props.workflow.id || props.workflow.title}`, title: ui("SOP: {value1}", { value1: props.guide.title }), purpose: "sop" },
      ask: async ({ question, signal, onProgress }) => {
        const { guide, workflow, platform, update } = current.current;
        if (!platform.edit) throw new Error("SOP editing is unavailable.");
        const run = new AbortController();
        const abort = () => run.abort();
        signal.addEventListener("abort", abort, { once: true });
        lifetime.signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted || lifetime.signal.aborted) abort();
        const runSignal = run.signal;
        try {
          runSignal.throwIfAborted();
          const next = await platform.edit(guide, workflow, question, runSignal, text => {
            if (!runSignal.aborted) onProgress({ text, activity: "writing" });
          });
          runSignal.throwIfAborted();
          if (current.current.guide !== guide)
            throw new Error("The SOP changed while the assistant was editing. Your edits were kept. Try again.");
          update(next);
          return "Updated the SOP. You can review the changes on the page.";
        } finally {
          signal.removeEventListener("abort", abort);
          lifetime.signal.removeEventListener("abort", abort);
        }
      },
    });
    return () => { lifetime.abort(); register(null); };
  }, [register, props.workflow.id, props.workflow.title]);
  return null;
}
