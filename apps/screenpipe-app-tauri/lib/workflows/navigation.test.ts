// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { describe, expect, it } from "vitest";
import { ALL_SETTINGS_SECTIONS } from "@/lib/settings-sections";
import { navigationProductMode } from "./navigation";

describe("native Home navigation", () => {
  it.each(["", "help", "feedback", ...ALL_SETTINGS_SECTIONS, "disk-usage", "cloud-sync"])(
    "preserves the workspace for the shared destination %s", section => {
      expect(navigationProductMode(new URLSearchParams(section ? { section } : {}))).toBeNull();
    },
  );
  it.each(["timeline", "meetings", "brain", "connections", "pipes"])(
    "still opens the Chat workspace for a %s deep link", section => {
      expect(navigationProductMode(new URLSearchParams({ section }))).toBe("screenpipe");
    },
  );
  it.each(["workflows", "screenpipe"])("honors explicit workspace %s", mode => {
    expect(navigationProductMode(new URLSearchParams({ mode, section: "help" }))).toBe(mode);
  });
});
