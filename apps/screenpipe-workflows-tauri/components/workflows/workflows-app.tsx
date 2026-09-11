// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

"use client";

import { WorkflowsApp as SharedWorkflowsApp } from "@screenpipe/workflows-ui";
import { desktopWorkflowsPlatform } from "@/lib/workflows/desktop-platform";

export function WorkflowsApp() {
  return <SharedWorkflowsApp platform={desktopWorkflowsPlatform} />;
}
