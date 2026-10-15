// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
export default function (pi: ExtensionAPI) {
  if (process.env.SCREENPIPE_PIPE_NAME !== "workflow-share") return;
  pi.registerTool({
    name: "workflow_team_share", label: "Team workflow sharing",
    description: "Read completed instruction-only workflow candidates, then save a professional, personal or uncertain decision for the exact reviewed id and hash. Only professional decisions publish to the opted-in team. Personal and uncertain decisions stay local.",
    parameters: { type: "object", properties: {
      action: { type: "string", enum: ["context", "classify"] },
      workflow_id: { type: "string" }, hash: { type: "string" },
      classification: { type: "string", enum: ["professional", "personal", "uncertain"] },
    }, required: ["action"], additionalProperties: false } as any,
    async execute(_id: string, input: Record<string, unknown>, signal: AbortSignal) {
      try {
        signal.throwIfAborted();
        if (input.action !== "context" && input.action !== "classify") throw new Error("Unknown sharing action");
        const permissions = JSON.parse(readFileSync(join(process.cwd(), ".screenpipe-permissions.json"), "utf8"));
        const base = new URL(permissions.api_base);
        if (base.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname) || !permissions.pipe_token) throw new Error("Local recorder capability unavailable");
        const response = await fetch(new URL("/workflows/team-sharing", base), {
          headers: { Authorization: `Bearer ${permissions.pipe_token}`, "Content-Type": "application/json" },
          signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]), redirect: "error",
          ...(input.action === "context" ? {} : { method: "POST", body: JSON.stringify(input) }),
        });
        const value = await response.json();
        if (!response.ok) throw new Error(value.error || "Team sharing failed");
        const serialized = JSON.stringify(value);
        // Preserve the exact reviewed input before the smallest provider's tool
        // result truncation. A partial instruction must never be classified.
        if (input.action === "context" && serialized.length > 6000) {
          const path = join(process.cwd(), `sharing-context-${randomUUID()}.json`);
          writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 });
          return { content: [{ type: "text" as const, text: JSON.stringify({ ready: value.ready, path, message: "Read this complete local snapshot in bounded pieces before classifying. Do not infer omitted instructions." }) }], details: { path } };
        }
        return { content: [{ type: "text" as const, text: serialized }], details: {} };
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : "Team sharing failed");
      }
    },
  });
}
