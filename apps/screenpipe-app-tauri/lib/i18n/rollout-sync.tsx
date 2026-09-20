// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";

import { useEffect, useRef } from "react";
import posthog from "posthog-js";
import { useSettings } from "@/lib/hooks/use-settings";
import { isPrimaryWindow } from "@/lib/utils/is-primary-window";

export const LOCALIZATION_FLAG = "desktop-localization";

/** Persist one resolved rollout decision for every webview and native surface. */
export function LocalizationRolloutSync({ ready }: { ready: boolean }) {
  const { settings, updateSettings, isSettingsLoaded } = useSettings();
  const current = useRef({ enabled: settings.uiLocalizationEnabled === true, updateSettings });
  current.current = { enabled: settings.uiLocalizationEnabled === true, updateSettings };

  useEffect(() => {
    if (!ready || !isSettingsLoaded || !isPrimaryWindow()) return;
    let cancelled = false;
    let pending = Promise.resolve();
    const unsubscribe = posthog.onFeatureFlags((_keys, variants, context) => {
      // An unavailable response is not a revocation. Retain the last decision
      // offline; new installs and pre-rollout settings default to false.
      if (context?.errorsLoading) return;
      const enabled = variants[LOCALIZATION_FLAG] === true;
      pending = pending.then(async () => {
        if (cancelled || enabled === current.current.enabled) return;
        await current.current.updateSettings({ uiLocalizationEnabled: enabled });
        current.current.enabled = enabled;
      }).catch((error) => {
        console.error("[localization] failed to persist PostHog rollout decision", error);
      });
    });
    return () => { cancelled = true; unsubscribe(); };
  }, [ready, isSettingsLoaded]);
  return null;
}
