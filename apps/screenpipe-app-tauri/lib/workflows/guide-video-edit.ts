// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { videoEditPrompt, applyVideoEdit, parseVideoEdit, type VideoEdit, type GuideVideoPlatform } from "@screenpipe/workflows-ui";
import { runWorkflowAgent } from "./agent-runner";
import { stageVideoProject } from "./video-project";
import { adoptAgentVideo } from "./guide-video";
import posthog from "posthog-js";
import { assistantProviderConfig } from "./assistant";

export const editGuideVideo: NonNullable<GuideVideoPlatform["edit"]> = async (draft, instruction, history, signal, progress, scenes = []) => {
  let patch: VideoEdit | null = null;
  let rendered = false;
  let renderAttempted = false;
  // The project is read on demand. The initial prompt contains only the request and bounded conversation.
  const project = await stageVideoProject(draft, scenes, signal);
  try {
  const message = await runWorkflowAgent({
    projectPath: project.path,
    name: "guide", signal, allowEmpty: true, timeoutMs: 900000,
    config: { ...assistantProviderConfig, maxTokens: 8192, allowedTools: ["read_video_sop", "edit_video_sop", "render_video_sop"] },
    prompt: videoEditPrompt(instruction, history),
    onProgress: progress,

    onEvent: event => {
      if (event.toolName === "render_video_sop") {
        if (event.type === "tool_execution_start") { renderAttempted = true; posthog.capture("workflow_video_started", {sections: draft.scenes.length}); }
        if (event.type === "tool_execution_end") {
          if (!event.isError) rendered = true;
          posthog.capture(!event.isError ? "workflow_video_completed" : "workflow_video_failed");
        }
      }
      if (event.type !== "tool_execution_end" || event.toolName !== "edit_video_sop" || event.isError) return;
      if (patch) throw new Error("Use one combined video edit per answer.");
      patch = parseVideoEdit(JSON.parse(event.result?.content?.find(part => typeof part.text === "string")?.text || "null"));
    },
  });
  signal.throwIfAborted();
  const edit = patch as VideoEdit | null;
  const next = edit ? applyVideoEdit(draft, edit) : draft;
  const changed = JSON.stringify(next) !== JSON.stringify(draft);
  const result = rendered ? await adoptAgentVideo(project.path, signal) : undefined;
  return { draft: next, changed, render: false, result, message };
  } catch (error) {
    if (renderAttempted && signal.aborted) posthog.capture("workflow_video_cancelled");
    throw error;
  } finally { await project.dispose().catch(() => {}); }
};
