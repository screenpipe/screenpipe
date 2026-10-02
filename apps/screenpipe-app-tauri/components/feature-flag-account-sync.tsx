// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";

import { useEffect } from "react";
import posthog from "posthog-js";
import { useSettings } from "@/lib/hooks/use-settings";

/** Account-based rollouts must not depend on analytics ingestion or opt-in. */
export function FeatureFlagAccountSync({ ready }: { ready: boolean }) {
  const { settings, isSettingsLoaded } = useSettings();
  const email = settings.user?.email ?? null;
  useEffect(() => {
    if (!ready || !isSettingsLoaded) return;
    // Evaluate the server's existing rules with the current account. Null clears
    // this property on logout without removing other feature-flag properties.
    // This does not identify a person, capture an event, or enable analytics.
    posthog.setPersonPropertiesForFlags({ email });
  }, [ready, isSettingsLoaded, email]);
  return null;
}
