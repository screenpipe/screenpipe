// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
const native = vi.hoisted(() => {
  let release!: (value: unknown) => void;
  const pending = new Promise(resolve => { release = resolve; });
  return { pending, release, getLocalApiConfig: vi.fn(() => pending) };
});
vi.mock("@/lib/utils/tauri", () => ({ commands: { getLocalApiConfig: native.getLocalApiConfig } }));
vi.mock("@/lib/hooks/use-tauri-event", () => ({ useTauriEvent: () => {} }));
vi.mock("@tauri-apps/api/event", () => ({ emit: async () => {} }));
vi.mock("@/components/starred-sessions/focused-narration", () => ({ FocusedNarration: class { stop = async () => {}; start = async () => {}; } }));
import { configureApi, getApiPort } from "@/lib/api";
import { useFocusedRecording } from "./use-focused-recording";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("waits for native API configuration before the first Capture read", async () => {
  const requests: string[] = [];
  const authorization: (string | null)[] = [];
  const session = { id: "fixture", name: "", phase: "recording", voiceEnabled: false, revision: 1, captureUntil: Date.now()+60000, intervals: [{start: Date.now(),end: null}] };
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    authorization.push(new Headers(init?.headers).get("Authorization"));
    requests.push(String(url));
    if (!String(url).startsWith("http://localhost:11437/")) throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify(session), {status: 200});
  });
  // SettingsProvider publishes its persisted fallback while the eager API
  // module's first getLocalApiConfig IPC still waits for the native result.
  configureApi({ port: 3030, authEnabled: true });
  const hook = renderHook(() => useFocusedRecording({canRecord:true,voiceAllowed:false}));
  await act(async () => {});
  expect(requests).toEqual([]);
  await act(async () => native.release({ port:11437, key:"fictional-local-key", auth_enabled:true }));
  await waitFor(() => expect(hook.result.current.session?.id).toBe("fixture"));
  expect(getApiPort()).toBe(11437);
  expect(requests).toEqual(["http://localhost:11437/focused-recordings/current"]);
  expect(authorization).toEqual(["Bearer fictional-local-key"]);
  expect(hook.result.current.error).toBeUndefined();
});
