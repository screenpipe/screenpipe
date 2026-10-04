// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { describe, expect, it, vi } from "vitest";
import { GEMINI_API_URL, geminiSelectionUpdate, isGeminiPreset } from "./gemini-preset";
import { testAiPresetConnection } from "./ai-preset-connection";
import { validateAiPresetConnectionFields } from "./validation";
import { pickPipePreset } from "./pick-pipe-preset";

describe("Gemini presets", () => {
  it("recognizes saved Gemini presets, including trailing slashes", () => {
    expect(isGeminiPreset({ provider: "custom", url: `${GEMINI_API_URL}/` })).toBe(true);
    for (const url of ["", "not a URL", "https://generativelanguage.googleapis.com.evil.test/v1beta/openai", "http://generativelanguage.googleapis.com/v1beta/openai", "https://other.example/v1", `${GEMINI_API_URL}/other`]) {
      expect(isGeminiPreset({ provider: "custom", url })).toBe(false);
    }
    expect(isGeminiPreset({ provider: "openai", url: GEMINI_API_URL })).toBe(false);
  });

  it("clears the previous model and key when entering or leaving Gemini", () => {
    const update = geminiSelectionUpdate("gemini", { provider: "custom", url: "https://other.example/v1", apiKey: "other-key", model: "other-model" });
    expect(update).toEqual({ provider: "custom", url: GEMINI_API_URL, apiKey: "", model: "" });
    expect(geminiSelectionUpdate("custom", update!)).toEqual({ provider: "custom", url: "", apiKey: "", model: "" });
    expect(geminiSelectionUpdate("gemini", update!)).toBeNull();
    expect(validateAiPresetConnectionFields(update!).apiKey).toBeTruthy();
    expect(validateAiPresetConnectionFields(update!).model).toBeTruthy();
  });

  it("uses the saved Gemini endpoint and key for connection tests and remains a pipe preset", async () => {
    const preset = { ...geminiSelectionUpdate("gemini"), id: "pipes", provider: "custom" as const, url: GEMINI_API_URL, model: "gemini-test-model", apiKey: "test-google-key", defaultPreset: true };
    const request = vi.fn(async (_input: string, _init?: RequestInit) => new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), { status: 200 }));
    await expect(testAiPresetConnection(preset, { fetch: request })).resolves.toMatchObject({ reply: "hi" });
    expect(request).toHaveBeenCalledWith(`${GEMINI_API_URL}/chat/completions`, expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer test-google-key" }) }));
    expect(JSON.parse(request.mock.calls[0][1]!.body as string)).toMatchObject({ model: "gemini-test-model", stream: false });
    expect(pickPipePreset([preset])).toEqual(preset);
  });
});
