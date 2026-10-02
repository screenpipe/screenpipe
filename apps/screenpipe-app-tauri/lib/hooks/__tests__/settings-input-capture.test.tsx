// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsProvider, createDefaultSettingsObject, useSettings } from "../use-settings";

const state = vi.hoisted(() => ({
  enterprise: true,
  settings: undefined as Record<string, unknown> | undefined,
}));
vi.mock("../use-is-enterprise-build", () => ({
  resolveEnterpriseBuild: async () => state.enterprise,
  isResolvedConsumerBuild: async () => !state.enterprise,
}));
vi.mock("@tauri-apps/plugin-store", () => ({
  Store: { load: async () => ({
    get: async () => state.settings,
    set: async (_key: string, value: Record<string, unknown>) => { state.settings = value; },
    save: async () => {},
    onKeyChange: async () => () => {},
  }) },
}));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: async () => "/tmp" }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "macos" }));
vi.mock("@/lib/api", () => ({
  configureApi: () => {}, refreshApiConfig: async () => {}, onUnauthorized: () => () => {},
}));
vi.mock("@/lib/utils/tauri", () => ({
  commands: {
    getScreenpipeBaseDir: async () => ({ status: "ok", data: "/tmp" }),
    getCloudToken: async () => null,
    reencryptStore: async () => {},
    setBrowserCookieAccessState: async () => {},
  },
}));

async function loadSettings() {
  const hook = renderHook(() => useSettings(), { wrapper: SettingsProvider });
  await waitFor(() => expect(hook.result.current.isSettingsLoaded).toBe(true));
  expect(hook.result.current.loadingError).toBeNull();
  return hook;
}

describe("stored input capture defaults", () => {
  beforeEach(() => {
    state.enterprise = true;
    state.settings = { ...createDefaultSettingsObject(), deviceId: "test-device" };
  });

  it("uses enterprise defaults for an empty store", async () => {
    state.settings = undefined;
    const { result } = await loadSettings();
    expect(result.current.settings.disableClipboardCapture).toBe(false);
    expect(result.current.settings.disableKeyboardCapture).toBe(false);
  });

  it.each([true, false])("fills absent capture settings for enterprise=%s", async (enterprise) => {
    state.enterprise = enterprise;
    delete state.settings!.disableClipboardCapture;
    delete state.settings!.disableKeyboardCapture;
    const { result } = await loadSettings();
    expect(result.current.settings.disableClipboardCapture).toBe(!enterprise);
    expect(result.current.settings.disableKeyboardCapture).toBe(!enterprise);
    expect(state.settings!.disableClipboardCapture).toBe(!enterprise);
    expect(state.settings!.disableKeyboardCapture).toBe(!enterprise);
  });

  it("keeps saved off choices and restores enterprise defaults on explicit reset", async () => {
    const { result } = await loadSettings();
    expect(result.current.settings.disableClipboardCapture).toBe(true);
    expect(result.current.settings.disableKeyboardCapture).toBe(true);
    await act(async () => { await result.current.resetSetting("disableKeyboardCapture"); });
    expect(state.settings!.disableKeyboardCapture).toBe(false);
    expect(state.settings!.disableClipboardCapture).toBe(true);
    await act(async () => { await result.current.resetSettings(); });
    expect(state.settings!.disableClipboardCapture).toBe(false);
    expect(state.settings!.disableKeyboardCapture).toBe(false);
  });

  it("keeps admin opt-outs through a full reset", async () => {
    state.settings!.enterpriseManagedSettings = {
      disableClipboardCapture: true, disableKeyboardCapture: true,
    };
    const { result } = await loadSettings();
    await act(async () => { await result.current.resetSettings(); });
    expect(state.settings!.disableClipboardCapture).toBe(true);
    expect(state.settings!.disableKeyboardCapture).toBe(true);
  });

  it.each([true, false])("fills missing PII defaults for enterprise=%s", async (enterprise) => {
    state.enterprise = enterprise;
    delete state.settings!.asyncPiiRedaction;
    delete state.settings!.asyncImagePiiRedaction;
    delete state.settings!.piiBackend;
    const { result } = await loadSettings();
    expect(result.current.settings.asyncPiiRedaction).toBe(enterprise);
    expect(result.current.settings.asyncImagePiiRedaction).toBe(enterprise);
    expect(result.current.settings.piiBackend).toBe(enterprise ? "tinfoil" : "local");
    expect(state.settings!.asyncPiiRedaction).toBe(enterprise);
    expect(state.settings!.asyncImagePiiRedaction).toBe(enterprise);
    expect(state.settings!.piiBackend).toBe(enterprise ? "tinfoil" : "local");
  });

  it("keeps saved local/off choices until an explicit enterprise reset", async () => {
    const { result } = await loadSettings();
    expect(result.current.settings.asyncPiiRedaction).toBe(false);
    expect(result.current.settings.asyncImagePiiRedaction).toBe(false);
    expect(result.current.settings.piiBackend).toBe("local");
    await act(async () => { await result.current.resetSetting("piiBackend"); });
    expect(state.settings!.piiBackend).toBe("tinfoil");
    expect(state.settings!.asyncPiiRedaction).toBe(false);
    await act(async () => { await result.current.resetSettings(); });
    expect(state.settings!.usePiiRemoval).toBe(true);
    expect(state.settings!.asyncPiiRedaction).toBe(true);
    expect(state.settings!.asyncImagePiiRedaction).toBe(true);
    expect(state.settings!.piiBackend).toBe("tinfoil");
  });

  it("keeps managed local/off settings through an enterprise reset", async () => {
    state.settings!.enterpriseManagedSettings = {
      usePiiRemoval: false, asyncPiiRedaction: false,
      asyncImagePiiRedaction: false, piiBackend: "local",
    };
    const { result } = await loadSettings();
    await act(async () => { await result.current.resetSettings(); });
    expect(state.settings!.usePiiRemoval).toBe(false);
    expect(state.settings!.asyncPiiRedaction).toBe(false);
    expect(state.settings!.asyncImagePiiRedaction).toBe(false);
    expect(state.settings!.piiBackend).toBe("local");
  });

});
