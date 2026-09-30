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
  return { platform, initialAnalysis: mode ? null : fixtureWorkflowAnalysis };
}

export default function WorkflowsPreviewPage() {
  const [state, setState] = useState<ReturnType<typeof preview> | null>(null);
  useEffect(() => { setState(preview(new URLSearchParams(window.location.search).get("catalog"))); }, []);
  return state ? <WorkflowsApp platform={state.platform} initialAnalysis={state.initialAnalysis} storageKey={null} /> : null;
}
