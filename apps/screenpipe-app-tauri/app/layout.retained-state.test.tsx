// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import React from "react";
import { act, render, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => undefined),
  listen: vi.fn(
    async (event: string, handler: (event: { payload: unknown }) => void) => {
      mocks.listeners.set(event, handler);
      return () => mocks.listeners.delete(event);
    },
  ),
}));
vi.mock("next/font/google", () => ({
  Inter: () => ({ className: "" }),
  Space_Grotesk: () => ({ variable: "" }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/home",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/dev/browser-runtime", () => ({}));
vi.mock("./providers", () => ({
  Providers: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/lib/utils/tauri", () => ({
  commands: new Proxy(
    {},
    { get: () => vi.fn(async () => ({ status: "ok", data: null })) },
  ),
}));
vi.mock("@/lib/logging/browser-log", () => ({
  installBrowserLogBridge: vi.fn(() => () => undefined),
  writeBrowserLogNow: vi.fn(),
}));
vi.mock("@/lib/chat-utils", () => ({
  clearSearchOpenedFromChatSurface: vi.fn(),
  markSearchOpenedFromChatSurface: vi.fn(),
  openChatConversationInCurrentChatSurface: vi.fn(),
}));
vi.mock("@/lib/experimental-features", () => ({
  useExperimentalFeaturesEnabled: () => false,
}));
vi.mock("@/components/ui/toaster", () => ({ Toaster: () => null }));
vi.mock("@/components/shortcut-reminder", () => ({ ShortcutTracker: () => null }));
vi.mock("@/components/pipe-install-dialog", () => ({ PipeInstallDialog: () => null }));
vi.mock("@/components/browser-pairing-dialog", () => ({
  BrowserPairingDialog: () => null,
}));
vi.mock("@/components/close-tab-or-window-shortcut", () => ({
  CloseTabOrWindowShortcut: () => null,
}));
vi.mock("@/components/chat/recent-chat-switcher-controller", () => ({
  RecentChatSwitcherController: () => null,
}));
vi.mock("@/components/feedback-dialog", () => ({ FeedbackDialog: () => null }));
vi.mock("@/components/announcement-host", () => ({ AnnouncementHost: () => null }));
vi.mock("@/components/advisory-overlay", () => ({ AdvisoryOverlay: () => null }));
vi.mock("@/components/storage-migration-gate", () => ({
  StorageMigrationGate: () => null,
}));
vi.mock("@/components/pipe-advisory-watcher", () => ({
  PipeAdvisoryWatcher: () => null,
}));

import RootLayout from "./layout";
import { useRetainedState } from "@/lib/hooks/use-retained-state";

describe("root layout", () => {
  it("forgets this window's retained values when another window deletes recorded data", async () => {
    // React warns about <html> inside the test's <div>; it renders anyway.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<RootLayout>{null}</RootLayout>);
    await waitFor(() =>
      expect(mocks.listeners.has("recorded-data-deleted")).toBe(true),
    );

    const kept = renderHook(() => useRetainedState("test:kept", "empty"));
    act(() => kept.result.current[1]("deleted window title"));
    kept.unmount();

    act(() => mocks.listeners.get("recorded-data-deleted")!({ payload: null }));

    const next = renderHook(() => useRetainedState("test:kept", "empty"));
    expect(next.result.current[0]).toBe("empty");
    vi.mocked(console.error).mockRestore();
  });
});
