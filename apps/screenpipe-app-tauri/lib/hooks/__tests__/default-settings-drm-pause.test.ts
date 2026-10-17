// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { describe, expect, it } from "vitest";
import { createDefaultSettingsObject } from "@/lib/hooks/use-settings";
import catalog from "../../../src-tauri/src/enterprise/managed-settings.json";

describe("default settings: DRM & remote desktop pause", () => {
  it("pauses capture for DRM and remote desktop on a fresh install", () => {
    expect(createDefaultSettingsObject().pauseOnDrmContent).toBe(true);
    expect(createDefaultSettingsObject(true).pauseOnDrmContent).toBe(true);
    expect(
      catalog.find((setting) => setting.deviceKey === "pauseOnDrmContent")
        ?.defaultValue,
    ).toBe(true);
  });
});
