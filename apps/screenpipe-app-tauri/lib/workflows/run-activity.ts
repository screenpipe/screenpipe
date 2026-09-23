// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import type { WorkflowRunActivity } from "@screenpipe/workflows-ui";
import { mountAgentEventBus, registerObserver } from "@/lib/events/bus";
import { parsePipeSessionId } from "@/lib/events/types";
import { GENERIC_ACTIVITY, presentToolActivity } from "@/lib/chat/tool-presentation";
import { getApiBaseUrl } from "@/lib/api";

/** Read-only observer: keep Chat's event ownership and task lifecycle intact. */
export async function subscribeWorkflowActivity(jobId: string, onActivity: (items: WorkflowRunActivity[]) => void) {
  const [taskName, executionId] = jobId.includes(":") ? jobId.split(":") : ["workflow-discovery", jobId];
  const apiBase = getApiBaseUrl();
  await mountAgentEventBus();
  const items = new Map<string, WorkflowRunActivity>();
  const presentations = new Map<string, ReturnType<typeof presentToolActivity>>();
  return registerObserver(envelope => {
    const session = parsePipeSessionId(envelope.sessionId);
    if (getApiBaseUrl() !== apiBase || envelope.source !== "pipe" || session?.pipeName !== taskName
      || String(envelope.executionId ?? session.executionId) !== executionId) return;
    const event = envelope.event;
    if (event.type !== "tool_execution_start" && event.type !== "tool_execution_end") return;
    if (!event.toolCallId || !event.toolName) return;
    const running = event.type === "tool_execution_start";
    const presentation = presentations.get(event.toolCallId) ?? presentToolActivity({ toolName: event.toolName, args: event.args, kind: event.kind });
    presentations.set(event.toolCallId, presentation);
    // Generic tool completions do not describe a workflow step or saved result.
    // Keep meaningful actions and every failure, without filling the feed with
    // identical internal bookkeeping events. The run status stays active.
    if (presentation === GENERIC_ACTIVITY && !event.isError) {
      items.delete(event.toolCallId);
      presentations.delete(event.toolCallId);
      onActivity([...items.values()]);
      return;
    }
    items.set(event.toolCallId, { id: event.toolCallId,
      label: presentation === GENERIC_ACTIVITY ? "An update action failed" : event.isError ? `${presentation.runningLabel} · failed` : running ? presentation.runningLabel : presentation.completedLabel,
      status: event.isError ? "error" : running ? "running" : "complete" });
    // Bounded summaries only. Never retain commands, source text or tool results.
    while (items.size > 20) {
      const oldest = items.keys().next().value!;
      items.delete(oldest);
      presentations.delete(oldest);
    }
    onActivity([...items.values()]);
  });
}
