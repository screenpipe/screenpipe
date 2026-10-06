// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { beforeEach, describe, expect, it, vi } from "vitest";
import { commands } from "./tauri";
import { localFetch } from "@/lib/api";
import { resumeMeetingCapture, startMeetingWithCapture } from "./meeting-capture";

vi.mock("./tauri", () => ({ commands: { startCapture: vi.fn() } }));
vi.mock("@/lib/api", () => ({ localFetch: vi.fn() }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(commands.startCapture).mockResolvedValue({ status: "ok", data: null });
  vi.mocked(localFetch).mockResolvedValue(new Response("{}"));
});

describe("explicit meeting capture actions", () => {
  it("waits for native capture startup before creating or resuming a meeting", async () => {
    let finish!: () => void;
    vi.mocked(commands.startCapture).mockImplementationOnce(() => new Promise(resolve => {
      finish = () => resolve({ status: "ok", data: null });
    }));
    const request = { app: "manual", id: 42, title: "Planning", calendar_event_id: "event-1" };
    const pending = startMeetingWithCapture(request);
    expect(localFetch).not.toHaveBeenCalled();
    finish();
    await pending;
    expect(localFetch).toHaveBeenCalledWith("/meetings/start", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request),
    });
  });

  it("does not create a ghost meeting when native startup returns an error", async () => {
    vi.mocked(commands.startCapture).mockResolvedValueOnce({ status: "error", error: "Capture unavailable" });
    await expect(startMeetingWithCapture({ app: "manual" })).rejects.toThrow("Capture unavailable");
    expect(localFetch).not.toHaveBeenCalled();
  });

  it("does not create a meeting when native IPC rejects", async () => {
    vi.mocked(commands.startCapture).mockRejectedValueOnce(new Error("IPC unavailable"));
    await expect(startMeetingWithCapture({ app: "manual" })).rejects.toThrow("IPC unavailable");
    expect(localFetch).not.toHaveBeenCalled();
  });

  it("retries native startup after failure instead of trusting capture intent", async () => {
    vi.mocked(commands.startCapture).mockResolvedValueOnce({ status: "error", error: "Startup failed" });
    await expect(resumeMeetingCapture()).rejects.toThrow("Startup failed");
    await resumeMeetingCapture();
    expect(commands.startCapture).toHaveBeenCalledTimes(2);
    expect(localFetch).not.toHaveBeenCalled();
  });

  it("resumes capture without starting another meeting or depending on device enumeration", async () => {
    await resumeMeetingCapture();
    expect(commands.startCapture).toHaveBeenCalledOnce();
    expect(localFetch).not.toHaveBeenCalled();
  });
});
