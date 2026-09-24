// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { requireWorkflowsRollout, syncWorkflowsRollout } from "./rollout";
import { localFetch } from "@/lib/api";
import type { WorkflowAnalysis, WorkflowAnalysisJob, WorkflowMap } from "@screenpipe/workflows-ui";

export const WORKFLOW_TASKS = ["workflow-discover", "workflow-deepen", "workflow-review", "workflow-maintain"] as const;
const LEGACY_TASKS = ["workflow-activity", "workflow-patterns", "workflow-procedures", "workflow-timing", "workflow-discovery"];
const TASK = "workflow-review";
async function request(path: string, body?: unknown, signal?: AbortSignal) {
  const response = await localFetch(path, body === undefined ? (signal ? { signal } : undefined) : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok || value.error) throw Object.assign(new Error(value.error || "Could not reach the workflow task."), { status: response.status });
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const tasks = [];
    for (const name of WORKFLOW_TASKS) {
      const response = await localFetch(`/pipes/${name}`, { signal: controller.signal });
      // Inspection never installs or enables tasks. Missing roles are off;
      // explicit enable installs the disabled templates before opting in.
      if (response.status === 404) {
        tasks.push({ name, title: name, enabled: false });
        continue;
      }
      if (!response.ok) throw new Error("Could not read the workflow task settings.");
      const { data } = await response.json();
      if (typeof data?.config?.enabled !== "boolean") throw new Error("Could not read the workflow task settings.");
      tasks.push({ name, title: data.config.title || name, enabled: data.config.enabled });
    }
    return { enabled: tasks.every(task => task.enabled), title: "Keep your workflows current", schedule: "Hourly discovery, with evidence review and maintenance", tasks };
  } finally {
    clearTimeout(timeout);
  }
}

// Only the explicit enable action opts in. Scheduling stays in the Pipe harness.
export async function enableWorkflowTask() {
  await ensureWorkflowTask();
  requireWorkflowsRollout();
  await syncWorkflowsRollout(true);
  // Explicit opt-in replaces the old group, preserving its files and custom prompts.
  // A disabled old pipe can still be inspected or re-enabled by its owner.
  for (const task of LEGACY_TASKS) {
    const response = await localFetch(`/pipes/${task}`);
    if (response.status === 404) continue;
    if (!response.ok) throw new Error("Could not inspect the previous workflow tasks.");
    await request(`/pipes/${task}/enable`, { enabled: false });
    await request(`/pipes/${task}/stop`, {});
  }
  // Enable Discover last so a scheduled entry cannot outrun setup.
  for (const task of [...WORKFLOW_TASKS].reverse()) await request(`/pipes/${task}/enable`, { enabled: true });
  const setup = await loadWorkflowTaskSetup();
  if (!setup.enabled) throw new Error("Some workflow tasks could not be enabled.");
}

/** Disable every role even if one request fails. Never grant access to turn off. */
export async function disableWorkflowTasks() {
  const results = await Promise.allSettled(WORKFLOW_TASKS.map(async task => {
    const response = await localFetch(`/pipes/${task}/enable`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    // A missing task cannot be scheduled. Do not install it just to disable it.
    if (response.status === 404) return;
    const value = await response.json();
    if (!response.ok || value.error) throw new Error("Could not turn off all workflow tasks.");
  }));
  const failed = results.find(result => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}

export async function loadScheduledCatalog(signal?: AbortSignal): Promise<WorkflowAnalysis | null> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal?.aborted) cancel();
  signal?.addEventListener("abort", cancel, { once: true });
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 10_000);
  try {
    const value = await request("/workflows/catalog", undefined, controller.signal);
    return value.analyzedAt ? value as WorkflowAnalysis : null;
  } catch (error) {
    if (timedOut && !signal?.aborted) throw new DOMException("Workflow catalog request timed out", "TimeoutError");
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", cancel);
  }
}

function job(execution: any): WorkflowAnalysisJob {
  const interrupted = execution.error_type === "interrupted" || execution.status === "interrupted";
  const status = interrupted ? "incomplete" : execution.status === "completed" ? "complete"
    : ["failed", "cancelled", "interrupted", "timed_out"].includes(execution.status) ? "failed"
    : execution.status === "running" ? "processing" : "queued";
  return { id: String(execution.id), status, startedAt: execution.started_at,
    message: interrupted ? "Screenpipe restarted during the update. Resume to continue from saved progress."
      : execution.status === "cancelled" ? "Update stopped. Your saved workflows are still available."
      : String(`${execution.error_type || ""} ${execution.error_message || ""}`).includes("workflow_allowance_paused") ? "Workflow updates paused to preserve AI allowance. Manage usage to increase capacity or check reset times."
      : String(`${execution.error_type || ""} ${execution.error_message || ""}`).includes("workflow_business_required") ? "Automatic workflow discovery requires Business. Your saved workflows are still available."
      : String(`${execution.error_type || ""} ${execution.error_message || ""}`).includes("workflow_usage_unavailable") ? "Could not check AI allowance. Reconnect and try again."
      : String(`${execution.error_type || ""} ${execution.error_message || ""}`).includes("workflow_sign_in_required") ? "Sign in again to resume workflow updates."
      : String(`${execution.error_type || ""} ${execution.error_message || ""}`).includes("workflow_rollout_disabled") ? "Workflows access was not confirmed. Try Update now to reconnect."
      : execution.error_type === "missing_output" ? "The update could not be saved. Your previous workflows are still available. Try again."
      : status === "failed" ? "Could not update workflows. Your saved workflows are still available. See the scheduled task for details."
      : status === "processing" ? "Updating workflows" : "Waiting to update workflows",
  };
}

