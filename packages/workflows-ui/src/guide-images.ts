// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { guideHtml, guideScreenshot, guideSourceStage, guideStepIncludesImage, type WorkflowGuide } from "./guide";
import type { WorkflowMap } from "./model";
import type { WorkflowsPlatform } from "./platform";

/** Only an explicit image export copies recorder pixels into the exported document. */
export async function exportGuideHtml(guide: WorkflowGuide, workflow: WorkflowMap, images: boolean,
  load?: WorkflowsPlatform["loadWorkflowScreenshot"]): Promise<string> {
  if (!images || !load || guide.sourceRevision !== (workflow.revision ?? 0)) return guideHtml(guide, workflow, images);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  const stages = workflow.stages.map(stage => ({ ...stage }));
  try {
    const selected = guide.steps.filter(guideStepIncludesImage).map(step => {
      const index = guideSourceStage(guide, step, workflow);
      return index == null ? null : { index, source: guideScreenshot(workflow, index, step.imageReview) };
    }).filter((item): item is NonNullable<typeof item> => item !== null);
    for (const { index, source } of selected) {
      if (!source) continue;
      const image = await load(source.timestamp, source.app, controller.signal, source.frameId);
      if (!image) throw new Error("A selected screenshot is no longer available. Remove it or export without screenshots.");
      try {
        const blob = await (await fetch(image.dataUrl, { signal: controller.signal })).blob();
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        });
        const capture = { ...source, dataUrl };
        const previous = stages[index].screenshots ?? [source];
        const matches = (image: typeof source) => image.frameId === capture.frameId && image.timestamp === capture.timestamp;
        const screenshots = previous.some(matches) ? previous.map(image => matches(image) ? capture : image) : [...previous, capture];
        stages[index] = { ...stages[index], screenshot: screenshots[0], screenshots };
      } finally { if (image.dataUrl.startsWith("blob:")) URL.revokeObjectURL(image.dataUrl); }
    }
    return guideHtml(guide, { ...workflow, stages }, true);
  } finally { clearTimeout(timeout); controller.abort(); }
}
