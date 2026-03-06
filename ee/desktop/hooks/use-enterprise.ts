// Screenpipe Enterprise Edition
// Licensed under the Screenpipe Enterprise License (see ee/LICENSE)

"use client";

import { useState, useEffect, useCallback } from "react";
import { useIsEnterpriseBuild } from "@/lib/hooks/use-is-enterprise-build";
import {
  validateLicense,
  getStoredLicenseKey,
  storeLicenseKey,
  clearLicense,
  LicenseInfo,
} from "../lib/license-validation";
import {
  fetchAdminPolicy,
  AdminPolicy,
  isSettingLocked,
  getLockedValue,
  isSectionHidden,
} from "../lib/admin-policy";

export interface EnterpriseState {
  isEnterprise: boolean;
  isLoading: boolean;
  isLicensed: boolean;
  needsLicenseKey: boolean;
  license: LicenseInfo | null;
  policy: AdminPolicy | null;
  error: string | null;
  activateLicense: (key: string) => Promise<boolean>;
  deactivate: () => void;
  isSettingLocked: (key: string) => boolean;
  getLockedValue: <T>(key: string) => T | undefined;
  isSectionHidden: (sectionId: string) => boolean;
}

export function useEnterprise(): EnterpriseState {
  const isEnterprise = useIsEnterpriseBuild();
  const [isLoading, setIsLoading] = useState(true);
  const [license, setLicense] = useState<LicenseInfo | null>(null);
  const [policy, setPolicy] = useState<AdminPolicy | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isLicensed = license?.valid ?? false;
  const needsLicenseKey = isEnterprise && !isLoading && !isLicensed;

  // On mount, check for stored license key and validate
  useEffect(() => {
    if (!isEnterprise) {
      setIsLoading(false);
      return;
    }

    const storedKey = getStoredLicenseKey();
    if (!storedKey) {
      setIsLoading(false);
      return;
    }

    (async () => {
      const result = await validateLicense(storedKey);
      if (result.ok) {
        setLicense(result.license);
        setError(null);
        const p = await fetchAdminPolicy(storedKey);
        setPolicy(p);
      } else {
        setError(result.error.message);
      }
      setIsLoading(false);
    })();
  }, [isEnterprise]);

  const activateLicense = useCallback(async (key: string): Promise<boolean> => {
    setIsLoading(true);
    setError(null);

    const result = await validateLicense(key);
    if (result.ok) {
      storeLicenseKey(key);
      setLicense(result.license);
      const p = await fetchAdminPolicy(key);
      setPolicy(p);
      setIsLoading(false);
      return true;
    }

    setError(result.error.message);
    setIsLoading(false);
    return false;
  }, []);

  const deactivate = useCallback(() => {
    clearLicense();
    setLicense(null);
    setPolicy(null);
    setError(null);
  }, []);

  const checkSettingLocked = useCallback(
    (key: string) => (policy ? isSettingLocked(policy, key) : false),
    [policy]
  );

  const checkLockedValue = useCallback(
    <T>(key: string) => (policy ? getLockedValue<T>(policy, key) : undefined),
    [policy]
  );

  const checkSectionHidden = useCallback(
    (sectionId: string) => (policy ? isSectionHidden(policy, sectionId) : false),
    [policy]
  );

  return {
    isEnterprise,
    isLoading,
    isLicensed,
    needsLicenseKey,
    license,
    policy,
    error,
    activateLicense,
    deactivate,
    isSettingLocked: checkSettingLocked,
    getLockedValue: checkLockedValue,
    isSectionHidden: checkSectionHidden,
  };
}
