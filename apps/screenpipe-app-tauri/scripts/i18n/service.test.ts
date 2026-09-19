// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { translateMissing } from "./service.mjs";
import { writeJson } from "./prepare.mjs";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "screenpipe-gt-service-test-"));
  dirs.push(root);
  await writeJson(path.join(root, ".localization/source/en.metadata.json"), { title: { dataFormat: "JSX" }, toast: { dataFormat: "ICU", filePaths: ["components/example.tsx"] } });
  return { root, source: { title: "Settings", toast: "Hello {name}" }, native: { messages: {}, metadata: {} }, config: { defaultLocale: "en", locales: ["ja"] }, policy: "test-policy", cache: { translations: { ja: { title: "設定" } }, native: {} } };
}

test("unchanged source hashes make zero translation requests", async () => {
  const f = await fixture();
  f.cache.translations.ja.toast = "こんにちは、{name}さん";
  const calls: unknown[] = [];
  const result = await translateMissing({ ...f, request: async (...args: unknown[]) => { calls.push(args); throw new Error("Unexpected request"); } });
  expect(result.exitCode).toBe(0);
  expect(calls).toHaveLength(0);
});

test("only missing messages are sent, with file context, and provider corrections are downloaded without regeneration", async () => {
  const f = await fixture();
  const calls: string[] = [];
  let uploaded: any;
  let translated = "こんにちは、{name}さん";
  const request = async (endpoint: string, body: any) => {
    calls.push(endpoint);
    if (endpoint.endsWith("branches/create")) return { branch: { id: "branch" } };
    if (endpoint.endsWith("upload-files")) {
      uploaded = body.data[0].source;
      expect(JSON.parse(Buffer.from(uploaded.content, "base64").toString("utf8"))).toEqual({ toast: "Hello {name}" });
      expect(uploaded.formatMetadata.toast.context).toContain("components/example.tsx");
      expect(uploaded.formatMetadata.toast.context).toContain("polite desu/masu");
      return { uploadedFiles: [uploaded] };
    }
    if (endpoint === "/v2/translate") {
      expect(Object.keys(body.requests)).toEqual(["toast"]);
      expect(body.requests.toast.source).toBe("Hello {name}");
      expect(body.requests.toast.metadata.actionType).toBe("standard");
      expect(body.requests.toast.metadata.context).toContain("components/example.tsx");
      return { toast: { success: true, locale: "ja", dataFormat: "ICU", translation: translated } };
    }
    if (endpoint.endsWith("upload-translations")) {
      expect(JSON.parse(Buffer.from(body.data[0].translations[0].content, "base64").toString())).toEqual({ toast: translated });
      return {};
    }
    if (endpoint.endsWith("download")) return { files: [{ ...body[0], fileFormat: "GTJSON", data: Buffer.from(JSON.stringify({ toast: translated })).toString("base64") }] };
    throw new Error(endpoint);
  };
  const first = await translateMissing({ ...f, request });
  expect(first.exitCode).toBe(0);
  expect(first.output).toContain("1 missing messages");
  f.cache.translations.ja.toast = translated;
  calls.length = 0;
  translated = "{name}さん、こんにちは";
  const second = await translateMissing({ ...f, request });
  expect(second.exitCode).toBe(0);
  expect(calls).toEqual(["/v2/project/files/download"]);
  const downloaded = JSON.parse(await fs.readFile(path.join(f.root, ".localization/gt/ja.json"), "utf8"));
  expect(downloaded.toast).toBe(translated);
  expect(f.cache.translations.ja.title).toBe("設定");
});

test("mismatched translated locale is a fatal artifact error", async () => {
  const f = await fixture();
  const request = async (endpoint: string, body: any) => {
    if (endpoint.endsWith("branches/create")) return { branch: { id: "branch" } };
    if (endpoint.endsWith("upload-files")) return { uploadedFiles: [body.data[0].source] };
    if (endpoint === "/v2/translate") return { toast: { success: true, locale: "de", dataFormat: "ICU", translation: "Hallo {name}" } };
    throw new Error(endpoint);
  };
  const result = await translateMissing({ ...f, request });
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain("artifact integrity");
});


test("completed batches survive a service failure and resume without translating accepted wording again", async () => {
  const f = await fixture();
  f.source = Object.fromEntries(Array.from({length: 45}, (_, i) => [`message-${String(i).padStart(2, "0")}`, `Message ${i}`]));
  f.cache = { translations: { ja: {} }, native: {} };
  const persisted = new Map<string, any>();
  let batches = 0;
  const request = async (endpoint: string, body: any) => {
    if (endpoint.endsWith("branches/create")) return { branch: { id: "branch" } };
    if (endpoint.endsWith("upload-files")) return { uploadedFiles: [body.data[0].source] };
    if (endpoint === "/v2/translate") {
      if (++batches === 2) throw new Error("GT HTTP 503 service unavailable");
      return Object.fromEntries(Object.entries(body.requests).map(([id, item]: [string, any]) =>
        [id, { success: true, locale: "ja", dataFormat: "ICU", translation: `翻訳 ${item.source}` }]));
    }
    if (endpoint.endsWith("upload-translations")) {
      const file = body.data[0];
      persisted.set(file.source.fileId, {fileFormat: file.source.fileFormat, data: file.translations[0].content});
      return {};
    }
    if (endpoint.endsWith("download")) return { files: body.map((ref: any) => ({...ref, ...persisted.get(ref.fileId)})) };
    throw new Error(endpoint);
  };
  const first = await translateMissing({...f, request});
  expect(first.exitCode).toBe(1);
  expect(first.downloaded).toBe(true);
  const second = await translateMissing({...f, request});
  expect(second.exitCode).toBe(0);
  expect(second.output).toContain("5 missing messages");
  expect(batches).toBe(3);
});
