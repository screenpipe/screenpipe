// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

"use client";

import { useEffect, useState } from "react";
import { WorkflowsApp } from "@screenpipe/workflows-ui";
import { createFixtureWorkflowsPlatform, fixtureWorkflowAnalysis } from "@screenpipe/workflows-ui/fixture";

function preview(mode: string | null) {
  const platform = createFixtureWorkflowsPlatform();
  const load = platform.loadCapturedWork!;
  if (mode === "loading") platform.loadCapturedWork = async (...args) => {
    await new Promise(resolve => setTimeout(resolve, 8000));
    return load(...args);
  };
  if (mode === "error") platform.loadCapturedWork = async () => { throw new Error("Preview unavailable"); };
  if (mode === "empty") platform.loadCapturedWork = async () => null;
  if (mode === "source-preview") {
    const captures = new Map<string, NonNullable<typeof fixtureWorkflowAnalysis.analysis.workflows[number]["stages"][number]["screenshot"]>>();
    platform.loadCapturedWork = async (...args) => {
      const analysis = await load(...args);
      if (!analysis) return analysis;
      return { ...analysis, analysis: { ...analysis.analysis, workflows: analysis.analysis.workflows.map(workflow => ({ ...workflow, stages: workflow.stages.map(stage => {
        const image = stage.screenshot ?? stage.screenshots?.[0];
        if (!image) return stage;
        captures.set(`${image.timestamp}:${image.app}`, image);
        return { ...stage, screenshot: undefined, screenshots: [], evidence: [{ timestamp: image.timestamp, app: image.app, source: "screen", detail: "Fictional captured step" }] };
      }) })) } };
    };
    platform.guides!.loadSourceScreenshot = async (timestamp, app, signal) => {
      signal.throwIfAborted();
      return captures.get(`${timestamp}:${app}`) ?? null;
    };
  }
  if (mode === "stale-sop") {
    const readGuide = platform.guides!.load;
    platform.guides!.load = async workflow => {
      const saved = await readGuide(workflow);
      if (saved) return saved;
      const generated = await platform.guides!.generate(workflow, new AbortController().signal, () => {});
      return { ...generated, sourceRevision: Math.max(0, (workflow.revision ?? 0) - 1) };
    };
    platform.loadCapturedWork = async (...args) => {
      const analysis = await load(...args);
      return analysis ? { ...analysis, analysis: { ...analysis.analysis, workflows: analysis.analysis.workflows.map(workflow => ({ ...workflow, revision: (workflow.revision ?? 0) + 1 })) } } : null;
    };
  }
  // Explicit fictional state for the chat-to-video interaction evaluation.
  if (mode === "video-chat") {
    platform.guides!.video!.edit = async (draft, _request, _history, signal, progress) => {
      const read = {id:"read", name:"read_video_sop", status:"complete" as const, detail:"Loaded the video skill and saved project."};
      progress({text:"I’ll create the video from your saved script and screenshots.",activity:"working",toolCalls:[read,{id:"render",name:"render_video_sop",status:"running",detail:"Creating narration"}]});
      await new Promise(resolve => setTimeout(resolve, 2200));
      signal.throwIfAborted();
      progress({text:"I’ll create the video from your saved script and screenshots.",activity:"working",toolCalls:[read,{id:"render",name:"render_video_sop",status:"running",detail:"Rendering the video"}]});
      await new Promise(resolve => setTimeout(resolve, 2200));
      signal.throwIfAborted();
      progress({text:"",activity:"working",toolCalls:[read,{id:"render",name:"render_video_sop",status:"complete",detail:"MP4 and captions ready."}]});
      return { draft, changed: false, render: false, message: "Your video is ready on the page.", result: { url: "/video-sop-fixture.mp4", path: "fictional-preview.mp4", captionsPath: "fictional-preview.vtt", captionsUrl: "/video-sop-fixture.vtt" } };
    };
  }
  return { platform, initialAnalysis: mode ? null : fixtureWorkflowAnalysis };
}

export default function WorkflowsPreviewPage() {
  const [state, setState] = useState<ReturnType<typeof preview> | null>(null);
  useEffect(() => { setState(preview(new URLSearchParams(window.location.search).get("catalog"))); }, []);
  return state ? <WorkflowsApp platform={state.platform} initialAnalysis={state.initialAnalysis} storageKey={null} /> : null;
}
