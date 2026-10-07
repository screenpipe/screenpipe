// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import {
  WORKFLOW_MODELS,
  type WorkflowModelMode,
} from "@screenpipe/workflows-ui";
import { getStore } from "@/lib/hooks/use-settings";
import { applyResolvedModelLimits } from "@/lib/model-metadata";
import type { AIPreset, PiProviderConfig } from "@/lib/utils/tauri";

// Workflows uses the Pi tool/event contract. External ACP agents are not model presets.
export const supportsWorkflowPreset = (preset: AIPreset) =>
  [
    "screenpipe-cloud",
    "openai",
    "openai-chatgpt",
    "anthropic",
    "custom",
    "native-ollama",
    "pi",
  ].includes(preset.provider);

export async function resolveWorkflowProvider(
  mode: WorkflowModelMode,
  config: PiProviderConfig,
): Promise<PiProviderConfig> {
  if (mode === "intelligent" || mode === "private") {
    return {
      ...config,
      provider: "screenpipe-cloud",
      model: WORKFLOW_MODELS[mode].model,
      url: "",
      apiKey: null,
      acpAgent: null,
      backend: null,
      maxContextChars: null,
    };
  }
  const settings = await (
    await getStore()
  ).get<{ aiPresets?: AIPreset[] }>("settings");
  const selected = settings?.aiPresets?.find(
    (preset) => preset.id === mode.slice(7),
  );
  if (
    !selected ||
    !supportsWorkflowPreset(selected) ||
    !selected.model?.trim()
  ) {
    throw new Error(
      "Your Workflows AI preset is missing or unsupported. Choose an AI preset again.",
    );
  }
  const preset = applyResolvedModelLimits(selected);
  return {
    ...config,
    provider: preset.provider === "pi" ? "screenpipe-cloud" : preset.provider,
    model: preset.model!,
    url: preset.url || "",
    apiKey: preset.apiKey || null,
    maxContextChars: preset.maxContextChars,
    maxTokens: preset.maxTokens ?? config.maxTokens,
    systemPrompt: [config.systemPrompt, preset.prompt]
      .filter(Boolean)
      .join("\n\n"),
    acpAgent: null,
    backend: null,
  };
}
