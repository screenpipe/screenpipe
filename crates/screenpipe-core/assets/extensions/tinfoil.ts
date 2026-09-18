// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { createGlmEncryptedFetch, GLM_SECURE_API } from "./lib/tinfoil-transport";

// Replaced with the managed runtime package.json path when installed by Rust.
// Resolve dependencies from that install, never from an arbitrary chat project.
const runtimePackageJson = __SCREENPIPE_PI_PACKAGE_JSON__;
const runtimeRequire = createRequire(runtimePackageJson);

export default async function (pi: ExtensionAPI) {
  // Pi's pinned ESM-only API export has no require condition. Use its managed
  // installation path rather than resolving it from the user's chat project.
  const { streamSimple } = await import(pathToFileURL(join(dirname(runtimePackageJson),
    "node_modules", "@earendil-works", "pi-ai", "dist", "api", "openai-completions.js",
  )).href);
  // Load lazily so a missing SDK cannot break unrelated hosted models. The
  // distinct model API has no built-in handler, so missing/disabled extensions
  // or failed verification cannot silently send GLM via ordinary OpenAI TLS.
  const sdk = () => import(pathToFileURL(runtimeRequire.resolve("tinfoil")).href);
  let publish: ((text: string) => void) | undefined;
  pi.on("before_agent_start", (_event, ctx) => {
    publish = text => ctx.ui.setStatus("screenpipe-confidential", text);
  });
  pi.on("session_shutdown", () => { publish = undefined; });
  const transports = new Map<string, typeof fetch>();
  pi.registerProvider("screenpipe", {
    api: GLM_SECURE_API,
    streamSimple(model, context, options) {
      const baseURL = model.baseUrl.replace(/\/$/, "");
      let transport = transports.get(baseURL);
      if (!transport) {
        // Construction and attestation happen inside the request fetch, where
        // Pi turns failures into terminal provider errors without fallback.
        let encryptedFetch: typeof fetch | undefined;
        transport = async (input, init) => {
          const { SecureClient } = await sdk();
          encryptedFetch ??= createGlmEncryptedFetch(baseURL, (config) => new SecureClient(config), update => publish?.(JSON.stringify(update)));
          return encryptedFetch(input, init);
        };
        transports.set(baseURL, transport);
      }
      return streamSimple({
        ...model, api: "openai-completions", baseUrl: `${baseURL}/tinfoil/glm`,
      }, context, { ...options, fetch: transport });
    },
  });
}
