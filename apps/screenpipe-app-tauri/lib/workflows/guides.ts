// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import {
  guideKey,
  guideMarkdown,
  guidePrompt,
  parseGuide,
  type WorkflowsPlatform,
} from "@screenpipe/workflows-ui";
import { runWorkflowAgent } from "./agent-runner";
import { assistantProviderConfig, ASSISTANT_TOOLS } from "./assistant";
import { loadGuideFromDisk, saveGuideToDisk } from "./disk-storage";
import { save } from "@tauri-apps/plugin-dialog";
import { commands } from "@/lib/utils/tauri";
import { open } from "@tauri-apps/plugin-shell";
import { writeTextFile } from "@tauri-apps/plugin-fs";

export const desktopGuides: NonNullable<WorkflowsPlatform["guides"]> = {
  async openWeb(guide) {
    const token = await commands.getCloudToken();
    if (!token)
      throw new Error("Sign in to Screenpipe to open your SOP on the web.");
    const response = await fetch("https://screenpipe.com/api/sops", {
      method: "POST",
      signal: AbortSignal.timeout(30000),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        workflowKey: guide.workflowKey,
        title: guide.title,
        content: guideMarkdown(guide),
      }),
    });
    if (!response.ok)
      throw new Error(
        "Could not open the web editor. Your SOP is saved on this device.",
      );
    const result = await response.json();
    if (typeof result.id !== "string" || !/^[a-f0-9-]{36}$/.test(result.id))
      throw new Error("The web editor returned an invalid page.");
    await open(`https://screenpipe.com/sops/${result.id}`);
  },
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
      filters: [{ name: "HTML SOP", extensions: ["html"] }],
    });
    if (!path) return false;
    await writeTextFile(path, html);
    return true;
  },
};

/** Edits run in the same local harness as creation; only the validated draft is saved. */
desktopGuides.edit = async (guide, workflow, instruction, signal, progress) => {
  const text = await runWorkflowAgent({
    name: "guide",
    signal,
    config: {
      ...assistantProviderConfig,
      maxTokens: 8192,
      allowedTools: ASSISTANT_TOOLS,
    },
    prompt: `${guidePrompt(workflow)}\nThis is an editing request. Preserve existing content unless the user asks to change it. Never render, share or execute anything.\nCurrent editable SOP:\n${JSON.stringify(guide)}\nUser edit request:\n${instruction}`,
    onProgress: () => progress("Editing your SOP"),
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
};
