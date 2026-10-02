// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { mkdir, writeFile, writeTextFile, remove, readDir, stat } from "@tauri-apps/plugin-fs";
import type { VideoDraft, GuideVideoScene } from "@screenpipe/workflows-ui";
import { commands } from "@/lib/utils/tauri";
import { findWorkflowScreenshot } from "./source-screenshot";
import { loadVideoScreenshot } from "./guide-video";

/** A turn-scoped project, with pixels outside the prompt and no account credentials. */
export async function stageVideoProject(draft: VideoDraft, scenes: GuideVideoScene[], signal: AbortSignal) {
  const base = await commands.getScreenpipeBaseDir();
  if (base.status === "error") throw new Error("Could not open the video workspace.");
  const root = `${base.data}/pi-workflows-guide/video-projects`;
  await mkdir(root, { recursive: true });
  // Only remove owned, day-old turn folders left after an application crash.
  const entries = (await readDir(root)).filter(entry => entry.isDirectory && !entry.isSymlink && /^[a-f0-9]{8}-[a-f0-9-]{27}$/.test(entry.name));
  for (const entry of entries.slice(0, 100)) {
    const directory = `${root}/${entry.name}`;
    try {
      const info = await stat(directory);
      if (info.mtime && Date.now() - info.mtime.getTime() > 86400000) await remove(directory, { recursive: true });
    } catch { /* Another turn may have already removed its directory. */ }
  }
  if (entries.length > 100) throw new Error("Too many temporary video projects. Close old edits and try again.");
  signal.throwIfAborted();
  const path = `${root}/${crypto.randomUUID()}`;
  await mkdir(path, { recursive: true });
  const dispose = () => remove(path, { recursive: true });
  try {
    const images: Record<string, string> = {};
    const cache = new Map<number, string | null>();
    let bytes = 0;
    for (const scene of scenes) {
      signal.throwIfAborted();
      if (!scene.id || !/^section-\d+$/.test(scene.id) || !draft.scenes.some(s => s.id === scene.id)) continue;
      const sourceId = scene.imageSourceId ?? scene.id;
      if (!/^section-\d+$/.test(sourceId) || images[sourceId]) continue;
      let data = scene.image;
      let frameId = scene.imageFrameId;
      if (!frameId && scene.imageSources?.length) {
        for (const source of scene.imageSources.slice(0, 3)) {
          const frame = await findWorkflowScreenshot(source.timestamp, source.app, signal);
          if (frame) { frameId = frame.frameId; break; }
        }
      }
      if (frameId) {
        if (!cache.has(frameId)) {
          try { cache.set(frameId, await loadVideoScreenshot(frameId, signal)); }
          catch { signal.throwIfAborted(); cache.set(frameId, null); }
        }
        data = cache.get(frameId) ?? null;
      }
      if (!data) continue;
      const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(data);
      if (!match) throw new Error("A video screenshot could not be read.");
      const image = Uint8Array.from(atob(match[2]), c => c.charCodeAt(0));
      bytes += image.length;
      if (image.length > 12000000 || bytes > 32000000) throw new Error("Use fewer screenshots in this video project.");
      await writeFile(`${path}/${sourceId}.image`, image);
      images[sourceId] = match[1];
    }
    signal.throwIfAborted();
    await writeTextFile(`${path}/video-project.json`, JSON.stringify({ draft, images, requiredImages: scenes.filter(scene => scene.requiresImage).map(scene => scene.id) }));
    return { path, dispose };
  } catch (error) { await dispose().catch(() => {}); throw error; }
}
