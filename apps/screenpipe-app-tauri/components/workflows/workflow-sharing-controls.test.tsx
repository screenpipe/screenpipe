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
  remote = { accountId: "user_one", available: true, sharing: false, training: false, epoch: null, revision: 0, noticeVersion: "2026-09-21" };
  requests = []; offline = false;
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    if (offline) throw new Error("offline");
    const body = init.body ? JSON.parse(init.body) : null;
    requests.push({ method: init.method, body });
    if (init.method === "PUT") remote = { ...remote, ...body, epoch: `epoch-${++remote.revision}` };
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
    expect(f.update).toHaveBeenCalledWith({ piiBackend: "tinfoil", workflowSharing: { accountId: "user_one", epoch: "epoch-1", enabledAt: expect.any(Number), priorBackend: "local" } });
    expect(requests.find(r => r.method === "PUT")!.body).toMatchObject({ sharing: true, training: false });
    expect(screen.getByRole("checkbox")).not.toBeChecked();
  });
  it("requires a separate training choice and restores the prior backend on off", async () => {
    render(<WorkflowSharingControls />); await ready();
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => expect(screen.getByRole("checkbox")).toBeEnabled());
    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => expect(screen.getByRole("checkbox")).toBeChecked());
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
  it("hides the optional entry control when rollout is unavailable", async () => {
    remote.available = false;
    render(<WorkflowSharingControls compact />);
    await waitFor(() => expect(requests.length).toBe(1));
    expect(screen.queryByRole("switch")).toBeNull();
  });
  it("does not enable sharing for managed deployments", async () => {
    f.managed = true; render(<WorkflowSharingControls />);
    await waitFor(() => expect(requests.length).toBe(1));
    expect(screen.getByRole("switch")).toBeDisabled();
  });
});
