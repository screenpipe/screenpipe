// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compactEvidence } from "./workflow-memory";

const TOOLS = ["workflow_context", "workflow_commit", "workflow_inspect_frame", "activity-summary", "search-content", "list-meetings", "get-meeting", "frame-context"];
const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });

export function requireInspectedFrames(workflows: any[], inspected: Set<number>) {
  for (const workflow of workflows) for (const stage of workflow.stages ?? []) {
    if (stage.screenshotFrameId != null && !inspected.has(stage.screenshotFrameId)) {
      throw new Error("Inspect each screenshot before attaching it. Omit blank or unrelated images.");
    }
  }
}

export default function workflowCatalog(pi: ExtensionAPI) {
  let ready = false;
  let token = "";
  let context: any;
  const inspected = new Set<number>();
  let successfulHistoryRead = false;
  const failedHistoryReads = new Set<string>();
  let base = "";
  async function request(path: string, body?: unknown, signal?: AbortSignal) {
    if (!ready) throw new Error("Workflow task is not initialized.");
    const response = await fetch(`${base}${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(150_000)]) : AbortSignal.timeout(150_000), redirect: "error" });
    if (!response.ok) {
      let message = `Workflow request failed (${response.status}).`;
      try { const data = await response.json(); if (typeof data.error === "string") message = data.error; } catch {}
      throw new Error(message);
    }
    return response;
  }
  async function readJson(path: string, body?: unknown, signal?: AbortSignal) {
    const value = await (await request(path, body, signal)).json();
    if (typeof value?.error === "string") throw new Error(value.error);
    return value;
  }
  pi.on("session_start", async (_event: any, ctx: any) => {
    const permissions = JSON.parse(readFileSync(join(ctx.cwd, ".screenpipe-permissions.json"), "utf8"));
    if (!permissions.pipe_token) throw new Error("Workflow task permissions are unavailable.");
    token = permissions.pipe_token;
    base = permissions.api_base;
    const address = new URL(base);
    if (address.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(address.hostname)) throw new Error("Workflow task requires its local recorder.");
    pi.setActiveTools(TOOLS);
    ready = true;
  });
  pi.on("tool_call", async (event: any) => {
    if (!ready || !TOOLS.includes(event.toolName || event.tool || event.name)) return { block: true, reason: "This task only reads work history and maintains its workflow catalog." };
  });
  // A retry can recover an outage; an unresolved source read cannot be skipped
  // merely because the model decides it has finished investigating.
  pi.on("tool_result", async (event: any) => {
    if (!["activity-summary", "search-content", "list-meetings", "get-meeting", "frame-context"].includes(event.toolName)) return;
    const key = event.toolName;
    if (event.isError) failedHistoryReads.add(key);
    else { successfulHistoryRead = true; failedHistoryReads.delete(key); }
  });
  const tool = (name: string, description: string, properties: any, required: string[], run: (input: any, signal?: AbortSignal) => Promise<any>) => {
    pi.registerTool({ name, label: name.replaceAll("_", " "), description,
      parameters: { type: "object", properties, required, additionalProperties: false } as any,
      async execute(_id: string, input: any, signal?: AbortSignal) {
        return run(input, signal);
      } });
  };
  tool("workflow_context", "Read saved workflows, user corrections, Context, checkpoint and the output contract before investigating changes.", {}, [], async (_input, signal) => {
    context = await readJson("/workflows/context", undefined, signal);
    return result(context);
  });
  tool("activity-summary", "Read a measured activity index for a chosen interval. Summaries guide investigation; they do not prove task completion.", {
    start_time: { type: "string" }, end_time: { type: "string" },
  }, ["start_time", "end_time"], async (input, signal) => ({ content: [{ type: "text", text: compactEvidence(await readJson(`/activity-summary?${new URLSearchParams(input)}`, undefined, signal)) }] }));
  tool("workflow_inspect_frame", "View the actual captured image. Attach it only if it visibly supports the claimed step. Blank/loading pages are not useful evidence.", {
    frame_id: { type: "integer", minimum: 1 },
  }, ["frame_id"], async (input, signal) => {
    if (!Number.isSafeInteger(input.frame_id) || input.frame_id <= 0) throw new Error("A positive frame ID is required.");
    const metadata = await readJson(`/frames/${input.frame_id}/metadata`, undefined, signal);
    const response = await request(`/frames/${input.frame_id}/thumbnail?width=1024&quality=80&fallback=false`, undefined, signal);
    const mimeType = response.headers.get("content-type")?.split(";")[0] || "";
    if (!/^image\/(jpeg|png|webp)$/.test(mimeType)) throw new Error("No usable captured image is available.");
    const bytes = await response.arrayBuffer();
    if (!bytes.byteLength || bytes.byteLength > 2_000_000) throw new Error("Captured image is unavailable or too large.");
    inspected.add(input.frame_id);
    return { content: [{ type: "text", text: JSON.stringify(metadata) }, { type: "image", mimeType, data: Buffer.from(bytes).toString("base64") }] };
  });
  tool("workflow_commit", "Validate and save only new or materially improved workflows. An empty array checkpoints a successful no-change investigation. Existing IDs and corrections remain intact.", {
    expected_revision: { type: "integer" }, checked_through: { type: "string" },
    workflows: { type: "array", maxItems: 30, items: { type: "object", additionalProperties: true } },
  }, ["expected_revision", "checked_through", "workflows"], async (input, signal) => {
    if (!context || input.expected_revision !== context.revision || input.checked_through !== context.now) throw new Error("Use the revision and current time returned by workflow_context.");
    if (!successfulHistoryRead || failedHistoryReads.size > 0) throw new Error("Cannot advance the checkpoint while source reads have failed. Retry the failed reads successfully or finish without saving.");
    requireInspectedFrames(input.workflows, inspected);
    const receipt = await readJson("/workflows/catalog", input, signal);
    context = undefined;
    return result(receipt);
  });
}
