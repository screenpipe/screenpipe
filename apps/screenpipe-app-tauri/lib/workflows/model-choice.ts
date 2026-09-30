// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { listen } from "@tauri-apps/api/event";
import { parsePipeSessionId } from "@/lib/events/types";
import { WORKFLOW_TASKS } from "./scheduled-discovery";
import { exists, readTextFile, writeTextFile, rename, remove } from "@tauri-apps/plugin-fs";
import { commands } from "@/lib/utils/tauri";
import { parseWorkflowModel, type WorkflowModelPreference } from "@screenpipe/workflows-ui";

async function path() {
  const base = await commands.getScreenpipeBaseDir();
  if (base.status === "error") throw new Error("Could not open Workflows settings.");
  return `${base.data}/workflows-model.json`;
}
export const workflowModelPreference: WorkflowModelPreference = {
  verification: {
    subscribe: listener => listen<{ source: string; sessionId: string; event: Record<string, unknown> }>("agent_event", ({ payload }) => {
      const pipe = payload.source === "pipe" ? parsePipeSessionId(payload.sessionId) : null;
      if ((payload.source === "pi" && payload.sessionId.startsWith("__title:workflow-"))
        || (pipe && WORKFLOW_TASKS.some(task => task === pipe.pipeName))) listener(payload);
    }),
  },
  async load() {
    const file = await path();
    return parseWorkflowModel(await exists(file) ? await readTextFile(file) : null);
  },
  async save(mode) {
    if (mode !== "private" && mode !== "intelligent") throw new Error("Unsupported AI choice");
    const file = await path();
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      await writeTextFile(temporary, JSON.stringify({ mode }));
      await rename(temporary, file);
    } finally { await remove(temporary).catch(() => {}); }
    window.dispatchEvent(new Event("workflows:model-changed"));
  },
};
