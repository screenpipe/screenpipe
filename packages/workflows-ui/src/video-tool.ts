// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
/** Scoped video tools run inside the normal agent, using the bundled renderer CLI. */
export type VideoFocus = { x: number; y: number; zoom: number };
export type VideoDraft = { version: 1; sourceHash: string; scenes: Array<{ id: string; title: string; narration: string; includeImage: boolean; imageSourceId?: string; pace?: number; focus?: VideoFocus | null }> };
export type VideoEdit = { changes: Array<{ id: string; title?: string; narration?: string; maxNarrationWords?: number; includeImage?: boolean; imageSourceId?: string; pace?: number; focus?: VideoFocus | null }>; order?: string[]; render: boolean };
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max: number) => typeof v === "string" && !!v.trim() && [...v].length <= max;
const presentation = (s: Record<string, any>) =>
  (s.imageSourceId === undefined || (typeof s.imageSourceId === "string" && /^section-\d+$/.test(s.imageSourceId))) &&
  (s.pace === undefined || (typeof s.pace === "number" && Number.isFinite(s.pace) && s.pace >= 0.85 && s.pace <= 1.25)) &&
  (s.focus === undefined || s.focus === null || (record(s.focus) && Object.keys(s.focus).every(k => ["x", "y", "zoom"].includes(k)) &&
    [s.focus.x, s.focus.y, s.focus.zoom].every(v => typeof v === "number" && Number.isFinite(v)) &&
    s.focus.x >= 0 && s.focus.x <= 1 && s.focus.y >= 0 && s.focus.y <= 1 && s.focus.zoom >= 1 && s.focus.zoom <= 1.6));
