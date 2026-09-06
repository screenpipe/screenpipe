// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import type { WorkProfile, WorkflowAnalysis, WorkflowRuntime } from "./model";
import type { WorkflowAnalysisJob, WorkflowAnalysisOptions, WorkflowsPlatform } from "./platform";

export type WebWorkflowsPlatformOptions = {
  runtimeEndpoint?: string;
  analysisEndpoint?: string;
  cachedAnalysisEndpoint?: string;
  analysisJobsEndpoint?: string;
  workProfileEndpoint?: string;
  accountUrl?: string;
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
};

async function resolvedHeaders(value: WebWorkflowsPlatformOptions["headers"]) {
  if (!value) return {};
  return typeof value === "function" ? value() : value;
}

async function requestJson<T>(url: string, init: RequestInit, headers: WebWorkflowsPlatformOptions["headers"]) {
  const requestHeaders = new Headers(await resolvedHeaders(headers));
  const extraHeaders = new Headers(init.headers);
  extraHeaders.forEach((value, key) => requestHeaders.set(key, value));
  if (!requestHeaders.has("content-type")) requestHeaders.set("content-type", "application/json");

  const response = await fetch(url, {
    ...init,
    credentials: "include",
    headers: requestHeaders,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(detail || `Workflows request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export function createWebWorkflowsPlatform(options: WebWorkflowsPlatformOptions = {}): WorkflowsPlatform {
  const runtimeEndpoint = options.runtimeEndpoint ?? "/api/workflows/runtime";
  const analysisEndpoint = options.analysisEndpoint ?? "/api/workflows/analyze";
  const requestOptions = (days: number, analysisOptions?: WorkflowAnalysisOptions) => ({
    days,
    scope: analysisOptions?.scope?.id,
    ...(analysisOptions?.workProfile ? { workProfile: analysisOptions.workProfile } : {}),
  });
  const platform: WorkflowsPlatform = {
    ensureRuntime: () => requestJson<WorkflowRuntime>(runtimeEndpoint, { method: "POST", body: "{}" }, options.headers),
    analyzeCapturedWork: (days, analysisOptions) => requestJson<WorkflowAnalysis>(analysisEndpoint, {
      method: "POST",
      body: JSON.stringify(requestOptions(days, analysisOptions)),
    }, options.headers),
    openAccount: async () => {
      if (typeof window !== "undefined") window.location.assign(options.accountUrl ?? "/login?next=/workflows");
    },
  };
  if (options.cachedAnalysisEndpoint) {
    platform.loadCapturedWork = (days, analysisOptions) => {
      const url = new URL(options.cachedAnalysisEndpoint!, typeof window === "undefined" ? "http://localhost" : window.location.origin);
      url.searchParams.set("days", String(days));
      if (analysisOptions?.scope?.id) url.searchParams.set("scope", analysisOptions.scope.id);
      return requestJson<WorkflowAnalysis | null>(`${url.pathname}${url.search}`, { method: "GET" }, options.headers);
    };
  }
  if (options.analysisJobsEndpoint) {
    platform.startAnalysisJob = (days, analysisOptions) => requestJson<WorkflowAnalysisJob>(options.analysisJobsEndpoint!, {
      method: "POST",
      body: JSON.stringify(requestOptions(days, analysisOptions)),
    }, options.headers);
    platform.getAnalysisJob = (jobId) => requestJson<WorkflowAnalysisJob>(
      `${options.analysisJobsEndpoint!.replace(/\/$/, "")}/${encodeURIComponent(jobId)}`,
      { method: "GET" },
      options.headers,
    );
  }
  if (options.workProfileEndpoint) {
    platform.loadWorkProfile = (scope) => {
      const url = new URL(options.workProfileEndpoint!, typeof window === "undefined" ? "http://localhost" : window.location.origin);
      if (scope?.id) url.searchParams.set("scope", scope.id);
      return requestJson<WorkProfile | null>(`${url.pathname}${url.search}`, { method: "GET" }, options.headers);
    };
    platform.saveWorkProfile = (profile, scope) => requestJson<WorkProfile>(options.workProfileEndpoint!, {
      method: "PUT",
      body: JSON.stringify({ profile, scope: scope?.id }),
    }, options.headers);
  }
  return platform;
}
