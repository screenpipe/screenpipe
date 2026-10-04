// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import type { AIPreset } from "./tauri";

export const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
export type AIProviderChoice = AIPreset["provider"] | "gemini";

/** Gemini uses the existing OpenAI-compatible transport in chat and pipes. */
export function isGeminiPreset(preset?: Pick<Partial<AIPreset>, "provider" | "url">): boolean {
  if (preset?.provider !== "custom" || !preset.url) return false;
  try {
    const url = new URL(preset.url);
    return url.origin === "https://generativelanguage.googleapis.com" &&
      url.pathname.replace(/\/+$/, "") === "/v1beta/openai";
  } catch {
    return false;
  }
}

/** Clear another service's key and model before changing the endpoint. */
export function geminiSelectionUpdate(
  choice: AIProviderChoice,
  preset?: Partial<AIPreset>,
): Partial<AIPreset> | null {
  const wasGemini = isGeminiPreset(preset);
  if (choice === "gemini") {
    return wasGemini ? null : { provider: "custom", url: GEMINI_API_URL, model: "", apiKey: "" };
  }
  if (choice === "custom" && wasGemini) {
    return { provider: "custom", url: "", model: "", apiKey: "" };
  }
  return null;
}
