// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SCREENPIPE_STARTER_SKILLS } from "@/lib/generated/screenpipe-skills";
import { StarterSkillsCard } from "./starter-skills-card";
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), presets: [{ id: "local", model: "test-local-model", provider: "native-ollama", defaultPreset: true }] }));
vi.mock("@/lib/api", () => ({ localFetch: mocks.fetch }));
vi.mock("@/lib/hooks/use-settings", () => ({ useSettings: () => ({ settings: { aiPresets: mocks.presets } }) }));
let enabled = false;
let configuredPreset: string[] = [];
beforeEach(() => {
  enabled = false; configuredPreset = []; mocks.fetch.mockReset();
  mocks.presets = [{ id: "local", model: "test-local-model", provider: "native-ollama", defaultPreset: true }];
  mocks.fetch.mockImplementation(async (path: string, init: RequestInit) => {
    if (path.endsWith("/enable")) { enabled = JSON.parse(String(init.body)).enabled; return Response.json({ success: true }); }
    if (path.endsWith("/config")) { configuredPreset = JSON.parse(String(init.body)).preset; return Response.json({ success: true }); }
    return Response.json({ data: { config: { enabled, model: "test-local-model", preset: configuredPreset } } });
  });
});
describe("starter skills and learning setup", () => {
  it("makes no writes until opted in and exposes the complete bundled catalog", async () => {
    render(<StarterSkillsCard />); await screen.findByRole("button", { name: "Turn on learning" });
    expect(mocks.fetch.mock.calls.every(([, init]) => !init.method)).toBe(true);
    fireEvent.click(screen.getByText("Browse included skills")); expect(screen.getAllByRole("listitem")).toHaveLength(SCREENPIPE_STARTER_SKILLS.length);
    expect(screen.getByText("Uses your local model.", { exact: false })).toBeTruthy();
  });
  it("persists model before enabling, verifies the result and can pause", async () => {
    render(<StarterSkillsCard />); fireEvent.click(await screen.findByRole("button", { name: "Turn on learning" }));
    await screen.findByRole("button", { name: "Pause learning" });
    const writes = mocks.fetch.mock.calls.filter(([, init]) => init.method === "POST");
    expect(writes.map(([path]) => path)).toEqual(["/pipes/skill-learning/config", "/pipes/skill-learning/enable"]);
    expect(JSON.parse(writes[0][1].body)).toEqual({ agent: "pi", preset: ["local"], cloud_agent: null });
    fireEvent.click(screen.getByRole("button", { name: "Pause learning" })); await screen.findByRole("button", { name: "Turn on learning" }); expect(enabled).toBe(false);
  });
  for (const isEnabled of [true, false]) it(`saves a model change while learning is ${isEnabled ? "enabled" : "paused"} and preserves that state`, async () => {
    enabled = isEnabled; configuredPreset = ["local"];
    mocks.presets.push({ id: "cloud", model: "test-cloud-model", provider: "screenpipe-cloud", defaultPreset: false });
    const view = render(<StarterSkillsCard />);
    await screen.findByRole("button", { name: isEnabled ? "Pause learning" : "Turn on learning" });
    const select = screen.getByRole("combobox", { name: "Skill learning model" });
    await waitFor(() => expect(select).toBeEnabled());
    fireEvent.change(select, { target: { value: "cloud" } });
    await waitFor(() => expect(configuredPreset).toEqual(["cloud"]));
    await waitFor(() => expect(select).toHaveValue("cloud"));
    expect(enabled).toBe(isEnabled);
    expect(mocks.fetch.mock.calls.filter(([, init]) => init.method === "POST").map(([path]) => path)).toEqual(["/pipes/skill-learning/config"]);
    expect(JSON.parse(mocks.fetch.mock.calls.find(([path]) => path.endsWith("/config"))![1].body)).toEqual({ agent: "pi", preset: ["cloud"], cloud_agent: null });
    view.unmount(); render(<StarterSkillsCard />);
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveValue("cloud"));
  });
  for (const failsWrite of [true, false]) it(`keeps the last confirmed selection when ${failsWrite ? "the save fails" : "read-back disagrees"}`, async () => {
    enabled = true;
    mocks.presets.push({ id: "cloud", model: "test-cloud-model", provider: "screenpipe-cloud", defaultPreset: false });
    mocks.fetch.mockImplementation(async (path: string) => path.endsWith("/config")
      ? failsWrite ? Response.json({ error: "failed" }, { status: 500 }) : Response.json({ success: true })
      : Response.json({ data: { config: { enabled: true, preset: ["local"] } } }));
    render(<StarterSkillsCard />); await screen.findByRole("button", { name: "Pause learning" });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "cloud" } });
    await screen.findByRole("alert");
    expect(screen.getByRole("combobox")).toHaveValue("local");
    expect(screen.getByRole("combobox")).toBeEnabled();
    expect(mocks.fetch.mock.calls.some(([path]) => path.endsWith("/enable"))).toBe(false);
  });
  it("keeps selection local until a missing learning task is enabled", async () => {
    mocks.presets.push({ id: "cloud", model: "test-cloud-model", provider: "screenpipe-cloud", defaultPreset: false });
    mocks.fetch.mockImplementation(async () => Response.json({ error: "pipe not found" }, { status: 404 }));
    render(<StarterSkillsCard />); await screen.findByRole("button", { name: "Turn on learning" });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "cloud" } });
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveValue("cloud"));
    expect(mocks.fetch.mock.calls.every(([, init]) => !init.method)).toBe(true);
  });
  it("installs the disabled bundled task before configuring a missing task", async () => {
    let exists = false;
    mocks.fetch.mockImplementation(async (path: string, init: RequestInit) => {
      if (path.includes("/bundled/")) { exists = true; return Response.json({ success: true }); }
      if (path.endsWith("/enable")) enabled = JSON.parse(String(init.body)).enabled;
      return Response.json(exists ? { data: { config: { enabled } } } : { error: "pipe not found" });
    });
    render(<StarterSkillsCard />); fireEvent.click(await screen.findByRole("button", { name: "Turn on learning" })); await screen.findByRole("button", { name: "Pause learning" });
    expect(mocks.fetch.mock.calls.filter(([, i]) => i.method === "POST").map(([p]) => p)).toEqual(["/pipes/bundled/skill-learning/install", "/pipes/skill-learning/config", "/pipes/skill-learning/enable"]);
  });
  it("does not enable when saving the model fails", async () => {
    mocks.fetch.mockImplementation(async (path: string) => path.endsWith("/config") ? Response.json({ error: "failed" }, { status: 500 }) : Response.json({ data: { config: { enabled: false } } }));
    render(<StarterSkillsCard />); fireEvent.click(await screen.findByRole("button", { name: "Turn on learning" })); await screen.findByRole("alert");
    expect(mocks.fetch.mock.calls.some(([p]) => p.endsWith("/enable"))).toBe(false);
  });
  it("shows unavailable state and retry instead of assuming setup is off", async () => {
    mocks.fetch.mockRejectedValueOnce(new Error("engine offline")); render(<StarterSkillsCard />); await screen.findByRole("button", { name: "Retry" });
    expect(screen.getByText("Status unavailable")).toBeTruthy(); fireEvent.click(screen.getByRole("button", { name: "Retry" })); await screen.findByRole("button", { name: "Turn on learning" });
  });
  it("disables learning when no compatible model exists", async () => {
    mocks.presets = []; render(<StarterSkillsCard />); await waitFor(() => expect(screen.getByRole("button", { name: "Turn on learning" })).toBeDisabled());
  });
  it("does not duplicate writes after a double click", async () => {
    render(<StarterSkillsCard />); const button = await screen.findByRole("button", { name: "Turn on learning" }); fireEvent.click(button); fireEvent.click(button);
    await screen.findByRole("button", { name: "Pause learning" }); expect(mocks.fetch.mock.calls.filter(([p]) => p.endsWith("/enable"))).toHaveLength(1);
  });
  it("filters the catalog without changing learning or hiding the controls", async () => {
    render(<StarterSkillsCard />); await screen.findByRole("button", { name: "Turn on learning" });
    fireEvent.click(screen.getByText("Browse included skills"));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "decision" } });
    const matches = SCREENPIPE_STARTER_SKILLS.filter(skill => `${skill.name} ${skill.description}`.includes("decision"));
    expect(screen.getAllByRole("listitem")).toHaveLength(matches.length);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "nothing-matches-this" } });
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    expect(screen.getByText(/No matching skills/)).toBeTruthy();
    expect(screen.getByRole("combobox")).toBeEnabled();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
    expect(screen.getAllByRole("listitem")).toHaveLength(SCREENPIPE_STARTER_SKILLS.length);
    expect(mocks.fetch.mock.calls.every(([, init]) => !init.method)).toBe(true);
  });
  it("shows actual cadence and failed run, then refreshes activity without writes", async () => {
    let running = false;
    mocks.fetch.mockImplementation(async () => Response.json({ data: { config: { enabled: false, schedule: "every 12h" }, last_run: "2026-10-01T12:00:00Z", last_success: false, is_running: running } }));
    render(<StarterSkillsCard />); await screen.findByText(/Last run failed/);
    expect(screen.getByText("every 12h")).toBeTruthy();
    running = true;
    fireEvent.click(screen.getByRole("button", { name: "Refresh learning status" }));
    await screen.findByText("Run in progress");
    expect(screen.getByText("Future runs are paused. The current run may finish.")).toBeTruthy();
    expect(mocks.fetch.mock.calls.every(([, init]) => !init.method)).toBe(true);
  });
  it("does not present a successful scheduler run as a skill change", async () => {
    mocks.fetch.mockImplementation(async () => Response.json({ data: { config: { enabled: true }, last_run: "2026-10-01T12:00:00Z", last_success: true } }));
    render(<StarterSkillsCard />); await screen.findByText(/Last run ·/);
    expect(screen.queryByText(/skill created|skill updated|Last run failed/i)).toBeNull();
  });

});
