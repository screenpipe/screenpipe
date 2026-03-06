// Screenpipe Enterprise Edition
// Licensed under the Screenpipe Enterprise License (see ee/LICENSE)

"use client";

import { ReactNode } from "react";
import { EnterpriseState } from "../hooks/use-enterprise";

interface EnterpriseSettingsGuardProps {
  enterprise: EnterpriseState;
  settingKey?: string;
  sectionId?: string;
  children: ReactNode;
}

/**
 * Wraps a settings section or control.
 * - Hides the section entirely if admin policy says so.
 * - Renders a "managed by" overlay if the setting is locked.
 */
export function EnterpriseSettingsGuard({
  enterprise,
  settingKey,
  sectionId,
  children,
}: EnterpriseSettingsGuardProps) {
  if (!enterprise.isEnterprise || !enterprise.policy) {
    return <>{children}</>;
  }

  if (sectionId && enterprise.isSectionHidden(sectionId)) {
    return null;
  }

  if (settingKey && enterprise.isSettingLocked(settingKey)) {
    return (
      <div className="relative">
        <div className="pointer-events-none opacity-60">{children}</div>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-xs bg-muted px-2 py-1 rounded">
            managed by {enterprise.policy.orgName || "your organization"}
          </span>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
