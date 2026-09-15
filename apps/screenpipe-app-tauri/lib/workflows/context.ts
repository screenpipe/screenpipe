// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { type ContextFillRequest, buildContextPrompt, normalizeContextWebsite, parseContextUpdate, validateContextDocuments } from "@screenpipe/workflows-ui/context";
import { assistantProviderConfig } from "./assistant";
import { runWorkflowAgent } from "./agent-runner";

export async function fillWorkContext({ documents, website, profile, signal, onField, onActivity }: ContextFillRequest) {
  validateContextDocuments(documents);
  website = normalizeContextWebsite(website);
  if (!documents.length && !website) throw new Error("Add some text, files, or a company website.");
  const received = new Set<string>();
  await runWorkflowAgent({
    name: "context", signal, allowEmpty: true,
    config: { ...assistantProviderConfig, maxTokens: 8000, allowedTools: ["fill_work_context", ...(website ? ["sp_web_search"] : [])] },
    prompt: buildContextPrompt({ documents, website, profile }),
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
