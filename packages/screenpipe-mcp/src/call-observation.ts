// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { PKG_VERSION } from "./version";
import { safeMcpClient, type McpClient } from "./qualified-value";

export type ErrorKind = "none" | "auth" | "invalid_request" | "not_found" | "rate_limited" | "backend" | "unavailable" | "cancelled" | "unknown";
type Observation = {
  request_id: string;
  error_kind: ErrorKind;
  result_count?: number;
  truncated?: boolean;
};
const context = new AsyncLocalStorage<Observation>();
export const currentMcpRequestId = () => context.getStore()?.request_id;

export function observeSearchResult(count: number, truncated: boolean): void {
  const state = context.getStore();
  if (state) { state.result_count = Math.max(0, Math.floor(count)); state.truncated = truncated; }
}

export function observeMcpError(error: unknown): void {
  const state = context.getStore();
  if (!state) return;
  const e = error as { status?: number; name?: string } | null;
  state.error_kind = e?.name === "AbortError" ? "cancelled"
    : e?.name === "BackendDownError" ? "unavailable"
    : e?.status === 401 || e?.status === 403 ? "auth"
    : e?.status === 400 || e?.status === 422 ? "invalid_request"
    : e?.status === 404 ? "not_found"
    : e?.status === 429 ? "rate_limited"
    : e?.status && e.status >= 500 ? "backend" : "unknown";
}

export type CallObservation = {
  schema_version: 1;
  request_id: string;
  mcp_version: string;
  client: McpClient;
  transport: "stdio" | "http";
  tool: string;
  status: "ok" | "empty" | "error";
  error_kind: ErrorKind;
  duration_ms: number;
  response_bytes: number;
  result_count?: number;
  truncated?: boolean;
  dropped_reports: number;
};

const disabled = () => ["SCREENPIPE_DISABLE_TELEMETRY", "SCREENPIPE_TELEMETRY_DISABLED", "CI", "GITHUB_ACTIONS"]
  .some(key => /^(1|true|yes|on)$/i.test(process.env[key] || ""));

/** A bounded best-effort reporter. It never records arguments, results or errors. */
export function createCallObserver(options: {
  tools: readonly string[];
  transport: "stdio" | "http";
  client: () => McpClient;
  send: (payload: CallObservation, signal: AbortSignal) => Promise<unknown>;
  enabled?: () => boolean;
}) {
  const knownTools = new Set(options.tools);
  let pending = 0, dropped = 0;
  function report(payload: Omit<CallObservation, "dropped_reports">) {
    if (!(options.enabled?.() ?? !disabled())) return;
    if (pending >= 8) { dropped++; return; }
    pending++;
    const previousDrops = dropped;
    dropped = 0;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1000);
    timer.unref();
    // Resolve on timeout even if an adapter ignores its signal.
    const timeout = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("telemetry timeout")), { once: true }));
    void Promise.race([Promise.resolve().then(() => options.send({ ...payload, dropped_reports: previousDrops }, controller.signal)), timeout])
      .catch(() => { dropped += previousDrops + 1; })
      .finally(() => { clearTimeout(timer); pending--; });
  }
  return async function observe<T extends { content?: unknown; isError?: boolean; _meta?: Record<string, unknown> }>(name: string, run: () => Promise<T>): Promise<T & { _meta: Record<string, unknown> }> {
    const state: Observation = { request_id: randomUUID(), error_kind: "none" };
    const start = performance.now();
    return context.run(state, async () => {
      let result: T | undefined;
      try {
        result = await run();
        return { ...result, _meta: { ...result._meta, "screenpipe/request_id": state.request_id } };
      } catch (error) {
        observeMcpError(error);
        throw error;
      } finally {
        const failed = !result || result.isError === true;
        // Count content size without serializing or retaining a second copy.
        const bytes = Array.isArray(result?.content) ? result.content.reduce((sum, item) =>
          sum + (typeof item?.text === "string" ? Buffer.byteLength(item.text) : typeof item?.data === "string" ? Buffer.byteLength(item.data) : 0), 0) : 0;
        try { report({ schema_version: 1, request_id: state.request_id, mcp_version: PKG_VERSION,
          client: safeMcpClient(options.client()), transport: options.transport,
          tool: knownTools.has(name) ? name : "unknown",
          status: failed ? "error" : state.result_count === 0 ? "empty" : "ok",
          error_kind: failed ? state.error_kind === "none" ? "unknown" : state.error_kind : "none",
          duration_ms: Math.max(0, Math.round(performance.now() - start)), response_bytes: bytes,
          ...(state.result_count === undefined ? {} : { result_count: state.result_count }),
          ...(state.truncated === undefined ? {} : { truncated: state.truncated }),
        }); } catch { /* Diagnostics must never change the tool result. */ }
      }
    });
  };
}
