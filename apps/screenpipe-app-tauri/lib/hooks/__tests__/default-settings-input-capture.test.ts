// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { describe, expect, it } from "vitest";
import { createDefaultSettingsObject } from "@/lib/hooks/use-settings";
import { applyManagedOverrides } from "@/lib/hooks/managed-settings";
import catalog from "../../../src-tauri/src/enterprise/managed-settings.json";

describe("input capture defaults", () => {
  it("enables enterprise capture without changing subsequent consumer defaults", () => {
    const enterprise = createDefaultSettingsObject(true);
    const consumer = createDefaultSettingsObject(false);
    for (const key of ["disableClipboardCapture", "disableKeyboardCapture"] as const) {
      expect(enterprise[key]).toBe(false);
      expect(consumer[key]).toBe(true);
      expect(createDefaultSettingsObject()[key]).toBe(true);
      expect(catalog.find((setting) => setting.deviceKey === key)?.defaultValue).toBe(enterprise[key]);
    }
  });

  it("preserves an admin capture opt-out when resetting enterprise defaults", () => {
    const defaults = applyManagedOverrides(createDefaultSettingsObject(true), {
      disableClipboardCapture: true,
      disableKeyboardCapture: true,
    });
    expect(defaults.disableClipboardCapture).toBe(true);
    expect(defaults.disableKeyboardCapture).toBe(true);
  });
});
