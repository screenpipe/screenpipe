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
    body: JSON.stringify(body), signal: AbortSignal.timeout(endpoint === "/v2/translate" ? 120_000 : 30_000),
  });
  if (!response.ok) throw new Error(`GT ${endpoint} HTTP ${response.status}: ${await response.text()}`);
  return response.json();
}

export async function translateMissing({ root, source, native, config, policy, cache, request = requestGT }) {
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
        // Bounded immutable batches checkpoint completed work and avoid one
        // request holding the whole app catalog. They retain the same GT format
        // and per-source identities used by provider corrections and recovery.
        for (let offset = 0; offset < ids.length; offset += 40) {
        const batchIds = ids.slice(offset, offset + 40);
        const batchMissing = Object.fromEntries(batchIds.map(id => [id, missing[id]]));
        const identity = digest({ policy, kind, locale, missing: batchMissing });
        const fileId = identity;
        const formatMetadata = Object.fromEntries(batchIds.map((id) => [id, {
          ...metadata[id],
          context: [...new Set([translationPolicy.context, metadata[id]?.context, (metadata[id]?.filePaths ?? []).join(", ")].filter(Boolean))].join("\n"),
        }]));
        batches.push({ kind, locale, missing: batchMissing, metadata: formatMetadata, source: {
          fileId, versionId: identity, fileName: `desktop/${kind}/${identity}.json`,
          fileFormat: kind === "gt" ? "GTJSON" : "JSON", locale: config.defaultLocale,
          content: JSON.stringify(batchMissing),
          formatMetadata: kind === "gt" ? formatMetadata : { keyedMetadata: formatMetadata },
        } });
        }
      }
    }
    if (!batches.length) {
      await writeJson(manifestPath, { policy, batches: known });
      return { exitCode: 0, timedOut: false, downloaded, output: "All source hashes already translated; zero translation requests." };
    }
    const { branch } = await request("/v2/project/branches/create", { branchName: `desktop-${policy.slice(0, 12)}` });
    if (!branch?.id) throw new Error("Localization artifact integrity: invalid branch response");
    for (const batch of batches) {
      const sourceFile = { ...batch.source, content: Buffer.from(batch.source.content).toString("base64"), branchId: branch.id };
      const { uploadedFiles } = await request("/v2/project/files/upload-files", {
        sourceLocale: config.defaultLocale, data: [{ source: sourceFile }],
      });
      const uploaded = uploadedFiles?.find((file) => file.fileId === batch.source.fileId && file.versionId === batch.source.versionId && file.branchId === branch.id);
      if (!uploaded) throw new Error("Localization artifact integrity: uploaded source identity mismatch");
      const ref = { fileId: uploaded.fileId, versionId: uploaded.versionId, branchId: branch.id, locale: batch.locale };
      // The per-message API is used ONLY by this build script. No credentials,
      // network translator, or provider URL is included in the desktop runtime.
      // Upload accepted results to the ordinary file workspace so terminology
      // corrections and fresh CI recovery use exactly the same source versions.
      const result = await request("/v2/translate", {
        requests: Object.fromEntries(Object.entries(batch.missing).map(([id, source]) => [id, {
          source,
          metadata: {
            hash: digest({ policy, kind: batch.kind, id, source }),
            context: batch.metadata[id].context,
            dataFormat: batch.metadata[id].dataFormat ?? (typeof source === "string" ? "ICU" : "JSX"),
            actionType: "standard",
          },
        }])), sourceLocale: config.defaultLocale, targetLocale: batch.locale, metadata: {},
      });
      const content = {};
      let serviceError;
      for (const id of Object.keys(batch.missing)) {
        const entry = result[id];
        if (entry?.success === false) { serviceError ??= `GT translation HTTP ${entry.code}: ${entry.error}`; continue; }
        const expectedFormat = batch.metadata[id].dataFormat ?? (typeof batch.missing[id] === "string" ? "ICU" : "JSX");
        if (entry?.success !== true || entry.locale !== batch.locale || entry.dataFormat !== expectedFormat || entry.translation === undefined) {
          throw new Error("Localization artifact integrity: translated message identity/format mismatch");
        }
        content[id] = entry.translation;
      }
      // Keep rejected entries in the local report, but never upload an invalid
      // placeholder/structure as an accepted provider correction.
      downloads[batch.kind][batch.locale] = { ...downloads[batch.kind][batch.locale], ...content };
      await writeJson(path.join(dir, batch.kind, `${batch.locale}.json`), downloads[batch.kind][batch.locale]);
      downloaded = true;
      const valid = validateCatalog(batch.missing, content, config.defaultLocale, batch.locale).valid;
      if (Object.keys(valid).length) {
        await request("/v2/project/files/upload-translations", {
          sourceLocale: config.defaultLocale, data: [{ source: sourceFile, translations: [{
            content: Buffer.from(JSON.stringify(valid)).toString("base64"),
            fileName: batch.source.fileName, fileFormat: batch.source.fileFormat, locale: batch.locale,
          }] }],
        });
        known.push({ kind: batch.kind, ref, messageIds: Object.keys(batch.missing) });
        await writeJson(manifestPath, { policy, batches: known });
      }
      console.log(`[i18n] ${batch.locale}: completed ${Object.keys(valid).length}/${Object.keys(batch.missing).length} ${batch.kind} messages`);
      if (serviceError) throw new Error(serviceError);
    }
    return { exitCode: 0, timedOut: false, downloaded, output: `Translated ${batches.reduce((sum, b) => sum + Object.keys(b.missing).length, 0)} missing messages; unchanged translations retained.` };
  } catch (error) {
    return { exitCode: 1, timedOut: error.name === "TimeoutError" || error.name === "AbortError", downloaded, output: String(error) };
  }
}
