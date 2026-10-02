// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
// Synthetic product-component preview. Native rendering is tested separately.
import React from "react";
import { createRoot } from "react-dom/client";
import { GTProvider, initializeGT } from "gt-react";
import { WorkflowsApp, applyVideoEdit, type GuideVideoPlatform } from "@screenpipe/workflows-ui";
import { createFixtureWorkflowsPlatform, fixtureWorkflowAnalysis } from "@screenpipe/workflows-ui/fixture";
initializeGT({ defaultLocale: "en", locales: ["en"], loadTranslations: async () => ({}), runtimeUrl: null, _disableDevHotReload: true });
const params = new URLSearchParams(location.search);
const platform = createFixtureWorkflowsPlatform(structuredClone(fixtureWorkflowAnalysis));
const load = platform.guides!.load;
platform.guides!.load = async workflow => {
  await load(workflow); // rasterize the existing fictional screenshots
  if (params.get("state") === "missing") { workflow.stages[0].screenshot = null; workflow.stages[0].screenshots = []; }
  if (params.get("state") === "legacy") { for (const stage of workflow.stages) { if (stage.screenshot) stage.screenshot.visualVerified = false; } }
  if (params.get("state") === "selection") {
    workflow.stages[0].screenshots = [workflow.stages[0].screenshot!, workflow.stages[1].screenshot!];
  }
  if (params.get("state") === "repeated") {
    for (const stage of workflow.stages) { stage.screenshot = workflow.stages[0].screenshot; stage.screenshots = []; }
  }
  return { version: 1, workflowKey: workflow.id || workflow.title, sourceRevision: (workflow.revision ?? 0) + (params.get("state") === "stale" ? 1 : 0), title: "Create a research brief",
    summary: "Gather reliable sources and turn them into a brief your team can review.", prerequisites: ["A research question and access to the source documents."],
    steps: workflow.stages.map((stage,i) => ({ title: stage.name, instruction: stage.description, expectedResult: "The source and its supporting claim are linked.", sourceStage: i, includeImage: params.get("state") !== "legacy" })),
    exceptions: ["If sources disagree, include both references and explain what remains unclear."], completion: ["Every conclusion has a supporting source."], questions: ["Who reviews the final brief?"] };
};
let releaseCount = 0;
let renderCount = 0;
const video: GuideVideoPlatform = {
  edit: async (draft, instruction) => {
    const render = instruction.toLowerCase().includes("create");
    const next = render ? draft : applyVideoEdit(draft, { changes: [{ id: draft.scenes[0].id, narration: "Collect sources, compare their claims, and share a reviewed brief." }], render: false });
    return { draft: next, changed: !render, render, message: "" };
  },
  generate: async (_scenes, signal, progress) => {
    progress("Narrating 2 of 8");
    if (params.get("state") === "progress" || params.get("state") === "cancel")
      await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), { once: true }));
    if (params.get("state") === "error") throw new Error("Speech generation is unavailable. Your SOP is unchanged. Try again later.");
    if (params.get("state") === "quota") throw new Error("Your monthly AI allowance is used up. Video creation can resume when it resets. Your SOP is unchanged.");
    return {url:"/synthetic-video.mp4",path:`preview-${++renderCount}.mp4`,captionsPath:"preview.vtt"};
  },
  export: async (_result, _title, captions) => { document.body.dataset.download = captions ? "vtt" : "mp4"; return true; },
  release: async () => { document.body.dataset.releases = String(++releaseCount); },
};
if (params.get("state") !== "before") platform.guides!.video = video;
createRoot(document.getElementById("root")!).render(<GTProvider><WorkflowsApp platform={platform} initialAnalysis={fixtureWorkflowAnalysis} storageKey={null} /></GTProvider>);
