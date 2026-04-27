// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpi.pe

/** Render a named markdown section. Returns empty string when lines is empty. */
export function formatSection(title: string, lines: string[]): string {
  if (!lines.length) return "";
  return `### ${title}\n${lines.join("\n")}`;
}

/** Like formatSection but only renders when condition is truthy. */
export function formatOptionalSection(title: string, lines: string[], condition: boolean): string {
  return condition ? formatSection(title, lines) : "";
}

/**
 * Render a pagination hint. Shows a strong hint when total is known, soft hint
 * when only a page limit was used.
 */
export function formatPagination(
  count: number,
  total: number | null | undefined,
  offset: number,
  toolHint: string
): string {
  if (total != null && offset + count < total) {
    return `> Showing ${offset + 1}–${offset + count} of ${total} — use \`${toolHint}\` with \`offset=${offset + count}\` for more`;
  }
  if (total == null && count > 0) {
    return `> ${count} results shown — if you requested a limit, increase \`offset\` by ${count} for older results`;
  }
  return "";
}

/**
 * Render a ### Query section echoing the effective search parameters.
 * Accepts Record<string, unknown> — non-primitive values are silently skipped
 * so callers can safely pass raw MCP args without casting.
 */
export function formatQuery(params: Record<string, unknown>): string {
  const lines = Object.entries(params)
    .filter(([, v]) => {
      if (v === null || v === undefined || v === "") return false;
      return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
    })
    .map(([k, v]) => `- ${k}: ${v}`);
  return formatOptionalSection("Query", lines, lines.length > 0);
}

/**
 * Format a deep link for a search result.
 * Prefers frame link when frame_id is available, falls back to timeline by timestamp.
 */
export function formatDeepLink(frameId: number | undefined | null, timestamp?: string): string {
  if (frameId != null) return `  → [frame ${frameId}](screenpipe://frame/${frameId})`;
  if (timestamp) return `  → [timeline](screenpipe://timeline?timestamp=${encodeURIComponent(timestamp)})`;
  return "";
}

/**
 * Flatten a plain object into indented "  key: value" lines.
 * One level deep — nested objects are JSON-stringified on the same line.
 */
export function flattenObject(obj: Record<string, unknown>): string[] {
  return Object.entries(obj).map(([k, v]) => {
    if (v !== null && typeof v === "object") {
      return `  ${k}: ${JSON.stringify(v)}`;
    }
    return `  ${k}: ${v}`;
  });
}

/**
 * Categorize and format a tool error into a human-readable message.
 * Distinguishes: validation, network/connect, HTTP status, and generic errors.
 */
export function formatToolError(toolName: string, error: unknown, apiBase?: string): string {
  const msg = error instanceof Error ? error.message : String(error);

  // Network/connect errors
  if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed") || msg.includes("Failed to fetch")) {
    const where = apiBase ? ` at ${apiBase}` : "";
    return [
      `### Error`,
      `Could not reach screenpipe${where}.`,
      `Make sure screenpipe is running (check \`screenpipe run\` or the desktop app).`,
    ].join("\n");
  }

  // HTTP status errors — match both "HTTP error: 404" and "HTTP 404" patterns
  const httpMatch = msg.match(/HTTP(?:\s+error)?:?\s+(\d+)/i);
  if (httpMatch) {
    const status = httpMatch[1];
    const detail =
      status === "401" ? "Invalid or missing API key."
      : status === "403" ? "Access denied."
      : status === "404" ? "Resource not found."
      : status === "503" ? "screenpipe service is unavailable."
      : `Server returned ${status}.`;
    return `### Error\n${detail} (${toolName})`;
  }

  // Validation or generic errors
  return `### Error\n${msg}`;
}
