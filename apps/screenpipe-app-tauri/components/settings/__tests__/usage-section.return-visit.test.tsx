// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ loadAllConversations: vi.fn() }));

vi.mock("@/lib/chat-storage", () => ({
  loadAllConversations: mocks.loadAllConversations,
}));
vi.mock("@tauri-apps/api/path", () => ({
  homeDir: async () => "/home",
  join: async (...parts: string[]) => parts.join("/"),
}));
// No usage cache on disk yet.
vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: async () => false,
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(async () => undefined),
}));
// No scheduled tasks have run.
vi.mock("@/lib/api", () => ({
  localFetch: vi.fn(async () => new Response(JSON.stringify({ data: [] }))),
}));
vi.mock("@/lib/hooks/use-usage-status", () => ({
  sortHostedAiAllowances: (allowances: unknown[]) => allowances,
  useUsageStatusQuery: () => ({
    usage: null,
    isLoading: false,
    isRefreshing: false,
    isUnavailable: true,
    refresh: vi.fn(),
  }),
}));

import { UsageSection } from "../usage-section";

const NO_DATA = /No model data yet/;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("UsageSection after a tab switch", () => {
  it("loads from the skeleton again when the last visit's scan failed", async () => {
    mocks.loadAllConversations.mockRejectedValue(new Error("store locked"));
    render(<UsageSection />);
    expect(await screen.findByText(NO_DATA)).toBeInTheDocument();
    cleanup();

    mocks.loadAllConversations.mockImplementation(
      () => new Promise(() => undefined),
    );
    render(<UsageSection />);

    // Zero usage would be a claim; the scan hasn't answered yet.
    expect(screen.queryByText(NO_DATA)).toBeNull();
    expect(document.querySelector('[class*="animate-pulse"]')).not.toBeNull();
  });

  it("shows the last totals at once after a scan that worked", async () => {
    mocks.loadAllConversations.mockResolvedValue([]);
    render(<UsageSection />);
    expect(await screen.findByText(NO_DATA)).toBeInTheDocument();
    cleanup();

    mocks.loadAllConversations.mockImplementation(
      () => new Promise(() => undefined),
    );
    render(<UsageSection />);

    expect(screen.getByText(NO_DATA)).toBeInTheDocument();
  });

  it("shows the last non-empty totals at once", async () => {
    mocks.loadAllConversations.mockResolvedValue([
      {
        id: "c1",
        messages: [
          { role: "user", timestamp: Date.now() - 1000 },
          {
            role: "assistant",
            timestamp: Date.now(),
            model: "kept-model-x",
            provider: "screenpipe-cloud",
          },
        ],
      },
    ]);
    render(<UsageSection />);
    expect((await screen.findAllByText(/kept-model-x/)).length).toBeGreaterThan(0);
    cleanup();

    mocks.loadAllConversations.mockImplementation(
      () => new Promise(() => undefined),
    );
    render(<UsageSection />);

    expect(screen.getAllByText(/kept-model-x/).length).toBeGreaterThan(0);
    expect(screen.queryByText(NO_DATA)).toBeNull();
  });
});
