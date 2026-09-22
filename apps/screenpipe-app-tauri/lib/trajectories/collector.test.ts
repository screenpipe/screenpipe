// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { describe, it, expect, vi } from "vitest";
import { createTrajectoryCollector, type LocalSharing, type SharingStatus } from "./collector";
function fixture() {
  let local: LocalSharing | null = { accountId: "user_one", epoch: "epoch-one", enabledAt: 0, priorBackend: "local" };
  let token: string | null = "token-one";
  const status: SharingStatus = { accountId: "user_one", epoch: "epoch-one", available: true, sharing: true, training: false, revision: 1, noticeVersion: "2026-09-21" };
  const request = vi.fn(async (_method: string, _body?: unknown, _token?: string, _signal?: AbortSignal) => status);
  const redact = vi.fn(async (_text: string) => "[REDACTED]");
  const collector = createTrajectoryCollector({ local: async () => local, token: async () => token, request, redact });
  return { collector, request, redact, status, setLocal: (value: LocalSharing | null) => { local = value; }, setToken: (value: string | null) => { token = value; } };
}
describe("Trajectory collection boundary", () => {
  it("makes no network or redaction calls without a local opt-in", async () => {
    const f = fixture(); f.setLocal(null);
    await f.collector.complete(await f.collector.begin(), "private question", "private answer");
    expect(f.request).not.toHaveBeenCalled(); expect(f.redact).not.toHaveBeenCalled();
  });
  it("only uploads strict-redacted question and answer after checking current consent", async () => {
    const f = fixture(); const ticket = await f.collector.begin();
    await f.collector.complete(ticket, "private question", "private answer");
    expect(f.request.mock.calls[0][0]).toBe("GET");
    expect(f.request).toHaveBeenLastCalledWith("POST", {
      id: ticket!.id, epoch: "epoch-one", source: "workflows-assistant", redaction: "tinfoil-strict-v1",
      question: "[REDACTED]", answer: "[REDACTED]",
    }, "token-one", expect.any(AbortSignal));
    expect(JSON.stringify(f.request.mock.calls)).not.toContain("private question");
  });
  it.each(["available", "sharing"] as const)("fails closed when server %s is false", async key => {
    const f = fixture(); f.status[key] = false;
    await f.collector.complete(await f.collector.begin(), "question", "answer");
    expect(f.redact).not.toHaveBeenCalled(); expect(f.request).toHaveBeenCalledTimes(1);
  });
  it.each(["accountId", "epoch", "noticeVersion"] as const)("refuses a stale %s", async key => {
    const f = fixture(); f.status[key] = "changed";
    await f.collector.complete(await f.collector.begin(), "question", "answer");
    expect(f.redact).not.toHaveBeenCalled();
  });
  it("rejects consent granted while the initial store read was pending", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(10);
    const f = fixture(); f.setLocal({ accountId: "user_one", epoch: "new", enabledAt: 11, priorBackend: "local" });
    expect(await f.collector.begin()).toBeNull();
    vi.restoreAllMocks();
  });
  it("does not retroactively include turns that began before opt-in", async () => {
    const f = fixture(); f.setLocal(null); const ticket = await f.collector.begin();
    f.setLocal({ accountId: "user_one", epoch: "new", enabledAt: 0, priorBackend: "local" });
    await f.collector.complete(ticket, "question", "answer"); expect(f.request).not.toHaveBeenCalled();
  });
  it("does not upload when either redaction fails", async () => {
    const f = fixture(); f.redact.mockResolvedValueOnce("safe").mockRejectedValueOnce(new Error("private failure"));
    await f.collector.complete(await f.collector.begin(), "question", "answer");
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it.each(["revoke", "logout", "stop", "reoptin"])("stops an in-flight turn on %s", async action => {
    const f = fixture(); const ticket = await f.collector.begin();
    f.redact.mockImplementationOnce(async () => {
      if (action === "revoke") f.setLocal(null);
      if (action === "logout") f.setToken(null);
      if (action === "stop") f.collector.stop();
      if (action === "reoptin") f.setLocal({ ...ticket!.local, epoch: "new-epoch" });
      return "safe";
    });
    await f.collector.complete(ticket, "question", "answer");
    expect(f.request).toHaveBeenCalledTimes(1); expect(f.redact).toHaveBeenCalledTimes(1);
  });
  it("drops oversized UTF-8 or empty messages without truncating identifiers", async () => {
    const f = fixture(); const ticket = await f.collector.begin();
    await f.collector.complete(ticket, "💬".repeat(500), "answer");
    await f.collector.complete(ticket, "question", " "); expect(f.request).not.toHaveBeenCalled();
  });
});
