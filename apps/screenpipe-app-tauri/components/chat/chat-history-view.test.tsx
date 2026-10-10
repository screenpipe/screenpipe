// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationMeta } from "@/lib/chat-storage";

Element.prototype.scrollTo ||= () => {};

const mocks = vi.hoisted(() => ({
  listConversations: vi.fn(),
  searchConversations: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(),
  listen: vi.fn(async () => () => undefined),
}));
vi.mock("@/lib/hooks/use-platform", () => ({
  usePlatform: () => ({ isMac: true }),
}));
vi.mock("@/lib/chat-storage", () => ({
  listConversations: mocks.listConversations,
  searchConversations: mocks.searchConversations,
  migrateFromStoreBin: vi.fn(async () => undefined),
  updateConversationFlags: vi.fn(),
  deleteConversationFile: vi.fn(),
}));

import { ChatHistoryView } from "@/components/chat/chat-history-view";

function conversation(id: string, title: string): ConversationMeta {
  return {
    id,
    title,
    createdAt: 1,
    updatedAt: 1,
    messageCount: 2,
    pinned: false,
    hidden: false,
    kind: "chat",
  };
}

function renderHistory() {
  render(
    <ChatHistoryView
      onBack={vi.fn()}
      onNewChat={vi.fn()}
      onSelectConversation={vi.fn()}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ChatHistoryView after leaving it", () => {
  it("shows the last list without the spinner, then refreshes it in place", async () => {
    mocks.listConversations.mockResolvedValue([
      conversation("a", "Quarterly planning"),
    ]);
    renderHistory();
    await screen.findByText("Quarterly planning");
    cleanup();

    let answer: ((metas: ConversationMeta[]) => void) | undefined;
    mocks.listConversations.mockImplementation(
      () => new Promise<ConversationMeta[]>((resolve) => (answer = resolve)),
    );
    renderHistory();

    expect(screen.getByText("Quarterly planning")).toBeInTheDocument();
    expect(screen.queryByText("Loading chats…")).toBeNull();

    await waitFor(() => expect(answer).toBeDefined());
    expect(screen.queryByText("Loading chats…")).toBeNull();
    await act(async () => answer!([conversation("b", "Launch checklist")]));
    expect(await screen.findByText("Launch checklist")).toBeInTheDocument();
    expect(screen.queryByText("Quarterly planning")).toBeNull();
  });

  it("shows the spinner when nothing was loaded before", () => {
    mocks.listConversations.mockImplementation(() => new Promise(() => undefined));
    renderHistory();

    expect(screen.getByText("Loading chats…")).toBeInTheDocument();
  });

  it("comes back to the same search and its results", async () => {
    mocks.listConversations.mockResolvedValue([
      conversation("a", "Quarterly planning"),
    ]);
    mocks.searchConversations.mockResolvedValue([
      conversation("b", "Launch checklist"),
    ]);
    renderHistory();
    await screen.findByText("Quarterly planning");
    fireEvent.change(screen.getByPlaceholderText("Search chats"), {
      target: { value: "launch" },
    });
    await screen.findByText("Launch checklist");
    cleanup();

    mocks.searchConversations.mockImplementation(
      () => new Promise(() => undefined),
    );
    renderHistory();

    expect(screen.getByPlaceholderText("Search chats")).toHaveValue("launch");
    expect(screen.getByText("Launch checklist")).toBeInTheDocument();
    expect(screen.queryByText("Loading chats…")).toBeNull();
  });

  it("does not page while the kept list refreshes", async () => {
    // The scroll sentinel reports itself in view as soon as it is observed,
    // before React has re-rendered, once `inView` is set.
    let inView = false;
    const original = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = class {
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe() {
        if (!inView) return;
        this.callback(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        );
      }
      disconnect() {}
    } as unknown as typeof IntersectionObserver;
    try {
      // A full page leaves more to load, so the sentinel is watched.
      mocks.listConversations.mockResolvedValue(
        Array.from({ length: 30 }, (_, index) =>
          conversation(`c${index}`, `Chat ${index}`),
        ),
      );
      renderHistory();
      await screen.findByText("Chat 0");
      cleanup();

      inView = true;
      mocks.listConversations.mockReset();
      mocks.listConversations.mockImplementation(
        () => new Promise(() => undefined),
      );
      renderHistory();
      await act(() => new Promise((resolve) => setTimeout(resolve, 0)));

      // Only the refresh; a page fetched now would land on the old rows.
      expect(mocks.listConversations).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.IntersectionObserver = original;
    }
  });

  it("shows the spinner, not an empty list, on the visit after a failed refresh", async () => {
    mocks.listConversations.mockResolvedValue([
      conversation("a", "Quarterly planning"),
    ]);
    renderHistory();
    await screen.findByText("Quarterly planning");
    cleanup();

    // The return visit's refresh fails.
    mocks.listConversations.mockRejectedValue(new Error("disk busy"));
    renderHistory();
    await screen.findByText("No chats yet.");
    cleanup();

    mocks.listConversations.mockImplementation(() => new Promise(() => undefined));
    renderHistory();

    expect(screen.queryByText("No chats yet.")).toBeNull();
    expect(screen.getByText("Loading chats…")).toBeInTheDocument();
  });
});
