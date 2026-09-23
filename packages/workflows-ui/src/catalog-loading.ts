// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

/** Only transport/startup failures can recover without user intervention. */
export function isCatalogConnectionError(error: unknown): boolean {
  const value = error as { status?: number; name?: string; message?: string } | null;
  const message = String(value?.message ?? error);
  if (/workflow_catalog_(unreadable|not_configured)/i.test(message)) return false;
  if (typeof value?.status === "number") return [408, 429, 502, 503, 504].includes(value.status);
  return value?.name === "TimeoutError" || /^(?:TypeError: )?(?:Load failed|Failed to fetch|NetworkError when attempting to fetch resource\.?|Network request failed|Offline)$/i.test(message);
}

export const CATALOG_CONNECT_NOTICE_MS = 15_000;
export const catalogRetryDelay = (attempt: number) => Math.min(1_000 * 2 ** Math.min(attempt, 4), 10_000);
