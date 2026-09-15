// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { WorkflowsApp, type ContextFillRequest } from "@screenpipe/workflows-ui";
import { createFixtureWorkflowsPlatform } from "@screenpipe/workflows-ui/fixture";
it("streams tool proposals into editable fields, preserves concurrent edits, and saves through the existing platform", async () => {
  window.history.replaceState(null, "", "/?view=profile");
  const platform = createFixtureWorkflowsPlatform();
  let pending!: ContextFillRequest;
  let finish!: () => void;
  platform.fillContext = vi.fn((request) => { pending = request; return new Promise<void>((resolve) => { finish = resolve; }); });
  platform.saveWorkProfile = vi.fn(async (profile) => profile);
  render(<WorkflowsApp platform={platform} storageKey={null} />);
  const summary = await screen.findByLabelText("Role and responsibilities");
  await waitFor(() => expect(summary).not.toHaveValue(""));
  fireEvent.change(screen.getByLabelText("Paste context"), { target: { value: "I lead support. Our company builds helpdesk software." } });
  fireEvent.click(screen.getByRole("button", { name: "Fill context" }));
  expect(screen.queryByRole("button", { name: "Save context" })).not.toBeInTheDocument();
  fireEvent.change(summary, { target: { value: "Keep my correction" } });
  await React.act(async () => {
    pending.onField({ field: "summary", value: "AI role" });
    pending.onField({ field: "company", value: "We build helpdesk software." });
    finish();
  });
  expect(summary).toHaveValue("Keep my correction");
  expect(screen.getByLabelText("Company overview")).toHaveValue("We build helpdesk software.");
  expect(screen.getByText(/Your edits were kept/)).toBeInTheDocument();
  await waitFor(() => expect(platform.saveWorkProfile).toHaveBeenCalledWith(expect.objectContaining({ company: "We build helpdesk software.", summary: "Keep my correction" }), undefined));
});
it("stops pending fills and ignores any later field result", async () => {
  window.history.replaceState(null, "", "/?view=profile");
  const platform = createFixtureWorkflowsPlatform();
  let pending!: ContextFillRequest;
  platform.fillContext = vi.fn((request) => { pending = request; return new Promise<void>((_, reject) => request.signal.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")))); });
  render(<WorkflowsApp platform={platform} storageKey={null} />);
  fireEvent.change(await screen.findByLabelText("Company website"), { target: { value: "example.com" } });
  fireEvent.click(screen.getByRole("button", { name: "Fill context" }));
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Fill context" })).toBeEnabled());
  pending.onField({ field: "company", value: "Too late" });
  expect(screen.getByLabelText("Company overview")).not.toHaveValue("Too late");
});

it("can discover context without inputs only when the host supports it", async () => {
  window.history.replaceState(null, "", "/?view=profile");
  const platform = createFixtureWorkflowsPlatform();
  platform.fillContext = vi.fn(async () => {});
  const view = render(<WorkflowsApp platform={platform} storageKey={null} />);
  const website = await screen.findByLabelText("Company website");
  fireEvent.change(website, { target: { value: "" } });
  const fill = screen.getByRole("button", { name: "Fill context" });
  expect(fill).toBeEnabled();
  fireEvent.click(fill);
  await waitFor(() => expect(platform.fillContext).toHaveBeenCalledWith(expect.objectContaining({ documents: [], website: "" })));
  view.unmount();
  render(<WorkflowsApp platform={{ ...platform, contextDiscovery: false }} storageKey={null} />);
  fireEvent.change(await screen.findByLabelText("Company website"), { target: { value: "" } });
  expect(screen.getByRole("button", { name: "Fill context" })).toBeDisabled();
});
