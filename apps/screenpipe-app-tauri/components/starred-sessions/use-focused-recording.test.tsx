// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useFocusedRecording } from "./use-focused-recording";
import { unfinishedFocusedSession } from "../../e2e/helpers/focused-recording-controls";
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), start: vi.fn(), stop: vi.fn(), flush: vi.fn() }));
vi.mock("@/lib/api", () => ({ ensureApiReady: async () => {}, localFetch: mocks.fetch }));
vi.mock("@/lib/hooks/use-tauri-event", () => ({ useTauriEvent: () => {} }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(async () => {}) }));
vi.mock("./focused-narration", () => ({ FocusedNarration: class { start = mocks.start; stop = mocks.stop; flush = mocks.flush; } }));
let session: any;
const options = { canRecord: true, voiceAllowed: true };
beforeEach(() => {
  vi.clearAllMocks(); mocks.start.mockResolvedValue(undefined); mocks.stop.mockResolvedValue(undefined); mocks.flush.mockResolvedValue(undefined);
  session = { id: "fixture", name: "Invoice workflow", phase: "recording", voiceEnabled: true, revision: 1,
    createdAt: Date.now()-10000, lastCaptureAt: Date.now(), captureUntil: Date.now()+15000,
    intervals: [{start:Date.now()-10000,end:null}], media:null };
  mocks.fetch.mockImplementation(async (_path, init) => {
    if (init?.method === "POST") {
      const body = JSON.parse(init.body);
      if (body.action === "rename") session = {...session,name:body.name};
      if (body.action === "finish") session = {...session,phase:"summary",intervals:[{...session.intervals[0],end:Date.now()}],media:{screenFrames:2,audioChunks:1,audioSeconds:3}};
      if (body.action === "pause") session = {...session,phase:"paused",intervals:[{...session.intervals[0],end:body.at ?? Date.now()}]};
      session = {...session,revision:session.revision+1};
    }
    return {ok:true,json:async()=>session};
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
it("retains the submitted receipt until an explicit new workflow replaces it", async () => {
  session = { ...session, phase: "submitted", intervals: [{ ...session.intervals[0], end: Date.now() }] };
  const receipt = structuredClone(session);
  mocks.fetch.mockImplementation(async (path, init) => {
    if (path === "/focused-recordings/start" && init?.method === "POST") {
      session = { ...session, id: JSON.parse(init.body).id, name: "", phase: "recording", revision: 1, intervals: [] };
    }
    return { ok: true, json: async () => session };
  });
  const hook = renderHook(() => useFocusedRecording(options));
  await waitFor(() => expect(hook.result.current.session?.phase).toBe("submitted"));
  expect(hook.result.current.session).toEqual(receipt);
  expect(unfinishedFocusedSession(hook.result.current.session)).toBe(false);
  expect(mocks.fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  await act(async () => { await hook.result.current.newWorkflow(); });
  expect(hook.result.current.session?.id).not.toBe(receipt.id);
  expect(hook.result.current.session?.phase).toBe("recording");
  expect(unfinishedFocusedSession(hook.result.current.session)).toBe(true);
  expect(mocks.fetch.mock.calls.filter(([, init]) => init?.method === "POST").map(([path]) => path)).toEqual(["/focused-recordings/start"]);
  expect(receipt.phase).toBe("submitted");
});
it("reopens the running session without starting a second capture or delaying it for a name", async () => {
  const hook = renderHook(() => useFocusedRecording(options));
  await waitFor(() => expect(hook.result.current.session?.id).toBe("fixture"));
  await waitFor(() => expect(mocks.start).toHaveBeenCalledOnce());
  expect(mocks.fetch.mock.calls.every(([path]) => !path.endsWith("/start"))).toBe(true);
});
it("saves the name and closes narration before finishing into a frozen summary", async () => {
  const hook = renderHook(() => useFocusedRecording(options));
  await waitFor(() => expect(hook.result.current.session).toBeTruthy());
  act(() => hook.result.current.setName("Renamed workflow"));
  await act(async () => { await hook.result.current.act("finish"); });
  expect(mocks.stop).toHaveBeenCalled();
  expect(hook.result.current.session?.phase).toBe("summary");
  expect(hook.result.current.session?.name).toBe("Renamed workflow");
  const seconds = hook.result.current.seconds;
  expect(seconds).toBeGreaterThanOrEqual(10);
  expect(hook.result.current.session?.intervals[0].end).not.toBeNull();
});
it("retries a lost action response with the same request identifier", async () => {
  const hook = renderHook(() => useFocusedRecording(options));
  await waitFor(() => expect(hook.result.current.session).toBeTruthy());
  mocks.fetch.mockRejectedValueOnce(new Error("Connection lost"));
  await act(async () => { await hook.result.current.act("finish"); });
  expect(hook.result.current.error).toContain("Connection lost");
  const first = mocks.fetch.mock.calls.at(-1)![1].body;
  await act(async () => { await hook.result.current.retry(); });
  expect(mocks.fetch.mock.calls.at(-1)![1].body).toBe(first);
  expect(hook.result.current.session?.phase).toBe("paused");
  await act(async () => { await hook.result.current.act("finish"); });
  expect(hook.result.current.session?.phase).toBe("summary");
});
it("pauses screen capture immediately while final narration bytes are still saving", async () => {
  const hook = renderHook(() => useFocusedRecording(options));
  await waitFor(() => expect(hook.result.current.session).toBeTruthy());
  let release!: () => void;
  mocks.stop.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  let finishing!: Promise<void>;
  act(() => { finishing = hook.result.current.act("finish"); });
  try {
    await waitFor(() => expect(hook.result.current.session?.phase).toBe("paused"));
  } finally {
    await act(async () => { release(); await finishing; });
  }
});
it("keeps recovery actions available after a rejected submission", async () => {
  session.phase = "summary"; session.intervals[0].end = Date.now();
  const hook = renderHook(() => useFocusedRecording(options));
  await waitFor(() => expect(hook.result.current.session).toBeTruthy());
  mocks.fetch.mockResolvedValueOnce({ok:false,status:409,json:async()=>({error:"Submission unavailable"})});
  await act(async () => { await hook.result.current.act("submit"); });
  await act(async () => { await hook.result.current.act("resume"); });
  expect(JSON.parse(mocks.fetch.mock.calls.at(-1)![1].body).action).toBe("resume");
});
it("freezes elapsed time at Finish intent before the pause response arrives", async () => {
  vi.useFakeTimers();
  const hook = renderHook(() => useFocusedRecording(options));
  await act(async () => {});
  expect(hook.result.current.session).toBeTruthy();
  const seconds = hook.result.current.seconds;
  const normal = mocks.fetch.getMockImplementation()!;
  let release!: () => void;
  mocks.fetch.mockImplementationOnce((path,init) => new Promise(resolve => { release=()=>{void Promise.resolve(normal(path,init)).then(resolve);}; }));
  let finishing!: Promise<void>;
  act(() => { finishing=hook.result.current.act("finish"); });
  try {
    await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
    expect(hook.result.current.seconds).toBeCloseTo(seconds,1);
  } finally { await act(async()=>{release();await finishing;}); }
});
it("releases the microphone when its acknowledged capture lease expires", async () => {
  vi.useFakeTimers();
  const hook = renderHook(() => useFocusedRecording(options));
  await act(async () => {});
  expect(mocks.start).toHaveBeenCalledOnce();
  mocks.stop.mockClear();
  const normal = mocks.fetch.getMockImplementation()!;
  let release!: () => void;
  mocks.fetch.mockImplementationOnce((path,init) => new Promise(resolve=>{release=()=>{void Promise.resolve(normal(path,init)).then(resolve);};}));
  try {
    await act(async()=>{await vi.advanceTimersByTimeAsync(15001);});
    expect(mocks.stop).toHaveBeenCalled();
  } finally { await act(async()=>{release();}); }
});
it("clears a rejected retry so recovery controls remain usable", async () => {
  const hook = renderHook(() => useFocusedRecording(options));
  await waitFor(() => expect(hook.result.current.session).toBeTruthy());
  mocks.fetch.mockRejectedValueOnce(new Error("Lost stop response"));
  await act(async()=>{await hook.result.current.act("finish");});
  mocks.fetch.mockResolvedValueOnce({ok:false,status:409,json:async()=>({error:"Recording changed"})});
  await act(async()=>{await hook.result.current.retry();});
  await act(async()=>{await hook.result.current.act("resume");});
  expect(JSON.parse(mocks.fetch.mock.calls.at(-1)![1].body).action).toBe("resume");
});
it("keeps microphone errors visible across successful screen heartbeats", async () => {
  vi.useFakeTimers(); mocks.start.mockRejectedValueOnce(new Error("Allow microphone access"));
  const hook = renderHook(() => useFocusedRecording(options));
  await act(async()=>{});
  expect(hook.result.current.error).toBe("Allow microphone access");
  await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
  expect(hook.result.current.error).toBe("Allow microphone access");
});
it("lets Pause stop narration while a background heartbeat response is delayed", async () => {
  vi.useFakeTimers(); const hook=renderHook(()=>useFocusedRecording(options)); await act(async()=>{});
  const stale={...session,revision:2};
  let release!:(value:unknown)=>void;
  mocks.fetch.mockImplementationOnce(()=>{session={...session,revision:2};return new Promise(resolve=>{release=resolve;});});
  await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
  mocks.stop.mockClear();
  await act(async()=>{await hook.result.current.act("pause");});
  try {
    expect(mocks.stop).toHaveBeenCalled();
    expect(hook.result.current.session?.phase).toBe("paused");
  } finally { await act(async()=>{release({ok:true,json:async()=>stale});}); }
  expect(hook.result.current.session?.phase).toBe("paused");
  expect(mocks.start).toHaveBeenCalledOnce();
});
it("does not start a microphone when a Voice request discovers a paused session", async () => {
  session.voiceEnabled=false;
  const hook=renderHook(()=>useFocusedRecording(options));
  await waitFor(()=>expect(hook.result.current.session).toBeTruthy());
  mocks.fetch.mockResolvedValueOnce({ok:true,json:async()=>({...session,phase:"paused",revision:2})});
  await act(async()=>{await hook.result.current.toggleVoice();});
  expect(mocks.start).not.toHaveBeenCalled();
});
it("finishes after stopping immediately during a delayed background save", async () => {
  vi.useFakeTimers();
  const hook=renderHook(()=>useFocusedRecording(options));
  await act(async()=>{});
  let release!:(value:unknown)=>void;
  const stale={...session,revision:2};
  mocks.fetch.mockImplementationOnce(()=>{session={...session,revision:2};return new Promise(resolve=>{release=resolve;});});
  await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
  let finishing!:Promise<void>;
  act(()=>{finishing=hook.result.current.act("finish");});
  await act(async()=>{});
  expect(mocks.stop).toHaveBeenCalled();
  expect(hook.result.current.session?.phase).toBe("paused");
  await act(async()=>{release({ok:true,json:async()=>stale});await finishing;});
  expect(hook.result.current.session?.phase).toBe("summary");
});
