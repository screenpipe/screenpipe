// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

export type WorkflowRuntime = {
  source: "screenpipe" | "workflows" | "starting";
  recording: boolean;
  apiBaseUrl?: string | null;
  authenticatedLocalApi: boolean;
  cloudAuthAvailable: boolean;
  processingAvailable: boolean;
  reason: string;
  captureLocation?: "device";
  processingLocation?: "device" | "cloud" | "confidential-cloud";
  syncState?: "local-only" | "uploading" | "synced" | "unavailable";
  workspace?: {
    id: string;
    name: string;
    role: "member" | "manager" | "admin";
  } | null;
  availableScopes?: WorkflowScope[];
  dataBoundary?: WorkflowDataBoundary;
};

export type WorkflowDataBoundary = {
  owner: "employee" | "workspace";
  rawHistory: "device-only" | "workspace-cloud";
  screenshots: "device-only" | "workspace-approved";
  workspaceVisibility: "none" | "employee-approved" | "aggregate-only";
  managerRawAccess: boolean;
  retention: {
    controlledBy: "employee" | "workspace";
    recommendedMinimumDays?: number;
    recommendedMaximumDays?: number;
  };
  archive: {
    status: "off" | "end-to-end-encrypted";
    recoveryControlledBy: "employee" | "workspace";
  };
};

export type WorkflowScopeKind = "personal" | "team" | "organization" | "project";

export type WorkflowScope = {
  id: string;
  kind: WorkflowScopeKind;
  label: string;
  detail?: string;
};

export type WorkProfileKpi = {
  name: string;
  definition: string;
  target: string;
  cadence: string;
  owner: string;
};

export type WorkProfile = {
  scope: "personal" | "workspace";
  summary: string;
  priorities: string;
  kpis: WorkProfileKpi[];
  hourlyValue: {
    amount: number;
    currency: string;
    basis: "personal-estimate" | "blended-cost";
  } | null;
  vocabulary: string;
  guidance: string;
  visibility: "device-only" | "aggregate-workspace";
  updatedAt?: string;
};

export type WorkflowEvidence = {
  timestamp: string;
  app: string;
  detail: string;
  source?: "parsed" | "screen" | "audio" | "meeting" | string;
  speaker?: string | null;
};

export type WorkflowScreenshot = {
  frameId: number;
  timestamp: string;
  app: string;
  matchDistanceSeconds: number;
  dataUrl: string;
};

export type WorkflowStage = {
  name: string;
  description: string;
  activeMinutes: number;
  waitingMinutes: number;
  durationSource?: "unknown";
  apps: string[];
  confidence: number;
  observedOccurrences: number;
  observedDays: number;
  evidence: WorkflowEvidence[];
  screenshot?: WorkflowScreenshot | null;
};

export type WorkflowQualityGrade = "strong" | "good" | "limited";

export type WorkflowQuality = {
  grade: WorkflowQualityGrade;
  evidenceCount: number;
  distinctDays: number;
  stageEvidenceCoverage: number;
  repeatedStageCoverage: number;
  screenshotCount: number;
  stageScreenshotCoverage: number;
  reasons: string[];
};

export type WorkflowBottleneck = {
  label: string;
  stage: string;
  type: "waiting" | "switching" | "rework" | "handoff" | "unclear";
  control?: "direct" | "influence" | "external" | "required";
  controlReason?: string;
  detail: string;
  estimatedMinutesPerRun: number;
  confidence: number;
  evidence: string;
};

export type WorkflowMap = {
  rank: number;
  analysisDays: number;
  title: string;
  description: string;
  repetitions: number;
  frequency: string;
  trigger: string;
  outcome: string;
  totalMinutes: number;
  activeMinutes: number;
  waitingMinutes: number;
  durationSource?: "measured-meeting" | "unknown";
  durationSampleCount?: number;
  appSwitches: number;
  confidence: number;
  apps: string[];
  people?: string[];
  teams?: string[];
  handoffs: string[];
  variations: string[];
  stages: WorkflowStage[];
  bottlenecks: WorkflowBottleneck[];
  evidence: WorkflowEvidence[];
  quality: WorkflowQuality;
};

export type TimeAllocationItem = {
  label: string;
  description: string;
  minutes: number;
  percentage: number;
  confidence: number;
  distinctDays: number;
  apps: string[];
  evidence: WorkflowEvidence[];
  basis?: "recorder-app" | "recorder-category" | "explicit-project";
};

export type TimeProfileDimension = {
  items: TimeAllocationItem[];
  attributedMinutes: number;
  unattributedMinutes: number;
  coveragePercent: number;
};

export type TimeProfile = {
  days: number;
  totalMinutes: number;
  categories: TimeProfileDimension;
  projects: TimeProfileDimension;
  people: TimeProfileDimension;
  companies: TimeProfileDimension;
};

export type AnalysisQuality = {
  grade: WorkflowQualityGrade;
  usableDays: number;
  requestedDays: number;
  capturedMinutes: number;
  totalFrames: number;
  appAttributionCoverage: number;
  parsedContextCount: number;
  verifiedEvidenceCount: number;
  screenshotCount: number;
  screenshotCoverage: number;
  warnings: string[];
};

export type WorkflowAnalysis = {
  schemaVersion: 5;
  analysis: { workflows: WorkflowMap[] };
  analyzedAt: string;
  days: number;
  source: "screenpipe" | "workflows";
  bundleCount: number;
  observedActiveMinutes: number;
  timeProfile?: TimeProfile | null;
  quality: AnalysisQuality;
  scope?: WorkflowScope;
  processing?: {
    location: "device" | "cloud" | "confidential-cloud";
    label: string;
  };
};
