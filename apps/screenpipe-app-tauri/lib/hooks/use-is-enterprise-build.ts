"use client";

import { useState, useEffect } from "react";
import { commands } from "@/lib/utils/tauri";

/** True when running the enterprise build (updates managed by IT). */
export function useIsEnterpriseBuild(): boolean {
  const [isEnterprise, setIsEnterprise] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function check() {
      // retry a few times — Tauri IPC may not be ready immediately
      for (let i = 0; i < 5; i++) {
        try {
          const result = await commands.isEnterpriseBuildCmd();
          if (!cancelled) {
            console.log(`[enterprise] isEnterpriseBuild = ${result} (attempt ${i + 1})`);
            setIsEnterprise(result);
          }
          return;
        } catch (e) {
          console.warn(`[enterprise] isEnterpriseBuildCmd failed (attempt ${i + 1}):`, e);
          if (i < 4) await new Promise((r) => setTimeout(r, 500));
        }
      }
      if (!cancelled) {
        console.error("[enterprise] isEnterpriseBuildCmd failed after 5 attempts");
        setIsEnterprise(false);
      }
    }

    check();
    return () => { cancelled = true; };
  }, []);

  return isEnterprise;
}
