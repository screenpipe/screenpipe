// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
export type CloudProcedureStep = {
  id: string;
  action: string;
  kind: "action" | "decision" | "check";
  app: string;
  detail: string;
  expected_result: string;
  caveat: string;
  required_access: string;
  escalation: string;
  response_template: string;
  next_step_id?: string;
  decision?: {
    condition: string;
    if_yes: string;
    if_no: string;
    yes_step_id?: string;
    no_step_id?: string;
  };
};
export type CloudProcedureDocument = {
  steps: CloudProcedureStep[];
  sop_document?: unknown;
};
export type CloudProcedure = {
  document: CloudProcedureDocument;
  revision: number;
  source_version: number;
  can_edit: boolean;
  actor_scope?: string;
  review: { frozen: boolean; status: string };
};
export type CloudWorkflowIdentity = {
  license_id: string;
  artifact_id: string;
  workflow_id: string;
};
export type CloudEditProposal = {
  document: CloudProcedureDocument;
  expected_revision: number;
  source_version: number;
  summary: string;
};
export type CloudDraftStore = {
  load: (key: string) => Promise<CloudProcedure | null>;
  save: (key: string, draft: CloudProcedure | null) => Promise<void>;
};
export class CloudWorkflowAccessError extends Error {}
export async function cloudWorkflowRequest(
  request: typeof fetch,
  path: string,
  identity: CloudWorkflowIdentity,
  method = "GET",
  body?: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 25_000);
  if (signal?.aborted) controller.abort();
  try {
    const response = await request(
      `/api/enterprise/member-workflows/${path}${method === "GET" ? `?${new URLSearchParams({ ...identity, ...body } as Record<string, string>)}` : ""}`,
      {
        method,
        cache: "no-store",
        signal: controller.signal,
        headers:
          method === "GET" ? undefined : { "Content-Type": "application/json" },
        ...(method === "GET"
          ? {}
          : { body: JSON.stringify({ ...identity, ...body }) }),
      },
    );
    const data = await response.json();
    if (!response.ok) {
      const message = data.error || "Could not load your workflow. Try again.";
      if ([401, 403, 404].includes(response.status))
        throw new CloudWorkflowAccessError(message);
      throw new Error(message);
    }
    return data;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
export function isCloudProcedure(value: unknown): value is CloudProcedure {
  const v = value as CloudProcedure | null;
  const fields = [
    "id",
    "action",
    "app",
    "detail",
    "expected_result",
    "caveat",
    "required_access",
    "escalation",
    "response_template",
  ] as const;
  return Boolean(
    v &&
    Number.isInteger(v.revision) &&
    v.revision >= 0 &&
    Number.isInteger(v.source_version) &&
    v.source_version > 0 &&
    typeof v.can_edit === "boolean" &&
    v.review &&
    typeof v.review.frozen === "boolean" &&
    typeof v.review.status === "string" &&
    Array.isArray(v.document?.steps) &&
    v.document.steps.length <= 100 &&
    v.document.steps.every(
      (step) =>
        step &&
        fields.every((field) => typeof step[field] === "string") &&
        ["action", "check", "decision"].includes(step.kind),
    ),
  );
}

/** Adapt canonical cloud steps to the existing workflow document editor. */
export function cloudProcedureWorkflow(base: import("./model").WorkflowMap, value: CloudProcedure): import("./model").WorkflowMap {
  return {
    ...base, revision: value.revision,
    stages: value.document.steps.map(step => ({
      name: step.action, description: step.detail, apps: step.app ? [step.app] : [],
      activeMinutes: 0, waitingMinutes: 0, durationSource: "unknown" as const,
      confidence: 0, observedOccurrences: 0, observedDays: 0, evidence: [],
      procedure: step.expected_result ? [{ kind: "check" as const, text: step.expected_result, app: step.app, quote: "", timestamp: "" }] : [],
    })),
  };
}
export function cloudProcedureEdit(current: CloudProcedure, edit: import("./workflow-edits").WorkflowEdit): CloudProcedure {
  const steps = edit.stages.map(stage => {
    const original = stage.sourceIndex === null ? undefined : current.document.steps[stage.sourceIndex];
    return {
      id: original?.id ?? crypto.randomUUID(), kind: original?.kind ?? "action" as const,
      app: "", caveat: "", required_access: "", escalation: "", response_template: "",
      ...original, action: stage.name, detail: stage.description,
      expected_result: stage.procedure.map(p => p.text).join("\n\n"),
    };
  });
  const ids = new Set(steps.map(s => s.id));
  return { ...current, revision: edit.expected_revision, document: { ...current.document, steps: steps.map(step => ({
    ...step, next_step_id: step.next_step_id && ids.has(step.next_step_id) ? step.next_step_id : undefined,
    ...(step.decision ? { decision: { ...step.decision,
      yes_step_id: step.decision.yes_step_id && ids.has(step.decision.yes_step_id) ? step.decision.yes_step_id : undefined,
      no_step_id: step.decision.no_step_id && ids.has(step.decision.no_step_id) ? step.decision.no_step_id : undefined,
    } } : {}),
  })) } };
}
