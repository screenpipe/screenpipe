// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebWorkflowsPlatform } from "@screenpipe/workflows-ui/web";
import { fixturePersonalWorkProfile, fixtureWorkflowAnalysis, fixtureWorkflowRuntime } from "@screenpipe/workflows-ui/fixture";

describe("web workflows platform", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses authenticated website endpoints without exposing a recorder credential", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(fixtureWorkflowRuntime), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(fixtureWorkflowAnalysis), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const platform = createWebWorkflowsPlatform({ headers: { "x-session-proof": "present" } });

    await expect(platform.ensureRuntime()).resolves.toEqual(fixtureWorkflowRuntime);
    await expect(platform.analyzeCapturedWork(90)).resolves.toEqual(fixtureWorkflowAnalysis);

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/workflows/runtime", expect.objectContaining({
      method: "POST",
      credentials: "include",
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/workflows/analyze", expect.objectContaining({
      method: "POST",
      credentials: "include",
      body: JSON.stringify({ days: 90 }),
    }));
    const headers = fetchMock.mock.calls[1][1].headers as Headers;
    expect(headers.get("x-session-proof")).toBe("present");
    expect(JSON.stringify(fetchMock.mock.calls)).not.toMatch(/api[_-]?key|bearer/i);
  });

  it("surfaces a website API failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Sign in required", { status: 401 })));
    const platform = createWebWorkflowsPlatform();

    await expect(platform.ensureRuntime()).rejects.toThrow("Sign in required");
  });

  it("supports cached reports and asynchronous confidential-cloud jobs", async () => {
    const job = { id: "job-1", status: "queued" as const };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(fixtureWorkflowAnalysis), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(job), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...job, status: "complete", result: fixtureWorkflowAnalysis }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { location: { origin: "https://screenpipe.com" } });
    const platform = createWebWorkflowsPlatform({
      cachedAnalysisEndpoint: "/api/workflows/analysis",
      analysisJobsEndpoint: "/api/workflows/analysis-jobs",
    });
    const scope = { id: "organization", kind: "organization" as const, label: "Organization" };

    await expect(platform.loadCapturedWork?.(90, { scope })).resolves.toEqual(fixtureWorkflowAnalysis);
    await expect(platform.startAnalysisJob?.(90, { scope })).resolves.toEqual(job);
    await expect(platform.getAnalysisJob?.("job-1")).resolves.toMatchObject({ status: "complete" });

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/workflows/analysis?days=90&scope=organization", expect.objectContaining({ method: "GET" }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/workflows/analysis-jobs", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ days: 90, scope: "organization" }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/workflows/analysis-jobs/job-1", expect.objectContaining({ method: "GET" }));
  });

  it("loads and saves the shared work profile without putting it in recorder credentials", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(fixturePersonalWorkProfile), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(fixturePersonalWorkProfile), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { location: { origin: "https://screenpipe.com" } });
    const platform = createWebWorkflowsPlatform({ workProfileEndpoint: "/api/workflows/profile" });
    const scope = { id: "personal", kind: "personal" as const, label: "My work" };

    await expect(platform.loadWorkProfile?.(scope)).resolves.toEqual(fixturePersonalWorkProfile);
    await expect(platform.saveWorkProfile?.(fixturePersonalWorkProfile, scope)).resolves.toEqual(fixturePersonalWorkProfile);

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/workflows/profile?scope=personal", expect.objectContaining({ method: "GET" }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/workflows/profile", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ profile: fixturePersonalWorkProfile, scope: "personal" }),
    }));
  });
});
