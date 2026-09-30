// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareLocalization, writeJson, digest, extractNative, redactGTOutput } from "./prepare.mjs";
import { localizationMode } from "./config.mjs";
import { validateCatalog } from "./validate.mjs";
import { resolveLocale } from "../../lib/i18n/locale";

const dirs: string[] = [];
const credentials = { key: process.env.GT_API_KEY, project: process.env.GT_PROJECT_ID };
const originalSnapshot = process.env.SCREENPIPE_I18N_SNAPSHOT;
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
  for (const [key, value] of Object.entries({ GT_API_KEY: credentials.key, GT_PROJECT_ID: credentials.project })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  if (originalSnapshot === undefined) delete process.env.SCREENPIPE_I18N_SNAPSHOT;
  else process.env.SCREENPIPE_I18N_SNAPSHOT = originalSnapshot;
});

const config = { defaultLocale: "en", locales: ["ja"], src: ["app/**/*.tsx"], files: { gt: { output: ".localization/gt/[locale].json" } } };
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "screenpipe-i18n-test-"));
  dirs.push(root);
  const source = { title: "Settings", toast: "Hello {name}", changed: "Old text" };
  await writeJson(path.join(root, "gt.config.json"), config);
  let calls: string[] = [];
  const run = async (args: string[]) => {
    calls.push(args[0]);
    if (args[0] === "generate") await writeJson(path.join(root, ".localization/source/en.json"), source);
    else await writeJson(path.join(root, ".localization/gt/ja.json"), { title: "設定", toast: "こんにちは、{name}さん", changed: "以前のテキスト" });
    return { exitCode: 0, timedOut: false, output: "" };
  };
  return { root, source, calls, run };
}

test("off is the default and never invokes GT even with credentials", async () => {
  const { root, run, calls } = await fixture();
  process.env.GT_API_KEY = "test-only"; process.env.GT_PROJECT_ID = "test-only";
  expect(localizationMode(undefined)).toBe("off");
  expect(() => localizationMode("enabled")).toThrow();
  const result = await prepareLocalization({ root, config, mode: "off", run });
  expect(calls).toEqual([]);
  expect(result.locales).toEqual([]);
});

test("cached invokes only offline extraction and preserves valid translations", async () => {
  const f = await fixture();
  process.env.GT_API_KEY = "test-only"; process.env.GT_PROJECT_ID = "test-only";
  await prepareLocalization({ ...f, config, mode: "generate" });
  f.calls.length = 0;
  const result = await prepareLocalization({ ...f, config, mode: "cached" });
  expect(f.calls).toEqual(["generate"]);
  expect(result.translations.ja.toast).toBe("こんにちは、{name}さん");
  expect(result.coverage.ja.frontend.translated).toBe(3);
});

test("permission descriptions produce locale resources and off removes stale languages", async () => {
  const f = await fixture();
  const source = "Record audio & screen";
  const id = digest(source).slice(0, 16);
  await fs.mkdir(path.join(f.root, "src-tauri"), { recursive: true });
  await fs.writeFile(path.join(f.root, "src-tauri/Info.plist"), `<plist><dict>
    <key>NSMicrophoneUsageDescription</key><string>Record audio &amp; screen</string>
    <key>PrivateIdentifier</key><string>never extract this</string>
  </dict></plist>`);
  expect((await extractNative(f.root)).messages).toEqual({ [id]: source });
  process.env.GT_API_KEY = "test-only";
  process.env.GT_PROJECT_ID = "test-only";
  const run = async (args: string[]) => {
    const result = await f.run(args);
    if (args[0] === "translate") await writeJson(path.join(f.root, ".localization/native/ja.json"), { [id]: "音声と画面を記録" });
    return result;
  };
  const snapshot = await prepareLocalization({ ...f, config, mode: "generate", run });
  expect(snapshot.coverage.ja.native).toEqual({ total: 1, translated: 1, fallback: 0 });
  const resources = path.join(f.root, ".localization/macos-resources");
  expect(await fs.readFile(path.join(resources, "ja.lproj/InfoPlist.strings"), "utf8")).toContain('"NSMicrophoneUsageDescription" = "音声と画面を記録";');
  await prepareLocalization({ ...f, config: { ...config, locales: ["ja", "de"] }, mode: "cached", run });
  expect(await fs.readFile(path.join(resources, "de.lproj/InfoPlist.strings"), "utf8")).toContain(source);
  f.calls.length = 0;
  await prepareLocalization({ ...f, config, mode: "off", run });
  expect(f.calls).toEqual([]);
  expect(await fs.readdir(resources)).toEqual(["en.lproj"]);
});

