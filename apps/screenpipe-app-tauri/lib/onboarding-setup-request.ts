// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { localFetch } from "@/lib/api";

type Operation = "health" | "read" | "install" | "configure" | "enable" | "verify" | "model";
const ERROR_CODES = ["timeout", "network", "http_error", "invalid_response", "backend_error", "verification_failed", "model_unavailable", "registry_timeout", "registry_network", "registry_http_error", "invalid_registry_response", "pipe_not_found", "installation_failed", "permission_denied", "disk_full", "invalid_state", "io_error", "operation_failed", "free_pipe_limit_reached"] as const;
type ErrorCode = typeof ERROR_CODES[number];

// Keep raw backend errors, URLs and request bodies out of analytics.
export class SetupRequestError extends Error {
  constructor(
    public readonly operation: Operation,
    public readonly code: ErrorCode,
    public readonly httpStatus?: number,
    public readonly durationMs?: number,
  ) { super(`setup ${operation}: ${code}`); }
}

export function setupFailureProperties(error: unknown) {
  return error instanceof SetupRequestError
    ? { operation: error.operation, error_code: error.code, http_status: error.httpStatus, request_duration_ms: error.durationMs }
    : { error_code: "unknown" };
}

function operationFor(path: string): Operation {
  if (path === "/health") return "health";
  if (path.endsWith("/install")) return "install";
  if (path.endsWith("/config")) return "configure";
  if (path.endsWith("/enable")) return "enable";
  return "read";
}

export async function setupRequest(path: string, signal: AbortSignal, body?: unknown,
  timeout = path === "/pipes/store/install" ? 20_000 : 10_000) {
  signal.throwIfAborted();
  const operation = operationFor(path);
  const started = Date.now();
  const bounded = new AbortController();
  const fail = (code: ErrorCode, status?: number) => new SetupRequestError(operation, code, status, Date.now() - started);
  let rejectAbort!: (error: unknown) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const cancel = () => { rejectAbort(signal.reason ?? new DOMException("cancelled", "AbortError")); bounded.abort(); };
  signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => { rejectAbort(fail("timeout")); bounded.abort(); }, timeout);
  try {
    // localFetch may be waiting on native auth IPC, which cannot be cancelled
    // by fetch's signal. Bound that wait and JSON decoding as well as fetch.
    return await Promise.race([aborted, (async () => {
      let response: Response;
      try {
        response = await localFetch(path, {
          signal: bounded.signal,
          ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
        });
      } catch { throw fail("network"); }
      bounded.signal.throwIfAborted();
      if (body === undefined && response.status === 404) return null;
      let data;
      try { data = await response.json(); }
      catch { throw fail(response.ok ? "invalid_response" : "http_error", response.status); }
      bounded.signal.throwIfAborted();
      if (!data || typeof data !== "object" || Array.isArray(data)) throw fail(response.ok ? "invalid_response" : "http_error", response.status);
      if (response.ok && body === undefined && typeof data.error === "string" && data.error.includes("not found")) return null;
      if (!response.ok || data.error || data.success === false) {
        // New engines return a safe code; older engines retain the bounded
        // generic category. Raw error messages never enter telemetry.
        const code = ERROR_CODES.includes(data.error_code) ? data.error_code as ErrorCode : response.ok ? "backend_error" : "http_error";
        const status = Number.isInteger(data.http_status) && data.http_status >= 100 && data.http_status <= 599 ? data.http_status : response.status;
        throw fail(code, status);
      }
      return data;
    })()]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
  }
}
