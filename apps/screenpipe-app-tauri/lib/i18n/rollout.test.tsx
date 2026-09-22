// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import React, { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useGT } from "gt-react";

type FlagCallback = (keys: string[], variants: Record<string, unknown>, context?: { errorsLoading?: boolean }) => void;
const mocks = vi.hoisted(() => ({
  useSettings: vi.fn(), primary: true, callbacks: new Set<FlagCallback>(), writes: vi.fn(),
}));
vi.mock("@/lib/hooks/use-settings", () => ({ useSettings: () => mocks.useSettings() }));
vi.mock("@/lib/utils/is-primary-window", () => ({ isPrimaryWindow: () => mocks.primary }));
vi.mock("@tauri-apps/plugin-os", () => ({ locale: async () => "ja-JP" }));
vi.mock("posthog-js", () => ({ default: {
  onFeatureFlags: (callback: FlagCallback) => {
    mocks.callbacks.add(callback);
    return () => mocks.callbacks.delete(callback);
  },
} }));
vi.mock("@/lib/i18n/generated.json", async () => {
  const { hashMessage } = await import("gt-i18n/internal");
  return { default: {
    defaultLocale: "en", locales: ["ja"], mode: "cached", revision: "rollout-test",
    translations: { ja: { [hashMessage("Settings", { $format: "ICU" })]: "設定" } },
    coverage: {}, fallbacks: {}, causes: [],
  } };
});

import { EmergencyLocalizationProvider, LocalizationProvider, useUiLocale } from "./provider";
import { LocalizationRolloutSync, LOCALIZATION_FLAG } from "./rollout-sync";
import { LanguageSelector } from "@/components/language-selector";

function Content() {
  const gt = useGT();
  const locale = useUiLocale();
  const [draft, setDraft] = useState("");
  return <><h1>{gt("Settings")}</h1><output>{locale}</output><input aria-label="Draft" value={draft} onChange={(event) => setDraft(event.target.value)} /><LanguageSelector /></>;
}

function App({ granted = false, ready = true, configured = "ja" }: { granted?: boolean; ready?: boolean; configured?: string }) {
  const [settings, setSettings] = useState({ uiLocale: configured, uiLocalizationEnabled: granted });
  mocks.useSettings.mockReturnValue({ settings, isSettingsLoaded: true, updateSettings: async (patch: Partial<typeof settings>) => {
    await mocks.writes(patch);
    setSettings(current => ({ ...current, ...patch }));
  } });
  return <><LocalizationRolloutSync ready={ready} /><LocalizationProvider><Content /></LocalizationProvider></>;
}

async function flags(variants: Record<string, unknown>, errorsLoading = false) {
  await act(async () => {
    for (const callback of mocks.callbacks) callback(Object.keys(variants), variants, { errorsLoading });
  });
}

beforeEach(() => {
  mocks.primary = true;
  mocks.writes.mockReset().mockResolvedValue(undefined);
  localStorage.clear();
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => { cleanup(); mocks.callbacks.clear(); vi.restoreAllMocks(); });

test.each(["system", "ja"])("defaults to English with no selector for saved locale %s before flag resolution", async configured => {
  render(<App configured={configured} />);
  expect(await screen.findByRole("heading", { name: "Settings" })).toBeVisible();
  expect(document.documentElement.lang).toBe("en");
  expect(screen.queryByTestId("language-selector")).toBeNull();
  expect(mocks.writes).not.toHaveBeenCalled();
});

test("flag grants and revocations change language without remounting drafts or erasing the choice", async () => {
  render(<App />);
  fireEvent.change(screen.getByRole("textbox", { name: "Draft" }), { target: { value: "private draft" } });
  for (const enabled of [true, false, true]) {
    await flags({ [LOCALIZATION_FLAG]: enabled });
    expect(await screen.findByRole("heading", { name: enabled ? "設定" : "Settings" })).toBeVisible();
    expect(document.documentElement.lang).toBe(enabled ? "ja" : "en");
    expect(Boolean(screen.queryByTestId("language-selector"))).toBe(enabled);
    expect(screen.getByRole("textbox", { name: "Draft" })).toHaveValue("private draft");
    expect(localStorage.getItem("screenpipe-ui-localization-enabled")).toBe(String(enabled));
  }
  expect(mocks.writes.mock.calls.map(([patch]) => patch)).toEqual([
    { uiLocalizationEnabled: true }, { uiLocalizationEnabled: false }, { uiLocalizationEnabled: true },
  ]);
});

test("cached grant survives unresolved and failed responses; a successfully removed flag revokes it", async () => {
  render(<App granted />);
  expect(await screen.findByRole("heading", { name: "設定" })).toBeVisible();
  await flags({}, true);
  expect(screen.getByRole("heading", { name: "設定" })).toBeVisible();
  expect(mocks.writes).not.toHaveBeenCalled();
  await flags({});
  expect(await screen.findByRole("heading", { name: "Settings" })).toBeVisible();
  expect(mocks.writes).toHaveBeenCalledWith({ uiLocalizationEnabled: false });
});

test("nonboolean variants never grant the rollout", async () => {
  render(<App />);
  for (const value of ["true", "test", 1, null, undefined]) await flags({ [LOCALIZATION_FLAG]: value });
  expect(screen.getByRole("heading", { name: "Settings" })).toBeVisible();
  expect(screen.queryByTestId("language-selector")).toBeNull();
  expect(mocks.writes).not.toHaveBeenCalled();
});

test("secondary windows and uninitialized PostHog cannot overwrite the shared decision", async () => {
  mocks.primary = false;
  const view = render(<App granted />);
  expect(await screen.findByRole("heading", { name: "設定" })).toBeVisible();
  expect(mocks.callbacks.size).toBe(0);
  view.unmount();
  mocks.primary = true;
  await act(async () => { render(<App ready={false} />); });
  expect(screen.getByRole("heading", { name: "Settings" })).toBeVisible();
  expect(mocks.callbacks.size).toBe(0);
});

test("a failed persistence write retains English and reports the originating error", async () => {
  const error = new Error("settings_write_failed");
  mocks.writes.mockRejectedValueOnce(error);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  render(<App />);
  await flags({ [LOCALIZATION_FLAG]: true });
  await waitFor(() => expect(log).toHaveBeenCalledWith("[localization] failed to persist PostHog rollout decision", error));
  expect(screen.getByRole("heading", { name: "Settings" })).toBeVisible();
  await flags({ [LOCALIZATION_FLAG]: true });
  expect(await screen.findByRole("heading", { name: "設定" })).toBeVisible();
});

test("the crash screen ignores a legacy cached Japanese locale without a cached grant", async () => {
  localStorage.setItem("screenpipe-ui-locale", "ja");
  mocks.useSettings.mockReturnValue({ settings: { uiLocale: "ja" }, updateSettings: vi.fn() });
  const view = render(<EmergencyLocalizationProvider><Content /></EmergencyLocalizationProvider>);
  expect(screen.getByRole("heading", { name: "Settings" })).toBeVisible();
  view.unmount();
  localStorage.setItem("screenpipe-ui-localization-enabled", "true");
  render(<EmergencyLocalizationProvider><Content /></EmergencyLocalizationProvider>);
  expect(await screen.findByRole("heading", { name: "設定" })).toBeVisible();
});
