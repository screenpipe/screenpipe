// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

// Use the pinned CLI's collector so extracted IDs, formats and file context are
// exactly the ones its compiler/runtime use. This step is entirely offline.
import { generateSettings } from "gt/config/generateSettings";
import { collectFiles } from "gt/formats/files/collectFiles";
import { matchFiles } from "gt/fs/matchFiles";
import glob from "fast-glob";
import path from "node:path";
import { writeJson } from "./prepare.mjs";

const settings = await generateSettings({ config: process.argv[2], omitConfigIds: true });
// GT keeps the first source for a shared message ID, including icon metadata.
// Resolve exclusions first, then give every runner the same relative file order.
// The collector expands these paths again, so retain literal Next.js route names.
settings.src = matchFiles(process.cwd(), settings.src)
  .map((file) => path.relative(process.cwd(), file).split(path.sep).join("/"))
  .sort()
  .map((file) => glob.posix.escapePath(file));
const { files } = await collectFiles({ inline: true }, settings, "gt-react");
const file = files.find((file) => file.fileFormat === "GTJSON");
const destination = path.join(process.cwd(), ".localization/source");
await writeJson(path.join(destination, `${settings.defaultLocale}.json`), file ? JSON.parse(file.content) : {});
await writeJson(path.join(destination, `${settings.defaultLocale}.metadata.json`), file?.formatMetadata ?? {});
