/**
 * Pi RPC event handler - pure functions for processing Pi sidecar events.
 * Extracted from global-chat.tsx for testability.
 */

// ============================================================================
// Types
// ============================================================================

export interface PiToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: "running" | "done" | "error";
  result?: string;
}

export interface PiMessageState {
  text: string;
  toolCalls: PiToolCall[];
  done: boolean;
}

export type PiEventType =
  | "message_update"
  | "tool_execution_start"
  | "tool_execution_update"
  | "tool_execution_end"
  | "agent_end"
  | "agent_start"
  | "turn_start"
  | "turn_end"
  | "message_start"
  | "message_end"
  | "response";

export interface PiEvent {
  type: PiEventType;
  // message_update
  assistantMessageEvent?: {
    type: string;
    delta?: string;
    contentIndex?: number;
    content?: string;
  };
  // tool events
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  partialResult?: {
    content?: Array<{ type: string; text?: string }>;
  };
  result?: {
    content?: Array<{ type: string; text?: string }>;
  };
  isError?: boolean;
  // response
  success?: boolean;
  error?: string;
  command?: string;
  // agent_end
  messages?: unknown[];
}

// ============================================================================
// State reducer - processes Pi events into message state
// ============================================================================

export function createInitialState(): PiMessageState {
  return { text: "", toolCalls: [], done: false };
}

/**
 * Pure reducer: takes current state + event, returns new state.
 * No side effects, fully testable.
 */
export function reducePiEvent(
  state: PiMessageState,
  event: PiEvent
): PiMessageState {
  switch (event.type) {
    case "message_update": {
      const evt = event.assistantMessageEvent;
      if (!evt) return state;
      if (evt.type === "text_delta" && evt.delta) {
        return { ...state, text: state.text + evt.delta };
      }
      return state;
    }

    case "tool_execution_start": {
      const toolCall: PiToolCall = {
        id: event.toolCallId ?? "",
        name: event.toolName ?? "unknown",
        args: event.args ?? {},
        status: "running",
      };
      return { ...state, toolCalls: [...state.toolCalls, toolCall] };
    }

    case "tool_execution_update": {
      const content = event.partialResult?.content
        ?.map((c) => c.text)
        .filter(Boolean)
        .join("\n");
      if (!content || !event.toolCallId) return state;
      return {
        ...state,
        toolCalls: state.toolCalls.map((tc) =>
          tc.id === event.toolCallId ? { ...tc, result: content } : tc
        ),
      };
    }

    case "tool_execution_end": {
      const resultText = event.result?.content
        ?.map((c) => c.text)
        .filter(Boolean)
        .join("\n");
      if (!event.toolCallId) return state;
      return {
        ...state,
        toolCalls: state.toolCalls.map((tc) =>
          tc.id === event.toolCallId
            ? {
                ...tc,
                status: event.isError ? "error" : "done",
                result: resultText ?? tc.result,
              }
            : tc
        ),
      };
    }

    case "agent_end": {
      return { ...state, done: true };
    }

    case "response": {
      if (event.success === false) {
        return {
          ...state,
          text: state.text + `\n\nError: ${event.error ?? "Unknown error"}`,
          done: true,
        };
      }
      return state;
    }

    default:
      return state;
  }
}

// ============================================================================
// Format message content with tool call details for display
// ============================================================================

/**
 * Renders Pi message state into markdown string for the chat UI.
 * Shows text + collapsible tool call details.
 */
export function formatPiMessage(state: PiMessageState): string {
  let content = state.text;

  for (const tc of state.toolCalls) {
    const statusIcon =
      tc.status === "running" ? "⏳" : tc.status === "error" ? "❌" : "✅";

    const argsStr = formatToolArgs(tc.name, tc.args);

    content += `\n\n${statusIcon} ${argsStr}`;

    if (tc.result) {
      // Truncate long results
      const result =
        tc.result.length > 500
          ? tc.result.slice(0, 500) + "\n... (truncated)"
          : tc.result;
      content += `\n\`\`\`\n${result}\n\`\`\``;
    }
  }

  if (!content && !state.done) {
    content = "Processing...";
  }

  return content;
}

export function formatToolArgs(
  toolName: string,
  args: Record<string, unknown>
): string {
  const fileName = (p: unknown) => {
    const s = String(p ?? "");
    return s.split("/").pop() || s;
  };
  switch (toolName) {
    case "read":
      return `Read ${fileName(args.path)}`;
    case "write":
      return `Wrote ${fileName(args.path)}`;
    case "edit":
      return `Edited ${fileName(args.path)}`;
    case "bash": {
      const cmd = String(args.command ?? "");
      return `Ran \`${cmd.length > 60 ? cmd.slice(0, 60) + "…" : cmd}\``;
    }
    case "grep":
      return `Searched for \`${args.pattern ?? "pattern"}\``;
    default:
      return Object.keys(args).length > 0 ? Object.keys(args).join(", ") : "";
  }
}

// ============================================================================
// Pi process lifecycle helpers
// ============================================================================

export interface PiStartConfig {
  projectDir: string;
  userToken: string | null;
}

/**
 * Validates a project directory path.
 * Returns null if valid, error string if not.
 */
export function validateProjectDir(dir: string): string | null {
  if (!dir || !dir.trim()) {
    return "Project directory is required";
  }
  // Must be absolute
  if (!dir.startsWith("/") && !dir.match(/^[A-Z]:\\/)) {
    return "Project directory must be an absolute path";
  }
  return null;
}

/**
 * Determines if Pi should start based on current state.
 * Returns { shouldStart, reason }.
 */
export function shouldPiStart(params: {
  isPi: boolean;
  open: boolean;
  needsLogin: boolean;
  projectDir: string;
  starting: boolean;
  running: boolean;
  generation: number;
}): { shouldStart: boolean; reason: string } {
  if (!params.isPi) return { shouldStart: false, reason: "not pi preset" };
  if (!params.open) return { shouldStart: false, reason: "chat not open" };
  if (params.needsLogin) return { shouldStart: false, reason: "needs login" };
  if (!params.projectDir)
    return { shouldStart: false, reason: "no project dir" };
  if (params.starting) return { shouldStart: false, reason: "already starting" };
  if (params.running) return { shouldStart: false, reason: "already running" };
  return { shouldStart: true, reason: "ready" };
}

/**
 * Checks if a pi_terminated event should be ignored
 * (e.g., it's from a stale process generation).
 */
export function shouldIgnoreTermination(
  eventGeneration: number,
  currentGeneration: number
): boolean {
  return eventGeneration < currentGeneration;
}

// ============================================================================
// Default project directory
// ============================================================================

export function getDefaultProjectDir(): string {
  // Use user's home directory as a sensible default
  if (typeof process !== "undefined" && process.env?.HOME) {
    return `${process.env.HOME}/screenpipe-workspace`;
  }
  return "/tmp/screenpipe-pi-chat";
}
