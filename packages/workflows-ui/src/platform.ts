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
import type { WorkflowGuide } from "./guide";
import type { WorkflowsAssistantPlatform } from "./assistant";

export type WorkflowAnalysisOptions = {
  scope?: WorkflowScope;
  workProfile?: WorkProfile | null;
};

export type WorkflowRunActivity = {
  id: string;
  label: string;
  status: "running" | "complete" | "error";
};

export type WorkflowAnalysisJob = {
  id: string;
  status: "queued" | "processing" | "complete" | "incomplete" | "failed";
  progress?: number;
  startedAt?: string;
  message?: string;
  result?: WorkflowAnalysis;
};

export type WorkflowsPlatform = {
  /** The existing scheduled-task runtime owns reconciliation and persistence. */
  managesAnalysis?: boolean;
  ensureAnalysisTask?: () => Promise<void>;
  getLatestAnalysisJob?: () => Promise<WorkflowAnalysisJob | null>;
  cancelAnalysisJob?: () => Promise<void>;
  /** Observe the existing harness. Does not start or enable a task. */
  subscribeAnalysisActivity?: (
    jobId: string,
    onActivity: (items: WorkflowRunActivity[]) => void,
  ) => Promise<() => void>;
  /** Local, on-demand media only. Never persist the returned URL or upload it. */
  loadWorkflowRecording?: (
    timestamp: string,
    app: string,
  ) => Promise<WorkflowRecording | null>;
  releaseWorkflowRecording?: (url: string) => Promise<void>;
  openCapturedMoment?: (frameId: number, timestamp: string) => Promise<void>;
  assistant?: WorkflowsAssistantPlatform;
  /** The host can discover context without uploaded sources. */
  contextDiscovery?: boolean;
  fillContext?: (
    request: import("./context-tool").ContextFillRequest,
  ) => Promise<void>;
  ensureRuntime: () => Promise<WorkflowRuntime>;
  analyzeCapturedWork: (
    days: number,
    options?: WorkflowAnalysisOptions,
  ) => Promise<WorkflowAnalysis>;
  loadCapturedWork?: (
    days: number,
    options?: WorkflowAnalysisOptions,
  ) => Promise<WorkflowAnalysis | null>;
  saveCapturedWork?: (
    analysis: WorkflowAnalysis,
    options?: WorkflowAnalysisOptions,
  ) => Promise<void>;
  startAnalysisJob?: (
    days: number,
    options?: WorkflowAnalysisOptions,
  ) => Promise<WorkflowAnalysisJob>;
  getAnalysisJob?: (jobId: string) => Promise<WorkflowAnalysisJob>;
  loadWorkProfile?: (scope?: WorkflowScope) => Promise<WorkProfile | null>;
  saveWorkProfile?: (
    profile: WorkProfile,
    scope?: WorkflowScope,
  ) => Promise<WorkProfile>;
  guides?: {
    generate: (
      workflow: WorkflowMap,
      signal: AbortSignal,
      progress: (message: string) => void,
    ) => Promise<import("./guide").WorkflowGuide>;
    load: (
      workflow: WorkflowMap,
    ) => Promise<import("./guide").WorkflowGuide | null>;
    save: (guide: import("./guide").WorkflowGuide) => Promise<void>;
    edit?: (
      guide: WorkflowGuide,
      workflow: WorkflowMap,
      instruction: string,
      signal: AbortSignal,
      progress: (message: string) => void,
    ) => Promise<WorkflowGuide>;
    openWeb?: (guide: WorkflowGuide) => Promise<void>;
    export: (html: string, title: string) => Promise<boolean>;
  };
  generateWorkflowSkill?: (
    workflow: WorkflowMap,
    profile?: WorkProfile | null,
    onProgress?: (progress: WorkflowSkillProgress) => void,
  ) => Promise<WorkflowSkillDraft>;
  saveWorkflowSkill?: (
    draft: WorkflowSkillDraft,
  ) => Promise<SavedWorkflowSkill>;
  skillInstallMode?: "local" | "preview";
  openAccount?: () => Promise<void>;
  startWindowDrag?: () => Promise<void> | void;
};

export type WorkflowRecording = {
  kind: "video" | "image";
  url: string;
  timestamp: string;
  frameId: number;
  offsetSeconds: number;
  matchDistanceSeconds: number;
};

export type WorkflowsAppProps = {
  platform: WorkflowsPlatform;
  initialAnalysis?: WorkflowAnalysis | null;
  storageKey?: string | null;
  initialScopeId?: string;
  embedded?: boolean;
  /** Keep mounted while another workspace is visible, without global shortcuts. */
  active?: boolean;
  /** Native fullscreen state supplied by the host window. */
  fullscreen?: boolean;
  navigationFooter?: (actions: {
    openKeyboardShortcuts: () => void;
  }) => import("react").ReactNode;
  navigationBrand?: import("react").ReactNode;
  composerAccessory?: import("./assistant").WorkflowComposerAccessory;
  /** Open the host sharing review; clicking must not send the workflow. */
  onShareWorkflow?: (workflow: WorkflowMap) => void;
  /** Host-owned live recorder status and controls. */
  recordingStatus?: import("react").ReactNode;
  analysisUnavailableReason?: string;
  /** Explain access only after the user requests an update. */
  onAnalysisUnavailable?: () => void;
  statusNotice?: import("react").ReactNode;
};
