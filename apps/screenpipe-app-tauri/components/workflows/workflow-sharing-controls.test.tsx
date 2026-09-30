// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ settings: {} as any, update: vi.fn(), token: "token", managed: false }));
vi.mock("@/lib/hooks/use-settings", () => ({ useSettings: () => ({ settings: f.settings, updateSettings: f.update }) }));
vi.mock("@/lib/hooks/use-managed-policy", () => ({ useManagedPolicy: () => ({ isManagedDeployment: f.managed }) }));
vi.mock("@/lib/utils/tauri", () => ({ commands: { getCloudToken: async () => f.token } }));
import { WorkflowSharingControls } from "./workflow-sharing-controls";
let remote: any;
let requests: Array<{ method: string; body: any }>;
let offline: boolean;
beforeEach(() => {
  f.settings = { user: { id: "internal-id" }, piiBackend: "local", workflowSharing: null };
  f.managed = false; f.token = "token";
  f.update.mockReset().mockImplementation(async (updates: any) => { f.settings = { ...f.settings, ...updates }; });
  remote = { accountId: "user_one", available: true, sharing: false, training: false, epoch: null, revision: 0, noticeVersion: "2026-09-23", acceptedNoticeVersion: null };
  requests = []; offline = false;
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    if (offline) throw new Error("offline");
    const body = init.body ? JSON.parse(init.body) : null;
    requests.push({ method: init.method, body });
    if (init.method === "PUT") remote = { ...remote, ...body, acceptedNoticeVersion: body.noticeVersion, epoch: `epoch-${++remote.revision}` };
    if (init.method === "DELETE") remote = { ...remote, sharing: false, training: false, epoch: "deleted" };
    return { ok: true, json: async () => ({ ...remote }) };
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function ready() {
  await waitFor(() => expect(screen.getByRole("switch")).toBeEnabled());
}
describe("sharing consent UI", () => {
  it("defaults off; enabling explicitly selects cloud without changing recording flags", async () => {
    render(<WorkflowSharingControls />); await ready();
    expect(screen.getByRole("switch")).not.toBeChecked();
    expect(requests.every(r => r.method === "GET")).toBe(true);
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => expect(screen.getByRole("switch")).toBeChecked());
    expect(f.update).toHaveBeenCalledWith({ piiBackend: "tinfoil", workflowSharingPromptSeen: { "internal-id": "2026-09-23" }, workflowSharing: { accountId: "user_one", epoch: "epoch-1", enabledAt: expect.any(Number), priorBackend: "local" } });
    expect(requests.find(r => r.method === "PUT")!.body).toMatchObject({ sharing: true, training: true, noticeVersion: "2026-09-23" });
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });
  it("revokes both permissions and restores the prior backend on off", async () => {
    render(<WorkflowSharingControls />); await ready();
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => expect(screen.getByRole("switch")).toBeChecked());
    expect(requests.filter(r => r.method === "PUT").at(-1)!.body.training).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Turn off sharing" }));
    await waitFor(() => expect(f.settings.workflowSharing).toBeNull());
    expect(f.settings.piiBackend).toBe("local");
  });
  it("stops locally when the server is offline and states the remaining uncertainty", async () => {
    render(<WorkflowSharingControls />); await ready(); fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => expect(screen.getByRole("switch")).toBeChecked());
    offline = true;
    fireEvent.click(screen.getByRole("button", { name: "Turn off sharing" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Stopped on this device. Account changes are unconfirmed"));
    expect(f.settings.workflowSharing).toBeNull();
  });
  it("deletes only after the explicit second click, and stops sharing", async () => {
    render(<WorkflowSharingControls />); await ready();
    fireEvent.click(screen.getByRole("button", { name: "Delete shared chats" }));
    expect(requests.some(r => r.method === "DELETE")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Confirm deletion and stop sharing" }));
    await waitFor(() => expect(requests.some(r => r.method === "DELETE")).toBe(true));
    expect(f.settings.workflowSharing).toBeNull();
  });
  it.each(["unavailable", "notice mismatch"])("keeps %s sharing visible without saving a choice", async reason => {
    if (reason === "unavailable") remote.available = false;
    if (reason === "notice mismatch") remote.noticeVersion = "different-version";
    const done = vi.fn();
    render(<WorkflowSharingControls compact onDone={done} />);
    expect(await screen.findByText("Sharing is not available for this account.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Allow sharing" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Not now" })).toBeEnabled();
    expect(done).not.toHaveBeenCalled();
    expect(f.update).not.toHaveBeenCalled();
    expect(requests.every(r => r.method === "GET")).toBe(true);
  });
  it.each([false, true])("allows managed accounts to opt in explicitly (compact=%s)", async compact => {
    f.managed = true;
    f.settings.enterpriseManagedSettings = { serverUrl: "https://example.com" };
    render(<WorkflowSharingControls compact={compact} />);
    const control = compact ? screen.getByRole("button", { name: "Allow sharing" }) : screen.getByRole("switch");
    await waitFor(() => expect(control).toBeEnabled());
    expect(requests.every(r => r.method === "GET")).toBe(true);
    expect(f.update).not.toHaveBeenCalled();
    fireEvent.click(control);
    await waitFor(() => expect(f.settings.workflowSharing).toMatchObject({ accountId: "user_one" }));
    expect(requests.find(r => r.method === "PUT")!.body).toMatchObject({ sharing: true, training: true });
  });
  it("submits both permissions only after the explicit prompt action", async () => {
    const done = vi.fn();
    render(<WorkflowSharingControls compact onDone={done} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Allow sharing" })).toBeEnabled());
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(requests.every(r => r.method === "GET")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Allow sharing" }));
    await waitFor(() => expect(done).toHaveBeenCalledOnce());
    expect(requests.find(r => r.method === "PUT")!.body).toMatchObject({ sharing: true, training: true, noticeVersion: "2026-09-23" });
  });
  it("does not silently upgrade existing sharing-only consent", async () => {
    f.settings.workflowSharing = { accountId: "user_one", epoch: "legacy", enabledAt: 0, priorBackend: "local" };
    remote = { ...remote, sharing: true, training: false, epoch: "legacy", acceptedNoticeVersion: "2026-09-21" };
    render(<WorkflowSharingControls />); await ready();
    expect(screen.getByRole("switch")).not.toBeChecked();
    expect(screen.getByText(/Sharing is paused on this version/)).toBeVisible();
    expect(requests.every(r => r.method === "GET")).toBe(true);
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => expect(screen.getByRole("switch")).toBeChecked());
    expect(requests.find(r => r.method === "PUT")!.body).toMatchObject({ sharing: true, training: true, noticeVersion: "2026-09-23" });
  });
  it("skips the sharing prompt without saving consent", async () => {
    const done = vi.fn();
    render(<WorkflowSharingControls compact onDone={done} />);
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(done).toHaveBeenCalledOnce();
    expect(f.update).not.toHaveBeenCalled();
    expect(requests.every(r => r.method === "GET")).toBe(true);
  });
  it("keeps the prompt open when saving fails", async () => {
    const done = vi.fn();
    render(<WorkflowSharingControls compact onDone={done} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Allow sharing" })).toBeEnabled());
    offline = true;
    fireEvent.click(screen.getByRole("button", { name: "Allow sharing" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not enable sharing");
    expect(done).not.toHaveBeenCalled();
    expect(f.update).not.toHaveBeenCalled();
  });

  it("does not save a late consent response into a different signed-in account", async () => {
    const view = render(<WorkflowSharingControls compact />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Allow sharing" })).toBeEnabled());
    let release!: () => void;
    const fetchNow = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (...args: Parameters<typeof fetch>) => {
      if ((args[1] as RequestInit).method === "PUT") await new Promise<void>(resolve => { release = resolve; });
      return fetchNow(...args);
    }));
    fireEvent.click(screen.getByRole("button", { name: "Allow sharing" }));
    await waitFor(() => expect(release).toBeDefined());
    f.settings = { ...f.settings, user: { id: "different-account" } };
    view.rerender(<WorkflowSharingControls compact />);
    release();
    await waitFor(() => expect(screen.getByRole("button", { name: "Allow sharing" })).toBeEnabled());
    expect(f.update).not.toHaveBeenCalled();
  });
});
