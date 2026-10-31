// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import React from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MainLayout from "./layout";

const { replace, listeners } = vi.hoisted(() => ({
  replace: vi.fn(),
  listeners: new Map<string, (event: { payload: { url: string } }) => void>(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name, handler) => {
    listeners.set(name, handler);
    return () => listeners.delete(name);
  }),
}));
vi.mock("@/components/app-sidebar", () => ({
  SidebarProvider: ({ children }: React.PropsWithChildren) => children,
  AppSidebarLayout: ({ children }: React.PropsWithChildren) => children,
}));
vi.mock("@/components/first-run/learning-window-provider", () => ({
  FirstRunLearningWindowProvider: ({ children }: React.PropsWithChildren) => children,
}));
vi.mock("@/components/card-ask-provider", () => ({ CardAskProvider: () => null }));
vi.mock("@/components/meeting-calendar-reminder", () => ({ MeetingCalendarReminder: () => null }));

beforeEach(() => {
  replace.mockReset();
  listeners.clear();
  window.history.replaceState(null, "", "/settings?section=general");
});
afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

async function navigate(url: string) {
  await waitFor(() => expect(listeners.has("navigate")).toBe(true));
  act(() => listeners.get("navigate")!({ payload: { url } }));
}

describe("main window reopen navigation", () => {
  it("returns from Settings through the client router while retaining the shell", async () => {
    const view = render(<MainLayout><input defaultValue="retained state" /></MainLayout>);
    const input = view.getByRole("textbox");
    await navigate("/home");
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith("/home");
    expect(view.getByRole("textbox")).toBe(input);
  });

  it("preserves an explicit meeting destination when reopening from Settings", async () => {
    render(<MainLayout>Settings</MainLayout>);
    const url = "/home?section=meetings&meetingId=42&transcript=true";
    await navigate(url);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith(url);
  });

  it("supports the macOS Tauri scheme with an opaque origin", async () => {
    render(<MainLayout>Settings</MainLayout>);
    const location = new URL("tauri://localhost/settings?section=general");
    expect(location.origin).toBe("null");
    vi.stubGlobal("window", new Proxy(window, {
      get(target, key) {
        return key === "location" ? location : Reflect.get(target, key, target);
      },
    }));
    await navigate("/home?section=meetings");
    expect(replace).toHaveBeenCalledWith("/home?section=meetings");
  });

  it.each(["/home", "/home?section=activity"])(
    "leaves an existing Home page mounted for %s", async (url) => {
      window.history.replaceState(null, "", "/home?section=meetings");
      render(<MainLayout>Home</MainLayout>);
      await navigate(url);
      expect(replace).not.toHaveBeenCalled();
      expect(window.location.search).toBe("?section=meetings");
    },
  );

  it.each(["/settings?section=audio", "https://example.com/home", "javascript:alert(1)", "http://["])(
    "ignores destinations outside the Home reopen contract: %s", async (url) => {
      render(<MainLayout>Settings</MainLayout>);
      await navigate(url);
      expect(replace).not.toHaveBeenCalled();
    },
  );
});