function tracked(execution: any, task: string): WorkflowAnalysisJob {
  const state = job(execution);
  const index = WORKFLOW_TASKS.indexOf(task as any);
  const names = ["Discovering workflows", "Investigating workflow evidence", "Reviewing workflow drafts", "Checking feedback and existing workflows"];
  return { ...state, id: `${task}:${execution.id}`, ...(state.status === "processing" ? {message:names[index]} : {}) };
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

async function workspace() {
  return request(`/workflows/workspace?task=${TASK}`);
}

export async function getWorkflowJob(id: string): Promise<WorkflowAnalysisJob> {
  const [state, tasks] = await Promise.all([workspace(), latestTasks()]);
  const ws = state.workspace;
  const cycleId = typeof ws.cycle?.id === "string" ? ws.cycle.id : undefined;
  const running = tasks.find(item => ["running", "queued"].includes(item.execution?.status));
  if (running) return { ...tracked(running.execution, running.task), cycleId };
  const startedAt = ws.cycle?.end;
  if (ws.cycle?.status === "paused") return { id, cycleId, startedAt, status: "incomplete", message: "Update stopped. Resume to continue from saved progress." };
  if (ws.cycle?.status === "complete") {
    const result = await loadScheduledCatalog();
    // Completion is the atomic receipt for this exact requested interval.
    if (result && result.checkedThrough === ws.cycle.end) return { id, cycleId, startedAt, status: "complete", result };
  }
  const failure = tasks.filter(item => item.execution && ["failed", "cancelled", "interrupted", "timed_out"].includes(item.execution.status)
    && Date.parse(item.execution.started_at) >= Date.parse(startedAt || ""))
    .sort((a,b) => Date.parse(b.execution.started_at) - Date.parse(a.execution.started_at))[0];
  if (failure) return { ...tracked(failure.execution, failure.task), cycleId };
  const lastFinished = Math.max(Date.parse(startedAt || "") || 0, ...tasks.map(item => Date.parse(item.execution?.finished_at || "") || 0));
  // Completion events normally wake the next agent. Scheduled readiness checks
  // recover a missed event or a review handoff that triggers chain cooldown.
  if (ws.cycle?.status === "running" && Date.now() - lastFinished < 360_000) {
    return { id, cycleId, startedAt, status: "queued", message: "Preparing the next workflow agent" };
  }
  const open = Object.values(ws.drafts || {}).filter((draft: any) => draft.status === "open").length;
  return { id, cycleId, startedAt, status: "incomplete", message: open
    ? `${open} workflow draft${open === 1 ? "" : "s"} awaiting investigation or review. Resume to continue.`
    : "The requested update is not complete yet. Resume to continue from saved progress." };
}

export async function startWorkflowJob(): Promise<WorkflowAnalysisJob> {
  requireWorkflowsRollout();
  await syncWorkflowsRollout(true);
  const setup = await loadWorkflowTaskSetup();
  if (!setup.enabled) throw new Error("Enable workflow tasks with Automatic updates before updating.");
  const tasks = await latestTasks();
  const running = tasks.find(item => ["running", "queued"].includes(item.execution?.status));
  if (running) return getWorkflowJob(`${running.task}:${running.execution.id}`);
  // Starting a new cycle fixes the requested end once. Resuming retains it.
  const startedCycle = await request("/workflows/workspace", {action:"start", task:WORKFLOW_TASKS[0]});
  // An explicit update/resume wakes every ready agent. A repeated wake event
  // may already be acknowledged by the scheduler from an interrupted run.
  const ready = await Promise.all(WORKFLOW_TASKS.map(async task => ({
    task, input: await request(`/workflows/workspace?task=${task}`),
  })));
  const pending = ready.filter(item => item.input.ready);
  if (!pending.length) throw new Error("No workflow work is ready. Check the saved draft status.");
  const started = await Promise.all(pending.map(async ({task}) => {
    try {
      const value = await request(`/pipes/${task}/run`, {});
      if (!Number.isInteger(value.execution_id)) throw new Error("The task did not return a tracked execution.");
      return {task, id:value.execution_id};
    } catch (error) {
      // A scheduler wake can win between readiness and the manual start. Only
      // coalesce with a persisted active execution; don't hide other failures.
      const {data} = await request(`/pipes/${task}/executions?limit=1&include_output=false`);
      const active = data?.[0];
      if (Number.isInteger(active?.id) && ["running", "queued"].includes(active.status)) {
        return {task, id:active.id};
      }
      throw error;
    }
  }));
  return { id: `${started[0].task}:${started[0].id}`, cycleId: typeof startedCycle.cycle?.id === "string" ? startedCycle.cycle.id : undefined, status: "queued", message: "Preparing workflow updates" };
}

export async function stopWorkflowJob() {
  // Persist this cycle's stop before cancelling runners. Readiness checks and
  // late writes observe the pause without changing recurring task preferences.
  await request("/workflows/workspace", { action: "pause", task: WORKFLOW_TASKS[0] });
  const stopped = await Promise.allSettled(WORKFLOW_TASKS.map(task => request(`/pipes/${task}/stop`, {})));
  const failed = stopped.find(result => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
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

export async function saveWorkflowEdits(draft: import("@screenpipe/workflows-ui").WorkflowEdit): Promise<WorkflowMap> {
  const result = await request("/workflows/edits", draft);
  if (result.workflow?.id !== draft.id) throw new Error("The saved workflow could not be confirmed. Your draft is kept.");
  return result.workflow;
}
