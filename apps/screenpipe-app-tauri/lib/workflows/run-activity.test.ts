// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { beforeEach, expect, it, vi } from "vitest";
import { subscribeWorkflowActivity } from "./run-activity";
import { registerObserver } from "@/lib/events/bus";
import type { AgentEventEnvelope } from "@/lib/events/types";
vi.mock("@/lib/events/bus", () => ({ mountAgentEventBus: vi.fn().mockResolvedValue(undefined), registerObserver: vi.fn() }));
vi.mock("@/lib/api", () => ({ getApiBaseUrl: () => "http://localhost:3030" }));
beforeEach(() => vi.clearAllMocks());
it("isolates the exact workflow execution and reuses readable Chat tool labels", async () => {
  const update = vi.fn(), off = vi.fn();
  vi.mocked(registerObserver).mockReturnValue(off);
  expect(await subscribeWorkflowActivity("42", update)).toBe(off);
  const receive = vi.mocked(registerObserver).mock.calls[0][0];
  const envelope: AgentEventEnvelope = { source: "pipe", sessionId: "pipe:workflow-discovery:continuous", executionId: 42,
    event: { type: "tool_execution_start", toolCallId: "a", toolName: "read", args: { path: "/private/secret.txt" } } };
  receive({ ...envelope, executionId: 41 });
  receive({ ...envelope, source: "pi" });
  receive({ ...envelope, sessionId: "pipe:another-task:42" });
  expect(update).not.toHaveBeenCalled();
  receive(envelope);
  expect(update.mock.lastCall![0][0]).toMatchObject({ id: "a", status: "running" });
  receive({ ...envelope, event: { ...envelope.event, type: "tool_execution_end" } });
  expect(update.mock.lastCall![0]).toHaveLength(1);
  expect(update.mock.lastCall![0][0].status).toBe("complete");
  expect(JSON.stringify(update.mock.calls)).not.toContain("secret.txt");
});
it("bounds activity and preserves tool failures without exposing results or thoughts", async () => {
  const update = vi.fn();
  await subscribeWorkflowActivity("7", update);
  const receive = vi.mocked(registerObserver).mock.calls[0][0];
  for (let n = 0; n < 30; n++) receive({ source: "pipe", sessionId: "pipe:workflow-discovery:7", event: {
    type: "tool_execution_end", toolCallId: String(n), toolName: "read", isError: n === 29, result: { content: [{ text: "sensitive result" }] },
  } });
  expect(update.mock.lastCall![0]).toHaveLength(20);
  expect(update.mock.lastCall![0].at(-1).status).toBe("error");
  expect(JSON.stringify(update.mock.calls)).not.toContain("sensitive result");
  const count = update.mock.calls.length;
  receive({ source: "pipe", sessionId: "pipe:workflow-discovery:7", event: { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "private reasoning" } } });
  expect(update).toHaveBeenCalledTimes(count);
});
