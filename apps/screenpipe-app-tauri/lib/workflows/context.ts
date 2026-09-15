// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { type ContextFillRequest, buildContextPrompt, normalizeContextWebsite, parseContextUpdate, validateContextDocuments } from "@screenpipe/workflows-ui/context";
import { ASSISTANT_TOOLS, assistantProviderConfig } from "./assistant";
import { runWorkflowAgent } from "./agent-runner";

export const CONTEXT_TOOLS = [...ASSISTANT_TOOLS, "user_profile", "skill_manage", "read", "screenpipe_list_connections", "sp_mcp_list_tools", "sp_mcp_read", "fill_work_context"];

export async function fillWorkContext({ documents, website, profile, signal, onField, onActivity }: ContextFillRequest) {
  validateContextDocuments(documents);
  website = normalizeContextWebsite(website);
  const received = new Set<string>();
  await runWorkflowAgent({
    name: "context", signal, allowEmpty: true,
    config: { ...assistantProviderConfig, maxTokens: 8000, allowedTools: [...CONTEXT_TOOLS, ...(website ? ["sp_web_search"] : [])] },
    prompt: buildContextPrompt({ documents, website, profile, discoverContext: true }),
    onProgress: ({ activity }) => onActivity(activity === "searching" ? "Reading sources…" : "Filling context…"),
    onEvent: (event) => {
      if (event.type !== "tool_execution_end" || event.toolName !== "fill_work_context" || event.isError) return;
      const text = event.result?.content?.find((part) => typeof part.text === "string")?.text;
      const update = parseContextUpdate(JSON.parse(text || "null"));
      if (received.has(update.field)) return;
      received.add(update.field);
      onField(update);
    },
  });
  if (!received.size) throw new Error("No supported context found. Add more detail and try again.");
}
