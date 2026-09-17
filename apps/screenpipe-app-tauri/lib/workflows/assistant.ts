// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import type { WorkflowsAssistantPlatform } from "@screenpipe/workflows-ui";
import { type PiProviderConfig } from "@/lib/utils/tauri";
import { loadAssistantFromDisk, saveAssistantToDisk } from "./disk-storage";
import { runWorkflowAgent } from "./agent-runner";
import { saveWorkflowFeedback, applyWorkflowFeedback, loadScheduledCatalog } from "./scheduled-discovery";
import { parseWorkflowRefinement, type WorkflowRefinement } from "../../../../packages/workflows-ui/src/feedback-tool";
import { WORKFLOW_MODELS } from "@screenpipe/workflows-ui";
import { ASSISTANT_TOOLS, buildAssistantPrompt } from "./assistant-prompt";
import { open } from "@tauri-apps/plugin-shell";
import { isAssistantLink } from "@screenpipe/workflows-ui";

export { ASSISTANT_TOOLS, buildAssistantPrompt } from "./assistant-prompt";

export const assistantProviderConfig: PiProviderConfig = {
  provider: "screenpipe-cloud", model: WORKFLOW_MODELS.intelligent.model, url: "", apiKey: null,
  maxTokens: 4096, systemPrompt: null, allowedTools: ASSISTANT_TOOLS,
};

export const desktopAssistant: WorkflowsAssistantPlatform = {
  learnsFromFeedback: true,
  openLink: async (url) => { if (!isAssistantLink(url)) throw new Error("Unsupported link."); await open(url); },
  saveFeedback: saveWorkflowFeedback,
  load: loadAssistantFromDisk,
  save: saveAssistantToDisk,
  async ask({ question, context, history, signal, onProgress }) {
    const feedback = context?.purpose === "feedback" && context.workflow?.id && history.length > 0;
    if (feedback) {
      const latest = (await loadScheduledCatalog())?.analysis.workflows.find(w => w.id === context!.workflow!.id);
      if (!latest) throw new Error("This workflow no longer exists. Reopen it before sending feedback.");
      context = { ...context!, workflow: latest };
    }
    let refinement: WorkflowRefinement | null = null;
    const text = await runWorkflowAgent({ name: "assistant", prompt: buildAssistantPrompt(question, context, history),
      config: context?.purpose === "feedback" ? { ...assistantProviderConfig, allowedTools: [...ASSISTANT_TOOLS, ...(feedback ? ["refine_workflow"] : [])] } : assistantProviderConfig,
      signal, onProgress, onEvent: event => {
        if (!feedback || event.type !== "tool_execution_end" || event.toolName !== "refine_workflow" || event.isError) return;
        if (refinement) throw new Error("Use one combined workflow refinement per answer.");
        refinement = parseWorkflowRefinement(JSON.parse(event.result?.content?.find(part => typeof part.text === "string")?.text || "null"));
      },
    });
    if (signal.aborted) throw new DOMException("Stopped", "AbortError");
    if (refinement && context?.workflow) {
      const { learning, changes } = refinement as WorkflowRefinement;
      const updated = await applyWorkflowFeedback(context.workflow, learning, changes);
      onProgress({ text, activity: "writing", workflow: updated });
      window.dispatchEvent(new CustomEvent("workflows:refined", { detail: updated }));
      return `${text}\n\n${Object.keys(changes).length ? "Workflow updated. " : ""}Feedback remembered for future updates and skill drafts.`;
    }
    return text;
  },
};
