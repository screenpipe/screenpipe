// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

type Response = { ok: boolean; status: number; body: unknown };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The search route fails closed when the remote privacy filter is unavailable.
// Accept only its error envelope: extra fields could expose unfiltered captures.
export function isPrivacyFilterUnavailable(response: Response): boolean {
  const body = response.body;
  return !response.ok && response.status === 503 && record(body) &&
    body.error === "privacy_filter_unavailable" &&
    typeof body.message === "string" && body.message.trim().length > 0 &&
    Object.keys(body).every((key) => key === "error" || key === "message");
}

// /health uses HTTP 200 for a snapshot, including an explained degraded pipeline.
// Burst tests measure API availability, not the recording state of the CI host.
export function assertHealthSnapshot(response: Response): void {
  const body = response.body;
  if (response.ok && response.status === 200 && record(body) && Array.isArray(body.unhealthy_reasons)) {
    if (body.status === "healthy" && body.status_code === 200 && body.unhealthy_reasons.length === 0) return;
    if (body.status === "degraded" && body.status_code === 503 && body.unhealthy_reasons.length > 0 &&
      body.unhealthy_reasons.every((reason) => record(reason) &&
        [reason.subsystem, reason.code, reason.detail].every((field) => typeof field === "string" && field.trim().length > 0))) return;
  }
  throw new Error(`Invalid health snapshot: HTTP ${response.status} ${JSON.stringify(body)}`);
}
