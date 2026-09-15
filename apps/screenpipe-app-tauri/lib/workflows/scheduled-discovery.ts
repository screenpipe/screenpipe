// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { localFetch } from "@/lib/api";
import type { WorkflowAnalysis, WorkflowAnalysisJob } from "@screenpipe/workflows-ui";

const TASK = "workflow-discovery";
async function request(path: string, body?: unknown) {
  const response = await localFetch(path, body === undefined ? undefined : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok || value.error) throw new Error(value.error || "Could not reach the workflow task.");
  return value;
}

// Installation is idempotent and never re-enables a task the user paused.
export async function ensureWorkflowTask() {
  const result = await request(`/pipes/bundled/${TASK}/install`, {});
  if (result.installed) await request(`/pipes/${TASK}/enable`, { enabled: true });
}

export async function loadScheduledCatalog(): Promise<WorkflowAnalysis | null> {
  const value = await request("/workflows/catalog");
  return value.analyzedAt ? value as WorkflowAnalysis : null;
}

function job(execution: any): WorkflowAnalysisJob {
  const status = execution.status === "completed" ? "complete"
    : ["failed", "cancelled", "interrupted"].includes(execution.status) ? "failed"
    : execution.status === "running" ? "processing" : "queued";
  return { id: String(execution.id), status,
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
    if (!workflow.id) continue;
    const prior = current?.analysis.workflows.find(w => w.id === workflow.id);
    if (JSON.stringify(prior?.userCorrection) === JSON.stringify(workflow.userCorrection)) continue;
    await request("/workflows/corrections", { id: workflow.id, correction: workflow.userCorrection ?? null });
  }
}
