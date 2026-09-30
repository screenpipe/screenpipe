// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { useRef, useState } from "react";
import { act, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@/lib/chat/types";
import type { AIPreset } from "@/lib/utils/tauri";
import { buildContextOverflowMessage } from "@/lib/chat/provider-errors";
import { MessageContent } from "../../message-content";
import { usePiChatState } from "../use-pi-chat-state";
import { usePiForegroundEvents } from "../use-pi-foreground-events";

const storeMessages = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(async () => {}) }));
vi.mock("@/lib/stores/chat-store", () => ({
  useChatStore: { getState: () => ({
    sessions: {},
    actions: { patch: vi.fn(), setStreaming: vi.fn(), setMessages: storeMessages },
  }) },
}));
vi.mock("@/lib/events/bus", () => ({
  mountAgentEventBus: vi.fn(async () => {}),
  onTerminated: vi.fn(() => () => {}),
}));
vi.mock("../pi-log-listener", () => ({ registerPiLogListener: vi.fn(async () => () => {}) }));
vi.mock("../pi-reauth-listener", () => ({ registerPiReauthListener: vi.fn(async () => () => {}) }));

const progress = "I'll look at the repo to see what it actually contains.";
const overflow = "400 request (33252 tokens) exceeds the available context size (32768 tokens), try increasing it";
const initial: Message = {
  id: "assistant-1", role: "assistant", content: progress, timestamp: 0,
  contentBlocks: [
    { type: "text", text: progress, phase: "commentary" },
    { type: "tool", toolCall: { id: "search-1", toolName: "sp_web_search", args: {}, isRunning: false } },
  ],
};

function useErrorHarness(activePreset?: AIPreset) {
  const pi = usePiChatState();
  const [messages, setMessages] = useState<Message[]>([initial]);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const handler = useRef<((event: unknown) => void) | null>(null);
  usePiForegroundEvents({
    ...pi,
    activePreset,
    buildProviderConfig: () => null,
    cancelStreamingMessageRender: vi.fn(),
    clearPipeExecution: vi.fn(),
    consumeQueuedDisplayForStartedMessage: () => undefined,
    findTurnIntentForUserStart: () => undefined,
    flushPendingSteerBatch: async () => {},
    flushStreamingMessageRender: vi.fn(),
    handleAgentEventDataRef: handler,
    handleAgentActionEvent: () => false,
    clearAgentActionsForSession: vi.fn(),
    handleInvalidatedAuthToken: vi.fn(),
    lastUserMessageRef: useRef("Explain this repo"),
    markTurnIntentConsumed: vi.fn(),
    messages, messagesRef, setMessages,
    mountedRef: useRef(true),
    optimisticSteerRef: useRef(null),
    pendingNextPiUserDisplayRef: useRef(null),
    pendingNextPiUserIntentRef: useRef(null),
    pendingSteerBatchRef: useRef([]),
    saveConversation: async () => {},
    scheduleStreamingMessageRender: vi.fn(),
    setIsLoading: vi.fn(), setIsStreaming: vi.fn(),
    settings: {} as never,
    syncThinkingLevelAfterStart: vi.fn(),
    turnIntentLedgerRef: useRef([]),
    turnIntentTextValuesMatch: () => false,
    noteTurnLivenessEvent: vi.fn(),
  });
  return { pi, messages, setMessages, handler };
}

