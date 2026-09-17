// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { useFeatureFlagEnabled } from "posthog-js/react";
import posthog from "posthog-js";

export const WORKFLOWS_FLAG = "workflows";
export function isWorkflowsRolloutEnabled(flag: unknown): boolean {
  return flag === true;
}
export function useWorkflowsRolloutEnabled(): boolean {
  const flag = useFeatureFlagEnabled(WORKFLOWS_FLAG);
  return process.env.NEXT_PUBLIC_SCREENPIPE_WEB_DEV === "mock" || isWorkflowsRolloutEnabled(flag);
}
export function requireWorkflowsRollout(): void {
  if (!isWorkflowsRolloutEnabled(posthog.isFeatureEnabled?.(WORKFLOWS_FLAG))) {
    throw new Error("Workflows is not available for this account yet.");
  }
}
