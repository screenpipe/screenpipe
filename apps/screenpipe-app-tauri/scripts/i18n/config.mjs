// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const appRoot = fileURLToPath(new URL("../../", import.meta.url));
export const gtConfig = JSON.parse(readFileSync(new URL("../../gt.config.json", import.meta.url), "utf8"));

export function localizationMode(value = process.env.SCREENPIPE_I18N_MODE) {
  const mode = value ?? "off";
  if (!["off", "cached", "generate"].includes(mode)) {
    throw new Error(`Invalid SCREENPIPE_I18N_MODE: ${mode}`);
  }
  return mode;
}

// Changes to this brief invalidate translations, including native messages.
// Native adapters supply this as keyed context. Configure the GT project's
// shared translation instructions with the same brief before the first run.
export const translationPolicy = {
  revision: 2,
  context: "Screenpipe desktop interface. Use concise, clear interface language. Keep screenpipe, product names, brands, keyboard shortcuts, paths, and technical identifiers unchanged. Preserve placeholders and rich-text structure. In Japanese use natural, concise interface labels and polite desu/masu wording for explanatory sentences. Avoid literal English phrasing and unnecessary pronouns. Never translate user content, recorded content, transcripts, AI responses, or executable prompts.",
};
