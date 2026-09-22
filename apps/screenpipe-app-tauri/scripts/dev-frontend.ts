// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { prepareLocalization } from "./i18n/prepare.mjs";

await prepareLocalization();
const child = Bun.spawn(["bun", "x", "next", "dev", "-p", "1420"], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.exit(await child.exited);
