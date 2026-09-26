// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import posthog from "posthog-js";

const PENDING = "screenpipe:workflow-review-request";
const OUTCOMES = "screenpipe:workflow-review-outcomes";
const ATTRIBUTION = "screenpipe:workflow-review-attribution";
export const WORKFLOW_REVIEW_EVENT = "workflows:review-request";
export type WorkflowReviewRequest = { key: string; workflowId?: string; workflowIds?: string[] };

export function workflowReviewLink(value: string): { workflowId?: string; workflowIds?: string[] } | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "screenpipe:" || url.hostname !== "workflows" || !["", "/"].includes(url.pathname)) return null;
    const id = url.searchParams.get("workflow");
    if (id !== null && !/^wf-[a-zA-Z0-9_-]{1,128}$/.test(id)) return null;
    const ids = url.searchParams.get("workflows")?.split(",");
    if (ids && (ids.length > 100 || ids.some(value => !/^wf-[a-zA-Z0-9_-]{1,128}$/.test(value)))) return null;
    return id ? { workflowId: id } : ids ? { workflowIds: [...new Set(ids)] } : {};
  } catch { return null; }
}

export function workflowReviewClicked() {
  posthog.capture("workflow_notification_clicked", { notification_category: "workflow_review", reason: "webview_action" });
}

export function rememberWorkflowReview(request: WorkflowReviewRequest) {
  try {
    if (sessionStorage.getItem("screenpipe:last-workflow-review-request") === request.key) return;
    sessionStorage.setItem(PENDING, JSON.stringify(request));
  } catch { /* mounted listener still works */ }
  window.dispatchEvent(new CustomEvent(WORKFLOW_REVIEW_EVENT, { detail: request }));
}
export function pendingWorkflowReview(): WorkflowReviewRequest | undefined {
  try {
    let value = JSON.parse(sessionStorage.getItem(PENDING) || "null");
    if (!value) {
      const params = new URLSearchParams(window.location.search);
      const key = params.get("reviewRequest");
      const destination = workflowReviewLink(`screenpipe://workflows?${params}`);
      if (key && destination && key !== sessionStorage.getItem("screenpipe:last-workflow-review-request")) value = { key, ...destination };
    }
    if (value && typeof value.key === "string" && (!value.workflowId || /^wf-[a-zA-Z0-9_-]{1,128}$/.test(value.workflowId))) return value;
  } catch { /* no saved navigation */ }
}

export function workflowReviewOpened(request: WorkflowReviewRequest, found: boolean) {
  try {
    sessionStorage.removeItem(PENDING);
    sessionStorage.setItem("screenpipe:last-workflow-review-request", request.key);
    if (found) sessionStorage.removeItem(OUTCOMES);
    if (found) sessionStorage.setItem(ATTRIBUTION, JSON.stringify({ workflowId: request.workflowId, workflowIds: request.workflowIds, at: Date.now(), outcomes: [] }));
  } catch { /* analytics never blocks navigation */ }
  posthog.capture(found ? "workflow_notification_opened" : "workflow_notification_open_failed", {
    notification_category: "workflow_review", destination: request.workflowId ? "workflow" : "catalog",
    ...(found ? {} : { reason: "workflow_unavailable" }),
  });
}

/** Attribution stays local and expires. No workflow IDs or content enter PostHog. */
export function trackWorkflowOutcome(event: "workflow_feedback_saved" | "workflow_sop_saved", workflowId: string) {
  let fromNotification = false;
  try {
    const recorded: string[] = JSON.parse(sessionStorage.getItem(OUTCOMES) || "[]");
    const outcomeKey = `${event}:${workflowId}`;
    if (recorded.includes(outcomeKey)) return;
    sessionStorage.setItem(OUTCOMES, JSON.stringify([...recorded.slice(-199), outcomeKey]));
    const value = JSON.parse(sessionStorage.getItem(ATTRIBUTION) || "null");
    const age = value ? Date.now() - value.at : Infinity;
    fromNotification = Boolean(value && age >= 0 && age <= 24 * 60 * 60 * 1000 && (value.workflowIds ? value.workflowIds.includes(workflowId) : (!value.workflowId || value.workflowId === workflowId)));
    if (fromNotification) {
      const key = `${event}:${workflowId}`;
      if (value.outcomes.includes(key)) return;
      value.outcomes.push(key);
      sessionStorage.setItem(ATTRIBUTION, JSON.stringify(value));
    }
  } catch { /* unavailable local attribution */ }
  posthog.capture(event, { source: fromNotification ? "notification" : "workflows" });
}
