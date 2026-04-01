// Screenpipe Enterprise Edition
// Licensed under the Screenpipe Enterprise License (see ee/LICENSE)

export { useEnterprise } from "./hooks/use-enterprise";
export type { EnterpriseState } from "./hooks/use-enterprise";

// useEnterprisePolicy and useIsEnterpriseBuild stay in app/lib/hooks/ because
// they depend on app-specific packages (@tauri-apps/plugin-http, @/lib/utils/tauri)

export { LicenseKeyInput } from "./components/license-key-input";
export { EnterpriseSettingsGuard } from "./components/enterprise-settings-guard";
// EnterpriseLicensePrompt stays in app/components/ because it depends on the app's UI libraries

export { validateLicense, getStoredLicenseKey, storeLicenseKey, clearLicense } from "./lib/license-validation";
export type { LicenseInfo, LicenseError } from "./lib/license-validation";

export { fetchAdminPolicy, isSettingLocked, getLockedValue, isSectionHidden } from "./lib/admin-policy";
export type { AdminPolicy } from "./lib/admin-policy";
