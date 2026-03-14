import { describe, it, expect } from "vitest";
import {
  createInitialState,
  reducePiEvent,
  formatPiMessage,
  validateProjectDir,
  shouldPiStart,
  shouldIgnoreTermination,
  formatToolArgs,
  PiEvent,
  PiMessageState,
} from "../pi-event-handler";

// ============================================================================
// reducePiEvent
// ============================================================================

describe("reducePiEvent", () => {
  it("returns initial state for unknown event types", () => {
    const state = createInitialState();
    const result = reducePiEvent(state, { type: "turn_start" } as PiEvent);
    expect(result).toEqual(state);
  });

  // --- text_delta ---

  it("appends text_delta to text", () => {
    const state = createInitialState();
    const event: PiEvent = {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Hello" },
    };
    const result = reducePiEvent(state, event);
    expect(result.text).toBe("Hello");
  });

  it("appends multiple text deltas", () => {
    let state = createInitialState();
    state = reducePiEvent(state, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Hello" },
    });
    state = reducePiEvent(state, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: " world" },
    });
    expect(state.text).toBe("Hello world");
  });

  it("ignores message_update with no assistantMessageEvent", () => {
    const state = createInitialState();
    const result = reducePiEvent(state, { type: "message_update" });
    expect(result).toEqual(state);
  });

  it("ignores non-text_delta assistant events", () => {
    const state = createInitialState();
    const result = reducePiEvent(state, {
      type: "message_update",
      assistantMessageEvent: { type: "text_start" },
    });
    expect(result.text).toBe("");
  });

  it("ignores text_delta with no delta", () => {
    const state = createInitialState();
    const result = reducePiEvent(state, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta" },
    });
    expect(result.text).toBe("");
  });

  // --- tool_execution_start ---

  it("adds tool call on tool_execution_start", () => {
    const state = createInitialState();
    const event: PiEvent = {
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "read",
      args: { path: "sample.txt" },
    };
    const result = reducePiEvent(state, event);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({
      id: "call_1",
      name: "read",
      args: { path: "sample.txt" },
      status: "running",
    });
  });

  it("handles tool_execution_start with missing fields", () => {
    const state = createInitialState();
    const result = reducePiEvent(state, { type: "tool_execution_start" });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("unknown");
    expect(result.toolCalls[0].id).toBe("");
  });

  // --- tool_execution_update ---

  it("updates tool result on tool_execution_update", () => {
    let state = createInitialState();
    state = reducePiEvent(state, {
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "bash",
      args: { command: "ls" },
    });
    state = reducePiEvent(state, {
      type: "tool_execution_update",
      toolCallId: "call_1",
      toolName: "bash",
      partialResult: { content: [{ type: "text", text: "file1.txt\nfile2.txt" }] },
    });
    expect(state.toolCalls[0].result).toBe("file1.txt\nfile2.txt");
    expect(state.toolCalls[0].status).toBe("running");
  });

  it("ignores tool_execution_update for unknown toolCallId", () => {
    let state = createInitialState();
    state = reducePiEvent(state, {
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "bash",
      args: {},
    });
    const result = reducePiEvent(state, {
      type: "tool_execution_update",
      toolCallId: "call_999",
      partialResult: { content: [{ type: "text", text: "stuff" }] },
    });
    expect(result.toolCalls[0].result).toBeUndefined();
  });

  it("ignores tool_execution_update with no content", () => {
    let state = createInitialState();
    state = reducePiEvent(state, {
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "bash",
      args: {},
    });
    const result = reducePiEvent(state, {
      type: "tool_execution_update",
      toolCallId: "call_1",
    });
    expect(result.toolCalls[0].result).toBeUndefined();
  });

  // --- tool_execution_end ---

  it("marks tool as done on tool_execution_end", () => {
    let state = createInitialState();
    state = reducePiEvent(state, {
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "read",
      args: { path: "test.txt" },
    });
    state = reducePiEvent(state, {
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "read",
      result: { content: [{ type: "text", text: "file contents" }] },
      isError: false,
    });
    expect(state.toolCalls[0].status).toBe("done");
    expect(state.toolCalls[0].result).toBe("file contents");
  });

  it("marks tool as error on tool_execution_end with isError", () => {
    let state = createInitialState();
    state = reducePiEvent(state, {
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "bash",
      args: { command: "bad-cmd" },
    });
    state = reducePiEvent(state, {
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "command not found" }] },
      isError: true,
    });
    expect(state.toolCalls[0].status).toBe("error");
    expect(state.toolCalls[0].result).toBe("command not found");
  });

  it("ignores tool_execution_end with no toolCallId", () => {
    let state = createInitialState();
    state = reducePiEvent(state, {
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "read",
      args: {},
    });
    const result = reducePiEvent(state, {
      type: "tool_execution_end",
      isError: false,
    });
    // Tool unchanged
    expect(result.toolCalls[0].status).toBe("running");
  });

  // --- agent_end ---

  it("sets done on agent_end", () => {
    const state = createInitialState();
    const result = reducePiEvent(state, { type: "agent_end" });
    expect(result.done).toBe(true);
  });

  it("preserves text and toolCalls on agent_end", () => {
    let state = createInitialState();
    state = reducePiEvent(state, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "result" },
    });
    state = reducePiEvent(state, {
      type: "tool_execution_start",
      toolCallId: "c1",
      toolName: "bash",
      args: {},
    });
    state = reducePiEvent(state, { type: "agent_end" });
    expect(state.text).toBe("result");
    expect(state.toolCalls).toHaveLength(1);
    expect(state.done).toBe(true);
  });

  // --- response errors ---

  it("appends error on response success=false", () => {
    const state = createInitialState();
    const result = reducePiEvent(state, {
      type: "response",
      success: false,
      error: "Model not found",
    });
    expect(result.text).toContain("Error: Model not found");
    expect(result.done).toBe(true);
  });

  it("ignores successful response events", () => {
    const state = createInitialState();
    const result = reducePiEvent(state, {
      type: "response",
      success: true,
      command: "prompt",
    });
    expect(result).toEqual(state);
  });

  // --- full scenario ---

  it("handles a full read + write scenario end to end", () => {
    let state = createInitialState();

    // Text before tool
    state = reducePiEvent(state, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "I'll read the file.\n\n" },
    });

    // Read tool
    state = reducePiEvent(state, {
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "read",
      args: { path: "sample.txt" },
    });
    state = reducePiEvent(state, {
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "read",
      result: { content: [{ type: "text", text: "hello" }] },
      isError: false,
    });

    // More text
    state = reducePiEvent(state, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Now writing." },
    });

    // Write tool
    state = reducePiEvent(state, {
      type: "tool_execution_start",
      toolCallId: "t2",
      toolName: "write",
      args: { path: "result.txt", content: "olleh" },
    });
    state = reducePiEvent(state, {
      type: "tool_execution_end",
      toolCallId: "t2",
      toolName: "write",
      result: { content: [{ type: "text", text: "Wrote 5 bytes to result.txt" }] },
      isError: false,
    });

    // Agent done
    state = reducePiEvent(state, { type: "agent_end" });

    expect(state.text).toBe("I'll read the file.\n\nNow writing.");
    expect(state.toolCalls).toHaveLength(2);
    expect(state.toolCalls[0].status).toBe("done");
    expect(state.toolCalls[0].result).toBe("hello");
    expect(state.toolCalls[1].status).toBe("done");
    expect(state.toolCalls[1].result).toBe("Wrote 5 bytes to result.txt");
    expect(state.done).toBe(true);
  });
});

