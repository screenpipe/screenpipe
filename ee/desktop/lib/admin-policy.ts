// Screenpipe Enterprise Edition
// Licensed under the Screenpipe Enterprise License (see ee/LICENSE)

/**
 * Enterprise admin policy.
 * Defines which settings are locked (forced values) and which UI sections are hidden.
 * Fetched from the server, pushed by the enterprise admin.
 */
export interface AdminPolicy {
  /** Settings forced to specific values - users cannot change these */
  lockedSettings: Record<string, unknown>;
  /** UI sections hidden in enterprise builds */
  hiddenSections: string[];
  /** Display name shown in "managed by" badges */
  orgName: string;
}

const POLICY_CACHE_KEY = "enterprise_admin_policy";
const POLICY_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

const EMPTY_POLICY: AdminPolicy = {
  lockedSettings: {},
  hiddenSections: [],
  orgName: "",
};

/**
 * Fetch admin policy for a license key.
 * Returns cached policy if network is unavailable.
 */
export async function fetchAdminPolicy(licenseKey: string): Promise<AdminPolicy> {
  try {
    const res = await fetch("https://screenpi.pe/api/enterprise/policy", {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "X-License-Key": licenseKey,
      },
    });

    if (!res.ok) return getCachedPolicy();

    const policy: AdminPolicy = await res.json();
    cachePolicy(policy);
    return policy;
  } catch {
    return getCachedPolicy();
  }
}

function cachePolicy(policy: AdminPolicy): void {
  try {
    localStorage.setItem(
      POLICY_CACHE_KEY,
      JSON.stringify({ policy, cachedAt: Date.now() })
    );
  } catch {
    // ignore
  }
}

function getCachedPolicy(): AdminPolicy {
  try {
    const raw = localStorage.getItem(POLICY_CACHE_KEY);
    if (!raw) return EMPTY_POLICY;
    const { policy, cachedAt } = JSON.parse(raw);
    // Use cached policy even if stale (enterprise should keep working offline)
    return policy;
  } catch {
    return EMPTY_POLICY;
  }
}

/**
 * Check if a setting is locked by admin policy.
 */
export function isSettingLocked(policy: AdminPolicy, key: string): boolean {
  return key in policy.lockedSettings;
}

/**
 * Get the locked value for a setting, or undefined if not locked.
 */
export function getLockedValue<T>(policy: AdminPolicy, key: string): T | undefined {
  if (key in policy.lockedSettings) {
    return policy.lockedSettings[key] as T;
  }
  return undefined;
}

/**
 * Check if a UI section should be hidden.
 */
export function isSectionHidden(policy: AdminPolicy, sectionId: string): boolean {
  return policy.hiddenSections.includes(sectionId);
}
