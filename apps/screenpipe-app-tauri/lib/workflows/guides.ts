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

import { guideVideo } from "./guide-video";

export const desktopGuides: NonNullable<WorkflowsPlatform["guides"]> = {
  video: guideVideo,
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

/** Edits run in the same local harness as creation; only the validated draft is saved. */
desktopGuides.edit = async (guide, workflow, instruction, signal, progress) => {
  const text = await runWorkflowAgent({ name: 'guide', signal,
    config: { ...assistantProviderConfig, maxTokens: 8192, allowedTools: ASSISTANT_TOOLS },
    prompt: `${guidePrompt(workflow)}\nThis is an editing request. Preserve existing content unless the user asks to change it. Keep narration under 800 characters per scene, factual, and easy to speak. Never render, share or execute anything.\nCurrent editable guide:\n${JSON.stringify(guide)}\nUser edit request:\n${instruction}`,
    onProgress: () => progress('Editing your guide'),
  });
  if (signal.aborted) throw new DOMException('Stopped', 'AbortError');
  return parseGuide(JSON.parse(text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')), workflow);
};
