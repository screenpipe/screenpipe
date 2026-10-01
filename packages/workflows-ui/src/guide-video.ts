// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { guideKey, guideScreenshot, guideStepIncludesImage, guideSourceStage, guideNeedsSourceReview, type WorkflowGuide } from "./guide";
import { parseVideoDraft, type VideoDraft, type VideoFocus } from "./video-tool";
import type { AssistantMessage, AssistantProgress } from "./assistant";
import type { WorkflowMap } from "./model";

export type GuideVideoScene = { title: string; narration: string; image: string | null; imageFrameId?: number; imageSourceId?: string; imageSources?: { timestamp: string; app: string }[]; id?: string; requiresImage?: boolean; pace?: number; focus?: VideoFocus | null };
export type GuideVideoResult = { url: string; path: string; captionsPath: string; captionsUrl?: string };
export type GuideVideoPlatform = {
  edit?: (draft: VideoDraft, instruction: string, history: AssistantMessage[], signal: AbortSignal, progress: (message: string | AssistantProgress) => void, scenes?: GuideVideoScene[]) => Promise<{ draft: VideoDraft; render: boolean; result?: GuideVideoResult; message: string; changed: boolean }>;
  generate: (scenes: GuideVideoScene[], signal: AbortSignal, progress: (message: string) => void) => Promise<GuideVideoResult>;
  export: (result: GuideVideoResult, title: string, captions: boolean) => Promise<boolean>;
  release: (result: GuideVideoResult) => Promise<void>;
};

/** Build the initial script from the reviewed SOP before applying explicit video edits. */
function baseGuideVideoScenes(guide: WorkflowGuide, workflow: WorkflowMap): GuideVideoScene[] {
  if (guide.workflowKey !== guideKey(workflow)) throw new Error("Open the SOP for this workflow before creating a video.");
  if (guideNeedsSourceReview(guide, workflow))
    throw new Error("Review the screenshot links below to use your saved SOP with the updated workflow.");
  if (guide.steps.some(step => !step.title.trim() || !step.instruction.trim()))
    throw new Error("Add a title and instruction to every SOP step before creating a video.");
  const scenes: GuideVideoScene[] = [];
  const add = (title: string, narration: string, image: string | null = null, imageFrameId?: number) => {
    if (narration.trim()) scenes.push({ title, narration: narration.trim(), image, ...(imageFrameId ? { imageFrameId } : {}) });
  };
  add(guide.title, guide.summary || guide.title);
  add("Before you start", guide.prerequisites.filter(Boolean).join("\n"));
  for (const [index, step] of guide.steps.entries()) {
    const sourceStage = guideSourceStage(guide, step, workflow) ?? null;
    const image = guideScreenshot(workflow, sourceStage, step.imageReview);
    const include = guideStepIncludesImage(step) && image;
    add(`${index + 1}. ${step.title}`, [step.instruction,
      step.expectedResult && `Expected result: ${step.expectedResult}`].filter(Boolean).join("\n"), include ? image.dataUrl || null : null, include ? image.frameId : undefined);
    const scene = scenes[scenes.length - 1];
    scene.requiresImage = true;
    if (!image && guideStepIncludesImage(step) && !step.imageReview && sourceStage !== null) {
      scene.imageSources = workflow.stages[sourceStage]?.evidence
        .filter(e => !["audio", "meeting"].includes(e.source ?? "") && e.app && Number.isFinite(Date.parse(e.timestamp)))
        .slice(0, 3).map(e => ({ timestamp: e.timestamp, app: e.app! }));
    }
  }
  add("Exceptions", guide.exceptions.filter(Boolean).join("\n"));
  add("Check your result", guide.completion.filter(Boolean).join("\n"));
  add("Questions to resolve", guide.questions.filter(Boolean).join("\n"));
  if (!guide.steps.length || !scenes.length) throw new Error("Add instructions to your SOP first.");
  if (scenes.length > 50 || scenes.some(s => [...s.title].length > 140) ||
      scenes.reduce((count, s) => count + [...s.narration].length, 0) > 18000)
    throw new Error("This SOP is too long for one video. Shorten it or split it into separate SOPs.");
  return scenes;
}

