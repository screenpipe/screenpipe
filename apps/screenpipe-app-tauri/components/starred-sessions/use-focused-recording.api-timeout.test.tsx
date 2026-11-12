// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ getLocalApiConfig: vi.fn(async () => ({ port: 11437, key: "fictional-local-key", auth_enabled: true })) }));
vi.mock("@/lib/utils/tauri", () => ({ commands: { getLocalApiConfig: native.getLocalApiConfig } }));
vi.mock("@/lib/hooks/use-tauri-event", () => ({ useTauriEvent: () => {} }));
vi.mock("@tauri-apps/api/event", () => ({ emit: async () => {} }));
vi.mock("./focused-narration", () => ({ FocusedNarration: class { stop = async () => {}; start = async () => {}; } }));
import { useFocusedRecording } from "./use-focused-recording";

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("releases a paused save at its deadline without sending a late write when native metadata stalls", async () => {
  const session = { id: "fixture", name: "", phase: "recording", voiceEnabled: false, revision: 1, captureUntil: Date.now() + 60000, intervals: [{ start: Date.now(), end: null }] };
  const fetch = vi.fn(async () => new Response(JSON.stringify(session), { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  const hook = renderHook(() => useFocusedRecording({ canRecord: true, voiceAllowed: false }));
  await waitFor(() => expect(hook.result.current.session?.id).toBe("fixture"));
  let release!: (config: { port: number; key: string; auth_enabled: boolean }) => void;
  native.getLocalApiConfig.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  vi.useFakeTimers();
  let pausing!: Promise<void>;
  await act(async () => { pausing = hook.result.current.act("pause"); });
  expect(hook.result.current.busy).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
  expect(hook.result.current.busy).toBe(false);
  expect(hook.result.current.error).toBeTruthy();
  expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () => {
    release({ port: 11437, key: "fictional-local-key", auth_enabled: true });
    await pausing;
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});
