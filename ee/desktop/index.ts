// Screenpipe Enterprise Edition
// Licensed under the Screenpipe Enterprise License (see ee/LICENSE)

export { useEnterprise } from "./hooks/use-enterprise";
export type { EnterpriseState } from "./hooks/use-enterprise";

export { LicenseKeyInput } from "./components/license-key-input";
export { EnterpriseSettingsGuard } from "./components/enterprise-settings-guard";

export { validateLicense, getStoredLicenseKey, storeLicenseKey, clearLicense } from "./lib/license-validation";
export type { LicenseInfo, LicenseError } from "./lib/license-validation";

export { fetchAdminPolicy, isSettingLocked, getLockedValue, isSectionHidden } from "./lib/admin-policy";
export type { AdminPolicy } from "./lib/admin-policy";
