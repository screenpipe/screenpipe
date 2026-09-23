// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import type { WorkflowScreenshot, WorkflowStage } from "./model";

// New catalogs store an array; legacy catalogs may still have one image.
export function stageScreenshots(stage: WorkflowStage): WorkflowScreenshot[] {
  const seen = new Set<number>();
  return [...(stage.screenshots ?? []), ...(stage.screenshot ? [stage.screenshot] : [])]
    .filter(image => image && Number.isSafeInteger(image.frameId) && image.frameId > 0
      && !seen.has(image.frameId) && !!seen.add(image.frameId));
}
export function verifiedStageScreenshots(stage: WorkflowStage): WorkflowScreenshot[] {
  return stageScreenshots(stage).filter(image => image.visualVerified && !!image.dataUrl);
}
