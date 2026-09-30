// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { appRoot, gtConfig, localizationMode, translationPolicy } from "./config.mjs";
import { validateCatalog } from "./validate.mjs";

export function digest(value) {
  return createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");
}
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export async function writeJson(file, value) {
  const text = canonical(value) + "\n";
  await fs.mkdir(path.dirname(file), { recursive: true });
  if (await fs.readFile(file, "utf8").catch(() => "") === text) return;
  const temp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(temp, text);
  await fs.rename(temp, file);
}
async function readJson(file, missing = {}) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return missing; throw error; }
}

export function verifySnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new Error("Localization snapshot integrity check failed: missing or invalid snapshot");
  const { revision, ...payload } = snapshot;
  if (snapshot.schemaVersion !== 1 || revision !== digest(payload)) throw new Error("Localization snapshot integrity check failed");
  return snapshot;
}

async function permissionDescriptions(root) {
  const plist = await fs.readFile(path.join(root, "src-tauri/Info.plist"), "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const entities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  return Object.fromEntries([...plist.matchAll(/<key>(NS[A-Za-z]+UsageDescription|CGRequestScreenCaptureAccess)<\/key>\s*<string>([\s\S]*?)<\/string>/g)].map(([, key, value]) => [key,
    value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity) => entity[0] === "#"
      ? String.fromCodePoint(entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1)))
      : entities[entity]),
  ]));
}

// macOS owns the language of its permission dialogs; bundle our explanations
// as InfoPlist.strings so they follow that OS language, including offline.
async function writeMacPermissionResources(root, snapshot) {
  const descriptions = await permissionDescriptions(root);
  const destination = path.join(root, ".localization/macos-resources");
  await fs.rm(destination, { recursive: true, force: true });
  for (const locale of [snapshot.defaultLocale, ...snapshot.locales]) {
    if (!/^[A-Za-z0-9-]+$/.test(locale)) throw new Error("Invalid localization resource locale");
    const directory = path.join(destination, `${locale}.lproj`);
    await fs.mkdir(directory, { recursive: true });
    const content = Object.entries(descriptions).map(([key, english]) => {
      const value = snapshot.native[locale]?.[digest(english).slice(0, 16)] ?? english;
      return `${JSON.stringify(key)} = ${JSON.stringify(value)};`;
    }).join("\n");
    await fs.writeFile(path.join(directory, "InfoPlist.strings"), content + "\n");
  }
}

export async function extractNative(root, policy = translationPolicy) {
  const messages = {}, metadata = {};
  // Deliberately extract only explicit English-source helpers, never arbitrary
  // Rust/Swift strings (logs, prompts and user content must not leave the app).
  const glob = new Bun.Glob("src-tauri/{src,swift}/**/*.{rs,swift}");
  for await (const file of glob.scan({ cwd: root })) {
    if (/(?:_tests?|_preview|_render)\./.test(file)) continue;
    const raw = await fs.readFile(path.join(root, file), "utf8");
    const code = raw.replace(/"(?:[^"\\]|\\.)*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (token) => token.startsWith('"') ? token : " ");
    for (const match of code.matchAll(/\b(?:ui_text|ui_format|ui_menu|source_text|uiText)\(\s*("(?:[^"\\]|\\.)*")/g)) {
      const english = JSON.parse(match[1]);
      const id = digest(english).slice(0, 16);
      if (messages[id] && messages[id] !== english) throw new Error("Native localization hash collision");
      messages[id] = english;
      metadata[id] = { context: `Native desktop interface: ${file}` };
    }
  }
  for (const [key, english] of Object.entries(await permissionDescriptions(root))) {
    const id = digest(english).slice(0, 16);
    if (messages[id] && messages[id] !== english) throw new Error("Native localization hash collision");
    messages[id] = english;
    metadata[id] = { context: `macOS permission explanation: src-tauri/Info.plist ${key}` };
  }
  return { messages, metadata };
}

export function redactGTOutput(output, env = process.env) {
  for (const value of [env.GT_API_KEY, env.GT_PROJECT_ID]) {
    if (value) output = output.replaceAll(value, "[REDACTED]");
  }
  return output;
}

