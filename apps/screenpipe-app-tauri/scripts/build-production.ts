// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { localizationMode } from "./i18n/config.mjs";
import { fileURLToPath } from "node:url";

// Release platform jobs supply the immutable snapshot from their preparation
// job. A standalone production build prepares one before inspecting the cache.
const mode = localizationMode(process.env.SCREENPIPE_I18N_MODE ??
  (process.env.SCREENPIPE_I18N_SNAPSHOT ? "cached" : "generate"));
if (mode === "off") throw new Error("Production builds require cached or generate localization mode");
const child = Bun.spawn(["bun", "run", "build"], {
  cwd: fileURLToPath(new URL("../", import.meta.url)),
  env: { ...process.env, SCREENPIPE_I18N_MODE: mode },
  stdin: "inherit", stdout: "inherit", stderr: "inherit",
});
process.exit(await child.exited);
