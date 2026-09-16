// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { requireWorkflowsRollout } from "./rollout";
import { localFetch } from "@/lib/api";
import type { WorkflowAnalysis, WorkflowAnalysisJob, WorkflowMap } from "@screenpipe/workflows-ui";

export const WORKFLOW_TASKS = ["workflow-activity", "workflow-patterns", "workflow-procedures", "workflow-timing", "workflow-discovery"] as const;
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
  requireWorkflowsRollout();
  for (const task of WORKFLOW_TASKS) await request(`/pipes/bundled/${task}/install`, {});
}

export interface WorkflowTaskSetup {
  enabled: boolean;
  title: string;
  schedule: string;
  tasks?: { name: string; title: string; enabled: boolean }[];
}

export async function loadWorkflowTaskSetup(): Promise<WorkflowTaskSetup> {
  await ensureWorkflowTask();
  const tasks = [];
  for (const name of WORKFLOW_TASKS) {
    const { data } = await request(`/pipes/${name}`);
    if (typeof data?.config?.enabled !== "boolean") throw new Error("Could not read the workflow task settings.");
    tasks.push({ name, title: data.config.title || name, enabled: data.config.enabled });
  }
  return { enabled: tasks.every(task => task.enabled), title: "Keep your workflows current", schedule: "Daily, with dependent updates", tasks };
}

// Only the explicit enable action opts in. Scheduling stays in the Pipe harness.
export async function enableWorkflowTask() {
  await ensureWorkflowTask();
  // Enable dependencies last so a scheduled entry cannot outrun setup.
  for (const task of [...WORKFLOW_TASKS].reverse()) await request(`/pipes/${task}/enable`, { enabled: true });
  const setup = await loadWorkflowTaskSetup();
  if (!setup.enabled) throw new Error("Some workflow tasks could not be enabled.");
}

export async function loadScheduledCatalog(): Promise<WorkflowAnalysis | null> {
  const value = await request("/workflows/catalog");
  return value.analyzedAt ? value as WorkflowAnalysis : null;
}

function job(execution: any): WorkflowAnalysisJob {
  const status = execution.status === "completed" ? "complete"
    : ["failed", "cancelled", "interrupted", "timed_out"].includes(execution.status) ? "failed"
    : execution.status === "running" ? "processing" : "queued";
  return { id: String(execution.id), status, startedAt: execution.started_at,
    message: execution.status === "cancelled" ? "Update stopped. Your saved workflows are still available."
      : String(`${execution.error_type || ""} ${execution.error_message || ""}`).includes("workflow_allowance_paused") ? "Workflow updates paused to preserve AI allowance. Manage usage to increase capacity or check reset times."
      : String(`${execution.error_type || ""} ${execution.error_message || ""}`).includes("workflow_business_required") ? "Automatic workflow discovery requires Business. Your saved workflows are still available."
      : String(`${execution.error_type || ""} ${execution.error_message || ""}`).includes("workflow_usage_unavailable") ? "Could not check AI allowance. Reconnect and try again."
      : String(`${execution.error_type || ""} ${execution.error_message || ""}`).includes("workflow_sign_in_required") ? "Sign in again to resume workflow updates."
      : execution.error_type === "missing_output" ? "The update could not be saved. Your previous workflows are still available. Try again."
      : status === "failed" ? "Could not update workflows. Your saved workflows are still available. See the scheduled task for details."
      : status === "processing" ? "Updating workflows" : "Waiting to update workflows",
  };
}

function tracked(execution: any, task: string): WorkflowAnalysisJob {
  const state = job(execution);
  const index = WORKFLOW_TASKS.indexOf(task as any);
  const names = ["Organizing captured activity", "Grouping recurring workflows", "Understanding workflow steps", "Measuring workflow occurrences", "Reviewing and saving workflows"];
  return { ...state, id: `${task}:${execution.id}`, ...(state.status === "processing" ? {message:`${names[index]} · ${index+1}/5`} : {}) };
}
async function latestTasks() {
  return Promise.all(WORKFLOW_TASKS.map(async task => {
    const value = await request(`/pipes/${task}/executions?limit=1&include_output=false`);
    return { task, execution: value.data?.[0] };
  }));
}
export async function latestWorkflowJob(): Promise<WorkflowAnalysisJob | null> {
  const latest = (await latestTasks()).filter(item => item.execution)
    .sort((a,b) => Date.parse(b.execution.started_at) - Date.parse(a.execution.started_at))[0];
  return latest ? getWorkflowJob(`${latest.task}:${latest.execution.id}`) : null;
}

