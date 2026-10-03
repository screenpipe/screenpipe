// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { localFetch } from "@/lib/api";
import { WORKFLOW_TASKS } from "./scheduled-discovery";

export const LOCAL_WORKFLOW_TASKS = [...WORKFLOW_TASKS, "workflow-activity", "workflow-patterns", "workflow-procedures", "workflow-timing", "workflow-discovery"];
/** Disable persisted schedules, stop current runs, then read back. Never touch capture. */
export async function stopLocalWorkflowProcessing(signal?: AbortSignal) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal?.aborted) cancel();
  signal?.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(cancel, 15_000);
  async function request(path: string, body?: unknown) {
    controller.signal.throwIfAborted();
    const response = await localFetch(path, { signal: controller.signal, ...(body === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }) });
    if (response.status === 404) return null;
    const value = await response.json();
    if (!response.ok || value.error) throw new Error("Could not stop local workflow analysis.");
    return value;
  }
  try {
    const listed = await request("/pipes");
    if (!Array.isArray(listed?.data) || listed.data.some((pipe: any) => typeof pipe?.config?.name !== "string")) throw new Error("Could not check local workflow tasks.");
    const installed = LOCAL_WORKFLOW_TASKS.filter(name => listed.data.some((pipe: { config: { name: string } }) => pipe.config.name === name));
    if (installed.every(name => listed.data.some((pipe: any) => pipe.config.name === name && pipe.config.enabled === false && pipe.is_running === false))) return;
    // Persist schedules first. A slow or failed pause must not prevent attempts
    // to stop the agents, and a failed task must not leave its siblings enabled.
    const disabled = await Promise.allSettled(installed.map(task => request(`/pipes/${task}/enable`, { enabled: false })));
    const currentTasks = installed.some(name => (WORKFLOW_TASKS as readonly string[]).includes(name));
    const stopped = await Promise.allSettled([
      ...(currentTasks ? [request("/workflows/workspace", { action: "pause", task: WORKFLOW_TASKS[0] })] : []),
      ...installed.map(task => request(`/pipes/${task}/stop`, {})),
    ]);
    const verified = await Promise.allSettled(installed.map(async task => {
      const value = await request(`/pipes/${task}`);
      if (value !== null && (value.data?.config?.enabled !== false || value.data?.is_running !== false)) throw new Error("Local workflow analysis has not stopped yet.");
    }));
    if ([...disabled, ...stopped, ...verified].some(result => result.status === "rejected")) throw new Error("Could not confirm local workflow analysis is off. Retry when the recorder is connected.");
  } finally { clearTimeout(timeout); signal?.removeEventListener("abort", cancel); }
}
