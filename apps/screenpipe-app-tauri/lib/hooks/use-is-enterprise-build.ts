"use client";

import { useState, useEffect } from "react";
import { commands } from "@/lib/utils/tauri";

// Module-level cache: one IPC call shared across all components.
let cachedResult: boolean | null = null;
let pendingPromise: Promise<boolean> | null = null;

export const E2E_FORCE_ENTERPRISE_BUILD_KEY = "screenpipe_e2e_force_enterprise_build";

function isE2eEnterpriseForced(): boolean {
  if (process.env.NEXT_PUBLIC_SCREENPIPE_E2E !== "true" || typeof window === "undefined") {
    return false;
  }
  try {
    return window.localStorage?.getItem(E2E_FORCE_ENTERPRISE_BUILD_KEY) === "1";
  } catch {
    return false;
  }
}

async function resolveEnterpriseBuild(): Promise<boolean> {
  if (isE2eEnterpriseForced()) {
    cachedResult = true;
    return true;
  }
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
