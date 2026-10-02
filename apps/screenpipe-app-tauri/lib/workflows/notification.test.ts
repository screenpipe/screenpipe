// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("posthog-js", () => ({ default: { capture: vi.fn() } }));
import posthog from "posthog-js";
import { workflowReviewLink, pendingWorkflowReview, rememberWorkflowReview, workflowReviewOpened, trackWorkflowOutcome } from "./notification";
beforeEach(() => { window.history.replaceState(null, "", "/"); sessionStorage.clear(); vi.clearAllMocks(); vi.useRealTimers(); });
describe("workflow notification navigation and outcomes", () => {
  it("validates direct and batch destinations without accepting external URLs", () => {
    expect(workflowReviewLink("screenpipe://workflows?workflow=wf-demo&source=notification")).toEqual({ workflowId: "wf-demo" });
    expect(workflowReviewLink("screenpipe://workflows?source=notification")).toEqual({});
    for (const url of ["https://workflows", "screenpipe://workflows/anything", "screenpipe://workflows?workflow=../../private", "invalid"]) expect(workflowReviewLink(url)).toBeNull();
  });
  it("keeps the request until the destination has actually loaded", () => {
    const request = { key: "request", workflowId: "wf-private" };
    rememberWorkflowReview(request);
    expect(pendingWorkflowReview()).toEqual(request);
    expect(posthog.capture).not.toHaveBeenCalled();
    workflowReviewOpened(request, true);
    expect(pendingWorkflowReview()).toBeUndefined();
    expect(posthog.capture).toHaveBeenCalledWith("workflow_notification_opened", { notification_category: "workflow_review", destination: "workflow" });
    trackWorkflowOutcome("workflow_feedback_saved", "wf-private");
    trackWorkflowOutcome("workflow_feedback_saved", "wf-private");
    expect(posthog.capture).toHaveBeenCalledTimes(2);
    expect(posthog.capture).toHaveBeenLastCalledWith("workflow_feedback_saved", { source: "notification" });
    expect(JSON.stringify(vi.mocked(posthog.capture).mock.calls)).not.toContain("wf-private");
  });
  it("does not attribute unrelated workflows or expired visits", () => {
    vi.useFakeTimers(); vi.setSystemTime(100000);
    workflowReviewOpened({ key: "request", workflowId: "wf-one" }, true);
    trackWorkflowOutcome("workflow_sop_saved", "wf-two");
    expect(posthog.capture).toHaveBeenLastCalledWith("workflow_sop_saved", { source: "workflows" });
    vi.advanceTimersByTime(86400001);
    trackWorkflowOutcome("workflow_sop_saved", "wf-one");
    expect(posthog.capture).toHaveBeenLastCalledWith("workflow_sop_saved", { source: "workflows" });
  });
  it("recovers a cold-start URL and consumes it only once", () => {
    window.history.replaceState(null, "", "/home?mode=workflows&reviewRequest=cold&workflow=wf-one");
    const request = pendingWorkflowReview();
    expect(request).toEqual({ key: "cold", workflowId: "wf-one" });
    workflowReviewOpened(request!, true);
    expect(pendingWorkflowReview()).toBeUndefined();
  });
  it("records an unavailable destination as failure, not opened", () => {
    workflowReviewOpened({ key: "request", workflowId: "wf-missing" }, false);
    expect(posthog.capture).toHaveBeenCalledWith("workflow_notification_open_failed", expect.objectContaining({ reason: "workflow_unavailable" }));
    trackWorkflowOutcome("workflow_feedback_saved", "wf-missing");
    expect(posthog.capture).toHaveBeenLastCalledWith("workflow_feedback_saved", { source: "workflows" });
  });
});