/** A fingerprint detects SOP changes without storing another copy of its text. */
function sourceHash(scenes: GuideVideoScene[]): string {
  let hash = 14695981039346656037n;
  const text = JSON.stringify(scenes.map(({ title, narration, image, imageFrameId, imageSources }) => ({ title, narration, hasImage: !!image || !!imageFrameId, imageFrameId, ...(imageSources?.length ? { imageSources } : {}) })));
  for (const char of text) hash = BigInt.asUintN(64, (hash ^ BigInt(char.codePointAt(0)!)) * 1099511628211n);
  return hash.toString(16);
}
export function guideVideoDraft(guide: WorkflowGuide, workflow: WorkflowMap): VideoDraft {
  const base = baseGuideVideoScenes(guide, workflow);
  const hash = sourceHash(base);
  if (guide.video) {
    const draft = parseVideoDraft(guide.video);
    if (draft.sourceHash !== hash || draft.scenes.some(s => (!base[Number(s.id.slice(8))] || (s.imageSourceId !== undefined && !base[Number(s.imageSourceId.slice(8))]))))
      throw new Error("The SOP changed after this video script was edited. Reset the video script to use the current SOP.");
    return draft;
  }
  return { version: 1, sourceHash: hash, scenes: base.flatMap((s, i) => s.requiresImage ? [{ id: `section-${i}`, title: s.title, narration: s.narration, includeImage: !!s.image || !!s.imageFrameId || !!s.imageSources?.length }] : []) };
}
export function guideVideoScenes(guide: WorkflowGuide, workflow: WorkflowMap, includeImages = true): GuideVideoScene[] {
  const base = baseGuideVideoScenes(guide, workflow);
  return guideVideoDraft(guide, workflow).scenes.map(s => {
    const image = includeImages && s.includeImage ? base[Number((s.imageSourceId ?? s.id).slice(8))] : undefined;
    return { id: s.id, ...(s.imageSourceId ? { imageSourceId: s.imageSourceId } : {}), title: s.title, narration: s.narration, image: image?.image ?? null, requiresImage: base[Number(s.id.slice(8))].requiresImage, pace: s.pace ?? 1, focus: s.focus ?? null, ...(image?.imageSources?.length ? { imageSources: image.imageSources } : {}), ...(image?.imageFrameId ? { imageFrameId: image.imageFrameId } : {}) };
  });
}

/** Rendering cannot silently substitute a text card for a procedural screenshot. */
export function videoScreenshotGaps(scenes: GuideVideoScene[]): string[] {
  return scenes.filter(s => s.requiresImage && !s.image && !s.imageFrameId && !s.imageSources?.length).map(s => s.title);
}

/** Reconnect only source references. Keep the user's document and video wording. */
export function reconnectGuideSources(guide: WorkflowGuide, workflow: WorkflowMap, sources: Array<number | null>): WorkflowGuide {
  if (guide.workflowKey !== guideKey(workflow) || sources.length !== guide.steps.length || sources.some(index => index !== null && (!Number.isInteger(index) || !workflow.stages[index]))) throw new Error("Choose a current workflow step for each screenshot link.");
  const next: WorkflowGuide = { ...guide, sourceRevision: workflow.revision ?? 0, steps: guide.steps.map((step, i) => {
    const { imageReview: previous, ...rest } = step;
    const image = guideScreenshot(workflow, sources[i], previous) ?? guideScreenshot(workflow, sources[i]);
    return { ...rest, sourceStage: sources[i], ...(image ? { imageReview: { frameId: image.frameId, timestamp: image.timestamp } } : {}) };
  }) };
  if (guide.video) {
    const { video: _video, ...base } = next;
    const current = guideVideoDraft(base, workflow);
    next.video = { ...guide.video, sourceHash: current.sourceHash, scenes: guide.video.scenes.map(scene => ({ ...scene, focus: null })) };
    guideVideoScenes(next, workflow);
  }
  return next;
}
