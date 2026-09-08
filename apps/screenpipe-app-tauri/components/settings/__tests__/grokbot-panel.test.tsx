// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GrokBotPanel } from "../grokbot-panel";
const mocks = vi.hoisted(() => ({ connection: vi.fn() }));
vi.mock("@/lib/grokbot-connection", () => ({ grokBotConnection: mocks.connection }));
beforeEach(() => { vi.resetAllMocks(); });
afterEach(cleanup);

describe("Grok Bot connection panel", () => {
  it("shows the verified automatic installation without a setup prompt", async () => {
    mocks.connection.mockResolvedValue({ detected: true, connected: true });
    render(<GrokBotPanel />);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Screenpipe skill installed"));
    expect(mocks.connection).toHaveBeenCalledWith("status");
    expect(screen.queryByText(/copy setup prompt/i)).toBeNull();
  });
  it("connects, reports the verified result, and disconnects", async () => {
    mocks.connection.mockImplementation(async action => ({ detected: true, connected: action === "connect", optedOut: action === "disconnect" }));
    const onChanged = vi.fn();
    render(<GrokBotPanel onChanged={onChanged} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "connect Grok Bot" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "connect Grok Bot" }));
    await waitFor(() => expect(onChanged).toHaveBeenLastCalledWith(true));
    fireEvent.click(screen.getByRole("button", { name: "disconnect" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Automatic installation is off"));
    expect(onChanged).toHaveBeenLastCalledWith(false);
  });
  it("keeps setup failures visible and allows retry or opting out", async () => {
    mocks.connection.mockRejectedValue(new Error("Open Grok Bot and sign in."));
    render(<GrokBotPanel />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Open Grok Bot and sign in.");
    expect(screen.getByRole("status")).not.toHaveTextContent("installed");
    expect(screen.getByRole("button", { name: "connect Grok Bot" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "disconnect" })).toBeEnabled();
  });
});