test("missing credentials and timeout retain valid Japanese with diagnosable causes", async () => {
  const f = await fixture();
  process.env.GT_API_KEY = "test-only"; process.env.GT_PROJECT_ID = "test-only";
  await prepareLocalization({ ...f, config, mode: "generate" });
  delete process.env.GT_API_KEY;
  f.calls.length = 0;
  const missing = await prepareLocalization({ ...f, config, mode: "generate" });
  expect(f.calls).toEqual(["generate"]);
  expect(missing.causes).toContain("missing_credentials");
  expect(missing.translations.ja.title).toBe("設定");
  process.env.GT_API_KEY = "test-only";
  const timeout = await prepareLocalization({ ...f, config, mode: "generate", run: async (args: string[]) => args[0] === "generate" ? f.run(args) : { exitCode: 1, timedOut: true, output: "" } });
  expect(timeout.causes).toContain("service_timeout");
  expect(timeout.translations.ja.title).toBe("設定");
});

test("new source hashes remove only stale translations", async () => {
  const f = await fixture();
  process.env.GT_API_KEY = "test-only"; process.env.GT_PROJECT_ID = "test-only";
  await prepareLocalization({ ...f, config, mode: "generate" });
  delete (f.source as any).changed;
  (f.source as any).newHash = "New text";
  const result = await prepareLocalization({ ...f, config, mode: "cached" });
  expect(result.translations.ja.title).toBe("設定");
  expect(result.translations.ja.changed).toBeUndefined();
  expect(result.fallbacks.ja.newHash).toBe("missing_translation");
});

test("GT billing rejection preserves cached translations and records the provider cause", async () => {
  const f = await fixture();
  process.env.GT_API_KEY = "test-only"; process.env.GT_PROJECT_ID = "test-project-only";
  await prepareLocalization({ ...f, config, mode: "generate" });
  const rejected = await prepareLocalization({ ...f, config, mode: "generate", run: async (args: string[]) => args[0] === "generate" ? f.run(args) : {
    exitCode: 1, timedOut: false,
    output: "ApiError: Your account's credit balance is insufficient to complete this request. Please add more usage credits to your account or configure auto-reload to reload your balance.",
  } });
  expect(rejected.causes).toContain("insufficient_translation_credits");
  expect(rejected.translations.ja.toast).toBe("こんにちは、{name}さん");
  expect(rejected.coverage.ja.frontend.translated).toBe(3);
});

test("GT command diagnostics redact credentials while preserving the technical error", () => {
  const env = { GT_API_KEY: "test-api-key-value", GT_PROJECT_ID: "test-project-value" };
  const output = redactGTOutput(`Project ID: ${env.GT_PROJECT_ID}; authorization ${env.GT_API_KEY}; error ENOSPC`, env);
  expect(output).not.toContain(env.GT_API_KEY);
  expect(output).not.toContain(env.GT_PROJECT_ID);
  expect(output).toContain("ENOSPC");
});

