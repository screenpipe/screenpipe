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

export async function loadWorkflowScreenshot(timestamp: string, app: string, signal: AbortSignal): Promise<WorkflowScreenshot | null> {
  if (!instant(timestamp) || !app.trim()) return null;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timeout = setTimeout(abort, 10_000);
  try {
    const time = Date.parse(timestamp);
    const query = new URLSearchParams({ content_type: "ocr", app_name: app,
      start_time: new Date(time - 1).toISOString(), end_time: new Date(time + 1).toISOString(),
      limit: "20", offset: "0" });
    const response = await localFetch(`/search?${query}`, { signal: controller.signal });
    if (!response.ok) throw new Error("Could not look up the source screenshot");
    const result = await response.json();
    const frame = result.data?.map((row: { content?: Record<string, unknown> }) => row.content)
      .find((row: Record<string, unknown> | undefined) => row
        && typeof row.timestamp === "string" && instant(row.timestamp) === instant(timestamp)
        && typeof row.app_name === "string" && row.app_name.toLowerCase() === app.toLowerCase()
        && Number.isSafeInteger(row.frame_id) && Number(row.frame_id) > 0);
    if (!frame) return null;
    const image = await localFetch(`/frames/${frame.frame_id}/thumbnail?width=960&quality=80&fallback=false`, { signal: controller.signal });
    if (image.status === 404 || image.status === 410) return null;
    if (!image.ok) throw new Error("Could not load the source screenshot");
    const blob = await image.blob();
    if (!/^image\/(jpeg|png|webp)$/.test(blob.type) || !blob.size || blob.size > 2_000_000) {
      throw new Error("Invalid source screenshot");
    }
    controller.signal.throwIfAborted();
    return { frameId: frame.frame_id, timestamp: frame.timestamp, app: frame.app_name,
      matchDistanceSeconds: 0, visualVerified: false, dataUrl: URL.createObjectURL(blob) };
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
}
