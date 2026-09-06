// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const appRoot = join(import.meta.dir, "..");
const mdmRoot = join(appRoot, "mdm");
const manifest = JSON.parse(
  readFileSync(join(mdmRoot, "deployment-manifest.v1.json"), "utf8"),
);
const profile = readFileSync(
  join(mdmRoot, "macos", "screenpipe-enterprise.mobileconfig"),
  "utf8",
);
const detection = readFileSync(
  join(mdmRoot, "windows", "detect-screenpipe-enterprise.ps1"),
  "utf8",
);
const intunePackager = readFileSync(
  join(appRoot, "scripts", "exe-to-intunewin.ps1"),
  "utf8",
);

describe("enterprise MDM dashboard contract", () => {
  test("selects only the opt-in persistent packages", () => {
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.macos.artifactSuffix).toBe("-persistent.pkg");
    expect(manifest.macos.persistenceOnlyRemovalCommand).toContain(
      "pkgutil --forget screenpi.pe.enterprise.persistence",
    );
    expect(manifest.macos.fullRemovalCommand).toContain(
      "pkgutil --forget screenpi.pe.enterprise.persistence",
    );
    expect(manifest.macos.permissions.inputMonitoring).toBe(
      "user_consent_required",
    );
    expect(manifest.macos.configurationProfileMaximumVersion).toBe("26.x");
    expect(manifest.macos.macos27.status).toBe(
      "requires_intune_app_settings_privacy_support",
    );
    expect(manifest.windows.artifactSuffix).toBe("-persistent.intunewin");
    expect(manifest.controlPlane.requiredLockedSettings).toEqual({
      autoStartEnabled: "true",
      enforcePersistence: "true",
    });
  });

  test("keeps Intune update and uninstall ownership explicit", () => {
    expect(manifest.windows.installBehavior).toBe("system");
    expect(manifest.windows.updateStrategy).toBe("in_place");
    expect(manifest.windows.supersedenceUninstallPreviousVersion).toBe(false);
    expect(manifest.windows.uninstallCommand).toContain(
      "C:\\ProgramData\\screenpipe\\mdm\\uninstall-screenpipe-enterprise.ps1",
    );
    expect(intunePackager).toContain('SetValue("PersistenceMode"');
    expect(intunePackager).toContain("uninstall-screenpipe-enterprise.ps1");
    expect(intunePackager).toContain(
      '"screenpipe-enterprise-$version-x64$flavor.intunewin"',
    );
  });

  test("macOS profile matches the signed app and persistence labels", () => {
    expect(profile).toContain("screenpi.pe.enterprise");
    expect(profile).toContain("URFF7QHPUR");
    expect(profile).toContain("screenpi.pe.enterprise.persistence");
    expect(profile).toContain("screenpi.pe.enterprise.persistence-supervisor");
    expect(profile).toContain("AllowStandardUserToSetSystemService");
    expect(profile).not.toContain("<key>Microphone</key>");
    expect(profile).not.toContain("<key>ListenEvent</key>");
  });

  test("Windows detection is versioned and requires the supervisor", () => {
    expect(detection).toContain('$expectedVersion = "{{VERSION}}"');
    expect(detection).toContain('GetValue("PersistenceMode", 0)');
    expect(detection).toContain(
      'Get-Service -Name "ScreenpipeEnterprisePersistence"',
    );
  });
});
