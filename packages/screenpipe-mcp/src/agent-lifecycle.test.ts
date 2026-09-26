// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { describe, expect, it, vi } from "vitest";
import { screenpipeStatus } from "./agent-lifecycle";

const healthy = { status: "healthy", frame_status: "ok", audio_status: "ok", vision_reason: "ok", last_frame_timestamp: "2026-09-25T10:00:00Z" };
async function probe(body: unknown = healthy, status = 200, intent = "status", client = "hermes") {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  const result = await screenpipeStatus("http://127.0.0.1:3030", { intent }, client, fetcher as typeof fetch);
  return { data: JSON.parse(result.content[0].text), fetcher };
}

describe("recorder lifecycle, independent of the connector", () => {
  it("does not claim capture coverage, history access, or auto-start from a healthy API", async () => {
    const { data, fetcher } = await probe();
    expect(data.state).toBe("available");
    expect(data.capture.last_frame_at).toBe("2026-09-25T10:00:00.000Z");
    expect(data.history_access).toBe("not_checked");
    expect(data.history_coverage).toBe("not_checked");
    expect(data.background_start).toBe("not_checked");
    expect(data.enterprise).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:3030/health");
    expect(options.headers).toBeUndefined();
    expect(options.redirect).toBe("error");
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("reads degraded health bodies and names permission only when explicitly denied", async () => {
    const { data } = await probe({ ...healthy, status: "unhealthy", frame_status: "stale", vision_reason: "permission_denied" }, 503);
    expect(data.state).toBe("permission_required");
    const stalled = await probe({ ...healthy, status: "unhealthy", frame_status: "stale", vision_reason: "capture_stalled" }, 503);
    expect(stalled.data.state).toBe("needs_attention");
  });

  it.each(["disabled_by_setting", "no_displays_expected", "screenshots_disabled_by_config", "screenshots_disabled_by_power_profile"])("preserves %s without permission repair", async (vision_reason) => {
    const { data } = await probe({ ...healthy, frame_status: "disabled", vision_reason });
    expect(data.state).toBe("capture_limited");
    expect(data.next_step).toContain("Respect the current capture choice");
  });

  it("does not treat server-only mode as capturing, or a quiet meeting microphone as broken", async () => {
    const server = await probe({ ...healthy, frame_status: "disabled", audio_status: "disabled" });
    expect(server.data.state).toBe("capture_limited");
    const quiet = await probe({ ...healthy, capture_status: { status: "waiting_for_meeting" } });
    expect(quiet.data.state).toBe("available");
    expect(quiet.data.capture.audio_capture).toBe("waiting_for_meeting");
  });

  it("does not mistake an arbitrary service for Screenpipe", async () => {
    expect((await probe({ status: "ok" })).data.state).toBe("unrecognized_endpoint");
    expect((await probe({ error: "denied" }, 403)).data.state).toBe("access_required");
  });

  it("does not leak errors or assume an unreachable recorder is uninstalled", async () => {
    const result = await screenpipeStatus("https://remote.invalid", {}, "openclaw", vi.fn().mockRejectedValue(new Error("private-key")));
    const data = JSON.parse(result.content[0].text);
    expect(data.state).toBe("unreachable");
    expect(data.recorder_location).toBe("configured remote computer");
    expect(result.content[0].text).not.toContain("private-key");
    expect(result.content[0].text).not.toContain("remote.invalid");
    expect(data.setup).toHaveLength(5);
  });

  it("bounds even a hanging response body", async () => {
    const fetcher = vi.fn(async (_url, options) => ({
      status: 200, ok: true,
      json: () => new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(new Error("timeout")))),
    })) as unknown as typeof fetch;
    const start = Date.now();
    const result = await screenpipeStatus("http://localhost:3030", {}, "hermes", fetcher);
    expect(JSON.parse(result.content[0].text).state).toBe("unreachable");
    expect(Date.now() - start).toBeLessThan(4500);
  });

  it("provides consent/setup disclosure and only offers enterprise on a team request", async () => {
    expect((await probe(healthy, 200, "setup")).data.data_notice).toContain("cloud provider");
    const { data } = await probe(healthy, 200, "team", "openclaw");
    expect(data.enterprise.url).toBe("https://screenpipe.com/enterprise?utm_source=openclaw&utm_medium=agent_plugin");
    const other = await probe(healthy, 200, "setup", "private customer name");
    expect(other.data.download).toContain("utm_source=agent&");
    expect(JSON.stringify(other.data)).not.toContain("private customer");
  });

  it("rejects undeclared arguments before making a request", async () => {
    const fetcher = vi.fn();
    await expect(screenpipeStatus("http://localhost:3030", { install: true }, "hermes", fetcher)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