// ============================================================================
// formatPiMessage
// ============================================================================

describe("formatPiMessage", () => {
  it("returns 'Processing...' when empty and not done", () => {
    const state = createInitialState();
    expect(formatPiMessage(state)).toBe("Processing...");
  });

  it("returns text when present and no tools", () => {
    const state: PiMessageState = { text: "Hello world", toolCalls: [], done: false };
    expect(formatPiMessage(state)).toBe("Hello world");
  });

  it("includes running tool with spinner icon", () => {
    const state: PiMessageState = {
      text: "Reading...",
      toolCalls: [
        { id: "t1", name: "read", args: { path: "file.txt" }, status: "running" },
      ],
      done: false,
    };
    const formatted = formatPiMessage(state);
    expect(formatted).toContain("⏳");
    expect(formatted).toContain("Read file.txt");
  });

  it("includes done tool with check icon", () => {
    const state: PiMessageState = {
      text: "Done",
      toolCalls: [
        { id: "t1", name: "read", args: { path: "file.txt" }, status: "done", result: "contents" },
      ],
      done: true,
    };
    const formatted = formatPiMessage(state);
    expect(formatted).toContain("✅");
    expect(formatted).toContain("```\ncontents\n```");
  });

  it("includes error tool with X icon", () => {
    const state: PiMessageState = {
      text: "",
      toolCalls: [
        { id: "t1", name: "bash", args: { command: "bad" }, status: "error", result: "not found" },
      ],
      done: true,
    };
    const formatted = formatPiMessage(state);
    expect(formatted).toContain("❌");
    expect(formatted).toContain("`bad`");
    expect(formatted).toContain("not found");
  });

  it("truncates long tool results", () => {
    const longResult = "x".repeat(600);
    const state: PiMessageState = {
      text: "",
      toolCalls: [
        { id: "t1", name: "read", args: { path: "big.txt" }, status: "done", result: longResult },
      ],
      done: true,
    };
    const formatted = formatPiMessage(state);
    expect(formatted).toContain("... (truncated)");
    expect(formatted.length).toBeLessThan(longResult.length);
  });

  it("formats bash tool args as command", () => {
    const state: PiMessageState = {
      text: "",
      toolCalls: [
        { id: "t1", name: "bash", args: { command: "ls -la" }, status: "done", result: "files" },
      ],
      done: true,
    };
    const formatted = formatPiMessage(state);
    expect(formatted).toContain("`ls -la`");
  });

  it("formats write tool args as path", () => {
    const state: PiMessageState = {
      text: "",
      toolCalls: [
        { id: "t1", name: "write", args: { path: "out.txt", content: "data" }, status: "done", result: "ok" },
      ],
      done: true,
    };
    const formatted = formatPiMessage(state);
    expect(formatted).toContain("Wrote out.txt");
  });

  it("handles multiple tool calls in sequence", () => {
    const state: PiMessageState = {
      text: "Working...",
      toolCalls: [
        { id: "t1", name: "read", args: { path: "a.txt" }, status: "done", result: "A" },
        { id: "t2", name: "write", args: { path: "b.txt" }, status: "done", result: "wrote B" },
        { id: "t3", name: "bash", args: { command: "echo hi" }, status: "running" },
      ],
      done: false,
    };
    const formatted = formatPiMessage(state);
    expect(formatted).toContain("✅ Read a.txt");
    expect(formatted).toContain("✅ Wrote b.txt");
    expect(formatted).toContain("⏳ Ran `echo hi`");
  });
});

