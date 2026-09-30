// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareLocalization, writeJson } from "./prepare.mjs";

test("release snapshot handoff is independent of source file discovery order", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "screenpipe-i18n-handoff-"));
  const originalSnapshot = process.env.SCREENPIPE_I18N_SNAPSHOT;
  delete process.env.SCREENPIPE_I18N_SNAPSHOT;
  try {
    const config = {
      defaultLocale: "en", locales: ["ja"],
      src: ["components/**/*.tsx", "app/**/*.tsx", "!**/*.test.*"],
      files: { gt: { output: ".localization/gt/[locale].json", parsingFlags: {
        enableAutoJsxInjection: true, autoderive: false, includeSourceCodeContext: false,
      } } },
    };
    await writeJson(path.join(root, "gt.config.json"), config);
    for (const [file, icon] of [["components/manage.tsx", "Bell"], ["app/manage.tsx", "Plus"], ["app/private.test.tsx", "Private"]]) {
      await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await fs.writeFile(path.join(root, file), `export function Probe() { return <button><${icon} />Manage</button>; }`);
    }
    const route = path.join(root, "app/(main)/[slug]/page.tsx");
    await fs.mkdir(path.dirname(route), { recursive: true });
    await fs.writeFile(route, "export default function Page() { return <p>Literal route message</p>; }");
    const snapshot = await prepareLocalization({ root, config, mode: "cached" });
    expect(snapshot.coverage.ja.frontend.total).toBe(2);
    const source = JSON.parse(await fs.readFile(path.join(root, ".localization/source/en.json"), "utf8"));
    expect(Object.values(source)).toContain("Literal route message");
    process.env.SCREENPIPE_I18N_SNAPSHOT = path.join(root, ".localization/snapshot.json");
    const handedOff = await prepareLocalization({ root, config: { ...config, src: [...config.src].reverse() }, mode: "cached" });
    expect(handedOff).toEqual(snapshot);
    await fs.appendFile(path.join(root, "app/manage.tsx"), '\nexport function Changed() { return <p>New source text</p>; }');
    await expect(prepareLocalization({ root, config, mode: "cached" })).rejects.toThrow("snapshot does not match");
  } finally {
    if (originalSnapshot === undefined) delete process.env.SCREENPIPE_I18N_SNAPSHOT;
    else process.env.SCREENPIPE_I18N_SNAPSHOT = originalSnapshot;
    await fs.rm(root, { recursive: true, force: true });
  }
}, 30_000);
