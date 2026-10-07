// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import type { ChatConversation } from "@/lib/hooks/use-settings";
import type { AIPreset } from "@/lib/utils/tauri";
import { generatePresetName } from "@/lib/utils/preset-appearance";

export type ImportedPresetConversation = Pick<ChatConversation, "importedFrom" | "presetId"> & {
  messages?: ChatConversation["messages"];
};

/** Explicit choices win. Never mutate a shared preset to fit another chat. */
export function resolveImportedChatPreset(
  conversation: ImportedPresetConversation,
  presets: AIPreset[],
  allowAgentPresets: boolean,
  reservedIds: string[] = presets.map(preset => preset.id),
): { preset: AIPreset; created: boolean } | undefined {
  const saved = presets.find((preset) => preset.id === conversation.presetId);
  if (saved) return { preset: saved, created: false };
  const source = conversation.importedFrom;
  if (!source || !allowAgentPresets) return undefined;
  const agentId = source.source === "codex" ? "codex-acp" : "claude-acp";
  // Older Claude imports already kept message.model; use it without requiring
  // a reimport. Missing metadata stays unset so the adapter chooses its default.
  const model = source.config?.model ?? conversation.messages?.slice().reverse().find(
    (message) => message.role === "assistant" && message.model
      && message.model !== "<synthetic>"
      && (!message.importedFrom || message.importedFrom === source.source),
  )?.model;
  const config: Record<string, string> = {};
  if (model) config.model = model;
  if (source.config?.reasoningEffort) config.reasoning_effort = source.config.reasoningEffort;
  const modeId = source.config?.modeId;
  const match = presets.find((preset) => {
    const agent = preset.acpAgent;
    return preset.provider === "acp" && agent?.id === agentId
      && !agent.useScreenpipeCloud && !agent.command && !agent.args?.length
      && !Object.keys(agent.env ?? {}).length
      && (agent.modeId ?? undefined) === modeId
      && agent.approvalMode !== "allow-all"
      && Object.keys(agent.config ?? {}).length === Object.keys(config).length
      && Object.entries(config).every(([key, value]) => agent.config?.[key] === value);
  });
  if (match) return { preset: match, created: false };
  return {
    created: true,
    preset: {
      id: generatePresetName({ provider: "acp", acpAgentId: agentId }, reservedIds),
      provider: "acp",
      model: agentId,
      url: "",
      apiKey: null,
      prompt: "",
      maxContextChars: 512000,
      defaultPreset: false,
      acpAgent: { id: agentId, config, ...(modeId ? { modeId } : {}), useScreenpipeCloud: false },
    },
  };
}
