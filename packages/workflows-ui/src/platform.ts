// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import type {
  SavedWorkflowSkill,
  WorkProfile,
  WorkflowAnalysis,
  WorkflowMap,
  WorkflowRuntime,
  WorkflowScope,
  WorkflowSkillDraft,
  WorkflowSkillProgress,
} from "./model";
import type { WorkflowsAssistantPlatform } from "./assistant";

export type WorkflowAnalysisOptions = {
  scope?: WorkflowScope;
  workProfile?: WorkProfile | null;
};

export type WorkflowAnalysisJob = {
  id: string;
  status: "queued" | "processing" | "complete" | "failed";
  progress?: number;
  message?: string;
  result?: WorkflowAnalysis;
};

export type WorkflowsPlatform = {
  assistant?: WorkflowsAssistantPlatform;
  ensureRuntime: () => Promise<WorkflowRuntime>;
  analyzeCapturedWork: (days: number, options?: WorkflowAnalysisOptions) => Promise<WorkflowAnalysis>;
  loadCapturedWork?: (days: number, options?: WorkflowAnalysisOptions) => Promise<WorkflowAnalysis | null>;
  saveCapturedWork?: (analysis: WorkflowAnalysis, options?: WorkflowAnalysisOptions) => Promise<void>;
  startAnalysisJob?: (days: number, options?: WorkflowAnalysisOptions) => Promise<WorkflowAnalysisJob>;
  getAnalysisJob?: (jobId: string) => Promise<WorkflowAnalysisJob>;
  loadWorkProfile?: (scope?: WorkflowScope) => Promise<WorkProfile | null>;
  saveWorkProfile?: (profile: WorkProfile, scope?: WorkflowScope) => Promise<WorkProfile>;
  generateWorkflowSkill?: (
    workflow: WorkflowMap,
    profile?: WorkProfile | null,
    onProgress?: (progress: WorkflowSkillProgress) => void,
  ) => Promise<WorkflowSkillDraft>;
  saveWorkflowSkill?: (draft: WorkflowSkillDraft) => Promise<SavedWorkflowSkill>;
  openAccount?: () => Promise<void>;
  startWindowDrag?: () => Promise<void> | void;
};

export type WorkflowsAppProps = {
  platform: WorkflowsPlatform;
  initialAnalysis?: WorkflowAnalysis | null;
  storageKey?: string | null;
  initialScopeId?: string;
  embedded?: boolean;
};
