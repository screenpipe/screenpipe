// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ receive: null as any }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (_: string, receive: unknown) => { state.receive = receive; return () => {}; }) }));
vi.mock("@tauri-apps/plugin-fs", () => ({ exists: vi.fn(), readTextFile: vi.fn(), writeTextFile: vi.fn(), rename: vi.fn(), remove: vi.fn() }));
vi.mock("@/lib/utils/tauri", () => ({ commands: {} }));
import { workflowModelPreference } from "./model-choice";
it("receives verification from workflow chat and scheduled runs, excluding unrelated agents", async () => {
  const receive = vi.fn();
  const off = await workflowModelPreference.verification!.subscribe(receive);
  for (const [source, sessionId] of [
    ["pi", "__title:workflow-assistant-123"], ["pipe", "pipe:workflow-deepen:115"],
    ["pipe", "pipe:workflow-review:continuous"], ["pipe", "pipe:daily-recap:9"], ["pi", "ordinary-chat"],
  ]) state.receive({ payload: { source, sessionId, event: { type: "extension_ui_request" } } });
  expect(receive.mock.calls.map(([value]) => value.sessionId)).toEqual([
    "__title:workflow-assistant-123", "pipe:workflow-deepen:115", "pipe:workflow-review:continuous",
  ]);
  off();
});
