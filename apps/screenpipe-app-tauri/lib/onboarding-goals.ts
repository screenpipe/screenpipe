// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { msg } from "gt-react";

export type OnboardingGoalCategory =
  | "work_memory"
  | "meeting_follow_through"
  | "work_patterns"
  | "process_automation"
  | "custom";

export type OnboardingChoiceCategory = OnboardingGoalCategory | "ai_context";

export type OnboardingGoalSuggestion = {
  category: Exclude<OnboardingGoalCategory, "custom">;
  title: string;
  description: string;
  prompt: string;
  preferredStorePipeSlugs: string[];
};

export type UserGoalCategory =
  | Exclude<OnboardingGoalCategory, "custom">
  | "default";

export const USER_GOAL_STORAGE_KEY = "screenpipe.user.goal-category.v1";
const LEGACY_HOME_FOCUS_STORAGE_KEY = "screenpipe.home.focus.v1";

const USER_GOAL_CATEGORIES = new Set<UserGoalCategory>([
  "default",
  "work_memory",
  "meeting_follow_through",
  "work_patterns",
  "process_automation",
]);

export const DEFAULT_USER_GOAL_CATEGORY: UserGoalCategory = "work_memory";

export const ONBOARDING_GOALS: OnboardingGoalSuggestion[] = [
  {
    category: "work_memory",
    title: msg("Ask about my work"),
    description: "Find anything I saw, heard, or did",
    prompt:
      "Build a personal work memory summary that helps me resume what I was doing, recover loose ends, and find the source-backed context behind recent work.",
    preferredStorePipeSlugs: ["digital-clone"],
  },
  {
    category: "meeting_follow_through",
    title: msg("Follow through after meetings"),
    description: "Keep decisions, owners, and next steps from getting lost",
    prompt:
      "Build a meeting follow-through summary with recent meeting context, explicit decisions, owned action items, unresolved questions, and source-backed next steps.",
    preferredStorePipeSlugs: ["meeting-intel"],
  },
  {
    category: "work_patterns",
    title: msg("Review my day"),
    description: "Tasks, meetings, and where my time went",
    prompt:
      "Build a daily review with source-backed tasks, meeting follow-through, and how I spent time across applications and projects.",
    preferredStorePipeSlugs: [
      "chronos-time-tracker",
      "daily-productivity-audit",
    ],
  },
  {
    category: "process_automation",
    title: msg("Automate repeated work"),
    description: "Turn real steps into a workflow or SOP",
    prompt:
      "Discover repeated captured work and surface concrete steps, exceptions, likely time cost, and one small human-reviewed automation opportunity.",
    preferredStorePipeSlugs: [
      "workflow-discovery",
      "workflow-automation-scout",
    ],
  },
];

export const ONBOARDING_GOAL_CHOICES = ONBOARDING_GOALS.filter(
  (goal) => goal.category !== "meeting_follow_through",
);

export function preferredStorePipeSlugs(
  category: OnboardingGoalCategory,
): string[] {
  if (category === "custom") return [];
  return (
    ONBOARDING_GOALS.find((candidate) => candidate.category === category)
      ?.preferredStorePipeSlugs ?? []
  );
}

export function normalizeUserGoalCategory(
  value: unknown,
): UserGoalCategory | null {
  return typeof value === "string" &&
    USER_GOAL_CATEGORIES.has(value as UserGoalCategory)
    ? (value as UserGoalCategory)
    : null;
}

/**
 * Read the pre-settings-store goal once during migration. This deliberately
 * does not write or delete anything: the caller clears the legacy keys only
 * after store.bin has been saved successfully.
 */
export function readLegacyUserGoalCategory(): UserGoalCategory {
  if (typeof window === "undefined") return DEFAULT_USER_GOAL_CATEGORY;
  try {
    const stored = normalizeUserGoalCategory(
      window.localStorage.getItem(USER_GOAL_STORAGE_KEY),
    );
    if (stored) return stored;

    const legacy = normalizeUserGoalCategory(
      window.localStorage.getItem(LEGACY_HOME_FOCUS_STORAGE_KEY),
    );
    if (legacy) return legacy;

    return DEFAULT_USER_GOAL_CATEGORY;
  } catch {
    return DEFAULT_USER_GOAL_CATEGORY;
  }
}

export function clearLegacyUserGoalCategory(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(USER_GOAL_STORAGE_KEY);
    window.localStorage.removeItem(LEGACY_HOME_FOCUS_STORAGE_KEY);
  } catch {
    // The durable settings value already won; stale legacy state is harmless.
  }
}