test("offline rebuild preserves the originating rejected-message and provider causes", async () => {
  const f = await fixture();
  process.env.GT_API_KEY = "test-only"; process.env.GT_PROJECT_ID = "test-only";
  const failed = await prepareLocalization({ ...f, config, mode: "generate", run: async (args: string[]) => {
    if (args[0] === "generate") return f.run(args);
    await writeJson(path.join(f.root, ".localization/gt/ja.json"), { title: "設定", toast: "こんにちは、{wrongName}さん" });
    return { exitCode: 0, timedOut: false, output: "Timed out, but 1 translation(s) completed successfully." };
  } });
  expect(failed.fallbacks.ja.toast).toBe("invalid_placeholders");
  const restarted = await prepareLocalization({ ...f, config, mode: "cached" });
  expect(restarted.causes).toContain("service_timeout");
  expect(restarted.fallbacks.ja.toast).toBe("invalid_placeholders");
  expect(restarted.translations.ja.title).toBe("設定");
  const recovered = await prepareLocalization({ ...f, config, mode: "generate" });
  expect(recovered.causes).toEqual([]);
  expect(recovered.fallbacks.ja.toast).toBeUndefined();
});

test("GT partial polling timeout reports its cause even with a successful exit", async () => {
  const f = await fixture();
  process.env.GT_API_KEY = "test-only"; process.env.GT_PROJECT_ID = "test-only";
  const result = await prepareLocalization({ ...f, config, mode: "generate", run: async (args: string[]) => {
    const completed = await f.run(args);
    return args[0] === "translate" ? { ...completed, output: "Timed out, but 1 translation(s) completed successfully. Downloading completed files..." } : completed;
  } });
  expect(result.causes).toContain("service_timeout");
  expect(result.translations.ja.title).toBe("設定");
});

test("service unavailability is soft but filesystem and compiler failures are fatal", async () => {
  const f = await fixture();
  process.env.GT_API_KEY = "test-only"; process.env.GT_PROJECT_ID = "test-only";
  const fail = (output: string) => async (args: string[]) => args[0] === "generate" ? f.run(args) : { exitCode: 1, timedOut: false, output };
  const unavailable = await prepareLocalization({ ...f, config, mode: "generate", run: fail("HTTP 503 Service Unavailable") });
  expect(unavailable.causes).toContain("translation_service_failed");
  for (const cause of ["ENOSPC: write failed", "SyntaxError: invalid component", "Unexpected CLI failure"]) {
    await expect(prepareLocalization({ ...f, config, mode: "generate", run: fail(cause) })).rejects.toThrow("generation failed");
  }
});

test("invalid placeholders, rich structure and plurals use English fallbacks", () => {
  const source = { toast: "Hello {name}", rich: ["Open ", { t: "a", i: 1, c: "Settings" }], plural: "{count, plural, one {# file} other {# files}}", missing: "Missing" };
  const result = validateCatalog(source, { toast: "Bonjour {password}", rich: ["Ouvrir ", { t: "script", i: 1, c: "Réglages" }], plural: "{count, plural, one {# fichier}}" }, "en", "fr");
  expect(result.translated).toBe(0);
  expect(result.fallbacks.toast).toBe("invalid_placeholders");
  expect(result.fallbacks.missing).toBe("missing_translation");
  const good = validateCatalog(source, { toast: "Bonjour {name}", rich: [{ t: "a", i: 1, c: "Réglages" }, " : ouvrir"], plural: "{count, plural, one {# fichier} many {# fichiers} other {# fichiers}}" }, "en", "fr");
  expect(good.translated).toBe(3);
  const attributeSource = { input: { t: "input", i: 1, d: { arl: "Your name", arb: "name-label" } } };
  expect(validateCatalog(attributeSource, { input: { t: "input", i: 1, d: { arl: "Votre nom", arb: "name-label" } } }, "en", "fr").translated).toBe(1);
  expect(validateCatalog(attributeSource, { input: { t: "input", i: 1, d: { arl: "Votre nom", arb: "nom" } } }, "en", "fr").translated).toBe(0);
});

