// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import type { WorkProfile, WorkflowMap } from "./model";

export type AssistantContext = {
  key: string;
  title: string;
  workflow?: WorkflowMap;
  profile?: WorkProfile | null;
  catalog?: Array<{ title: string; description: string }>;
};
export type AssistantMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: string;
  context?: AssistantContext;
  status?: "stopped" | "error";
};
export type AssistantConversation = { id: string; title: string; messages: AssistantMessage[]; draft: string };
export type AssistantState = {
  version: 1;
  mode: "floating" | "sidebar";
  sidebarWidth?: number;
  activeId: string;
  conversations: AssistantConversation[];
};
export type AssistantProgress = { text: string; activity: "starting" | "searching" | "writing" };
export type WorkflowsAssistantPlatform = {
  openLink?: (url: string) => Promise<void>;
  load: () => Promise<AssistantState | null>;
  save: (state: AssistantState) => Promise<void>;
  ask: (request: {
    question: string;
    context: AssistantContext | null;
    history: AssistantMessage[];
    signal: AbortSignal;
    onProgress: (progress: AssistantProgress) => void;
  }) => Promise<string>;
};

export function isAssistantLink(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (["http:", "https:"].includes(parsed.protocol)) return !parsed.username && !parsed.password;
    return parsed.protocol === "screenpipe:" && (
      (parsed.host === "frame" && /^\/\d+$/.test(parsed.pathname)) ||
      (parsed.host === "timeline" && Boolean(parsed.searchParams.get("timestamp")) && Number.isFinite(Date.parse(parsed.searchParams.get("timestamp")!)))
    );
  } catch { return false; }
}

export function newAssistantConversation(): AssistantConversation {
  return { id: crypto.randomUUID(), title: "New conversation", messages: [], draft: "" };
}
export function emptyAssistantState(): AssistantState {
  const conversation = newAssistantConversation();
  return { version: 1, mode: "floating", activeId: conversation.id, conversations: [conversation] };
}
export function isAssistantState(value: unknown): value is AssistantState {
  const state = value as AssistantState | null;
  return Boolean(state && state.version === 1 && ["floating", "sidebar"].includes(state.mode)
    && typeof state.activeId === "string" && Array.isArray(state.conversations)
    && state.conversations.some((c) => c?.id === state.activeId)
    && state.conversations.every((c) => c && typeof c.id === "string" && typeof c.title === "string"
      && typeof c.draft === "string" && Array.isArray(c.messages)
      && c.messages.every((m) => m && typeof m.id === "string" && ["user", "assistant"].includes(m.role)
        && typeof m.text === "string" && typeof m.at === "string")));
}

/** Capture structured page content only. Never attach screenshot data URLs or local media paths. */
export function assistantContextSnapshot(context: AssistantContext): AssistantContext {
  return JSON.parse(JSON.stringify(context, (key, value) =>
    ["dataUrl", "filePath", "screenshot", "screenshots"].includes(key) ? undefined : value));
}
