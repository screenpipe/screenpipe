// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import type { StorageCapacity } from "@/lib/utils/tauri";
export type { StorageCapacity };
export type RetentionChoice = {
  localRetentionEnabled?: boolean;
  localRetentionMode?: string;
  localRetentionDays?: number;
  storageRetentionDefaultDays?: number;
};
export const STORAGE_ADVICE_COOLDOWN = 7 * 24 * 60 * 60 * 1000;
export const gib = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);

export function canRecommendMedia(choice: RetentionChoice) {
  return (
    !choice.localRetentionEnabled ||
    ((choice.localRetentionMode ?? "media") === "media" &&
      (choice.localRetentionDays ?? 14) > 7)
  );
}

export function storageNoticeKind(
  capacity: StorageCapacity,
  choice: RetentionChoice,
) {
  if (
    choice.storageRetentionDefaultDays === 7 &&
    choice.localRetentionEnabled &&
    choice.localRetentionDays === 7 &&
    (choice.localRetentionMode ?? "media") === "media"
  )
    return "default";
  // The existing capture-stop notification owns the critical <=5 GiB state.
  if (
    capacity.lowSpace &&
    capacity.availableBytes > 5 * 1024 ** 3 &&
    canRecommendMedia(choice)
  )
    return "pressure";
  return null;
}

export function buildStorageNotice(
  kind: "default" | "pressure",
  capacity: StorageCapacity,
  now = Date.now(),
) {
  return {
    id: `storage-advice-${kind}-${now}`,
    type: "storage_advice",
    priority: "normal",
    transient: false,
    title:
      kind === "default"
        ? "Your media history is set to 7 days"
        : "Your recording drive is running low",
    body:
      kind === "default"
        ? "Screenpipe chose a shorter media history for your storage. Older video and audio will be removed; searchable text stays. Review or change this in Storage."
        : `${gib(capacity.availableBytes)} GB free of ${gib(capacity.totalBytes)} GB. Review a 7-day media policy to limit growth. Nothing changes until you confirm.`,
    actions: [
      {
        id: "review-storage",
        label: "Review storage",
        type: "deeplink",
        url: "screenpipe://settings?section=storage",
        primary: true,
      },
    ],
  };
}