export async function getWorkflowJob(id: string): Promise<WorkflowAnalysisJob> {
  const [name, executionId] = id.includes(":") ? id.split(":") : [TASK, id];
  if (!WORKFLOW_TASKS.includes(name as any) || !/^\d+$/.test(executionId)) throw new Error("Invalid workflow execution.");
  const { data } = await request(`/pipes/${name}/executions/${executionId}`);
  const original = tracked(data, name);
  // Compatibility with a saved pre-pipeline job.
  if (!id.includes(":")) {
    if (original.status !== "complete") return original;
    const result = await loadScheduledCatalog();
    if (!result || !Number.isFinite(Date.parse(result.checkedThrough || "")) || !Number.isFinite(Date.parse(data.started_at)) || Date.parse(result.checkedThrough || "") < Date.parse(data.started_at)) return { ...original, status: "failed", message: "The update could not be saved. Your previous workflows are still available." };
    return { ...original, result };
  }
  const tasks = await latestTasks();
  const running = tasks.find(item => ["running", "queued"].includes(item.execution?.status));
  if (running) return tracked(running.execution, running.task);
  // A later dependency can finish without input. It must not hide the failure
  // that prevented this cycle's activity scan from producing any input.
  const cycleStart = Date.parse(tasks.find(item => item.task === WORKFLOW_TASKS[0])?.execution?.started_at || data.started_at);
  const failure = tasks.find(item => item.execution && ["failed", "cancelled", "interrupted", "timed_out"].includes(item.execution.status)
    && Date.parse(item.execution.started_at) >= cycleStart);
  if (failure) return tracked(failure.execution, failure.task);
  const pipeline = await request(`/workflows/pipeline?task=${TASK}`);
  const result = await loadScheduledCatalog();
  if (pipeline.upToDate && pipeline.inputRevision > 0 && (result as any)?.pipelineRevision === pipeline.inputRevision) return { ...original, status: "complete", result: result! };
  // An existing completed single-task run predates the enrichment pipeline.
  // Preserve its verified receipt until the first new pipeline input exists.
  if (!pipeline.inputRevision && !(result as any)?.pipelineRevision && original.status === "complete"
    && result?.checkedThrough && Number.isFinite(Date.parse(data.started_at))
    && Date.parse(result.checkedThrough) >= Date.parse(data.started_at)) return { ...original, result };
  if (pipeline.blockedReason) return { ...original, status: "failed", message: pipeline.blockedReason };
  // Completion events normally start the next stage immediately. Bound waiting
  // so a missed event or disabled task never leaves a permanent spinner.
  const latest = tasks.filter(item => item.execution).sort((a,b) => Date.parse(b.execution.finished_at || b.execution.started_at) - Date.parse(a.execution.finished_at || a.execution.started_at))[0];
  const finished = Date.parse(latest?.execution.finished_at || data.started_at);
  // Allow several 30-second scheduler ticks, including its run stagger.
  if (Date.now() - finished > 90_000) return { ...original, status: "incomplete", message: "Update paused before all stages finished. Resume to continue; your saved workflows are still available." };
  return { ...original, status: "queued", message: "Preparing the next enrichment task" };
}

export async function startWorkflowJob(): Promise<WorkflowAnalysisJob> {
  requireWorkflowsRollout();
  const setup = await loadWorkflowTaskSetup();
  if (!setup.enabled) throw new Error("Enable workflow tasks before updating. Open Workflows again to review setup.");
  const tasks = await latestTasks();
  const running = tasks.find(item => ["running", "queued"].includes(item.execution?.status));
  if (running) return tracked(running.execution, running.task);
  // Resume unfinished downstream work before reading more history.
  let next: string = WORKFLOW_TASKS[0];
  for (const task of WORKFLOW_TASKS.slice(1)) {
    const input = await request(`/workflows/pipeline?task=${task}`);
    if (input.ready) { next = task; break; }
  }
  const started = await request(`/pipes/${next}/run`, {});
  if (!Number.isInteger(started.execution_id)) throw new Error("The task did not return a tracked execution.");
  return { id: `${next}:${started.execution_id}`, status: "queued", message: "Preparing workflow updates" };
}

export async function stopWorkflowJob() {
  // Pause the group first so completion events cannot launch its next stage.
  for (const task of WORKFLOW_TASKS) await request(`/pipes/${task}/enable`, { enabled: false });
  for (const task of WORKFLOW_TASKS) await request(`/pipes/${task}/stop`, {});
}

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

/** Compare-and-save a scoped feedback refinement through the catalog writer. */
export async function applyWorkflowFeedback(workflow: WorkflowMap, learning: string, changes: Record<string, string>) {
  if (!workflow.id) throw new Error("This workflow no longer exists.");
  const prior = workflow.userCorrection?.trim() || "";
  const note = `User feedback: ${learning.trim()}`;
  const correction = prior.includes(note) ? prior : [prior, note].filter(Boolean).join("\n\n");
  const result = await request("/workflows/corrections", { id: workflow.id, correction, expected_revision: workflow.revision ?? 0, changes });
  if (!result.success || result.workflow?.id !== workflow.id) throw new Error("Could not verify the saved workflow refinement.");
  return result.workflow as WorkflowMap;
}
