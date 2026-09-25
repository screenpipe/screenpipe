// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it } from "vitest";
import { useSessionDraftField } from "./use-session-draft-field";
import { useChatStore, type SessionRecord } from "@/lib/stores/chat-store";
const session = (id: string): SessionRecord => ({
  id,
  title: id,
  status: "idle",
  preview: "",
  messageCount: 0,
  createdAt: 1,
  updatedAt: 1,
  pinned: false,
  unread: false,
});
beforeEach(() =>
  useChatStore.setState({
    sessions: { a: session("a"), b: session("b") },
    currentId: "a",
  }),
);
it("edits each pane without activating it or replacing its attachments", () => {
  const { result } = renderHook(() => ({
    text: useSessionDraftField<"input", string>("b", "input", ""),
    docs: useSessionDraftField<"attachedDocs", unknown[]>(
      "b",
      "attachedDocs",
      [],
    ),
  }));
  act(() => {
    result.current.docs[1]([{ name: "notes.txt" }]);
    result.current.text[1]("hello");
    result.current.text[1]((text) => text + " there");
  });
  expect(useChatStore.getState().currentId).toBe("a");
  expect(result.current.text[0]).toBe("hello there");
  expect(result.current.docs[0]).toEqual([{ name: "notes.txt" }]);
  expect(useChatStore.getState().sessions.a.composerDraft).toBeUndefined();
});
it("keeps a late extraction bound to its original session after unmount", () => {
  const { result, unmount } = renderHook(() =>
    useSessionDraftField<"attachedDocs", unknown[]>("b", "attachedDocs", []),
  );
  const completeExtraction = result.current[1];
  unmount();
  act(() => {
    useChatStore.getState().actions.setCurrent("a");
    completeExtraction((docs) => [...docs, { name: "late.txt" }]);
  });
  expect(
    useChatStore.getState().sessions.b.composerDraft?.attachedDocs,
  ).toEqual([{ name: "late.txt" }]);
  expect(useChatStore.getState().sessions.a.composerDraft).toBeUndefined();
});
it("does not resurrect a deleted or archived session on late completion", () => {
  const { result } = renderHook(() =>
    useSessionDraftField<"attachedDocs", unknown[]>("b", "attachedDocs", []),
  );
  act(() => useChatStore.getState().actions.patch("b", { hidden: true }));
  act(() => result.current[1]([{ name: "late.txt" }]));
  expect(useChatStore.getState().sessions.b.composerDraft).toBeUndefined();
});
