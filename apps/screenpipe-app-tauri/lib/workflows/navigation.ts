// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import type { ProductMode } from "@/components/workflows/product-switcher";
import { resolveSettingsSection } from "@/lib/settings-sections";

/** A shared destination opens in the current workspace, without changing it. */
export function navigationProductMode(params: URLSearchParams): ProductMode | null {
  const mode = params.get("mode");
  if (mode === "workflows" || mode === "screenpipe") return mode;
  const section = params.get("section");
  if (!section || section === "help" || section === "feedback" || resolveSettingsSection(section)) {
    return null;
  }
  return "screenpipe";
}
