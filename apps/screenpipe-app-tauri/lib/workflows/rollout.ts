// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { useFeatureFlagEnabled } from "posthog-js/react";
import posthog from "posthog-js";

export const WORKFLOWS_FLAG = "workflows";
export function isWorkflowsRolloutEnabled(flag: unknown): boolean {
  return flag === true;
}
export function useWorkflowsRolloutDecision(): boolean | undefined {
  const flag = useFeatureFlagEnabled(WORKFLOWS_FLAG);
  if (process.env.NEXT_PUBLIC_SCREENPIPE_WEB_DEV === "mock") return true;
  return flag === undefined ? undefined : isWorkflowsRolloutEnabled(flag);
}
export function useWorkflowsRolloutEnabled(): boolean {
  return useWorkflowsRolloutDecision() === true;
}
export function requireWorkflowsRollout(): void {
  if (!isWorkflowsRolloutEnabled(posthog.isFeatureEnabled?.(WORKFLOWS_FLAG))) {
    throw new Error("Workflows is not available for this account yet.");
  }
}
