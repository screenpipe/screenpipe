// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

"use client";

import { WorkflowsApp } from "@screenpipe/workflows-ui";
import { createFixtureWorkflowsPlatform, fixtureWorkflowAnalysis } from "@screenpipe/workflows-ui/fixture";

const previewPlatform = createFixtureWorkflowsPlatform();

export default function WorkflowsPreviewPage() {
  return <WorkflowsApp platform={previewPlatform} initialAnalysis={fixtureWorkflowAnalysis} storageKey={null} />;
}
