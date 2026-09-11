// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

"use client";

import { WorkflowsApp } from "@screenpipe/workflows-ui";
import { createWebWorkflowsPlatform } from "@screenpipe/workflows-ui/web";

const platform = createWebWorkflowsPlatform({
  runtimeEndpoint: "/api/workflows/runtime",
  analysisEndpoint: "/api/workflows/analyze",
  cachedAnalysisEndpoint: "/api/workflows/analysis",
  analysisJobsEndpoint: "/api/workflows/analysis-jobs",
  accountUrl: "/login?next=/workflows",
});

export function WebsiteWorkflows() {
  return <WorkflowsApp platform={platform} storageKey="screenpipe-workflows:web:last-analysis" />;
}