export function translationServiceFailure(result) {
  if (result.timedOut || /\btimed out\b|translation.*timeout exceeded/i.test(result.output ?? "")) return "service_timeout";
  const output = result.output ?? "";
  if (/credit balance is insufficient|insufficient (?:usage )?credits/i.test(output)) return "insufficient_translation_credits";
  if (/\b(?:401|402|403|408|429|5\d\d|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)\b|fetch failed|network error|request timed out|invalid api key|unauthorized|rate limit/i.test(output)) return "translation_service_failed";
  return null;
}

async function runGT(args, root, job) {
  if (args[0] === "translate") {
    const { translateMissing } = await import("./service.mjs");
    const result = await translateMissing({ root, ...job });
    result.output = redactGTOutput(result.output);
    await writeJson(path.join(root, ".localization/gt-translate-result.json"), result);
    console.log(`[i18n] ${result.output}`);
    return result;
  }
  const child = Bun.spawn(["bun", path.join(appRoot, "scripts/i18n/collect.mjs"), args[args.indexOf("--config") + 1]], {
    cwd: root, env: { ...process.env, NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 930_000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const result = { exitCode, timedOut, output: redactGTOutput(stdout + stderr) };
    await writeJson(path.join(root, ".localization", `gt-${args[0]}-result.json`), result);
    return result;
  } finally { clearTimeout(timer); }
}

function coverage(result) { return { total: result.total, translated: result.translated, fallback: result.total - result.translated }; }

export async function prepareLocalization({ root = appRoot, mode = localizationMode(), config = gtConfig, run = runGT } = {}) {
  const output = path.join(root, "lib/i18n/generated.json");
  const policy = digest(translationPolicy);
  const base = { schemaVersion: 1, mode, defaultLocale: config.defaultLocale, locales: mode === "off" ? [] : config.locales, policy, translations: {}, native: {}, coverage: {}, fallbacks: {}, causes: [] };
  if (mode === "off") {
    const snapshot = { ...base, revision: digest(base) };
    await writeJson(output, snapshot);
    await writeMacPermissionResources(root, snapshot);
    return snapshot;
  }

  const dir = path.join(root, ".localization");
  const native = await extractNative(root);
  await writeJson(path.join(dir, "native", `${config.defaultLocale}.json`), native.messages);
  await writeJson(path.join(dir, "native", `${config.defaultLocale}.metadata.json`), native.metadata);
  // `gt generate` fills target locales with English. Use a separate config with
  // no targets and a separate output so it cannot overwrite real translations.
  const sourceConfig = { ...config, locales: [], files: { gt: { ...config.files.gt, output: ".localization/source/[locale].json" } } };
  const sourceConfigPath = path.join(dir, "source.config.json");
  await writeJson(sourceConfigPath, sourceConfig);
  const extracted = await run(["generate", "--config", sourceConfigPath, "--omit-config-ids"], root);
  if (extracted.exitCode !== 0) throw new Error(`Localization source extraction failed:\n${extracted.output}`);
  const source = await readJson(path.join(dir, "source", `${config.defaultLocale}.json`));
  const sourceIdentity = digest({ source, native: native.messages, policy });
  const previous = await readJson(path.join(dir, "snapshot.json"), null);
  if (previous) verifySnapshot(previous);
  if (process.env.SCREENPIPE_I18N_SNAPSHOT) {
    if (mode !== "cached") throw new Error("A supplied release snapshot requires cached localization mode");
    const supplied = verifySnapshot(await readJson(process.env.SCREENPIPE_I18N_SNAPSHOT, null));
    if (supplied.sourceIdentity !== sourceIdentity || supplied.policy !== policy || supplied.defaultLocale !== config.defaultLocale || canonical(supplied.locales) !== canonical(config.locales)) {
      throw new Error("Localization snapshot does not match this source/configuration/policy");
    }
    await writeJson(output, supplied);
    await writeMacPermissionResources(root, supplied);
    return supplied;
  }
  const cacheMatches = previous?.policy === policy;
  const cache = cacheMatches ? previous : null;
  // Packaging an existing snapshot must retain its originating service cause;
  // an offline build has no new provider result that could clear that evidence.
  if (mode === "cached") base.causes = [...(cache?.causes ?? [])];

  if (mode === "generate") {
    if (!process.env.GT_API_KEY || !process.env.GT_PROJECT_ID) base.causes.push("missing_credentials");
    else {
      // Keep provider corrections and unchanged message hashes. A policy change
      // deliberately starts a new translation branch instead of reusing wording
      // approved under a different terminology/style policy.
      const result = await run(["translate"], root, { source, native, config, policy, cache });
      const serviceFailure = translationServiceFailure(result);
      if (result.downloaded) base.causes.push("generated");
      if (result.exitCode !== 0) {
        // Only service availability/authentication failures are soft. A compiler,
        // filesystem or unrecognized CLI failure must not silently ship stale UI.
        if (serviceFailure) base.causes.push(serviceFailure);
        else throw new Error(`Localization generation failed:\n${redactGTOutput(result.output ?? "")}`);
      }
      else {
        // GT can exit successfully after its polling deadline and download only
        // completed files. Keep those results and report the unfinished job.
        base.causes.push("generated");
        if (serviceFailure === "service_timeout") base.causes.push(serviceFailure);
      }
    }
  }
  const downloaded = base.causes.includes("generated");
  base.causes = base.causes.filter((cause) => cause !== "generated");
  for (const locale of config.locales) {
    const gt = downloaded ? await readJson(path.join(dir, "gt", `${locale}.json`)) : {};
    const nativeGt = downloaded ? await readJson(path.join(dir, "native", `${locale}.json`)) : {};
    const validDownload = validateCatalog(source, gt, config.defaultLocale, locale);
    const validNativeDownload = validateCatalog(native.messages, nativeGt, config.defaultLocale, locale);
    const frontend = validateCatalog(source, { ...cache?.translations?.[locale], ...validDownload.valid }, config.defaultLocale, locale);
    const nativeResult = validateCatalog(native.messages, { ...cache?.native?.[locale], ...validNativeDownload.valid }, config.defaultLocale, locale);
    // Rejected entries are deliberately absent from the valid cache. Keep their
    // technical cause while that same source hash still falls back after a
    // restart/offline rebuild, instead of degrading it to "missing".
    for (const [id, cause] of Object.entries(cache?.fallbacks?.[locale] ?? {})) {
      if (frontend.fallbacks[id]) frontend.fallbacks[id] = cause;
      if (nativeResult.fallbacks[id]) nativeResult.fallbacks[id] = cause;
    }
    // Preserve the originating validation failure instead of reporting a rejected
    // translation merely as missing. Cached valid corrections remain usable.
    if (downloaded) {
      for (const [id, cause] of Object.entries({ ...validDownload.fallbacks, ...validNativeDownload.fallbacks })) {
        if (cause !== "missing_translation") {
          if (frontend.fallbacks[id]) frontend.fallbacks[id] = cause;
          if (nativeResult.fallbacks[id]) nativeResult.fallbacks[id] = cause;
        }
      }
    }
    base.translations[locale] = frontend.valid;
    base.native[locale] = nativeResult.valid;
    base.coverage[locale] = { frontend: coverage(frontend), native: coverage(nativeResult) };
    base.fallbacks[locale] = { ...frontend.fallbacks, ...nativeResult.fallbacks };
  }
  const payload = { ...base, sourceIdentity };
  const snapshot = { ...payload, revision: digest(payload) };
  await writeJson(path.join(dir, "snapshot.json"), snapshot);
  await writeJson(output, snapshot);
  await writeMacPermissionResources(root, snapshot);
  await writeJson(path.join(dir, "coverage.json"), { revision: snapshot.revision, coverage: base.coverage, causes: base.causes, fallbacks: base.fallbacks });
  for (const [locale, stats] of Object.entries(base.coverage)) {
    console.log(`[i18n] ${locale}: frontend ${stats.frontend.translated}/${stats.frontend.total}; native ${stats.native.translated}/${stats.native.total}`);
    if (stats.frontend.fallback || stats.native.fallback) console.warn(`::warning::Localization ${locale} has English fallbacks; see localization coverage artifact.`);
  }
  for (const cause of base.causes) console.warn(`::warning::Localization ${cause}; packaging cached translations and English fallbacks.`);
  return snapshot;
}

if (import.meta.main) await prepareLocalization();
