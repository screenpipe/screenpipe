// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const tasks = ["workflow-discover", "workflow-deepen", "workflow-review", "workflow-maintain"];
export default function (pi: ExtensionAPI) {
  const task = process.env.SCREENPIPE_PIPE_NAME || "";
  if (!tasks.includes(task)) return;
  const actions = ["context", "handoff", "finish"];
  if (task === "workflow-discover") actions.push("start", "propose");
  if (task === "workflow-maintain") actions.push("propose");
  if (task === "workflow-review") actions.push("reject", "publish");
  pi.registerTool({
    name: "workflow_workspace",
    label: "Workflow drafts",
    description: "Read shared drafts and durable review decisions, hand a draft to another workflow agent, publish a reviewed draft, or finish your work. Research uses the normal Screenpipe tools and skill. All writes return a durable receipt and remaining work. A draft save is not cycle completion; Review calls finish when remaining.canFinish is true. On conflict, reread context and reconsider before retrying. Publishing requires Review to first inspect original recorder evidence with normal Screenpipe tools, then supply a catalog_revision from context, and an assigned draft matching the catalog output contract.",
    parameters: {
      type: "object", properties: {
        action: {type: "string", enum: actions},
        expected_revision: {type:"integer", description:"revision from context"},
        catalog_revision: {type:"integer", description:"catalogRevision from context; publish and Review finish only"},
        draft_id: {type:"string", description:"For context, read this draft in full; for writes, the owned draft to change."},
        workflow_id: {type:"string", description:"With context, read one existing catalog workflow in full."},
        assignee: {type:"string", enum: tasks},
        payload: {type:"object", description:"For propose or handoff: research notes are valid, including a candidate title, source addresses, observed actions and unanswered questions. You do not need a finished procedure to hand off reconnaissance. Handoff replaces the draft payload. Only publish requires ONE complete workflow matching outputContract, including description and stages with procedure/evidence; omit payload to publish the stored draft. note never changes the payload."},
        note: {type:"string", description:"Evidence decision, specific question for the next agent, or what was actually checked. Required for writes."},
      }, required: ["action"], additionalProperties: false,
    } as any,
    async execute(_id: string, input: Record<string, any>, signal: AbortSignal) {
      try {
        const permissions = JSON.parse(readFileSync(join(process.cwd(), ".screenpipe-permissions.json"),"utf8"));
        if (!permissions.api_base || !permissions.pipe_token) throw new Error("Local recorder capability unavailable");
        const base = new URL(permissions.api_base);
        if (base.protocol !== "http:" || !["localhost","127.0.0.1","[::1]"].includes(base.hostname) || !permissions.pipe_token) throw new Error("Local recorder capability unavailable");
        const headers = {"Content-Type":"application/json", Authorization:`Bearer ${permissions.pipe_token}`};
        const bounded = AbortSignal.any([signal, AbortSignal.timeout(150_000)]);
        const missingDraft = (ws: any) => `Draft ${JSON.stringify(input.draft_id)} not found. Copy an exact id from these open drafts assigned to you; do not guess or modify identifiers: ${JSON.stringify(Object.values(ws.drafts || {}).filter((d:any)=>d.status === "open" && d.assignee === task).map((d:any)=>({id:d.id,title:d.payload?.title})))}. No changes were saved.`;
        const call = async (path: string, body?: unknown): Promise<any> => {
          const response = await fetch(new URL(path,base), {headers, redirect:"error",signal:bounded,
            ...(body === undefined ? {} : {method:"POST",body:JSON.stringify(body)})});
          const value = await response.json();
          if (!response.ok) {
            if (body !== undefined && input.draft_id && value.error === "Draft not found.") {
              const state = await call(`/workflows/workspace?task=${task}`);
              throw new Error(missingDraft(state.workspace));
            }
            throw new Error(`${response.status}: ${value.error || "Workflow save failed"}`);
          }
          return value;
        };
        let result: any;
        if (input.action === "context") {
          const state = await call(`/workflows/workspace?task=${task}`);
          const catalog = await call("/workflows/context");
          const ws = state.workspace;
          if (input.draft_id) {
            const draft = ws.drafts?.[input.draft_id];
            if (!draft) throw new Error(missingDraft(ws));
            result = {revision:ws.revision, catalogRevision:state.catalogRevision, cycle:ws.cycle, draft, evidenceStatus:"These are an agent’s proposed quotations, not original recorder results. Independently read the source records with normal Screenpipe tools before publishing.", outputContract:catalog.outputContract};
          } else if (input.workflow_id) {
            const workflow = catalog.workflows.find((w:any)=>w.id === input.workflow_id);
            if (!workflow) throw new Error("Workflow not found");
            result = {revision:ws.revision,catalogRevision:state.catalogRevision,workflow,outputContract:catalog.outputContract};
          } else {
            result = {task,ready:state.ready,canFinish:state.canFinish,revision:ws.revision,catalogRevision:state.catalogRevision,
              cycle:ws.cycle && {id:ws.cycle.id,status:ws.cycle.status,start:ws.cycle.start,end:ws.cycle.end,finished:ws.cycle.finished,changes:ws.cycle.changes},
              drafts:Object.values(ws.drafts || {}).map((d:any)=>({id:d.id,status:d.status,assignee:d.assignee,version:d.version,title:d.payload?.title || d.payload?.name,question:d.history?.at(-1)?.note})),
              workflows:catalog.workflows.map((w:any)=>({id:w.id,title:w.title,trigger:w.trigger,outcome:w.outcome,userCorrection:w.userCorrection,quality:w.quality,openQuestions:w.openQuestions})),
              profile:catalog.profile,
              next:"Read context with draft_id for an assigned draft or workflow_id for a saved workflow. These return the full record and outputContract. Do not reconstruct unseen payloads from this index."};
          }
        } else {
          result = await call("/workflows/workspace", {...input,task});
          // A publication receipt confirms one save, not completion of the
          // update. Give the agent fresh queue state after every mutation.
          // Failure to read it must never turn a successful save into an error.
          try {
            const state = await call(`/workflows/workspace?task=${task}`);
            result = {...result, remaining: {
              revision:state.workspace.revision, catalogRevision:state.catalogRevision,
              cycleStatus:state.workspace.cycle?.status, canFinish:state.canFinish,
              openDrafts:Object.values(state.workspace.drafts || {}).filter((d:any)=>d.status === "open")
                .map((d:any)=>({id:d.id,assignee:d.assignee,title:d.payload?.title})),
            }};
          } catch {
            result = {...result, remaining: {unavailable:true, next:"The save succeeded. Read context before deciding what remains; do not repeat the save blindly."}};
          }
        }
        // The normal Pipe prompt supplies the execution budget. Keep the clock
        // visible when agents revisit their workspace, without choosing their
        // research steps or treating an incomplete investigation as finished.
        result = {...result, observedAt:new Date().toISOString()};
        const text = JSON.stringify(result);
        // Use the existing snapshot path before the smallest supported
        // transport's 8K text boundary can cut JSON in the middle. Preserve the
        // full context for both modes, without choosing what the agent reads.
        if (text.length > 8_000) {
          // Preserve the exact snapshot. The normal read tool supports bounded
          // reads; a truncated preview is never a substitute for agent context.
          const path = join(process.cwd(),`.workflow-context-${randomUUID()}.json`);
          writeFileSync(path,JSON.stringify(result,null,2),{mode:0o600});
          return {content:[{type:"text" as const,text:JSON.stringify({revision:result.revision,catalogRevision:result.catalogRevision,path,message:"This context is large. Read the saved JSON snapshot with the normal read/bash tools in bounded pieces. All data is preserved. Do not infer missing drafts or workflows."})}],details:{path}};
        }
        return {content:[{type:"text" as const,text}], details:{revision:result.revision}};
      } catch (error: any) {
        // Pi marks a tool call failed only when execute throws. Returning an
        // isError property is treated as a successful result by the harness.
        throw new Error(`Workflow operation failed: ${error.message}`);
      }
    },
  });
}
