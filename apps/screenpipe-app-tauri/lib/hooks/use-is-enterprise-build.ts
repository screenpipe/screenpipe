"use client";

import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

/** True when running the enterprise build (updates managed by IT). */
export function useIsEnterpriseBuild(): boolean {
  const [isEnterprise, setIsEnterprise] = useState(false);

  useEffect(() => {
    invoke<boolean>("is_enterprise_build_cmd")
      .then(setIsEnterprise)
      .catch(() => setIsEnterprise(false));
  }, []);

  return isEnterprise;
}
