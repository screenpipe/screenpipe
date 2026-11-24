// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { beforeEach, describe, expect, it, vi } from "vitest";
import posthog from "posthog-js";
import type { WorkflowsPlatform } from "@screenpipe/workflows-ui";
import { fixtureWorkflowAnalysis } from "@screenpipe/workflows-ui/fixture";
import { captureWorkflowUsage, withWorkflowUsage } from "./usage";
vi.mock("posthog-js", () => ({ default: { capture: vi.fn() } }));
const eventNames = () => vi.mocked(posthog.capture).mock.calls.map(c => c[0]);
beforeEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });
function fixture() {
  const p = {
    ensureRuntime: vi.fn(), analyzeCapturedWork: vi.fn(),
    startAnalysisJob: vi.fn().mockResolvedValue({ id: "private-job", cycleId: "private-cycle", status: "queued" }),
    getAnalysisJob: vi.fn(), getLatestAnalysisJob: vi.fn(),
    guides: { save: vi.fn().mockResolvedValue(undefined) },
    saveWorkflowSkill: vi.fn().mockResolvedValue({ name: "private", path: "/private/skill", warnings: [] }),
  } as unknown as WorkflowsPlatform;
  return { p, tracked: withWorkflowUsage(p) };
}
describe("local Workflows telemetry", () => {
  it("correlates a requested cycle across agents and waits for loaded results, exactly once", async () => {
    const { p, tracked } = fixture();
    const poll = vi.mocked(p.getLatestAnalysisJob!);
    poll.mockResolvedValue({ id: "old", status: "complete", result: fixtureWorkflowAnalysis });
    await tracked.getLatestAnalysisJob!(); expect(eventNames()).toEqual([]);
    await tracked.startAnalysisJob!(1);
    poll.mockResolvedValue({ id: "other-agent", cycleId: "private-cycle", status: "complete" });
    await tracked.getLatestAnalysisJob!();
    expect(eventNames()).toEqual(["workflow_analysis_requested"]);
    vi.mocked(p.getAnalysisJob!).mockResolvedValue({ id: "other-agent", cycleId: "private-cycle", status: "complete", result: fixtureWorkflowAnalysis });
    await tracked.getAnalysisJob!("other-agent"); await tracked.getAnalysisJob!("other-agent");
    expect(eventNames()).toEqual(["workflow_analysis_requested", "workflow_analysis_completed"]);
    const payloads = JSON.stringify(vi.mocked(posthog.capture).mock.calls);
    for (const value of ["private-job", "private-cycle", "other-agent", fixtureWorkflowAnalysis.analysis.workflows[0].title]) expect(payloads).not.toContain(value);
  });
  it.each(["failed", "incomplete"] as const)("preserves %s instead of claiming completion", async status => {
    const { p, tracked } = fixture(); await tracked.startAnalysisJob!(1);
    vi.mocked(p.getLatestAnalysisJob!).mockResolvedValue({ id: "private-job", cycleId: "private-cycle", status, message: "private failure text" });
    await tracked.getLatestAnalysisJob!(); await tracked.getLatestAnalysisJob!();
    expect(eventNames()).toEqual(["workflow_analysis_requested", `workflow_analysis_${status}`]);
    expect(JSON.stringify(vi.mocked(posthog.capture).mock.calls)).not.toContain("private failure");
  });
  it("does not turn a transient poll failure into a failed execution", async () => {
    const { p, tracked } = fixture(); await tracked.startAnalysisJob!(1);
    vi.mocked(p.getLatestAnalysisJob!).mockRejectedValue(new Error("offline"));
    await expect(tracked.getLatestAnalysisJob!()).rejects.toThrow("offline");
    expect(eventNames()).toEqual(["workflow_analysis_requested"]);
  });
  it("keeps rejected requests separate from completion and propagates the original error", async () => {
    const { p, tracked } = fixture(); vi.mocked(p.startAnalysisJob!).mockRejectedValue(Object.assign(new Error("access denied: /Users/private"), { status: 403 }));
    await expect(tracked.startAnalysisJob!(1)).rejects.toThrow("access denied");
    expect(eventNames()).toEqual(["workflow_analysis_requested", "workflow_analysis_failed"]);
    const failedCall = vi.mocked(posthog.capture).mock.calls.find(c => c[0] === "workflow_analysis_failed");
    expect(failedCall?.[1]).toEqual(expect.objectContaining({
      operation: "analysis",
      failure_stage: "start",
      error_code: "http_4xx",
    }));
    expect(JSON.stringify(failedCall)).not.toContain("access denied");
    expect(JSON.stringify(failedCall)).not.toContain("/Users/private");
  });
  it("emits enumerated error_code and failure_stage for failed jobs and sanitizes arbitrary values", async () => {
    const { p, tracked } = fixture(); await tracked.startAnalysisJob!(1);
    vi.mocked(p.getLatestAnalysisJob!).mockResolvedValue({
      id: "private-job",
      cycleId: "private-cycle",
      status: "failed",
      errorCode: "allowance_paused",
      message: "raw secret path /Users/alice",
    } as never);
    await tracked.getLatestAnalysisJob!();
    const failedCall = vi.mocked(posthog.capture).mock.calls.find(c => c[0] === "workflow_analysis_failed");
    expect(failedCall?.[1]).toEqual(expect.objectContaining({
      operation: "analysis",
      failure_stage: "execution",
      error_code: "allowance_paused",
    }));
    expect(JSON.stringify(failedCall)).not.toContain("alice");

    vi.clearAllMocks();
    captureWorkflowUsage({
      event: "workflow_analysis_failed",
      error_code: "arbitrary_secret_error: /Users/bob" as never,
      failure_stage: "execution",
    } as never);
    const sanitized = vi.mocked(posthog.capture).mock.calls[0];
    expect(sanitized?.[1]).toEqual(expect.objectContaining({
      error_code: "unknown",
      failure_stage: "execution",
    }));
    expect(JSON.stringify(sanitized)).not.toContain("bob");
  });
  it("counts outputs only after persistence succeeds", async () => {
    const { p, tracked } = fixture();
    vi.mocked(p.guides!.save).mockRejectedValueOnce(new Error("disk full"));
    await expect(tracked.guides!.save({} as never)).rejects.toThrow("disk full");
    expect(eventNames()).toEqual([]);
    await tracked.guides!.save({} as never); await tracked.saveWorkflowSkill!({} as never);
    expect(vi.mocked(posthog.capture).mock.calls.map(c => c[1]?.output)).toEqual(["sop", "skill"]);
  });
  it("preserves the production UI when analytics throws, omits arbitrary content and suppresses previews", () => {
    captureWorkflowUsage({ event: "workflow_opened", content: "PRIVATE" } as never);
    expect(posthog.capture).toHaveBeenCalledWith("workflow_opened", {
      schema_version: 1, surface: "desktop_workflows", workflow_source: "device",
      $current_url: "screenpipe://workflows", $pathname: "/workflows", $referrer: "",
    });
    vi.mocked(posthog.capture).mockImplementationOnce(() => { throw new Error("analytics unavailable"); });
    expect(() => captureWorkflowUsage({ event: "workflow_opened" })).not.toThrow();
    vi.clearAllMocks(); vi.stubEnv("NEXT_PUBLIC_SCREENPIPE_WEB_DEV", "mock");
    captureWorkflowUsage({ event: "workflow_opened" }); expect(posthog.capture).not.toHaveBeenCalled();
  });
});