// ============================================================================
// validateProjectDir
// ============================================================================

describe("validateProjectDir", () => {
  it("returns error for empty string", () => {
    expect(validateProjectDir("")).not.toBeNull();
  });

  it("returns error for whitespace only", () => {
    expect(validateProjectDir("   ")).not.toBeNull();
  });

  it("returns error for relative path", () => {
    expect(validateProjectDir("relative/path")).not.toBeNull();
  });

  it("returns null for valid unix absolute path", () => {
    expect(validateProjectDir("/home/user/project")).toBeNull();
  });

  it("returns null for valid windows absolute path", () => {
    expect(validateProjectDir("C:\\Users\\project")).toBeNull();
  });

  it("returns null for /tmp path", () => {
    expect(validateProjectDir("/tmp/test")).toBeNull();
  });
});

// ============================================================================
// shouldPiStart
// ============================================================================

describe("shouldPiStart", () => {
  const defaults = {
    isPi: true,
    open: true,
    needsLogin: false,
    projectDir: "/tmp/test",
    starting: false,
    running: false,
    generation: 0,
  };

  it("returns true when all conditions met", () => {
    const { shouldStart } = shouldPiStart(defaults);
    expect(shouldStart).toBe(true);
  });

  it("returns false when not pi", () => {
    const { shouldStart, reason } = shouldPiStart({ ...defaults, isPi: false });
    expect(shouldStart).toBe(false);
    expect(reason).toBe("not pi preset");
  });

  it("returns false when chat closed", () => {
    const { shouldStart, reason } = shouldPiStart({ ...defaults, open: false });
    expect(shouldStart).toBe(false);
    expect(reason).toBe("chat not open");
  });

  it("returns false when needs login", () => {
    const { shouldStart, reason } = shouldPiStart({ ...defaults, needsLogin: true });
    expect(shouldStart).toBe(false);
    expect(reason).toBe("needs login");
  });

  it("returns false when no project dir", () => {
    const { shouldStart, reason } = shouldPiStart({ ...defaults, projectDir: "" });
    expect(shouldStart).toBe(false);
    expect(reason).toBe("no project dir");
  });

  it("returns false when already starting", () => {
    const { shouldStart, reason } = shouldPiStart({ ...defaults, starting: true });
    expect(shouldStart).toBe(false);
    expect(reason).toBe("already starting");
  });

  it("returns false when already running", () => {
    const { shouldStart, reason } = shouldPiStart({ ...defaults, running: true });
    expect(shouldStart).toBe(false);
    expect(reason).toBe("already running");
  });
});

// ============================================================================
// shouldIgnoreTermination
// ============================================================================

describe("shouldIgnoreTermination", () => {
  it("ignores stale generation", () => {
    expect(shouldIgnoreTermination(0, 1)).toBe(true);
    expect(shouldIgnoreTermination(5, 10)).toBe(true);
  });

  it("does not ignore current generation", () => {
    expect(shouldIgnoreTermination(5, 5)).toBe(false);
  });

  it("does not ignore future generation (edge case)", () => {
    expect(shouldIgnoreTermination(6, 5)).toBe(false);
  });
});
