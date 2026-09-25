// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useChatAttachments } from "./use-chat-attachments";
import { useChatStore, type SessionRecord } from "@/lib/stores/chat-store";
const mock = vi.hoisted(() => ({
  open: vi.fn(),
  read: vi.fn(),
  listeners: [] as ((event: any) => void)[],
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mock.open }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: mock.read }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (fn: (event: any) => void) => {
      mock.listeners.push(fn);
      return Promise.resolve(() => {});
    },
  }),
}));
vi.mock("@/lib/pi/extract-document", () => ({
  DOC_PICKER_EXTENSIONS: ["txt"],
  extFromName: () => "txt",
  isSupportedDocExt: () => true,
  extractDocument: async (name: string) => ({
    name,
    text: "notes",
    charCount: 5,
    truncated: false,
    ext: "txt",
  }),
}));
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
function options(id: string, x = 0) {
  const root = document.createElement("div");
  Object.defineProperty(root, "offsetParent", { value: document.body });
  root.getBoundingClientRect = () =>
    ({ left: x, right: x + 100, top: 0, bottom: 100 }) as DOMRect;
  return {
    draftSessionId: id,
    isEmbedded: true,
    scopeDrops: true,
    dropRootRef: { current: root },
    inputRef: { current: document.createElement("textarea") },
    setInput: vi.fn(),
    setShowMentionDropdown: vi.fn(),
    setMentionFilter: vi.fn(),
  };
}
beforeEach(() => {
  mock.open.mockReset();
  mock.read.mockReset();
  mock.listeners.length = 0;
  mock.read.mockResolvedValue(new Uint8Array([1]));
  useChatStore.setState({
    sessions: { a: session("a"), b: session("b") },
    currentId: "a",
  });
});
it("attaches a picked file to the secondary draft even when its read finishes after unmount", async () => {
  let resolve!: (bytes: Uint8Array) => void;
  mock.read.mockReturnValue(
    new Promise<Uint8Array>((r) => {
      resolve = r;
    }),
  );
  mock.open.mockResolvedValue(["/notes.txt"]);
  const { result, unmount } = renderHook(() =>
    useChatAttachments(options("b")),
  );
  let picking!: Promise<void>;
  await act(async () => {
    picking = result.current.handleFilePicker();
  });
  expect(result.current.pendingDocs).toHaveLength(1);
  unmount();
  await act(async () => {
    resolve(new Uint8Array([1]));
    await picking;
  });
  expect(
    useChatStore.getState().sessions.b.composerDraft?.attachedDocs,
  ).toEqual([expect.objectContaining({ name: "notes.txt" })]);
  expect(
    useChatStore.getState().sessions.b.composerDraft?.pendingDocs,
  ).toHaveLength(0);
  expect(useChatStore.getState().sessions.a.composerDraft).toBeUndefined();
});
it("routes a window-level file drop to only the pane under the pointer", async () => {
  const a = options("a", 0),
    b = options("b", 100);
  renderHook(() => useChatAttachments(a));
  renderHook(() => useChatAttachments(b));
  await act(async () => {
    for (const listener of mock.listeners)
      listener({
        payload: {
          type: "drop",
          position: {
            x: 150 * window.devicePixelRatio,
            y: 50 * window.devicePixelRatio,
          },
          paths: ["/notes.txt"],
        },
      });
  });
  expect(mock.read).toHaveBeenCalledTimes(1);
  expect(
    useChatStore.getState().sessions.b.composerDraft?.attachedDocs,
  ).toHaveLength(1);
  expect(useChatStore.getState().sessions.a.composerDraft).toBeUndefined();
});
