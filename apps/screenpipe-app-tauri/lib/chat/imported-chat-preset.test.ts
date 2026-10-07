// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { describe, expect, it } from "vitest";
import { resolveImportedChatPreset, type ImportedPresetConversation } from "./imported-chat-preset";
import { parseCodexTranscript, parseClaudeCodeTranscript } from "./external-chat-parser";
import type { AIPreset } from "@/lib/utils/tauri";

const codex: ImportedPresetConversation = {
  importedFrom: { source: "codex", sourceId: "demo", importedAt: 1,
    config: { model: "gpt-5.4", reasoningEffort: "high" } },
};
const cloud: AIPreset = {
  id: "cloud", provider: "screenpipe-cloud", model: "auto", apiKey: null,
  prompt: "", maxContextChars: 1000, defaultPreset: true,
};
const jsonl = (...records: object[]) => records.map(r => JSON.stringify(r)).join("\n");

describe("imported chat presets", () => {
  it("creates a Codex account preset with the transcript's model and effort without changing the default", () => {
    const result = resolveImportedChatPreset(codex, [cloud], true)!;
    expect(result.created).toBe(true);
    expect(result.preset).toMatchObject({ provider: "acp", defaultPreset: false,
      acpAgent: { id: "codex-acp", useScreenpipeCloud: false,
        config: { model: "gpt-5.4", reasoning_effort: "high" } } });
    expect(cloud.defaultPreset).toBe(true);
  });

  it("reuses an exact configuration but leaves other chats' presets untouched", () => {
    const first = resolveImportedChatPreset(codex, [cloud], true)!.preset;
    expect(resolveImportedChatPreset(codex, [cloud, first], true)).toEqual({ preset: first, created: false });
    const changed = { ...codex, importedFrom: { ...codex.importedFrom!, config: { model: "gpt-5.4", reasoningEffort: "low" } } };
    const next = resolveImportedChatPreset(changed, [cloud, first], true)!;
    expect(next.created).toBe(true);
    expect(next.preset.id).not.toBe(first.id);
    expect(first.acpAgent?.config?.reasoning_effort).toBe("high");
  });

  it("preserves an explicit Cloud switch and recreates a deleted source preset", () => {
    expect(resolveImportedChatPreset({ ...codex, presetId: cloud.id }, [cloud], true))
      .toEqual({ preset: cloud, created: false });
    expect(resolveImportedChatPreset({ ...codex, presetId: "deleted" }, [cloud], true)?.created).toBe(true);
  });

  it("does not reuse cloud-routed or custom-command agents for source-account chats", () => {
    const first = resolveImportedChatPreset(codex, [], true)!.preset;
    for (const overrides of [{ useScreenpipeCloud: true }, { command: "/custom/agent" }, { approvalMode: "allow-all" as const }]) {
      const other = { ...first, acpAgent: { ...first.acpAgent!, ...overrides } };
      expect(resolveImportedChatPreset(codex, [other], true)?.created).toBe(true);
    }
  });

  it("keeps rollout/policy gating and regular chats unchanged", () => {
    expect(resolveImportedChatPreset(codex, [cloud], false)).toBeUndefined();
    expect(resolveImportedChatPreset({}, [cloud], true)).toBeUndefined();
    expect(resolveImportedChatPreset({ presetId: cloud.id }, [cloud], false)?.preset).toBe(cloud);
  });

  it("does not invent a model when the transcript omits it", () => {
    const conversation = { importedFrom: { source: "claude-code" as const, sourceId: "old", importedAt: 1 } };
    expect(resolveImportedChatPreset(conversation, [], true)?.preset.acpAgent)
      .toMatchObject({ id: "claude-acp", config: {} });
  });

  it("uses the last recorded Codex turn settings, ignoring unportable configuration", () => {
    const conversation = parseCodexTranscript(jsonl(
      { type: "turn_context", payload: { model: "gpt-5", effort: "low" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] } },
      { type: "turn_context", payload: { model: "gpt-5.4", effort: "high", cwd: "/private/project", approval_policy: "never" } },
    ), { sourceId: "demo", fallbackTimestamp: 1 })!;
    expect(conversation.importedFrom?.config).toEqual({ model: "gpt-5.4", reasoningEffort: "high" });
    expect(resolveImportedChatPreset(conversation, [cloud], true)?.preset.acpAgent?.config)
      .toEqual({ model: "gpt-5.4", reasoning_effort: "high" });
  });

  it("reads Codex collaboration settings when direct settings are absent", () => {
    const conversation = parseCodexTranscript(jsonl(
      { type: "turn_context", payload: { collaboration_mode: { settings: { model: "gpt-5.4", reasoning_effort: "medium" } } } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] } },
    ), { sourceId: "demo", fallbackTimestamp: 1 })!;
    expect(conversation.importedFrom?.config).toEqual({ model: "gpt-5.4", reasoningEffort: "medium" });
  });

  it("imports Claude's actual model and mode, excluding sidechain and synthetic models", () => {
    const conversation = parseClaudeCodeTranscript(jsonl(
      { type: "user", permissionMode: "plan", message: { content: "Hello" } },
      { type: "assistant", message: { model: "claude-sonnet-4-6", content: [{ type: "text", text: "Hello" }] } },
      { type: "assistant", isSidechain: true, message: { model: "claude-haiku-4-5", content: "side task" } },
      { type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text: "Interrupted" }] } },
    ), { sourceId: "demo", fallbackTimestamp: 1 })!;
    const preset = resolveImportedChatPreset(conversation, [cloud], true)!.preset;
    expect(preset.acpAgent).toMatchObject({ id: "claude-acp", modeId: "plan", config: { model: "claude-sonnet-4-6" } });
  });
});
