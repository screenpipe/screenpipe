// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

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
  let task = "workflow-discovery";
  let blocked = false;
  let token = "";
  let context: any;
  let committed = false;
  let recoveryRequested = false;
  let lastStopReason: string | undefined;
  const inspected = new Set<number>();
  const failedFrames = new Set<number>();
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
      throw Object.assign(new Error(message), { status: response.status });
    }
    return response;
  }
  async function readJson(path: string, body?: unknown, signal?: AbortSignal) {
    const value = await (await request(path, body, signal)).json();
    if (typeof value?.error === "string") throw new Error(value.error);
    return value;
  }
  pi.on("session_start", async (_event: any, ctx: any) => {
    task = process.env.SCREENPIPE_PIPE_NAME || basename(ctx.cwd);
    const permissions = JSON.parse(readFileSync(join(ctx.cwd, ".screenpipe-permissions.json"), "utf8"));
    if (!permissions.pipe_token) throw new Error("Workflow task permissions are unavailable.");
    token = permissions.pipe_token;
    base = permissions.api_base;
    const address = new URL(base);
    if (address.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(address.hostname)) throw new Error("Workflow task requires its local recorder.");
    ready = true;
  });
  // The normal Pipe harness owns skills, tools, connections and permissions.
  // This extension only owns workflow context, verification and save receipts.
  // Pi owns continuation, cancellation and the task timeout. Give the agent
  // one follow-up to satisfy its save contract, never a second processing loop.
  pi.on("agent_end", async (event: any) => {
    const last = event.messages?.findLast((message: any) => message.role === "assistant");
    lastStopReason = last?.stopReason;
    if (!ready || blocked || committed || lastStopReason !== "stop" || recoveryRequested) return;
    recoveryRequested = true;
    pi.sendMessage({
      customType: "workflow-save-required",
      content: "This stage has no successful save receipt yet. Use workflow_stage_commit for enrichment stages and workflow_commit only for final review. Continue from the tool results: repair any rejected claims using their sources, or omit unsupported changes. If investigation succeeded and nothing qualifies, commit workflows: [] to preserve the catalog and record the check. If a source read failed, retry that read; do not checkpoint an incomplete investigation. A validation rejection alone is not a saved result. Finish only after a successful receipt, or explain the unresolved failure.",
      display: true,
    }, { deliverAs: "followUp", triggerTurn: true });
  });
  pi.on("agent_settled", async () => {
    if (!ready || committed) return;
    process.exitCode = 1;
    // Preserve provider and cancellation errors rather than relabeling them.
    if (lastStopReason === "error" || lastStopReason === "aborted") return;
    // The existing Pipe result classifier consumes structured stderr. A normal
    // assistant sentence cannot turn a rejected save into a completed task.
    process.stderr.write(JSON.stringify({ error: {
      code: "missing_output",
      message: "The agent could not save a supported update. Your saved workflows are unchanged.",
    } }) + "\n");
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
    context.pipeline = await readJson(`/workflows/pipeline?task=${encodeURIComponent(task)}`, undefined, signal);
    blocked = !context.pipeline.ready;
    return result(context);
  });
  tool("workflow_inspect_frame", "View the actual captured image. Attach it only if it visibly supports the claimed step. Blank/loading pages are not useful evidence.", {
    frame_id: { type: "integer", minimum: 1 },
  }, ["frame_id"], async (input, signal) => {
    if (!Number.isSafeInteger(input.frame_id) || input.frame_id <= 0) throw new Error("A positive frame ID is required.");
    failedFrames.add(input.frame_id);
    try {
      const metadata = await readJson(`/frames/${input.frame_id}/metadata`, undefined, signal);
      const response = await request(`/frames/${input.frame_id}/thumbnail?width=1024&quality=80&fallback=false`, undefined, signal);
      const mimeType = response.headers.get("content-type")?.split(";")[0] || "";
      if (!/^image\/(jpeg|png|webp)$/.test(mimeType)) throw new Error("No usable captured image is available.");
      const bytes = await response.arrayBuffer();
      if (!bytes.byteLength || bytes.byteLength > 2_000_000) throw new Error("Captured image is unavailable or too large.");
      inspected.add(input.frame_id);
      failedFrames.delete(input.frame_id);
      return { content: [{ type: "text", text: JSON.stringify(metadata) }, { type: "image", mimeType, data: Buffer.from(bytes).toString("base64") }] };
    } catch (error) {
      // A deleted capture can be omitted; an interrupted read cannot be checkpointed.
      if ([404, 410].includes((error as any)?.status)) failedFrames.delete(input.frame_id);
      throw error;
    }
  });
  tool("workflow_stage_commit", "Save this enrichment stage, preserving its upstream revision and actual completed coverage. Only final review publishes workflows.", {
    checked_through: { type: "string", description: "Only for a partially completed activity batch; otherwise omit. Revisions are managed automatically." },
    items: { type: "array", maxItems: 200, items: { type: "object", additionalProperties: true } },
    coverage: { type: "array", items: { type: "object", properties: {
      start: { type: "string", description: "Exact ISO timestamp at the start of the reviewed interval." },
      end: { type: "string", description: "Exact ISO timestamp at the end of the reviewed interval." },
      complete: { type: "boolean", description: "True only after finishing the interval's source reads and pages." },
    }, required: ["start", "end", "complete"], additionalProperties: true } },
  }, ["items", "coverage"], async (input, signal) => {
    const pipeline = context?.pipeline;
    if (!pipeline?.ready || pipeline.stage === 4) throw new Error("Read this stage's current workflow_context before saving.");
    input = { ...input, expected_revision: pipeline.revision, input_revision: pipeline.inputRevision, checked_through: input.checked_through || pipeline.checkedThrough };
    if (pipeline.stage > 0 && input.checked_through !== pipeline.checkedThrough) throw new Error("Preserve upstream coverage.");
    if (pipeline.stage === 0 && (Date.parse(input.checked_through) > Date.parse(pipeline.checkedThrough) || !input.coverage.length || input.coverage.some((r: any) => Date.parse(r.start) < Date.parse(pipeline.window.start)))) throw new Error("Save only completed coverage inside this batch.");
    const coverage = pipeline.stage === 0 ? input.coverage : pipeline.input.coverage;
    const receipt = await readJson("/workflows/pipeline", { ...input, coverage, task }, signal);
    if (!Number.isInteger(receipt.revision) || receipt.revision <= input.expected_revision) throw new Error("Missing stage save receipt.");
    committed = true;
    return result(receipt);
  });
  tool("workflow_commit", "Validate and save only new or materially improved workflows. An empty array checkpoints a successful no-change investigation. Existing IDs and corrections remain intact.", {
    workflows: { type: "array", maxItems: 30, items: { type: "object", additionalProperties: true } },
  }, ["workflows"], async (input, signal) => {
    if (!context?.pipeline?.ready || task !== "workflow-discovery") throw new Error("Read workflow_context before saving the final review.");
    input = { workflows: input.workflows, expected_revision: context.revision, checked_through: context.pipeline.checkedThrough };
    if (failedFrames.size) throw new Error(`Screenshot verification failed. Retry workflow_inspect_frame for IDs ${[...failedFrames].join(", ")} before saving, or finish without a checkpoint.`);
    requireInspectedFrames(input.workflows, inspected);
    const receipt = await readJson("/workflows/catalog", { ...input, pipeline_revision: context.pipeline.inputRevision }, signal);
    if (!Number.isInteger(receipt?.revision) || receipt.revision <= input.expected_revision || receipt.checkedThrough !== input.checked_through) throw new Error("The recorder did not return a valid save receipt. Read workflow_context to check whether the update persisted before trying again.");
    committed = true;
    context = undefined;
    return result(receipt);
  });
}
