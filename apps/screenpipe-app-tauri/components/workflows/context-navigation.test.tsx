// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkflowsApp } from "@screenpipe/workflows-ui";
import { createFixtureWorkflowsPlatform, fixtureWorkflowAnalysis, fixturePersonalWorkProfile } from "@screenpipe/workflows-ui/fixture";
import type { ContextFillRequest } from "@screenpipe/workflows-ui/context";

afterEach(cleanup);
function setup(scoped = false) {
  window.history.replaceState(null, "", "/?view=profile");
  const platform = createFixtureWorkflowsPlatform();
  platform.loadCapturedWork = async () => structuredClone(fixtureWorkflowAnalysis);
  platform.loadWorkProfile = vi.fn().mockResolvedValue({ ...fixturePersonalWorkProfile, company: "", summary: "" });
  platform.saveWorkProfile = vi.fn().mockImplementation(async p => p);
  platform.contextDiscovery = true;
  if (scoped) {
    const ensureRuntime = platform.ensureRuntime;
    platform.ensureRuntime = async () => ({ ...await ensureRuntime(), availableScopes: [
      { id: "personal", kind: "personal", label: "Personal" },
      { id: "team", kind: "team", label: "Team" },
    ] });
  }
  let request!: ContextFillRequest;
  let finish!: () => void;
  let fail!: (error: Error) => void;
  platform.fillContext = vi.fn().mockImplementation((req: ContextFillRequest) => {
    request = req;
    req.onActivity("Reading sources…");
    return new Promise<void>((resolve, reject) => {
      finish = resolve; fail = reject;
      req.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  });
  const app = render(<WorkflowsApp platform={platform} storageKey={null} />);
  const start = async () => {
    fireEvent.click(await screen.findByRole("button", { name: "Fill context", exact: true }));
    await waitFor(() => expect(platform.fillContext).toHaveBeenCalledOnce());
    return request;
  };
  return { ...app, platform, start, finish: () => finish(), fail: () => fail(new Error("Source unavailable. Try again.")) };
}

it("fills and saves in the background across navigation, preserving draft and manual edits", async () => {
  const app = setup();
  fireEvent.change(await screen.findByRole("textbox", { name: "Paste context" }), { target: { value: "My research notes" } });
  const req = await app.start();
  fireEvent.change(screen.getByRole("textbox", { name: "Role and responsibilities" }), { target: { value: "My newer edit" } });
  fireEvent.click(screen.getByRole("button", { name: /^Home/ }));
  expect(screen.queryByRole("textbox", { name: "Paste context" })).toBeNull();
  expect(req.signal.aborted).toBe(false);
  await act(async () => {
    req.onField({ field: "summary", value: "Older proposal" });
    req.onField({ field: "company", value: "Example Studio organizes research." });
    app.finish();
  });
  await waitFor(() => expect(app.platform.saveWorkProfile).toHaveBeenCalledWith(expect.objectContaining({ company: "Example Studio organizes research.", summary: "My newer edit" }), undefined));
  fireEvent.click(screen.getByRole("button", { name: "Context", exact: true }));
  expect(screen.getByRole("textbox", { name: "Paste context" })).toHaveValue("My research notes");
  expect(screen.getByRole("textbox", { name: "Company overview" })).toHaveValue("Example Studio organizes research.");
  expect(screen.getByText(/1 section filled/)).toBeVisible();
  expect(app.platform.fillContext).toHaveBeenCalledOnce();
});

it("keeps Stop available on return, preserves partial results, and ignores late fields", async () => {
  const app = setup(); const req = await app.start();
  act(() => req.onField({ field: "company", value: "Kept result" }));
  fireEvent.click(screen.getByRole("button", { name: /^Home/ }));
  fireEvent.click(screen.getByRole("button", { name: "Context", exact: true }));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Stop", exact: true })));
  expect(req.signal.aborted).toBe(true);
  act(() => req.onField({ field: "summary", value: "Too late" }));
  expect(screen.getByRole("textbox", { name: "Company overview" })).toHaveValue("Kept result");
  expect(screen.getByRole("textbox", { name: "Role and responsibilities" })).toHaveValue("");
  expect(screen.getByText("Stopped. Filled fields were kept.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Fill context", exact: true })).toBeEnabled();
});

it("does not cancel when the Workflows surface is hidden or the browser loses focus", async () => {
  const app = setup(); const req = await app.start();
  app.rerender(<WorkflowsApp platform={app.platform} storageKey={null} active={false} />);
  fireEvent(window, new Event("blur"));
  fireEvent(document, new Event("visibilitychange"));
  expect(req.signal.aborted).toBe(false);
  await act(async () => { req.onField({ field: "company", value: "Background result" }); app.finish(); });
  app.rerender(<WorkflowsApp platform={app.platform} storageKey={null} active />);
  expect(screen.getByRole("textbox", { name: "Company overview" })).toHaveValue("Background result");
});

it("aborts when the app actually closes", async () => {
  const app = setup(); const req = await app.start();
  app.unmount();
  expect(req.signal.aborted).toBe(true);
  act(() => req.onField({ field: "company", value: "Too late" }));
  expect(app.platform.saveWorkProfile).not.toHaveBeenCalled();
});


it("cancels a fill at the scope boundary and never saves its late fields into the new scope", async () => {
  const app = setup(true); const req = await app.start();
  fireEvent.change(screen.getByRole("combobox", { name: "Workflows scope" }), { target: { value: "team" } });
  await waitFor(() => expect(req.signal.aborted).toBe(true));
  await screen.findByRole("button", { name: "Fill context", exact: true });
  act(() => req.onField({ field: "company", value: "Private previous-scope result" }));
  expect(screen.getByRole("textbox", { name: "Company overview" })).toHaveValue("");
  expect(app.platform.saveWorkProfile).not.toHaveBeenCalled();
  expect(app.platform.loadWorkProfile).toHaveBeenLastCalledWith(expect.objectContaining({ id: "team" }));
});


it("keeps a background failure visible on return and allows a retry", async () => {
  const app = setup(); await app.start();
  fireEvent.click(screen.getByRole("button", { name: /^Home/ }));
  await act(async () => app.fail());
  fireEvent.click(screen.getByRole("button", { name: "Context", exact: true }));
  expect(screen.getByRole("alert")).toHaveTextContent("Source unavailable. Try again.");
  fireEvent.click(screen.getByRole("button", { name: "Fill context", exact: true }));
  expect(app.platform.fillContext).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alert")).toBeNull();
  await act(async () => app.finish());
});
