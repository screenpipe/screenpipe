// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import type { WorkProfile, WorkflowAnalysis, WorkflowRuntime, WorkflowScope } from "./model";

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
  ensureRuntime: () => Promise<WorkflowRuntime>;
  analyzeCapturedWork: (days: number, options?: WorkflowAnalysisOptions) => Promise<WorkflowAnalysis>;
  loadCapturedWork?: (days: number, options?: WorkflowAnalysisOptions) => Promise<WorkflowAnalysis | null>;
  saveCapturedWork?: (analysis: WorkflowAnalysis, options?: WorkflowAnalysisOptions) => Promise<void>;
  startAnalysisJob?: (days: number, options?: WorkflowAnalysisOptions) => Promise<WorkflowAnalysisJob>;
  getAnalysisJob?: (jobId: string) => Promise<WorkflowAnalysisJob>;
  loadWorkProfile?: (scope?: WorkflowScope) => Promise<WorkProfile | null>;
  saveWorkProfile?: (profile: WorkProfile, scope?: WorkflowScope) => Promise<WorkProfile>;
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
