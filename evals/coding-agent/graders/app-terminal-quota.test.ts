// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { useRef, useState } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@/lib/chat/types";
import { commands } from "@/lib/utils/tauri";
import type { AIPreset } from "@/lib/utils/tauri";
import { buildContextOverflowMessage } from "@/lib/chat/provider-errors";
import { usePiChatState } from "@/components/chat/standalone/hooks/use-pi-chat-state";
import { usePiForegroundEvents } from "@/components/chat/standalone/hooks/use-pi-foreground-events";

const storeMessages = vi.hoisted(() => vi.fn());
const loading = vi.hoisted(() => vi.fn());
const streaming = vi.hoisted(() => vi.fn());
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
vi.mock("@/components/chat/standalone/hooks/pi-log-listener", () => ({ registerPiLogListener: vi.fn(async () => () => {}) }));
vi.mock("@/components/chat/standalone/hooks/pi-reauth-listener", () => ({ registerPiReauthListener: vi.fn(async () => () => {}) }));

vi.mock("posthog-js", () => ({ default: {capture: vi.fn(), getFeatureFlag: vi.fn()} }));
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
    setIsLoading: loading, setIsStreaming: streaming,
    settings: {} as never,
    syncThinkingLevelAfterStart: vi.fn(),
    turnIntentLedgerRef: useRef([]),
    turnIntentTextValuesMatch: () => false,
    noteTurnLivenessEvent: vi.fn(),
  });
  return { pi, messages, setMessages, handler };
}


describe("terminal quota event outcomes", () => {
  beforeEach(() => {
    vi.useFakeTimers(); vi.clearAllMocks();
    vi.spyOn(commands, "piStop").mockResolvedValue({status: "ok", data: null} as never);
    vi.spyOn(commands, "piPrompt").mockResolvedValue({status: "ok", data: null} as never);
    vi.stubGlobal("fetch", vi.fn(() => {throw new Error("live network forbidden");}));
  });
  afterEach(() => {vi.clearAllTimers();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});
  const terminal = [
    {raw: '429 {"error":"daily_cost_limit_exceeded"}', visible: /limit|allowance|budget/i},
    {raw: '429 credits_exhausted', visible: /credit|limit|allowance|used.*included.*queries/i},
    {raw: '429 {"error":"model_not_allowed"}', visible: /model|upgrade/i},
  ];
  it.each(terminal)("stops a futile provider retry and finalizes $raw", async ({raw,visible}) => {
    const {result}=renderHook(useErrorHarness);
    const error={role:"assistant",stopReason:"error",errorMessage:raw,content:[]};
    const sid=result.current.pi.piSessionIdRef.current;
    act(() => {
      result.current.pi.piMessageIdRef.current=initial.id;
      result.current.handler.current!({type:"message_end",message:error});
      result.current.handler.current!({type:"agent_end",willRetry:true,messages:[error]});
    });
    await act(async () => {await vi.advanceTimersByTimeAsync(61000);});
    expect(commands.piStop).toHaveBeenCalledWith(sid);
    expect(commands.piPrompt).not.toHaveBeenCalled();
    expect(result.current.messages[0].content).toMatch(visible);
    expect(loading).toHaveBeenLastCalledWith(false);
    expect(streaming).toHaveBeenLastCalledWith(false);
    expect(result.current.pi.piMessageIdRef.current).toBeNull();
  });
  it.each(['429 Too many requests reset_in=1','500 upstream unavailable'])("leaves an ordinary provider retry active: %s", raw => {
    const {result}=renderHook(useErrorHarness);
    const error={role:"assistant",stopReason:"error",errorMessage:raw,content:[]};
    act(() => {
      result.current.pi.piMessageIdRef.current=initial.id;
      result.current.handler.current!({type:"message_end",message:error});
      result.current.handler.current!({type:"agent_end",willRetry:true,messages:[error]});
    });
    expect(commands.piStop).not.toHaveBeenCalled();
    expect(result.current.pi.piMessageIdRef.current).toBe(initial.id);
    expect(loading).toHaveBeenLastCalledWith(true);
    expect(streaming).toHaveBeenLastCalledWith(true);
  });
  it("retries an ordinary throttled response after its wait",async()=>{
    const {result}=renderHook(useErrorHarness);
    act(()=>{result.current.pi.piMessageIdRef.current=initial.id;result.current.handler.current!({type:"response",success:false,error:"429 Too many requests reset_in=1"});});
    await act(async()=>{await vi.advanceTimersByTimeAsync(61000);});
    expect(commands.piPrompt).toHaveBeenCalledTimes(1);
    expect(commands.piStop).not.toHaveBeenCalled();
  });
  it("finalizes a successful answer",()=>{
    const {result}=renderHook(useErrorHarness);
    act(()=>{result.current.pi.piMessageIdRef.current=initial.id;result.current.handler.current!({type:"agent_end",messages:[{role:"assistant",content:[{type:"text",text:"Synthetic successful answer"}]}]});});
    expect(result.current.messages[0].content).toBe("Synthetic successful answer");
    expect(commands.piStop).not.toHaveBeenCalled();expect(loading).toHaveBeenLastCalledWith(false);
  });
});
