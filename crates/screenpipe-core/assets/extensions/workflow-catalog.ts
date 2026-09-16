// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { compactEvidence } from "./workflow-memory";

const TOOLS = ["workflow_context", "workflow_stage_commit", "workflow_commit", "workflow_inspect_frame", "activity-summary", "search-content", "list-meetings", "get-meeting", "frame-context"];
const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });

export function requireInspectedFrames(workflows: any[], inspected: Set<number>) {
  for (const workflow of workflows) for (const stage of workflow.stages ?? []) {
    if (stage.screenshotFrameId != null && !inspected.has(stage.screenshotFrameId)) {
      throw new Error("Inspect each screenshot before attaching it. Omit blank or unrelated images.");
    }
  }
}

/** Preserve actual read scope instead of calling a few matches full coverage. */
export function checkedCoverage(coverage: any[], indices: any[], reads: any[]) {
  for (const range of coverage) {
    const start = Date.parse(range.start), end = Date.parse(range.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || !indices.some(index => Date.parse(index.start) <= start && Date.parse(index.end) >= end)) throw new Error("Read the activity index for every interval before checkpointing it.");
  }
  const pages = new Map<string, any[]>();
  for (const read of reads) {
    if (typeof read.total !== "number" || typeof read.count !== "number") continue;
    const { offset: _offset, limit: _limit, ...scope } = read.query;
    const key = JSON.stringify([read.tool, Object.entries(scope).sort()]);
    pages.set(key, [...(pages.get(key) || []), read]);
  }
  for (const group of pages.values()) {
    let offset = 0;
    for (const page of group.sort((a,b) => a.offset-b.offset)) {
      if (page.offset > offset) throw new Error("Source pagination has an unread gap. Finish reading pages or retry a smaller window.");
      offset = Math.max(offset, page.offset + page.count);
    }
    if (offset < Math.max(...group.map(page => page.total))) throw new Error("Source results have unread pages. Finish paging before checkpointing this batch.");
  }
  return coverage.map(range => ({...range, method:"activity-index-and-targeted-sources", queries:reads}));
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
  let successfulHistoryRead = false;
  const indices: any[] = [];
  const reads: any[] = [];
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
    task = process.env.SCREENPIPE_PIPE_NAME || basename(ctx.cwd);
    const permissions = JSON.parse(readFileSync(join(ctx.cwd, ".screenpipe-permissions.json"), "utf8"));
    if (!permissions.pipe_token) throw new Error("Workflow task permissions are unavailable.");
    token = permissions.pipe_token;
    base = permissions.api_base;
    const address = new URL(base);
    if (address.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(address.hostname)) throw new Error("Workflow task requires its local recorder.");
    pi.setActiveTools(TOOLS.filter(name => name !== (task === "workflow-discovery" ? "workflow_stage_commit" : "workflow_commit")));
    ready = true;
  });
  pi.on("tool_call", async (event: any) => {
    if (!ready || !TOOLS.filter(name => name !== (task === "workflow-discovery" ? "workflow_stage_commit" : "workflow_commit")).includes(event.toolName || event.tool || event.name)) return { block: true, reason: "This task only reads work history and maintains its workflow catalog." };
  });
  // A retry can recover an outage; an unresolved source read cannot be skipped
  // merely because the model decides it has finished investigating.
  pi.on("tool_result", async (event: any) => {
    if (!["activity-summary", "search-content", "list-meetings", "get-meeting", "frame-context"].includes(event.toolName)) return;
    const key = event.toolName;
    if (event.isError) failedHistoryReads.add(key);
    else { successfulHistoryRead = true; failedHistoryReads.delete(key); if (event.details?.lookup) reads.push(event.details.lookup); }
  });
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
      message: failedHistoryReads.size > 0
        ? "Could not finish reading work history. Your saved workflows are unchanged."
        : "The agent could not save a supported update. Your saved workflows are unchanged.",
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
  tool("activity-summary", "Read a measured activity index for a chosen interval. Summaries guide investigation; they do not prove task completion.", {
    start_time: { type: "string" }, end_time: { type: "string" },
  }, ["start_time", "end_time"], async (input, signal) => {
    const value = await readJson(`/activity-summary?${new URLSearchParams({ ...input, include_key_texts: "false", include_snippets: "false", include_memories: "false", include_parsed_count: "false" })}`, undefined, signal);
    indices.push({start:input.start_time,end:input.end_time});
    return {content:[{type:"text",text:compactEvidence(value)}]};
  });
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
  tool("workflow_stage_commit", "Save this enrichment stage, preserving its upstream revision and actual completed coverage. Only final review publishes workflows.", {
    checked_through: { type: "string", description: "Only for a partially completed activity batch; otherwise omit. Revisions are managed automatically." },
    items: { type: "array", maxItems: 200, items: { type: "object", additionalProperties: true } },
    coverage: { type: "array", items: { type: "object", additionalProperties: true } },
  }, ["items", "coverage"], async (input, signal) => {
    const pipeline = context?.pipeline;
    if (!pipeline?.ready || pipeline.stage === 4) throw new Error("Read this stage's current workflow_context before saving.");
    input = { ...input, expected_revision: pipeline.revision, input_revision: pipeline.inputRevision, checked_through: input.checked_through || pipeline.checkedThrough };
    if (failedHistoryReads.size || (pipeline.stage === 0 && !successfulHistoryRead)) throw new Error("Resolve source read failures before saving progress.");
    if (pipeline.stage > 0 && input.checked_through !== pipeline.checkedThrough) throw new Error("Preserve upstream coverage.");
    if (pipeline.stage === 0 && (Date.parse(input.checked_through) > Date.parse(pipeline.checkedThrough) || !input.coverage.length || input.coverage.some((r: any) => Date.parse(r.start) < Date.parse(pipeline.window.start)))) throw new Error("Save only completed coverage inside this batch.");
    const coverage = pipeline.stage === 0 ? checkedCoverage(input.coverage, indices, reads) : pipeline.input.coverage;
    const receipt = await readJson("/workflows/pipeline", { ...input, coverage, task }, signal);
    if (!Number.isInteger(receipt.revision) || receipt.revision <= input.expected_revision) throw new Error("Missing stage save receipt.");
    committed = true;
    return result(receipt);
  });
  tool("workflow_commit", "Validate and save only new or materially improved workflows. An empty array checkpoints a successful no-change investigation. Existing IDs and corrections remain intact.", {
    expected_revision: { type: "integer" }, checked_through: { type: "string" },
    workflows: { type: "array", maxItems: 30, items: { type: "object", additionalProperties: true } },
  }, ["expected_revision", "checked_through", "workflows"], async (input, signal) => {
    if (!context?.pipeline?.ready || task !== "workflow-discovery" || input.expected_revision !== context.revision || input.checked_through !== context.pipeline.checkedThrough) throw new Error("Use the catalog revision and pipeline checkedThrough returned by workflow_context.");
    if (failedHistoryReads.size > 0 || (context.pipeline.input?.items?.length > 0 && !successfulHistoryRead)) throw new Error("Cannot advance the checkpoint while source reads have failed. Retry the failed reads successfully or finish without saving.");
    requireInspectedFrames(input.workflows, inspected);
    const receipt = await readJson("/workflows/catalog", { ...input, pipeline_revision: context.pipeline.inputRevision }, signal);
    if (!Number.isInteger(receipt?.revision) || receipt.revision <= input.expected_revision || receipt.checkedThrough !== input.checked_through) throw new Error("The recorder did not return a valid save receipt. Read workflow_context to check whether the update persisted before trying again.");
    committed = true;
    context = undefined;
    return result(receipt);
  });
}
