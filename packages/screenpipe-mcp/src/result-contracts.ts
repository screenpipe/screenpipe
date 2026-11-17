// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

export interface SearchCoverage {
  query?: string;
  start_time?: string;
  end_time?: string;
  app?: string;
  limit?: string | number;
  offset?: string | number;
  details?: string;
}

/**
 * A zero-hit reply is a successful result, not an error. State what was
 * scanned so a caller can distinguish "nothing in this window" from "wrong
 * query" or "backend unavailable", and knows which filter to widen. Errors
 * keep their own distinct shape and never use this text.
 */
export function zeroHitCoverageText(tool: string, c: SearchCoverage = {}): string {
  const fields = [
    `query=${c.query ?? "(none)"}`,
    `start_time=${c.start_time ?? "(unbounded)"}`,
    `end_time=${c.end_time ?? "(unbounded)"}`,
    `app=${c.app ?? "(all)"}`,
    `limit=${c.limit ?? "(default)"}`,
    `offset=${c.offset ?? 0}`,
  ];
  if (c.details) fields.push(c.details);
  return [
    `No results for ${tool} (successful search, zero results; this is not an error).`,
    `Coverage: ${fields.join(", ")}.`,
    "Try a wider start_time/end_time, fewer terms, or removing the app filter.",
  ].join("\n");
}

/**
 * Some MCP clients serialize integer arguments as floats or numeric strings
 * (for example "268.0"), which the Rust routes reject as a non-i64 URL segment.
 * Accept only whole, non-negative values; reject fractional or junk input so a
 * bad argument produces a clear local error instead of a 400 from the engine.
 */
export function normalizePositiveInt(raw: unknown): number | null {
  return normalizeInt(raw, 1);
}

export function normalizeNonNegativeInt(raw: unknown): number | null {
  return normalizeInt(raw, 0);
}

function normalizeInt(raw: unknown, min: number): number | null {
  if (typeof raw === "number") {
    return Number.isSafeInteger(raw) && raw >= min ? raw : null;
  }
  if (typeof raw === "string") {
    const value = raw.trim();
    if (!/^\d+(?:\.0+)?$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= min ? parsed : null;
  }
  return null;
}
