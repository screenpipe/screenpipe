// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import path from "node:path";
import { prepareLocalization, writeJson } from "./prepare.mjs";
import { appRoot } from "./config.mjs";

const snapshot = await prepareLocalization();
const destination = path.resolve(appRoot, "../../.release-localization");
await writeJson(path.join(destination, "snapshot.json"), snapshot);
await writeJson(path.join(destination, "coverage.json"), {
  revision: snapshot.revision, coverage: snapshot.coverage,
  causes: snapshot.causes, fallbacks: snapshot.fallbacks,
});
