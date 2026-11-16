// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const evidence = import.meta.dir;
const live = JSON.parse(readFileSync(join(evidence, "digital-clone-v7-live.json"), "utf8")).data;
const out = join(evidence, "digital-clone-store-proposal");
mkdirSync(out, { recursive: true });

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
if (sha256(live.source_md) !== "3ae629da4bab55336fe2586a1a157011445fe85841d6202c95db02da6db4deb9") {
  throw new Error("live Digital Clone v7 source changed; review before rebuilding");
}

const startMarker = "<!-- BUN_RUNTIME -->\n```javascript\n";
const endMarker = "\n```\n<!-- END_BUN_RUNTIME -->";
const start = live.source_md.lastIndexOf(startMarker);
const end = live.source_md.lastIndexOf(endMarker);
if (start < 0 || end <= start) throw new Error("embedded runtime markers missing");
const runtime = live.source_md.slice(start + startMarker.length, end) + "\n";

let proposedRuntime = runtime
  .replace("Bun.spawn({cmd:", "Bun.spawn({windowsHide:!0,cmd:")
  .replace("detached:!0,stdio:", "windowsHide:!0,detached:process.platform===\"win32\",stdio:");
if (proposedRuntime === runtime) throw new Error("runtime patch did not apply");
if ((proposedRuntime.match(/windowsHide:!0/g) ?? []).length !== 2) {
  throw new Error("both Bun.spawn and child_process.spawn must hide Windows consoles");
}
if (proposedRuntime.includes("detached:!0")) throw new Error("unconditional detachment remains");

const description = "screenpipe-cloud sends screen content and local AI chat logs to Screenpipe's cloud model.";
const runtimeSha = sha256(proposedRuntime);
const prompt = live.source_md
  .replace(`description: ${live.description}`, `description: ${description}`)
  .replace(
    "Bun only; no installs or remote code downloads.",
    "No installs or remote code downloads.",
  );
const compactPrompt = prompt.replace(
  "Save the bootstrap as `bootstrap.ts`; run `bun run bootstrap.ts`.",
  "Save as `bootstrap.ts`; run it.",
).replace("Launch is not completion. ", "");
const promptStart = compactPrompt.lastIndexOf(startMarker);
const promptEnd = compactPrompt.lastIndexOf(endMarker);
let source = compactPrompt.slice(0, promptStart + startMarker.length)
  + proposedRuntime.trimEnd()
  + compactPrompt.slice(promptEnd);
source = source.replace(
  /digest\("hex"\)!=="[0-9a-f]{64}"/,
  `digest("hex")!=="${runtimeSha}"`,
);

let readme = live.readme_md.replace(
  "The wiki, source ledger, backups and optional Obsidian export remain local. **Identity classification sends selected capture excerpts through Screenpipe's AI endpoint.** The model defaults to `auto`; set `discovery_model` to a model supported by your Screenpipe setup if needed. Review your AI provider and data-sharing settings before enabling the Pipe. Local storage does not mean inference is necessarily on-device.",
  "The wiki, source ledger, backups and optional Obsidian export remain local. Inference is not necessarily local: with the `screenpipe-cloud` preset, selected screen content and relevant excerpts from local Claude Code, Codex, and Hermes chat logs are sent to Screenpipe's cloud model. Other configured presets send that selected context to the provider named in the preset; review its data-sharing settings before enabling the Pipe. The model defaults to `auto`; set `discovery_model` to a model supported by your Screenpipe setup if needed.",
);
if (readme === live.readme_md) throw new Error("README disclosure patch did not apply");

const payload = {
  slug: live.slug,
  title: live.title,
  description,
  icon: live.icon,
  category: live.category,
  source_md: source,
  readme_md: readme,
};
const expectedFields = ["category", "description", "icon", "readme_md", "slug", "source_md", "title"];
if (Object.keys(payload).sort().join() !== expectedFields.join()) throw new Error("invalid payload fields");
if (Buffer.byteLength(source) > 65_536) throw new Error(`source exceeds store boundary: ${Buffer.byteLength(source)}`);
if (!source.includes(`digest("hex")!=="${runtimeSha}"`)) throw new Error("bootstrap hash not updated");

writeFileSync(join(out, "source-v7.md"), live.source_md);
writeFileSync(join(out, "runtime-v7.js"), runtime);
writeFileSync(join(out, "runtime-proposed.js"), proposedRuntime);
writeFileSync(join(out, "source-proposed.md"), source);
writeFileSync(join(out, "readme-proposed.md"), readme);
writeFileSync(join(out, "submission-payload.json"), JSON.stringify(payload, null, 2) + "\n");
console.log(JSON.stringify({
  source_v7_sha256: sha256(live.source_md),
  runtime_v7_sha256: sha256(runtime),
  runtime_proposed_sha256: runtimeSha,
  source_proposed_sha256: sha256(source),
  source_proposed_bytes: Buffer.byteLength(source),
  payload_sha256: sha256(JSON.stringify(payload)),
}, null, 2));
