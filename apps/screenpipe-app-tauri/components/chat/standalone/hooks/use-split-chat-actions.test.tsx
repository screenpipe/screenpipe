// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore, type SessionRecord } from "@/lib/stores/chat-store";
import { useSplitChatActions } from "./use-split-chat-actions";

const session = (id: string): SessionRecord => ({ id, title: id, status: "idle", preview: "", messageCount: 0, createdAt: 1, updatedAt: 1, pinned: false, unread: false });
const options = () => ({ conversationId: "a", activate: vi.fn(async () => {}), send: vi.fn(async () => {}), stop: vi.fn(), canSend: true, preparing: false, input: "primary draft", focus: vi.fn(), onError: vi.fn() });
beforeEach(() => useChatStore.setState({ sessions: { a: session("a"), b: session("b") }, currentId: "a" }));
describe("split composer handoff", () => {
  it("waits for both restore and the matching render, then sends once", async () => {
    let resolve!: () => void;
    const props = options();
    props.activate = vi.fn(() => new Promise<void>(r => { resolve = r; }));
    const { result, rerender } = renderHook(p => useSplitChatActions(p), { initialProps: props });
    let work!: Promise<void>;
    act(() => { work = result.current.run("b", "send"); });
    await act(async () => { await result.current.run("b", "send"); });
    expect(props.activate).toHaveBeenCalledTimes(1);
    expect(props.send).not.toHaveBeenCalled();
    act(() => useChatStore.getState().actions.setCurrent("b"));
    rerender({ ...props, conversationId: "b", input: "secondary draft" });
    expect(props.send).not.toHaveBeenCalled();
    await act(async () => { resolve(); await work; });
    await waitFor(() => expect(props.send).toHaveBeenCalledWith("secondary draft"));
    expect(props.send).toHaveBeenCalledTimes(1);
    expect(props.focus).toHaveBeenCalledTimes(1);
  });
  it("cancels when another chat wins navigation", async () => {
    const props = options();
    const { result } = renderHook(() => useSplitChatActions(props));
    await act(async () => { await result.current.run("b", "send"); });
    expect(props.send).not.toHaveBeenCalled();
    expect(result.current.pendingId).toBeNull();
  });
  it("does not resurrect a pending send when navigation leaves and returns", async () => {
    let resolve!: () => void;
    const props = options();
    props.activate = vi.fn(() => new Promise<void>(r => { resolve = r; }));
    const { result, rerender } = renderHook(p => useSplitChatActions(p), { initialProps: props });
    let work!: Promise<void>;
    act(() => { work = result.current.run("b", "send"); });
    act(() => {
      useChatStore.getState().actions.setCurrent("b");
      useChatStore.getState().actions.setCurrent("a");
      useChatStore.getState().actions.setCurrent("b");
    });
    rerender({ ...props, conversationId: "b", input: "secondary" });
    await act(async () => { resolve(); await work; });
    expect(props.send).not.toHaveBeenCalled();
    expect(result.current.pendingId).toBeNull();
  });

  it("preserves a draft when restore fails or the target cannot send", async () => {
    const props = options();
    props.activate = vi.fn(async () => { throw new Error("disk error"); });
    const { result, rerender } = renderHook(p => useSplitChatActions(p), { initialProps: props });
    await act(async () => { await result.current.run("b", "send"); });
    expect(props.onError).toHaveBeenCalledTimes(1);
    expect(props.send).not.toHaveBeenCalled();
    act(() => useChatStore.getState().actions.setCurrent("b"));
    rerender({ ...props, activate: vi.fn(async () => {}), conversationId: "b", canSend: false });
    await act(async () => { await result.current.run("b", "send"); });
    expect(props.send).not.toHaveBeenCalled();
  });
  it("waits for worktree readiness and dispatches Stop without sending a draft", async () => {
    const props = options();
    act(() => useChatStore.getState().actions.setCurrent("b"));
    const { result, rerender } = renderHook(p => useSplitChatActions(p), { initialProps: { ...props, conversationId: "b", preparing: true } });
    await act(async () => { await result.current.run("b", "stop"); });
    expect(props.stop).not.toHaveBeenCalled();
    rerender({ ...props, conversationId: "b", preparing: false });
    expect(props.stop).toHaveBeenCalledTimes(1);
    expect(props.send).not.toHaveBeenCalled();
  });
});
