// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { useEffect } from "react";
import { useManagedPolicy } from "@/lib/hooks/use-managed-policy";
import { useSettings } from "@/lib/hooks/use-settings";
import { useStorageCapacity } from "@/lib/hooks/use-storage-capacity";
import { appServerFetch } from "@/lib/notifications/app-server";
import {
  buildStorageNotice,
  storageNoticeKind,
  STORAGE_ADVICE_COOLDOWN,
} from "@/lib/storage/advice";

/** Wait until after setup; sample only volume metadata, never the recording tree. */
export function StorageAdviceNotifier() {
  const policy = useManagedPolicy();
  const blocked =
    !policy.isManagedDeploymentResolved ||
    policy.isSectionHidden("storage") ||
    ["localRetentionEnabled", "localRetentionMode", "localRetentionDays"].some(
      policy.isSettingLocked,
    );
  const { settings } = useSettings();
  const { capacity, directory } = useStorageCapacity(60_000, 15 * 60_000);
  useEffect(() => {
    if (blocked || !capacity || !directory) return;
    const kind = storageNoticeKind(capacity, settings);
    if (!kind) return;
    const key = `storage-advice-v1:${directory}:${kind}`;
    let previous: number;
    try {
      previous = Number(localStorage.getItem(key) || 0);
      if (
        previous &&
        (kind === "default" || Date.now() - previous < STORAGE_ADVICE_COOLDOWN)
      )
        return;
      // Reserve delivery before the async request so rerenders cannot duplicate it.
      localStorage.setItem(key, String(Date.now()));
    } catch {
      return;
    } // No durable dedupe means no unsolicited repeated notice.
    void appServerFetch("/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildStorageNotice(kind, capacity, Date.now())),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Notification rejected");
        const receipt = await response.json();
        if (receipt.message === "notifications paused")
          throw new Error("Notification deferred");
      })
      .catch(() => {
        try {
          localStorage.setItem(key, String(previous));
        } catch {
          /* optional notice */
        }
      });
  }, [
    blocked,
    capacity,
    directory,
    settings.localRetentionEnabled,
    settings.localRetentionDays,
    settings.localRetentionMode,
    settings.storageRetentionDefaultDays,
  ]);
  return null;
}
