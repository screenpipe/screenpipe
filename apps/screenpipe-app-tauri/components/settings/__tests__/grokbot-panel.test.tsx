// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GrokBotPanel } from "../grokbot-panel";

const mocks = vi.hoisted(() => ({ getPrompt: vi.fn(), copy: vi.fn() }));
vi.mock("@/lib/grokbot-connection", () => ({
  getGrokBotSetupPrompt: mocks.getPrompt,
  GROKBOT_SETUP_GUIDE: "https://docs.x.ai/grok-bot/computer-and-apps",
}));
vi.mock("@/lib/utils/tauri", () => ({ commands: { copyTextToClipboard: mocks.copy } }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getPrompt.mockResolvedValue("setup prompt fixture");
  mocks.copy.mockResolvedValue({ status: "ok", data: null });
});
afterEach(cleanup);

describe("Grok Bot setup panel", () => {
  it("copies instructions without claiming that access is connected", async () => {
    render(<GrokBotPanel />);
    expect(mocks.getPrompt).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "copy setup prompt" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Paste into Grok Bot to finish setup there");
    expect(mocks.copy).toHaveBeenCalledWith("setup prompt fixture");
    expect(screen.queryByText(/^connected/i)).toBeNull();
  });

  it("shows a clipboard failure and allows retry without a false copied state", async () => {
    mocks.copy.mockResolvedValue({ status: "error", error: "Clipboard unavailable" });
    render(<GrokBotPanel />);
    fireEvent.click(screen.getByRole("button", { name: "copy setup prompt" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Clipboard unavailable");
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: "copy setup prompt" })).toBeEnabled();
  });

  it("leaves the clipboard untouched when setup parameters cannot be resolved", async () => {
    mocks.getPrompt.mockRejectedValue(new Error("Screenpipe unavailable"));
    render(<GrokBotPanel />);
    fireEvent.click(screen.getByRole("button", { name: "copy setup prompt" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Screenpipe unavailable");
    expect(mocks.copy).not.toHaveBeenCalled();
  });
});
