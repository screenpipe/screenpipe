// Screenpipe Enterprise Edition
// Licensed under the Screenpipe Enterprise License (see ee/LICENSE)

export interface LicenseInfo {
  valid: boolean;
  teamId: string;
  maxSeats: number;
  currentSeats: number;
  expiresAt: string;
  features: string[];
  gracePeriod: boolean;
}

export interface LicenseError {
  code: "invalid" | "expired" | "seats_exceeded" | "network_error";
  message: string;
}

const LICENSE_CACHE_KEY = "enterprise_license_cache";
const LICENSE_KEY_KEY = "enterprise_license_key";
const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const GRACE_PERIOD_DAYS = 14;

/**
 * Validate a license key against the server.
 * Caches the result locally so the app works offline.
 */
export async function validateLicense(
  licenseKey: string
): Promise<{ ok: true; license: LicenseInfo } | { ok: false; error: LicenseError }> {
  try {
    const res = await fetch("https://screenpi.pe/api/license/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ license_key: licenseKey }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const error: LicenseError = {
        code: res.status === 402 ? "expired" : "invalid",
        message: data.error || "license validation failed",
      };
      return { ok: false, error };
    }

    const license: LicenseInfo = await res.json();
    // Cache the successful validation
    cacheLicense(license);
    return { ok: true, license };
  } catch {
    // Network error - try cached license with grace period
    const cached = getCachedLicense();
    if (cached) {
      return { ok: true, license: { ...cached, gracePeriod: true } };
    }
    return {
      ok: false,
      error: { code: "network_error", message: "cannot reach license server and no cached license found" },
    };
  }
}

function cacheLicense(license: LicenseInfo): void {
  try {
    localStorage.setItem(
      LICENSE_CACHE_KEY,
      JSON.stringify({ license, cachedAt: Date.now() })
    );
  } catch {
    // localStorage may be unavailable
  }
}

export function getCachedLicense(): LicenseInfo | null {
  try {
    const raw = localStorage.getItem(LICENSE_CACHE_KEY);
    if (!raw) return null;
    const { license, cachedAt } = JSON.parse(raw);
    // Allow cached license during grace period even if TTL expired
    const age = Date.now() - cachedAt;
    if (age > GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000) return null;
    if (age > CACHE_TTL_MS) {
      return { ...license, gracePeriod: true };
    }
    return license;
  } catch {
    return null;
  }
}

export function getStoredLicenseKey(): string | null {
  try {
    return localStorage.getItem(LICENSE_KEY_KEY);
  } catch {
    return null;
  }
}

export function storeLicenseKey(key: string): void {
  try {
    localStorage.setItem(LICENSE_KEY_KEY, key);
  } catch {
    // ignore
  }
}

export function clearLicense(): void {
  try {
    localStorage.removeItem(LICENSE_CACHE_KEY);
    localStorage.removeItem(LICENSE_KEY_KEY);
  } catch {
    // ignore
  }
}