describe("Pi terminal provider errors", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });
  it.each([false, true])("retains an error after tool progress (earlier error events: %s)", (emitEarlierError) => {
    const { result } = renderHook(useErrorHarness);
    const errorMessage = { role: "assistant", stopReason: "error", errorMessage: overflow, content: [] };
    const sessionId = result.current.pi.piSessionIdRef.current;

    act(() => {
      const { pi, handler } = result.current;
      pi.piMessageIdRef.current = initial.id;
      pi.piStreamingTextRef.current = progress;
      pi.piContentBlocksRef.current = [...initial.contentBlocks!];
      if (emitEarlierError) {
        handler.current!({ type: "message_start", message: errorMessage });
        handler.current!({ type: "message_end", message: errorMessage });
      }
      handler.current!({ type: "agent_end", messages: [
        { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: progress }] },
        errorMessage,
      ] });
    });

    expect(result.current.messages[0]).toMatchObject({
      content: `Error: ${buildContextOverflowMessage(overflow)}`,
      retryPrompt: "Explain this repo",
      contentBlocks: initial.contentBlocks,
    });
    expect(storeMessages).toHaveBeenLastCalledWith(sessionId, result.current.messages);
    expect(result.current.pi.piMessageIdRef.current).toBeNull();
  });

  it("clears the retry action when the provider recovers and answers", () => {
    const { result } = renderHook(useErrorHarness);
    const answer = "Here is how to run the repository.";
    act(() => {
      result.current.setMessages([{ ...initial, content: buildContextOverflowMessage(overflow), retryPrompt: "Explain this repo" }]);
      result.current.pi.piMessageIdRef.current = initial.id;
      result.current.pi.piStreamingTextRef.current = answer;
      result.current.pi.piContentBlocksRef.current = [
        ...initial.contentBlocks!, { type: "text", text: answer },
      ];
      result.current.handler.current!({ type: "agent_end", messages: [
        { role: "assistant", stopReason: "stop", content: [{ type: "text", text: answer }] },
      ] });
    });
    expect(result.current.messages[0].content).toBe(answer);
    expect(result.current.messages[0].retryPrompt).toBeUndefined();
  });

  it.each([
    { agentId: "claude-acp", agentName: "Claude Code", error: 'Internal error: Credit balance is too low: { "errorKind": "billing_error" }', recovery: "Add credits" },
    { agentId: "cursor", agentName: "Cursor", error: "spending_limit_exceeded", recovery: "adjust the limit or see when it resets" },
    { agentId: "codex-acp", agentName: "Codex", error: 'Internal error: {"codexErrorInfo":"usageLimitExceeded"}', recovery: "usage settings to check when it resets" },
  ].flatMap((agent) => [false, true].map((with429) => ({ ...agent, with429 }))))(
    "retains $agentName billing recovery through the saved turn (HTTP 429: $with429)",
    ({ agentId, agentName, error, recovery, with429 }) => {
      const preset: AIPreset = {
        id: agentId, provider: "acp", model: agentId, prompt: "",
        acpAgent: { id: agentId, useScreenpipeCloud: false },
        defaultPreset: true, apiKey: null, maxContextChars: 100000,
      };
      const { result } = renderHook(() => useErrorHarness(preset));
      const raw = `${with429 ? "429 " : ""}${error}`;
      const errorMessage = { role: "assistant", stopReason: "error", errorMessage: raw, content: [] };
      const rawLog = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        act(() => {
          const { pi, handler } = result.current;
          pi.piMessageIdRef.current = initial.id;
          pi.piStreamingTextRef.current = progress;
          pi.piContentBlocksRef.current = [...initial.contentBlocks!];
          handler.current!({ type: "message_update", assistantMessageEvent: {
            type: "error", reason: "ACP request failed", error: raw,
          } });
          handler.current!({ type: "message_end", message: errorMessage });
          handler.current!({ type: "agent_end", messages: [errorMessage] });
        });
        const message = result.current.messages[0];
        expect(message.content).toContain(agentName);
        expect(message.content).toContain(recovery);
        expect(message.content).toContain("choose another AI preset");
        expect(message.retryPrompt).toBeUndefined();
        // Keep the original technical cause in the console logs collected by
        // support, while persisted chat history carries the recovery message.
        expect(rawLog).toHaveBeenCalledWith("[Pi] LLM error via", "message_end", ":", raw);
        const saved = storeMessages.mock.calls.at(-1)?.[1]?.[0];
        expect(saved).toEqual(message);
        render(<MessageContent message={JSON.parse(JSON.stringify(saved))} />);
        expect(screen.getByRole("alert")).toHaveTextContent(agentName);
        expect(screen.getByRole("alert")).toHaveTextContent(recovery);
        expect(screen.queryByRole("link", { name: /Anthropic/ })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
      } finally {
        rawLog.mockRestore();
      }
    },
  );
});
