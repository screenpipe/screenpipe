// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { createGlmEncryptedFetch, GLM_SECURE_API } from "./lib/tinfoil-transport";
import { compactGlmSkillCatalog, compactGlmToolResultText } from "./lib/glm-protocol";

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
  const { writeRawStdout } = await import(pathToFileURL(join(dirname(runtimePackageJson),
    "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "output-guard.js",
  )).href);
  // Load lazily so a missing SDK cannot break unrelated hosted models. The
  // distinct model API has no built-in handler, so missing/disabled extensions
  // or failed verification cannot silently send GLM via ordinary OpenAI TLS.
  const sdk = () => import(pathToFileURL(runtimeRequire.resolve("tinfoil")).href);
  let publish: ((text: string) => void) | undefined;
  pi.on("before_agent_start", (event, ctx) => {
    publish = text => {
      if (ctx.mode === "json") {
        // Pipes use Pi's JSON mode, where ui.setStatus is a no-op. Emit the
        // same status envelope as RPC so the normal Pipe event bridge can
        // forward public attestation evidence without adding it to AI context.
        writeRawStdout(JSON.stringify({ type: "extension_ui_request", method: "setStatus", key: "screenpipe-confidential", text }) + "\n");
      } else {
        ctx.ui.setStatus("screenpipe-confidential", text);
      }
    };
    // Budget the same prompt the private provider actually sends. Trimming
    // only inside fetch left Pi reserving room for skills absent on the wire.
    if (ctx.model?.api === GLM_SECURE_API) {
      return { systemPrompt: compactGlmSkillCatalog(event.systemPrompt) };
    }
  });
  pi.on("tool_result", (event, ctx) => {
    if (ctx.model?.api !== GLM_SECURE_API) return;
    let changed = false;
    const content = event.content.map(item => {
      if (item.type !== "text") return item;
      const text = compactGlmToolResultText(item.text);
      changed ||= text !== item.text;
      return text === item.text ? item : { ...item, text };
    });
    // Store the existing provider-visible excerpt before Pi estimates history
    // or summarizes it. Keep images, errors and details; the marked excerpt
    // still directs the agent to reread a bounded range of the original file.
    if (changed) return { content, details: event.details, isError: event.isError };
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
