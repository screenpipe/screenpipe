// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { describe, expect, it } from "vitest";
import { assertHealthSnapshot, isPrivacyFilterUnavailable } from "../../e2e/helpers/api-search-contracts";

const unavailable = { ok: false, status: 503, body: { error: "privacy_filter_unavailable", message: "privacy filter request failed" } };

describe("local API stress contracts", () => {
  it("accepts only the privacy filter's explicit fail-closed response", () => {
    expect(isPrivacyFilterUnavailable(unavailable)).toBe(true);
    for (const field of ["data", "recordings", "content", "results"]) {
      expect(isPrivacyFilterUnavailable({ ...unavailable, body: { ...unavailable.body, [field]: [{ text: "private capture" }] } })).toBe(false);
    }
    expect(isPrivacyFilterUnavailable({ ...unavailable, body: { error: "database unavailable", message: "failed" } })).toBe(false);
    expect(isPrivacyFilterUnavailable({ ...unavailable, status: 500 })).toBe(false);
    expect(isPrivacyFilterUnavailable({ ...unavailable, body: { error: "privacy_filter_unavailable", message: "" } })).toBe(false);
  });

  it("accepts a healthy snapshot or an explained degraded snapshot while HTTP stays available", () => {
    const reason = { subsystem: "audio", code: "audio_not_started", detail: "audio has not started" };
    expect(() => assertHealthSnapshot({ ok: true, status: 200, body: { status: "healthy", status_code: 200, unhealthy_reasons: [] } })).not.toThrow();
    expect(() => assertHealthSnapshot({ ok: true, status: 200, body: { status: "degraded", status_code: 503, unhealthy_reasons: [reason] } })).not.toThrow();
  });

  it("rejects unavailable transport, contradictory health, and unexplained degradation", () => {
    for (const response of [
      { ok: false, status: 503, body: {} },
      { ok: true, status: 200, body: { status: "healthy", status_code: 503, unhealthy_reasons: [] } },
      { ok: true, status: 200, body: { status: "healthy", status_code: 200, unhealthy_reasons: [{ subsystem: "audio", code: "audio_not_started", detail: "not started" }] } },
      { ok: true, status: 200, body: { status: "degraded", status_code: 200, unhealthy_reasons: [{ subsystem: "audio", code: "audio_not_started", detail: "not started" }] } },
      { ok: true, status: 200, body: { status: "degraded", status_code: 503, unhealthy_reasons: [] } },
      { ok: true, status: 200, body: { status: "degraded", status_code: 503, unhealthy_reasons: [{}] } },
      { ok: true, status: 200, body: { status: "unknown", status_code: 200, unhealthy_reasons: [] } },
    ]) expect(() => assertHealthSnapshot(response)).toThrow();
  });
});
