// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PipeChatDestinationPicker } from "./pipe-chat-destination-picker";
import type { ConversationMeta } from "@/lib/chat-storage";

const { listConversations, loadConversationFile, searchConversations } = vi.hoisted(() => ({
  listConversations: vi.fn(),
  loadConversationFile: vi.fn(),
  searchConversations: vi.fn(),
}));

vi.mock("@/lib/chat-storage", () => ({
  listConversations,
  loadConversationFile,
  searchConversations,
}));

function chat(id: string, title: string, pinned = false): ConversationMeta {
  return {
    id,
    title,
    createdAt: 1,
    updatedAt: pinned ? 1 : 2,
    messageCount: 2,
    pinned,
    hidden: false,
    kind: "chat",
  };
}

beforeAll(() => {
  globalThis.PointerEvent ||= MouseEvent as unknown as typeof PointerEvent;
  Element.prototype.scrollIntoView = vi.fn();
});

describe("PipeChatDestinationPicker", () => {
  beforeEach(() => {
    listConversations.mockReset();
    loadConversationFile.mockReset();
    searchConversations.mockReset();
    listConversations.mockResolvedValue([
      chat("recent-chat", "recent work"),
      chat("pinned-chat", "pinned strategy", true),
    ]);
    searchConversations.mockResolvedValue([]);
    loadConversationFile.mockResolvedValue(null);
  });

  it("groups pinned chats first and selects the immutable id", async () => {
    const onSelect = vi.fn();
    render(
      <PipeChatDestinationPicker
        open
        onOpenChange={vi.fn()}
        onSelect={onSelect}
      />,
    );

    await screen.findByText("pinned strategy");
    expect(listConversations).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "chat", includeHidden: false }),
    );
    const options = screen.getAllByRole("option");
    expect(options[0]).toHaveTextContent("pinned strategy");
    fireEvent.keyDown(screen.getByRole("textbox", { name: "search chats" }), {
      key: "ArrowDown",
    });
    expect(options[0]).toHaveFocus();
    fireEvent.keyDown(options[0], { key: "ArrowDown" });
    expect(options[1]).toHaveFocus();
    fireEvent.click(screen.getByRole("option", { name: /recent work/i }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "recent-chat" }));
  });

  it("searches chat content without replacing a selected id", async () => {
    searchConversations.mockResolvedValue([chat("match-id", "customer follow-up")]);
    render(
      <PipeChatDestinationPicker
        value="kept-id"
        open
        onOpenChange={vi.fn()}
        onSelect={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "search chats" }), {
      target: { value: "customer" },
    });
    await waitFor(() => expect(searchConversations).toHaveBeenCalledWith(
      "customer",
      expect.objectContaining({ kind: "chat", includeHidden: false }),
    ));
    expect(await screen.findByText("customer follow-up")).toBeInTheDocument();
  });

  it("makes a deleted target explicit instead of choosing a replacement", async () => {
    render(
      <PipeChatDestinationPicker
        value="deleted-chat"
        open={false}
        onOpenChange={vi.fn()}
        onSelect={vi.fn()}
      />,
    );

    expect(await screen.findByText("chat unavailable")).toBeInTheDocument();
    expect(listConversations).not.toHaveBeenCalled();
  });

  it("shows the saved title while closed without loading the whole list", async () => {
    loadConversationFile.mockResolvedValue({
      id: "kept-chat",
      title: "customer strategy",
      createdAt: 1,
      updatedAt: 2,
      messages: [],
      kind: "chat",
    });
    render(
      <PipeChatDestinationPicker
        value="kept-chat"
        open={false}
        onOpenChange={vi.fn()}
        onSelect={vi.fn()}
      />,
    );

    expect(await screen.findByText("customer strategy")).toBeInTheDocument();
    expect(listConversations).not.toHaveBeenCalled();
  });

  it("offers retry when the local chat index cannot be read", async () => {
    listConversations
      .mockRejectedValueOnce(new Error("index unavailable"))
      .mockResolvedValueOnce([chat("recovered-chat", "recovered chat")]);
    render(
      <PipeChatDestinationPicker
        open
        onOpenChange={vi.fn()}
        onSelect={vi.fn()}
      />,
    );

    expect(await screen.findByText("couldn't load chats")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "retry" }));
    expect(await screen.findByText("recovered chat")).toBeInTheDocument();
  });
});
