// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { beforeEach, expect, it, vi } from "vitest";
import type { AIPreset, PiProviderConfig } from "@/lib/utils/tauri";
const store = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/hooks/use-settings", () => ({ getStore: async () => store }));
import { resolveWorkflowProvider } from "./model-provider";
const base = {
  provider: "screenpipe-cloud",
  model: "auto",
  systemPrompt: "Workflow rules",
  allowedTools: ["read"],
  maxTokens: 1000,
} as PiProviderConfig;
const custom = {
  id: "Clinic model",
  provider: "custom",
  model: "my-model",
  url: "http://localhost:1234/v1",
  apiKey: "fixture-key",
  prompt: "Prefer concise answers",
  maxContextChars: 64000,
  maxTokens: 2000,
  defaultPreset: false,
} as AIPreset;
beforeEach(() => {
  store.get.mockResolvedValue({ aiPresets: [custom] });
});
it("uses the exact saved endpoint and credentials while retaining workflow permissions", async () => {
  expect(
    await resolveWorkflowProvider("preset:Clinic model", base),
  ).toMatchObject({
    provider: "custom",
    model: "my-model",
    url: custom.url,
    apiKey: "fixture-key",
    allowedTools: ["read"],
    maxContextChars: 64000,
    maxTokens: 2000,
    systemPrompt: "Workflow rules\n\nPrefer concise answers",
    backend: null,
  });
});
it("reads edited presets again for the next run", async () => {
  await resolveWorkflowProvider("preset:Clinic model", base);
  store.get.mockResolvedValue({
    aiPresets: [{ ...custom, model: "new-model", apiKey: "new-fixture-key" }],
  });
  expect(
    await resolveWorkflowProvider("preset:Clinic model", base),
  ).toMatchObject({ model: "new-model", apiKey: "new-fixture-key" });
});
it("does not use the chat default or cloud when the saved preset is deleted", async () => {
  store.get.mockResolvedValue({
    aiPresets: [{ ...custom, id: "Other", defaultPreset: true }],
  });
  await expect(
    resolveWorkflowProvider("preset:Clinic model", base),
  ).rejects.toThrow("missing or unsupported");
});
it("rejects external agents instead of treating their name as a hosted model", async () => {
  store.get.mockResolvedValue({ aiPresets: [{ ...custom, provider: "acp" }] });
  await expect(
    resolveWorkflowProvider("preset:Clinic model", base),
  ).rejects.toThrow("missing or unsupported");
});
it("clears custom credentials when switching back to a built-in choice", async () => {
  expect(
    await resolveWorkflowProvider("private", {
      ...base,
      apiKey: "old-fixture-key",
      url: custom.url,
    }),
  ).toMatchObject({ provider: "screenpipe-cloud", apiKey: null, url: "" });
});
