// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import fs from "node:fs/promises";
import path from "node:path";
import { digest, writeJson } from "./prepare.mjs";
import { validateCatalog } from "./validate.mjs";
import { translationPolicy } from "./config.mjs";

// GT's CLI versions the entire React catalog as one file. Sending that file
// again when one label changes can retranslate unchanged messages. Immutable
// batches contain only missing source hashes and preserve accepted corrections.
export function missingMessages(source, cached, sourceLocale, locale) {
  const { valid } = validateCatalog(source, cached ?? {}, sourceLocale, locale);
  return Object.fromEntries(Object.entries(source).filter(([id]) => !(id in valid)));
}

export async function requestGT(endpoint, body) {
  const response = await fetch(`https://api.gtx.dev${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.GT_API_KEY}`, "gt-project-id": process.env.GT_PROJECT_ID, "gt-api-version": "2026-03-06.v1" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GT ${endpoint} HTTP ${response.status}: ${await response.text()}`);
  return response.json();
}

export async function translateMissing({ root, source, native, config, policy, cache, request = requestGT, wait = (ms) => Bun.sleep(ms), timeoutMs = 900_000 }) {
  const dir = path.join(root, ".localization");
  const frontendMetadata = JSON.parse(await fs.readFile(path.join(dir, "source", `${config.defaultLocale}.metadata.json`), "utf8"));
  const manifestPath = path.join(dir, "translation-jobs.json");
  const manifest = await fs.readFile(manifestPath, "utf8").then(JSON.parse).catch((error) => {
    if (error.code === "ENOENT") return { policy, batches: [] };
    throw error;
  });
  const known = manifest.policy === policy ? manifest.batches : [];
  const current = structuredClone(cache ?? { translations: {}, native: {} });
  const downloads = { gt: {}, native: {} };
  let downloaded = false;
  try {
    // A fresh CI checkout can recover the provider's existing policy branch
    // even if its Actions cache was evicted. Never retranslate the whole app just
    // because the local generated artifacts disappeared.
    if (!cache && !known.length) {
      const branchName = `desktop-${policy.slice(0, 12)}`;
      const { branches } = await request("/v2/project/branches/info", { branchNames: [branchName] });
      const branch = branches?.find((entry) => entry.name === branchName);
      if (branch) {
        const { orphanedFiles } = await request("/v2/project/files/orphaned", { branchId: branch.id, fileIds: [] });
        if (!Array.isArray(orphanedFiles)) throw new Error("Localization artifact integrity: invalid source catalog response");
        for (const file of orphanedFiles) {
          const kind = file.fileName === "__INTERNAL_GT_TEMPLATE_NAME__" || file.fileName.startsWith("desktop/gt/") ? "gt"
            : file.fileName === `.localization/native/${config.defaultLocale}.json` || file.fileName.startsWith("desktop/native/") ? "native" : null;
          if (!kind) continue;
          for (const locale of config.locales) known.push({ kind, ref: { branchId: branch.id, fileId: file.fileId, versionId: file.versionId, locale }, messageIds: Object.keys(kind === "gt" ? source : native.messages) });
        }
      }
    }
    // Refresh provider corrections without enqueueing a translation. Immutable
    // source references prevent an old/policy-mismatched result being imported.
    const relevant = known.filter(({ kind, ref, messageIds }) => config.locales.includes(ref.locale) && messageIds.some((id) => id in (kind === "gt" ? source : native.messages)));
    for (let offset = 0; offset < relevant.length; offset += 100) {
      const requested = relevant.slice(offset, offset + 100);
      const { files } = await request("/v2/project/files/download", requested.map(({ ref }) => ref));
      if (!Array.isArray(files)) throw new Error("Localization artifact integrity: invalid correction response");
      for (const file of files) {
        const batch = requested.find(({ ref }) => ref.fileId === file.fileId && ref.versionId === file.versionId && ref.branchId === file.branchId && ref.locale === file.locale);
        if (!batch || file.fileFormat !== (batch.kind === "gt" ? "GTJSON" : "JSON")) throw new Error("Localization artifact integrity: correction source identity mismatch");
        const content = JSON.parse(Buffer.from(file.data, "base64").toString("utf8"));
        const messages = batch.kind === "gt" ? source : native.messages;
        const valid = validateCatalog(messages, content, config.defaultLocale, file.locale).valid;
        const target = batch.kind === "gt" ? current.translations : current.native;
        target[file.locale] = { ...target[file.locale], ...valid };
        downloads[batch.kind][file.locale] = { ...downloads[batch.kind][file.locale], ...content };
        await writeJson(path.join(dir, batch.kind, `${file.locale}.json`), downloads[batch.kind][file.locale]);
        downloaded = true;
      }
    }
    const batches = [];
    for (const locale of config.locales) {
      for (const [kind, messages, cached, metadata] of [
        ["gt", source, current.translations?.[locale], frontendMetadata],
        ["native", native.messages, current.native?.[locale], native.metadata],
      ]) {
        // Never leave an old loose download available as this run's result.
        await writeJson(path.join(dir, kind, `${locale}.json`), downloads[kind][locale] ?? {});
        const missing = missingMessages(messages, cached, config.defaultLocale, locale);
        const ids = Object.keys(missing).sort();
        if (!ids.length) continue;
        const identity = digest({ policy, kind, locale, missing });
        const fileId = identity;
        const formatMetadata = Object.fromEntries(ids.map((id) => [id, {
          ...metadata[id],
          context: `${translationPolicy.context}\n${metadata[id]?.context ?? ""}\n${(metadata[id]?.filePaths ?? []).join(", ")}`,
        }]));
        batches.push({ kind, locale, missing, source: {
          fileId, versionId: identity, fileName: `desktop/${kind}/${identity}.json`,
          fileFormat: kind === "gt" ? "GTJSON" : "JSON", locale: config.defaultLocale,
          content: JSON.stringify(missing),
          formatMetadata: kind === "gt" ? formatMetadata : { keyedMetadata: formatMetadata },
        } });
      }
    }
    if (!batches.length) {
      await writeJson(manifestPath, { policy, batches: known });
      return { exitCode: 0, timedOut: false, downloaded, output: "All source hashes already translated; zero translation requests." };
    }
    const { branch } = await request("/v2/project/branches/create", { branchName: `desktop-${policy.slice(0, 12)}` });
    if (!branch?.id) throw new Error("Localization artifact integrity: invalid branch response");
    const pending = [];
    for (const batch of batches) {
      const { uploadedFiles } = await request("/v2/project/files/upload-files", {
        sourceLocale: config.defaultLocale, data: [{ source: { ...batch.source, content: Buffer.from(batch.source.content).toString("base64"), branchId: branch.id } }],
      });
      const uploaded = uploadedFiles?.find((file) => file.fileId === batch.source.fileId && file.versionId === batch.source.versionId && file.branchId === branch.id);
      if (!uploaded) throw new Error("Localization artifact integrity: uploaded source identity mismatch");
      const ref = { fileId: uploaded.fileId, versionId: uploaded.versionId, branchId: branch.id, locale: batch.locale };
      await request("/v2/project/translations/enqueue", { files: [ref], sourceLocale: config.defaultLocale, targetLocales: [batch.locale], force: false, publish: false });
      pending.push({ ...batch, ref });
    }
    const newRefs = pending.map(({ kind, ref, missing }) => ({ kind, ref, messageIds: Object.keys(missing) }));
    const refs = new Map([...known, ...newRefs].map((batch) => [`${batch.ref.fileId}:${batch.ref.locale}`, batch]));
    await writeJson(manifestPath, { policy, batches: [...refs.values()] });
    const deadline = Date.now() + timeoutMs;
    while (pending.length) {
      const { files } = await request("/v2/project/files/download", pending.map(({ ref }) => ref));
      if (!Array.isArray(files)) throw new Error("Localization artifact integrity: invalid download response");
      for (const file of files) {
        const index = pending.findIndex(({ ref }) => ref.fileId === file.fileId && ref.versionId === file.versionId && ref.branchId === file.branchId && ref.locale === file.locale);
        if (index < 0) throw new Error("Localization artifact integrity: downloaded source identity mismatch");
        const batch = pending[index];
        if (file.fileFormat !== batch.source.fileFormat) throw new Error("Localization artifact integrity: downloaded format mismatch");
        const content = JSON.parse(Buffer.from(file.data, "base64").toString("utf8"));
        downloads[batch.kind][batch.locale] = { ...downloads[batch.kind][batch.locale], ...content };
        await writeJson(path.join(dir, batch.kind, `${batch.locale}.json`), downloads[batch.kind][batch.locale]);
        downloaded = true;
        pending.splice(index, 1);
      }
      if (!pending.length) break;
      if (Date.now() >= deadline) return { exitCode: 0, timedOut: true, downloaded, output: "Translation service timeout; retained completed batches." };
      await wait(2000);
    }
    return { exitCode: 0, timedOut: false, downloaded, output: `Translated ${batches.reduce((sum, b) => sum + Object.keys(b.missing).length, 0)} missing messages; unchanged translations retained.` };
  } catch (error) {
    return { exitCode: 1, timedOut: error.name === "TimeoutError" || error.name === "AbortError", downloaded, output: String(error) };
  }
}
