// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { localFetch } from "@/lib/api";
import type { WorkflowAnalysis, WorkflowAnalysisJob, WorkflowMap } from "@screenpipe/workflows-ui";

const TASK = "workflow-discovery";
async function request(path: string, body?: unknown) {
  const response = await localFetch(path, body === undefined ? undefined : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok || value.error) throw new Error(value.error || "Could not reach the workflow task.");
  return value;
}

// Installing the disabled template must never opt the user into background AI.
export async function ensureWorkflowTask() {
  await request(`/pipes/bundled/${TASK}/install`, {});
}

export interface WorkflowTaskSetup {
  enabled: boolean;
  title: string;
  schedule: string;
}

export async function loadWorkflowTaskSetup(): Promise<WorkflowTaskSetup> {
  await ensureWorkflowTask();
  const { data } = await request(`/pipes/${TASK}`);
  if (typeof data?.config?.enabled !== "boolean") throw new Error("Could not read the workflow task settings.");
  return { enabled: data.config.enabled, title: data.config.title || "Update my workflows", schedule: data.config.schedule };
}

// Only the explicit enable action opts in. Scheduling stays in the Pipe harness.
export async function enableWorkflowTask() {
  await ensureWorkflowTask();
  await request(`/pipes/${TASK}/enable`, { enabled: true });
}

export async function loadScheduledCatalog(): Promise<WorkflowAnalysis | null> {
  const value = await request("/workflows/catalog");
  return value.analyzedAt ? value as WorkflowAnalysis : null;
}

function job(execution: any): WorkflowAnalysisJob {
  const status = execution.status === "completed" ? "complete"
    : ["failed", "cancelled", "interrupted"].includes(execution.status) ? "failed"
    : execution.status === "running" ? "processing" : "queued";
  return { id: String(execution.id), status, startedAt: execution.started_at,
    message: execution.status === "cancelled" ? "Update stopped. Your saved workflows are still available."
      : status === "failed" ? "Could not update workflows. See the scheduled task for details."
      : status === "processing" ? "Updating workflows" : "Waiting to update workflows",
  };
}

export async function latestWorkflowJob(): Promise<WorkflowAnalysisJob | null> {
  const value = await request(`/pipes/${TASK}/executions?limit=1&include_output=false`);
  return value.data?.[0] ? job(value.data[0]) : null;
}

export async function getWorkflowJob(id: string): Promise<WorkflowAnalysisJob> {
  const value = await request(`/pipes/${TASK}/executions/${encodeURIComponent(id)}`);
  const state = job(value.data);
  if (state.status === "complete") {
    const result = await loadScheduledCatalog();
    if (!result || !result.checkedThrough || Date.parse(result.checkedThrough) < Date.parse(value.data.started_at)) return { ...state, status: "failed", message: "The task finished without saving workflows." };
    state.result = result;
  }
  return state;
}

export async function startWorkflowJob(): Promise<WorkflowAnalysisJob> {
  await ensureWorkflowTask();
  const current = await latestWorkflowJob();
  if (current && ["queued", "processing"].includes(current.status)) return current;
  const started = await request(`/pipes/${TASK}/run`, {});
  if (!Number.isInteger(started.execution_id)) throw new Error("The task did not return a tracked execution.");
  return { id: String(started.execution_id), status: "queued", message: "Waiting to update workflows" };
}

export async function stopWorkflowJob() { await request(`/pipes/${TASK}/stop`, {}); }

// Human edits share the backend writer with background commits. They cannot
// overwrite a newer catalog snapshot with an old React state object.
export async function saveWorkflowCorrections(analysis: WorkflowAnalysis) {
  const current = await loadScheduledCatalog();
  for (const workflow of analysis.analysis.workflows) {
    const prior = current?.analysis.workflows.find(w => workflow.id ? w.id === workflow.id
      : w.title === workflow.title && w.trigger === workflow.trigger && w.outcome === workflow.outcome);
    if (!prior?.id) continue;
    if (JSON.stringify(prior?.userCorrection) === JSON.stringify(workflow.userCorrection)) continue;
    await request("/workflows/corrections", { id: prior.id, correction: workflow.userCorrection ?? null });
  }
}

/** Uses the same catalog writer and correction storage as manual edits. */
export async function saveWorkflowFeedback(workflow: WorkflowMap, feedback: string) {
  if (!workflow.id) throw new Error("Refresh this workflow before sending feedback.");
  await request("/workflows/corrections", { id: workflow.id, correction: feedback });
}
