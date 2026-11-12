// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({
  getLocalApiConfig: vi.fn(() => Promise.resolve({ port:11437, key:"fictional-local-key", auth_enabled:true })),
}));
vi.mock("@/lib/utils/tauri", () => ({ commands: { getLocalApiConfig: native.getLocalApiConfig } }));
vi.mock("@/lib/hooks/use-tauri-event", () => ({ useTauriEvent: () => {} }));
vi.mock("@tauri-apps/api/event", () => ({ emit: async () => {} }));
vi.mock("@/components/starred-sessions/focused-narration", () => ({ FocusedNarration: class { stop = async () => {}; start = async () => {}; } }));
import { configureApi, getApiPort, ensureApiReady } from "@/lib/api";
import { useFocusedRecording } from "./use-focused-recording";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });


it("refreshes the native port when persisted settings replace it after key hydration", async () => {
  // Establish the other startup ordering: native auth already hydrated, then
  // SettingsProvider publishes its persisted port before its refresh resolves.
  await ensureApiReady();
  expect(getApiPort()).toBe(11437);
  configureApi({ port: 3030, authEnabled: true });
  let release!: (value: { port: number; key: string; auth_enabled: boolean }) => void;
  native.getLocalApiConfig.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const requests: string[] = [];
  const authorization: (string | null)[] = [];
  const session = { id: "cached-key-fixture", name: "", phase: "paused", voiceEnabled: false, revision: 1, captureUntil: Date.now(), intervals: [] };
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    requests.push(String(url));
    authorization.push(new Headers(init?.headers).get("Authorization"));
    if (!String(url).startsWith("http://localhost:11437/")) throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify(session), {status: 200});
  });
  const hook = renderHook(() => useFocusedRecording({canRecord:true,voiceAllowed:false}));
  await act(async () => {});
  expect(requests).toEqual([]);
  await act(async () => release({ port:11437, key:"fictional-local-key", auth_enabled:true }));
  await waitFor(() => expect(hook.result.current.session?.id).toBe("cached-key-fixture"));
  expect(requests).toEqual(["http://localhost:11437/focused-recordings/current"]);
  expect(authorization).toEqual(["Bearer fictional-local-key"]);
  expect(hook.result.current.error).toBeUndefined();
});
