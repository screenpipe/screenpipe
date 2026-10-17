// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { guideScreenshot, guideSourceStage, guideStepIncludesImage, type WorkflowGuide } from "@screenpipe/workflows-ui";
import type { WorkflowMap } from "@screenpipe/workflows-ui/model";
import { loadOriginalWorkflowScreenshot } from "./original-screenshot";
import { findWorkflowScreenshot } from "./source-screenshot";
import { screenpipeWebUrl, PROD_WEB_BASE } from "@/lib/web-url";

/** Called only by the user's Share/Open on web action, never background sync. */
export async function uploadGuideImages(guide: WorkflowGuide, workflow: WorkflowMap, token: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  const images: Record<string, string> = {};
  const uploaded = new Map<number, string>();
  try {
    for (const [index, step] of guide.steps.entries()) {
      if (!guideStepIncludesImage(step)) continue;
      const stageIndex = guideSourceStage(guide, step, workflow);
      if (stageIndex === undefined) throw Error("Reconnect the SOP’s screenshot sources before sharing, or remove those images.");
      if (stageIndex === null) continue;
      const stage = workflow.stages[stageIndex];
      if (!stage) continue;
      let source = guideScreenshot(workflow, stageIndex, step.imageReview);
      if (!source && step.imageReview) throw Error("A selected image is unavailable. Remove or replace it before sharing.");
      if (!source) {
        for (const evidence of stage.evidence ?? []) {
          if (["audio", "meeting"].includes(evidence.source ?? "") || !evidence.app || !Number.isFinite(Date.parse(evidence.timestamp))) continue;
          source = await findWorkflowScreenshot(evidence.timestamp, evidence.app, controller.signal);
          if (source) break;
        }
      }
      if (!source) continue;
      let url = uploaded.get(source.frameId);
      if (!url) {
        const original = await loadOriginalWorkflowScreenshot(source.frameId, controller.signal);
        const blob = await shareImage(original);
        controller.signal.throwIfAborted();
        const response = await fetch(screenpipeWebUrl("/api/sops/images", PROD_WEB_BASE), {
          method: "POST", signal: controller.signal,
          headers: { Authorization: `Bearer ${token}`, "Content-Type": blob.type }, body: blob,
        });
        if (!response.ok) throw Error("An image could not be uploaded. Your SOP is saved on this device. Try again or remove the image.");
        const result = await response.json();
        if (typeof result.url !== "string" || !/^\/api\/sops\/images\/[a-f0-9]{64}\/[a-f0-9]{64}$/.test(result.url))
          throw Error("Invalid screenshot upload response.");
        url = result.url as string;
        uploaded.set(source.frameId, url);
      }
      images[`step/${step.blockId ?? `step-${index}`}`] = url;
    }
    return images;
  } finally { clearTimeout(timer); controller.abort(); }
}

async function shareImage(original: Blob): Promise<Blob> {
  if (original.size <= 3 * 1024 * 1024) return original;
  const bitmap = await createImageBitmap(original);
  try {
    const scale = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
    const context = canvas.getContext("2d");
    if (!context) throw Error("Could not prepare screenshot.");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", 0.9));
    if (!blob || blob.size > 3 * 1024 * 1024) throw Error("An image is too large to share. Remove or replace it.");
    return blob;
  } finally { bitmap.close(); }
}
