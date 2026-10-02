// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { expect, it } from "vitest";
import type { AIPreset } from "@/lib/utils/tauri";
import {
  DEFAULT_ENTERPRISE_AI_PRESET_POLICY,
  filterPresetsForEnterprisePolicy,
} from "./enterprise-ai-preset-policy";

it("keeps named managed presets visible when cloud and employee presets are disabled", () => {
  const managed: AIPreset = {
    id: "company-assistant",
    provider: "anthropic",
    model: "company-model",
    prompt: "",
    apiKey: null,
    maxContextChars: 128000,
    defaultPreset: true,
    enterpriseManaged: true,
  };
  const { enterpriseManaged: _, ...unmarked } = managed;
  const presets: AIPreset[] = [
    managed,
    { ...unmarked, id: "legacy-employee-assistant", defaultPreset: false },
    { ...unmarked, id: "employee-assistant", enterpriseManaged: false, defaultPreset: false },
    { ...unmarked, id: "screenpipe-cloud", provider: "screenpipe-cloud", defaultPreset: false },
    { ...unmarked, id: "enterprise-managed", defaultPreset: false },
  ];

  expect(
    filterPresetsForEnterprisePolicy(presets, {
      ...DEFAULT_ENTERPRISE_AI_PRESET_POLICY,
      allow_screenpipe_cloud: false,
      allow_employee_custom_presets: false,
    }).map((preset) => preset.id),
  ).toEqual(["company-assistant", "enterprise-managed"]);
});