export function parseVideoDraft(value: unknown): VideoDraft {
  if (!record(value) || value.version !== 1 || !text(value.sourceHash, 32) || !Array.isArray(value.scenes) || !value.scenes.length || value.scenes.length > 50 ||
      value.scenes.some(s => !record(s) || !/^section-\d+$/.test(s.id) || !text(s.title, 140) || !text(s.narration, 18000) || typeof s.includeImage !== "boolean" || !presentation(s)) ||
      new Set(value.scenes.map(s => s.id)).size !== value.scenes.length || value.scenes.reduce((n, s) => n + [...s.narration].length, 0) > 18000) throw new Error("Invalid video draft. Your saved script is unchanged.");
  return { version: 1, sourceHash: value.sourceHash, scenes: value.scenes.map(({ id, title, narration, includeImage, imageSourceId, pace, focus }) => ({ id, title, narration, includeImage, ...(imageSourceId !== undefined ? { imageSourceId } : {}), ...(pace !== undefined ? { pace } : {}), ...(focus !== undefined ? { focus } : {}) })) };
}
export function parseVideoEdit(value: unknown): VideoEdit {
  if (!record(value) || Object.keys(value).some(k => !["changes", "order", "render"].includes(k)) || typeof value.render !== "boolean" || !Array.isArray(value.changes) || value.changes.length > 50 ||
      value.changes.some(c => !record(c) || !/^section-\d+$/.test(c.id) || Object.keys(c).some(k => !["id", "title", "narration", "maxNarrationWords", "includeImage", "imageSourceId", "pace", "focus"].includes(k)) ||
        (c.maxNarrationWords !== undefined && (!Number.isInteger(c.maxNarrationWords) || c.maxNarrationWords < 1 || c.maxNarrationWords > 18000)) || (c.title !== undefined && !text(c.title, 140)) || (c.narration !== undefined && !text(c.narration, 18000)) || (c.includeImage !== undefined && typeof c.includeImage !== "boolean") || !presentation(c)) ||
      new Set(value.changes.map(c => c.id)).size !== value.changes.length ||
      (value.order !== undefined && (!Array.isArray(value.order) || !value.order.length || value.order.length > 50 || value.order.some(id => typeof id !== "string" || !/^section-\d+$/.test(id)) || new Set(value.order).size !== value.order.length)))
    throw new Error("Invalid video edit. Your saved script is unchanged.");
  return value as VideoEdit;
}
export function applyVideoEdit(draft: VideoDraft, input: unknown): VideoDraft {
  const edit = parseVideoEdit(input);
  const ids = new Set(draft.scenes.map(s => s.id));
  if ([...edit.changes.map(c => c.id), ...(edit.order ?? [])].some(id => !ids.has(id))) throw new Error("The video edit references an unknown section.");
  const changes = new Map(edit.changes.map(c => [c.id, c]));
  const scenes = draft.scenes.map(s => {
    const change = changes.get(s.id);
    const { maxNarrationWords, ...fields } = change ?? {};
    const next = { ...s, ...fields };
    if (change?.imageSourceId !== undefined && change.imageSourceId !== (s.imageSourceId ?? s.id) && change.focus === undefined) next.focus = null;
    if (maxNarrationWords !== undefined && next.narration.trim().split(/\s+/u).length > maxNarrationWords) throw new Error(`Narration for ${s.id} exceeds ${maxNarrationWords} words. Shorten it while preserving required actions and exceptions, then retry.`);
    if (change?.focus && !next.includeImage) throw new Error("Include the screenshot before setting its focus.");
    if (!next.includeImage && next.focus) next.focus = null;
    return next;
  });
  return parseVideoDraft({ ...draft, scenes: edit.order ? edit.order.map(id => scenes.find(s => s.id === id)!) : scenes });
}
export default function videoTool(pi: any) {
  let draft: VideoDraft | null = null;
  let proposed = false;
  let rendered = false;
  const inspected = new Set<string>();
  pi.registerTool({
    name: "read_video_sop", label: "Inspect video project",
    description: "Read the attached video project before editing. With guidance:true, load the video editing skill. With scene_id, inspect that section's actual screenshot. Load images only when needed. A missing screenshot is not visual evidence.",
    parameters: { type: "object", additionalProperties: false, properties: { guidance: { type: "boolean" }, scene_id: { type: "string", pattern: "^section-\\d+$" } } },
    async execute(_id: string, args: { guidance?: boolean; scene_id?: string }, _signal: AbortSignal, _update: unknown, ctx: { cwd: string; model?: { input?: string[] } }) {
      const module = "node:fs/promises";
      const fs = await import(/* @vite-ignore */ module);
      if (args.guidance) return { content: [{ type: "text", text: await fs.readFile(`${ctx.cwd}/.pi/skills/video-sop/SKILL.md`, "utf8") }] };
      const path = `${ctx.cwd}/video-project.json`;
      if ((await fs.stat(path)).size > 100000) throw new Error("Video project is too large.");
      const project = JSON.parse(await fs.readFile(path, "utf8"));
      draft ??= parseVideoDraft(project.draft);
      if (!args.scene_id) return { content: [{ type: "text", text: JSON.stringify({ ...draft, screenshots: Object.keys(project.images ?? {}), missingScreenshots: draft.scenes.filter(s => project.requiredImages?.includes(s.id) && (!s.includeImage || !project.images?.[s.imageSourceId ?? s.id])).map(s => s.id) }) }] };
      if (!/^section-\d+$/.test(args.scene_id) || (!draft.scenes.some(s => s.id === args.scene_id) && !project.images?.[args.scene_id])) throw new Error("Unknown video section.");
      const sourceId = draft.scenes.find(s => s.id === args.scene_id)?.imageSourceId ?? args.scene_id;
      const mimeType = project.images?.[sourceId];
      if (!["image/png", "image/jpeg", "image/webp"].includes(mimeType)) return { content: [{ type: "text", text: "No reviewed screenshot is available for this section. Do not invent a visual or focus region." }] };
      if (!ctx.model?.input?.includes("image")) return { content: [{ type: "text", text: "The selected model cannot inspect screenshots. Wording and pacing edits still work. Ask the user to select an image-capable model for visual focus edits; do not switch providers or guess a focus region." }] };
      const image = `${ctx.cwd}/${sourceId}.image`;
      if ((await fs.stat(image)).size > 12000000) throw new Error("Screenshot is too large.");
      const data = (await fs.readFile(image)).toString("base64");
      inspected.add(sourceId);
      return { content: [{ type: "image", mimeType, data }] };
    },
  });
  pi.registerTool({
    name: "edit_video_sop", label: "Edit video SOP",
    description: "Read the project and video skill with read_video_sop first. Inspect the actual section image before focusing. Pace 0.85–1.25; focus x/y normalized, zoom 1–1.6, null resets. Propose one combined patch to the attached video script. Existing section IDs only. Supply order to reorder or omit sections. Render true only when the user explicitly asks to create/regenerate the video. A normal wording edit saves the script without generating speech. No files, media URLs, arbitrary commands or workflow execution. The app saves the validated draft. To create a video, call render_video_sop after editing and wait for its result.",
    parameters: { type: "object", additionalProperties: false, required: ["changes", "render"], properties: {
      changes: { type: "array", maxItems: 50, items: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string", pattern: "^section-\\d+$" }, title: { type: "string", minLength: 1, maxLength: 140 }, narration: { type: "string", minLength: 1, maxLength: 18000 }, maxNarrationWords: { type: "integer", minimum: 1, maximum: 18000, description: "When the user specifies a narration word limit, copy it here. The tool counts whitespace-separated words and rejects excess before accepting." }, includeImage: { type: "boolean" }, imageSourceId: { type: "string", pattern: "^section-\\d+$", description: "Use an inspected screenshot source from this project for this section. Set includeImage:true. Reuse only when it provides relevant visual context." }, pace: { type: "number", minimum: 0.85, maximum: 1.25 }, focus: { anyOf: [{ type: "null" }, { type: "object", additionalProperties: false, required: ["x", "y", "zoom"], properties: { x: { type: "number", minimum: 0, maximum: 1 }, y: { type: "number", minimum: 0, maximum: 1 }, zoom: { type: "number", minimum: 1, maximum: 1.6 } } }] } } } },
      order: { type: "array", minItems: 1, maxItems: 50, uniqueItems: true, items: { type: "string" } },
      render: { type: "boolean" },
    } },
    async execute(_id: string, input: unknown) {
      if (!draft) throw new Error("Read the attached project before editing it.");
      if (rendered) throw new Error("The video has already been created. Save further edits in a new turn.");
      if (proposed) throw new Error("Use one combined video edit per answer. A proposal was already accepted.");
      const edit = parseVideoEdit(input);
      if (edit.changes.some(c => c.imageSourceId && !inspected.has(c.imageSourceId))) throw new Error("Inspect the source screenshot before assigning it to another section.");
      if (edit.changes.some(c => c.focus && !inspected.has(c.imageSourceId ?? draft!.scenes.find(s => s.id === c.id)?.imageSourceId ?? c.id))) throw new Error("Inspect each screenshot before choosing its focus.");
      draft = applyVideoEdit(draft, edit);
      proposed = true;
      return { content: [{ type: "text", text: JSON.stringify(edit) }] };
    },
  });
  pi.registerTool({
    name: "render_video_sop", label: "Create video",
    description: "Create the attached video with narration, screenshots and captions using the bundled renderer CLI. Read the project and skill first. Apply any requested edits before calling. Only call for an explicit request to create or regenerate a video. Wait for the result; progress is streamed while it runs. One render attempt per turn. No arbitrary commands or paths.",
    parameters: { type: "object", additionalProperties: false, properties: {} },
    async execute(_id: string, _args: unknown, signal: AbortSignal, update: ((result: unknown) => void) | undefined, ctx: { cwd: string }) {
      if (!draft) throw new Error("Read the attached project before creating its video.");
      if (rendered) throw new Error("A video was already attempted in this turn. Ask the user before retrying.");
      signal?.throwIfAborted();
      const fsModule = "node:fs/promises", processModule = "node:child_process", envModule = "node:process";
      const fs = await import(/* @vite-ignore */ fsModule);
      const { spawn } = await import(/* @vite-ignore */ processModule);
      const { env } = await import(/* @vite-ignore */ envModule);
      const binary = env.SCREENPIPE_VIDEO_CLI;
      if (!binary) throw new Error("The video renderer is unavailable. Reopen the desktop app.");
      const project = JSON.parse(await fs.readFile(`${ctx.cwd}/video-project.json`, "utf8"));
      const scenes = draft.scenes.map(scene => {
        const sourceId = scene.imageSourceId ?? scene.id;
        const image = scene.includeImage && project.images?.[sourceId] ? `${ctx.cwd}/${sourceId}.image` : null;
        if (project.requiredImages?.includes(scene.id) && !image) throw new Error(`The screenshot for “${scene.title}” is unavailable. Inspect a relevant project screenshot, assign its imageSourceId with edit_video_sop, and retry. Ask for a new capture only if none fits.`);
        return { title: scene.title, narration: scene.narration, image, pace: scene.pace ?? 1, focus: scene.focus ?? null };
      });
      await fs.writeFile(`${ctx.cwd}/render-scenes.json`, JSON.stringify(scenes));
      signal?.throwIfAborted();
      rendered = true;
      await new Promise<void>((resolve, reject) => {
        const child = spawn(binary, ["--render-workflow-video", ctx.cwd], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
        let buffer = "", error = "", completed = false;
        const stop = () => child.stdin.end();
        const timeout = setTimeout(() => { error = "Video creation timed out. Try a shorter video."; stop(); }, 600000);
        signal?.addEventListener("abort", stop, { once: true });
        if (signal?.aborted) stop();
        child.stdin.on("error", () => {});
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          buffer += chunk;
          if (buffer.length > 65536) { error = "Invalid renderer output"; stop(); buffer = ""; return; }
          let newline: number;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
            try {
              const event = JSON.parse(line);
              if (typeof event.progress === "string") update?.({ content: [{ type: "text", text: event.progress.slice(0, 500) }] });
              if (typeof event.error === "string") error = event.error.slice(0, 1000);
              if (event.complete === true) completed = true;
            } catch { /* Non-protocol startup logging is not model context. */ }
          }
        });
        const cleanup = () => { clearTimeout(timeout); signal?.removeEventListener("abort", stop); };
        child.once("error", (cause: Error) => { cleanup(); reject(cause); });
        child.once("close", (code: number) => {
          cleanup();
          if (signal?.aborted) reject(new Error("Video creation stopped."));
          else if (code !== 0 || !completed || error) reject(new Error(error || "The video renderer did not finish."));
          else resolve();
        });
      });
      // Verify the files before reporting tool success to the model.
      for (const name of ["video.mp4", "captions.vtt"]) {
        if (!(await fs.stat(`${ctx.cwd}/rendered/${name}`)).size) throw new Error("The renderer returned an empty video or captions.");
      }
      return { content: [{ type: "text", text: JSON.stringify({ video: "rendered/video.mp4", captions: "rendered/captions.vtt", status: "ready" }) }] };
    },
  });

}
