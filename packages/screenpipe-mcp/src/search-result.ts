// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { inputEventContent } from "./workflow-tools";

export const DEFAULT_SEARCH_CONTENT_TRUNCATE = 1000;

export function searchContentCap(value: unknown): number {
  const cap = typeof value === "number" ? value : Number(value);
  return value !== undefined && Number.isFinite(cap) && cap >= 0
    ? Math.floor(cap) : DEFAULT_SEARCH_CONTENT_TRUNCATE;
}

export function truncateSearchText(text: string, cap: number): string {
  if (cap === 0 || text.length <= cap) return text;
  const left = Math.floor(cap / 2);
  return text.slice(0, left) + `…[${text.length - cap} chars truncated; inspect the source or narrow the search]…` + text.slice(text.length - (cap - left));
}

function numericId(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Source identifiers come from the backend, never from result position or text. */
export function formatSearchHit(result: any, cap: number): { text: string; truncated: boolean } | null {
  const c = result.content;
  if (!c || typeof c !== "object") return null;
  const frame = numericId(c.frame_id);
  const chunk = numericId(c.chunk_id);
  const frameRef = frame === undefined ? "" : `\nSource: frame_id=${frame}; screenpipe://frame/${frame}`;
  const tags = Array.isArray(c.tags) && c.tags.length ? `\nTags: ${c.tags.join(", ")}` : "";
  let label: string, body: string, source = frameRef;
  switch (result.type) {
    case "OCR":
      label = c.text_source === "accessibility" ? "[Screen·a11y]" : c.text_source === "ocr" ? "[Screen·ocr]" : "[Screen]";
      label += ` ${c.app_name || "?"} | ${c.window_name || "?"}`;
      body = c.text || "";
      break;
    case "UI": case "Accessibility":
      label = `[Accessibility] ${c.app_name || "?"} | ${c.window_name || "?"}`;
      body = c.text || "";
      break;
    case "Audio":
      label = `[Audio] ${c.device_name || "?"}`;
      body = c.transcription || "";
      source = chunk === undefined ? "" : `\nSource: chunk_id=${chunk}`;
      if (typeof c.timestamp === "string" && Number.isFinite(Date.parse(c.timestamp))) {
        source += `${source ? "; " : "\nSource: "}screenpipe://timeline?timestamp=${encodeURIComponent(c.timestamp)}`;
      }
      break;
    case "Parsed":
      label = `[Parsed] ${c.app_name || "?"} | ${c.window_name || "?"} | frame ${frame ?? "?"}`;
      body = c.text || "";
      break;
    case "Memory":
      label = `[Memory #${c.id}]${c.importance != null ? ` (importance: ${c.importance})` : ""}`;
      body = c.content || "";
      break;
    case "Input":
      return { text: `${result.starred ? "[Starred moment]\n" : ""}${inputEventContent(c, cap === 0 ? Number.MAX_SAFE_INTEGER : cap)}${source}`, truncated: cap > 0 && typeof c.text_content === "string" && c.text_content.length > cap };
    default: return null;
  }
  body = String(body);
  return {
    text: `${result.starred ? "[Starred moment]\n" : ""}${label}\n${c.timestamp || c.created_at || ""}${source}\n${truncateSearchText(body, cap)}${tags}`,
    truncated: cap > 0 && body.length > cap,
  };
}

export function searchResultHeader(count: number, pagination: any): string {
  const total = typeof pagination.total === "number" ? pagination.total : undefined;
  const offset = typeof pagination.offset === "number" ? pagination.offset : 0;
  return `Results: ${count}/${total ?? "?"}` +
    (count > 0 && total !== undefined && offset + count < total ? ` (use offset=${offset + count} for more)` : "");
}
