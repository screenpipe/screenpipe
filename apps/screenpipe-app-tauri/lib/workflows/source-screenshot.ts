// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { localFetch } from "@/lib/api";
import type { WorkflowScreenshot } from "@screenpipe/workflows-ui/model";

// Date.parse alone loses sub-millisecond identity. Recorder timestamps can
// contain microseconds; tolerate timezone formatting, never a nearby frame.
function instant(value: string): string | null {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  const fraction = value.match(/\.(\d+)(?:Z|[+-]\d\d:\d\d)$/)?.[1] ?? "";
  return `${Math.floor(time / 1000)}:${fraction.padEnd(9, "0")}`;
}

export async function loadWorkflowScreenshot(timestamp: string, app: string, signal: AbortSignal, frameId?: number): Promise<WorkflowScreenshot | null> {
  if (!instant(timestamp) || !app.trim() || (frameId !== undefined && (!Number.isSafeInteger(frameId) || frameId <= 0))) return null;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timeout = setTimeout(abort, 10_000);
  let release: (() => void) | undefined;
  try {
    release = await acquire(controller.signal);
    const source = await findWorkflowScreenshot(timestamp, app, controller.signal, frameId);
    if (!source) return null;
    const frame = { frame_id: source.frameId, timestamp: source.timestamp, app_name: source.app };
    const image = await localFetch(`/frames/${frame.frame_id}?fallback=false`, { signal: controller.signal });
    if (image.status === 404 || image.status === 410) return null;
    if (!image.ok) throw new Error("Could not load the source screenshot");
    const mime = image.headers.get("content-type")?.split(";")[0] ?? "";
    const limit = 16 * 1024 * 1024;
    if (!/^image\/(jpeg|png|webp)$/.test(mime) || Number(image.headers.get("content-length")) > limit || !image.body) {
      await image.body?.cancel();
      throw new Error("Invalid source screenshot");
    }
    const reader = image.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        controller.signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw new Error("Source screenshot exceeds the image limit");
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    if (!size) throw new Error("Invalid source screenshot");
    const blob = new Blob(chunks as BlobPart[], { type: mime });
    controller.signal.throwIfAborted();
    return { frameId: frame.frame_id, timestamp: frame.timestamp, app: frame.app_name,
      matchDistanceSeconds: 0, visualVerified: false, dataUrl: URL.createObjectURL(blob) };
  } finally {
    release?.();
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
}

// Bound simultaneous decoding/transfer without introducing another image cache.
// Queued requests are cancellable and retain no image bytes.
let active = 0;
const waiting: (() => void)[] = [];
function acquire(signal: AbortSignal): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const cancel = () => {
      const index = waiting.indexOf(start);
      if (index >= 0) waiting.splice(index, 1);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const start = () => {
      signal.removeEventListener("abort", cancel);
      if (signal.aborted) { cancel(); return; }
      active++;
      resolve(() => { active--; waiting.shift()?.(); });
    };
    if (signal.aborted) { cancel(); return; }
    signal.addEventListener("abort", cancel, { once: true });
    if (active < 3) start(); else waiting.push(start);
  });
}

export async function findWorkflowScreenshot(timestamp: string, app: string, signal: AbortSignal, frameId?: number): Promise<WorkflowScreenshot | null> {
  if (!instant(timestamp) || !app.trim() || (frameId !== undefined && (!Number.isSafeInteger(frameId) || frameId <= 0))) return null;
  signal.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, 10_000);
  try {
    const time = Date.parse(timestamp);
    let frame: { frame_id: number; timestamp: string; app_name: string } | undefined;
    if (frameId !== undefined) {
      const response = await localFetch(`/frames/${frameId}/metadata`, { signal: controller.signal });
      if (response.status === 404 || response.status === 410) return null;
      if (!response.ok) throw new Error("Could not look up the source screenshot");
      const metadata = await response.json();
      // IDs can be reused after a recorder/database switch. Never show another capture.
      if (metadata.frame_id !== frameId || typeof metadata.timestamp !== "string" || instant(metadata.timestamp) !== instant(timestamp)) return null;
      frame = { frame_id: frameId, timestamp: metadata.timestamp, app_name: app };
    } else {
      const query = new URLSearchParams({ content_type: "ocr", app_name: app,
        start_time: new Date(time - 1).toISOString(), end_time: new Date(time + 1).toISOString(),
        limit: "20", offset: "0" });
      const response = await localFetch(`/search?${query}`, { signal: controller.signal });
      if (!response.ok) throw new Error("Could not look up the source screenshot");
      const result = await response.json();
      frame = result.data?.map((row: { content?: Record<string, unknown> }) => row.content)
        .find((row: Record<string, unknown> | undefined) => row
          && typeof row.timestamp === "string" && instant(row.timestamp) === instant(timestamp)
          && typeof row.app_name === "string" && row.app_name.toLowerCase() === app.toLowerCase()
          && Number.isSafeInteger(row.frame_id) && Number(row.frame_id) > 0);
    }
    if (!frame) return null;
    controller.signal.throwIfAborted();
    return { frameId: frame.frame_id, timestamp: frame.timestamp, app: frame.app_name, matchDistanceSeconds: 0, visualVerified: false, dataUrl: "" };
  } finally { clearTimeout(timeout); signal.removeEventListener("abort", abort); }
}
