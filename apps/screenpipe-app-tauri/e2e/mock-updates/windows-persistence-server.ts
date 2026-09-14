// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.env.SP_PERSISTENCE_ARTIFACT_DIR;
if (!root) throw new Error("SP_PERSISTENCE_ARTIFACT_DIR is required");
const version = "90.0.1";
const persistent = `screenpipe-enterprise-${version}-x64-persistent.exe`;
const signature = readFileSync(join(root, `${persistent}.sig`), "utf8").trim();

Bun.serve({
  hostname: "127.0.0.1",
  port: 8765,
  fetch(request) {
    const path = new URL(request.url).pathname;
    console.log(`${request.method} ${path}`);
    if (path === "/api/enterprise/policy") {
      const mode = readFileSync(join(root, "policy-mode.txt"), "utf8").trim();
      return Response.json({
        appUpdatePolicy: { mode },
        lockedSettings: { enforcePersistence: true, app_update_policy: { mode } },
      });
    }
    if (path.startsWith("/api/app-update/enterprise/")) {
      const publishedVersion = readFileSync(join(root, "published-version.txt"), "utf8").trim();
      return Response.json({
        version: publishedVersion,
        notes: "Windows persistent updater acceptance fixture",
        pub_date: "2026-09-07T00:00:00Z",
        signature,
        url: `http://127.0.0.1:8765/releases/${version}/windows-x86_64/ordinary.exe`,
      });
    }
    if (path === `/releases/${version}/windows-x86_64/${persistent}`) {
      return new Response(Bun.file(join(root, persistent)));
    }
    if (path === `/releases/${version}/windows-x86_64/${persistent}.sig`) {
      return new Response(Bun.file(join(root, `${persistent}.sig`)));
    }
    return new Response("not found", { status: 404 });
  },
});

console.log("persistent updater fixture listening on 127.0.0.1:8765");
