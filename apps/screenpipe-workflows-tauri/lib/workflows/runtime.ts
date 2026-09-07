// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { invoke } from "@tauri-apps/api/core";
import type {
  SavedWorkflowSkill,
  WorkProfile,
  WorkflowAnalysis,
  WorkflowMap,
  WorkflowRuntime,
  WorkflowSkillDraft,
} from "@screenpipe/workflows-ui";

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
export const generateWorkflowSkill = (workflow: WorkflowMap, workProfile?: WorkProfile | null) => invoke<WorkflowSkillDraft>("generate_workflow_skill", { workflow, profile: workProfile ?? null });
export const saveWorkflowSkill = (draft: WorkflowSkillDraft) => invoke<SavedWorkflowSkill>("save_workflow_skill", { draft });
