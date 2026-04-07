"use client";

import { useState, useEffect } from "react";
import { commands } from "@/lib/utils/tauri";

// Module-level cache: one IPC call shared across all components.
let cachedResult: boolean | null = null;
let pendingPromise: Promise<boolean> | null = null;

async function resolveEnterpriseBuild(): Promise<boolean> {
  if (cachedResult !== null) return cachedResult;
  if (pendingPromise) return pendingPromise;

  pendingPromise = (async () => {
    for (let i = 0; i < 3; i++) {
      try {
        const result = await commands.isEnterpriseBuildCmd();
        cachedResult = result;
        if (i === 0) {
          console.log(`[enterprise] isEnterpriseBuild = ${result}`);
        }
        return result;
      } catch {
        if (i < 2) await new Promise((r) => setTimeout(r, 500));
      }
    }
    cachedResult = false;
    return false;
  })();

  return pendingPromise;
}

/** True when running the enterprise build (updates managed by IT). */
export function useIsEnterpriseBuild(): boolean {
  const [isEnterprise, setIsEnterprise] = useState(cachedResult ?? false);

  useEffect(() => {
    if (cachedResult !== null) {
      setIsEnterprise(cachedResult);
      return;
    }
    let cancelled = false;
    resolveEnterpriseBuild().then((result) => {
      if (!cancelled) setIsEnterprise(result);
    });
    return () => { cancelled = true; };
  }, []);

  return isEnterprise;
}