test("adding a locale uses only configuration and yields stable offline snapshots", async () => {
  const f = await fixture();
  const expanded = { ...config, locales: [...config.locales, "de"] };
  const one = await prepareLocalization({ ...f, config: expanded, mode: "cached" });
  const two = await prepareLocalization({ ...f, config: expanded, mode: "cached" });
  expect(one.locales).toEqual(["ja", "de"]);
  expect(one.coverage.de.frontend.total).toBe(3);
  expect(one.revision).toBe(two.revision);
  expect(digest({ b: 2, a: 1 })).toBe(digest({ a: 1, b: 2 }));
});

test("Japanese plurals accept other without English categories and preserve exact counts", () => {
  const source = { files: "{count, plural, =0 {No files} one {# file} other {# files}}" };
  const valid = validateCatalog(source, { files: "{count, plural, =0 {ファイルはありません} other {# 件のファイル}}" }, "en", "ja");
  expect(valid.translated).toBe(1);
  const englishCategory = validateCatalog(source, { files: "{count, plural, =0 {ファイルはありません} one {# 件のファイル} other {# 件のファイル}}" }, "en", "ja");
  expect(englishCategory.translated).toBe(1);
  expect(englishCategory.valid.files).not.toMatch(/one\s*\{/);
  expect(englishCategory.valid.files).toMatch(/=0\s*\{/);
  const missingExactCount = validateCatalog(source, { files: "{count, plural, other {# 件のファイル}}" }, "en", "ja");
  expect(missingExactCount.fallbacks.files).toBe("invalid_placeholders");
});

test("literal command examples are not interpreted as unclosed rich-text tags", () => {
  const result = validateCatalog(
    { hint: 'No models found. Run "ollama pull <model>" to get started.' },
    { hint: "モデルが見つかりません。開始するには「ollama pull <model>」を実行してください。" },
    "en", "ja",
  );
  expect(result.translated).toBe(1);
});

test("system locale uses exact, then base, then English without changing explicit choice", () => {
  const available = ["en", "ja", "ja-JP"];
  expect(resolveLocale("system", ["ja-JP"], available, "en")).toBe("ja-JP");
  expect(resolveLocale("system", ["ja_JP"], ["en", "ja"], "en")).toBe("ja");
  expect(resolveLocale("en", ["ja-JP"], available, "en")).toBe("en");
  expect(resolveLocale("fr", ["ja-JP"], available, "en")).toBe("en");
});

test("native extraction includes only explicit English helpers, with policy and file context", async () => {
  const { root } = await fixture();
  await fs.mkdir(path.join(root, "src-tauri/src"), { recursive: true });
  await fs.writeFile(path.join(root, "src-tauri/src/menu.rs"), `
    let label = ui_text("Open screenpipe");
    tracing::info!("Diagnostic log");
    let prompt = "Executable prompt";
    // ui_text("Old commented message")
    /* ui_text("Another retired message") */
  `);
  const native = await extractNative(root);
  expect(Object.values(native.messages)).toEqual(["Open screenpipe"]);
  expect(native.metadata[digest("Open screenpipe").slice(0, 16)].context).toContain("src-tauri/src/menu.rs");
});

test("a shared snapshot is byte-identical across consumers and rejects changed source or corruption", async () => {
  const f = await fixture();
  const snapshot = await prepareLocalization({ ...f, config, mode: "cached" });
  const suppliedPath = path.join(f.root, "release-snapshot.json");
  await writeJson(suppliedPath, snapshot);
  process.env.SCREENPIPE_I18N_SNAPSHOT = suppliedPath;
  const reused = await prepareLocalization({ ...f, config, mode: "cached" });
  expect(reused).toEqual(snapshot);
  await expect(prepareLocalization({ ...f, config: { ...config, locales: ["fr"] }, mode: "cached" })).rejects.toThrow("does not match");
  (f.source as any).newMessage = "New message";
  await expect(prepareLocalization({ ...f, config, mode: "cached" })).rejects.toThrow("does not match");
  delete (f.source as any).newMessage;
  await writeJson(suppliedPath, { ...snapshot, revision: "corrupt" });
  await expect(prepareLocalization({ ...f, config, mode: "cached" })).rejects.toThrow("integrity");
});
