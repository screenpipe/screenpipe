// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { $ } from "bun";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("../", import.meta.url));
// Like the native app build, start with a fresh Next cache: file: workspace
// packages can otherwise retain old compiled UI despite changed source.
await rm(new URL("../.next", import.meta.url), { recursive: true, force: true });
await $`bun x next build`.cwd(appRoot);
