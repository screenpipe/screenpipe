// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { guideImage, type WorkflowsPlatform } from "@screenpipe/workflows-ui";
import {
  mkdir,
  writeTextFile,
  readFile,
  copyFile,
} from "@tauri-apps/plugin-fs";
import { save } from "@tauri-apps/plugin-dialog";
import { commands } from "@/lib/utils/tauri";
import { runWorkflowAgent } from "./agent-runner";
import { assistantProviderConfig } from "./assistant";

export const guideVideo: NonNullable<
  NonNullable<WorkflowsPlatform["guides"]>["video"]
> = {
  async render(guide, workflow, images, signal, progress) {
    const scenes = guide.steps.map((s) => ({
      title: s.title,
      narration: s.narration ?? s.instruction,
      image:
        images &&
        s.includeImage &&
        guide.sourceRevision === (workflow.revision ?? 0)
          ? guideImage(workflow, s.sourceStage)
          : null,
    }));
    if (
      scenes.length > 12 ||
      scenes.some((s) => !s.narration.trim() || [...s.narration].length > 800)
    )
      throw new Error(
        "Use up to 12 scenes, each with 1–800 characters of narration.",
      );
    const base = await commands.getScreenpipeBaseDir();
    if (base.status === "error")
      throw new Error("Could not open your local workspace.");
    const jobId = crypto.randomUUID();
    const directory = `${base.data}/pi-workflows-guide/guide-media/${jobId}`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeTextFile(`${directory}/scenes.json`, JSON.stringify(scenes), {
      mode: 0o600,
    });
    let completed = false;
    await runWorkflowAgent({
      name: "guide",
      signal,
      allowEmpty: true,
      timeoutMs: 900000,
      config: {
        ...assistantProviderConfig,
        allowedTools: ["render_guide_video"],
        maxTokens: 512,
      },
      prompt: `The user reviewed this video script and requested rendering. Call render_guide_video exactly once with jobId ${jobId}. Do not edit, search, publish, retry a failed render or call other tools. Report the result briefly.`,
      onEvent: (event) => {
        if (event.toolName !== "render_guide_video") return;
        const message = (
          event.type === "tool_execution_update"
            ? event.partialResult
            : event.result
        )?.content?.find((part) => typeof part.text === "string")?.text;
        if (event.type === "tool_execution_update" && message)
          progress(message);
        if (event.type === "tool_execution_end") {
          if (event.isError)
            throw new Error(
              message || "Video rendering failed. Your guide is saved.",
            );
          const receipt = JSON.parse(message || "null");
          if (receipt?.jobId !== jobId || receipt?.filename !== "guide.mp4")
            throw new Error("The video was not saved. Try again.");
          completed = true;
        }
      },
    });
    if (signal.aborted) throw new DOMException("Stopped", "AbortError");
    if (!completed)
      throw new Error(
        "The assistant did not render the video. Your guide is saved.",
      );
    const path = `${directory}/guide.mp4`;
    const bytes = await readFile(path);
    const url = URL.createObjectURL(new Blob([bytes], { type: "video/mp4" }));
    return {
      url,
      dispose: () => URL.revokeObjectURL(url),
      async export() {
        const destination = await save({
          defaultPath: `${guide.title.replace(/[^a-zA-Z0-9 -]/g, "").slice(0, 80) || "guide"}.mp4`,
          filters: [{ name: "Video", extensions: ["mp4"] }],
        });
        if (!destination) return false;
        await copyFile(path, destination);
        return true;
      },
    };
  },
};
