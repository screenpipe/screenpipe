// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { invoke } from "@tauri-apps/api/core";
import type { WorkProfile, WorkflowAnalysis, WorkflowRuntime } from "@screenpipe/workflows-ui";

export type {
  AnalysisQuality,
  TimeAllocationItem,
  TimeProfile,
  TimeProfileDimension,
  WorkflowAnalysis,
  WorkflowBottleneck,
  WorkflowEvidence,
  WorkflowMap,
  WorkflowQuality,
  WorkflowQualityGrade,
  WorkflowRuntime,
  WorkflowScreenshot,
  WorkflowStage,
} from "@screenpipe/workflows-ui";

export const getWorkflowRuntime = () => invoke<WorkflowRuntime>("get_workflows_runtime");
export const ensureWorkflowRuntime = () => invoke<WorkflowRuntime>("ensure_workflows_runtime");
export const analyzeCapturedWork = (days = 7, workProfile?: WorkProfile | null) => invoke<WorkflowAnalysis>("analyze_workflows", { days, profile: workProfile ?? null });
