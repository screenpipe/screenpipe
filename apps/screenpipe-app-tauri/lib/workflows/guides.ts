// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import {
  guideKey,
  guidePrompt,
  parseGuide,
  type WorkflowsPlatform,
} from "@screenpipe/workflows-ui";
import { runWorkflowAgent } from "./agent-runner";
import { assistantProviderConfig, ASSISTANT_TOOLS } from "./assistant";
import { loadGuideFromDisk, saveGuideToDisk } from "./disk-storage";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";

export const desktopGuides: NonNullable<WorkflowsPlatform["guides"]> = {
  load: (workflow) => loadGuideFromDisk(guideKey(workflow)),
  save: saveGuideToDisk,
  async generate(workflow, signal, progress) {
    const text = await runWorkflowAgent({
      name: "guide",
      prompt: guidePrompt(workflow),
      signal,
      config: {
        ...assistantProviderConfig,
        maxTokens: 8192,
        allowedTools: [
          ...ASSISTANT_TOOLS,
          "screenpipe_list_connections",
          "sp_mcp_list_tools",
          "sp_mcp_read",
        ],
      },
      onProgress: ({ activity }) =>
        progress(
          activity === "searching"
            ? "Checking the source material"
            : activity === "writing"
              ? "Writing steps and completion checks"
              : "Reading your workflow",
        ),
    });
    if (signal.aborted) throw new DOMException("Stopped", "AbortError");
    return parseGuide(
      JSON.parse(
        text
          .trim()
          .replace(/^```(?:json)?\s*/, "")
          .replace(/\s*```$/, ""),
      ),
      workflow,
    );
  },
  async export(html, title) {
    const path = await save({
      defaultPath: `${title.replace(/[^a-zA-Z0-9 -]/g, "").slice(0, 80) || "workflow-guide"}.html`,
      filters: [{ name: "HTML guide", extensions: ["html"] }],
    });
    if (!path) return false;
    await writeTextFile(path, html);
    return true;
  },
};
