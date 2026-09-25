// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import React, { useState } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CloudAiConnectionCard,
  CLOUD_MCP_URL,
  CODEX_CLOUD_SETUP,
} from "./cloud-ai-connection-card";

afterEach(cleanup);

describe("cloud AI setup", () => {
  it("requires explicit upload consent and keeps a rejected save retryable", async () => {
    const enable = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    function Harness() {
      const [enabled, setEnabled] = useState(false);
      return (
        <CloudAiConnectionCard
          enabled={enabled}
          onEnable={async () => {
            const ok = await enable();
            if (ok) setEnabled(true);
            return ok;
          }}
        />
      );
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Connect Codex" }));
    expect(enable).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Codex setup command")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Enable cloud sync and continue" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "could not be enabled",
    );
    expect(screen.queryByLabelText("Codex setup command")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Enable cloud sync and continue" }),
    );
    expect(await screen.findByLabelText("Codex setup command")).toHaveValue(
      CODEX_CLOUD_SETUP,
    );
    expect(enable).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Connected", { exact: true })).toBeNull();
  });

  it("blocks repeat enables while the save is pending", async () => {
    let finish!: (ok: boolean) => void;
    const enable = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    render(<CloudAiConnectionCard enabled={false} onEnable={enable} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect Claude" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Enable cloud sync and continue" }),
    );
    expect(
      screen.getByRole("button", { name: "Enabling cloud sync…" }),
    ).toBeDisabled();
    fireEvent.click(
      screen.getByRole("button", { name: "Enabling cloud sync…" }),
    );
    expect(enable).toHaveBeenCalledTimes(1);
    finish(false);
    await screen.findByRole("alert");
  });

  it("keeps the URL selectable after clipboard failure and retries copying", async () => {
    const copy = vi
      .fn()
      .mockRejectedValueOnce(new Error("permission denied"))
      .mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: copy },
    });
    render(<CloudAiConnectionCard enabled onEnable={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect Claude" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Copy connection URL" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "copy it manually",
    );
    expect(screen.getByLabelText("Cloud MCP URL")).toHaveValue(CLOUD_MCP_URL);
    fireEvent.click(
      screen.getByRole("button", { name: "Copy connection URL" }),
    );
    await screen.findByRole("button", { name: "URL copied" });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(copy).toHaveBeenLastCalledWith(CLOUD_MCP_URL);
  });

  it("reports native browser-open failure without reporting a connected client", async () => {
    const open = vi.fn().mockRejectedValue(new Error("blocked"));
    render(
      <CloudAiConnectionCard
        enabled
        onEnable={vi.fn()}
        onOpenExternal={open}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Connect Claude" }));
    fireEvent.click(screen.getByRole("link", { name: "Open Claude" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not open Claude",
    );
    expect(open).toHaveBeenCalledWith("https://claude.ai/settings/connectors");
    expect(screen.queryByText("Connected", { exact: true })).toBeNull();
  });

  it("returns keyboard focus to the selected client after setup closes", async () => {
    render(<CloudAiConnectionCard enabled onEnable={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "Connect Codex" });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("dialog"), {
      key: "Escape",
      code: "Escape",
    });
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
