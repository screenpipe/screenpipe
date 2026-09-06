<!-- screenpipe — AI that knows everything you've seen, said, or heard -->
<!-- https://screenpipe.com -->

# Enterprise MDM configuration

`deployment-manifest.v1.json` is the platform-neutral dashboard contract. The
dashboard selects the persistent artifact for the chosen release, replaces
`{{VERSION}}` in the Windows detection script, and presents the native artifacts
and commands from this directory.

## macOS

Deploy `macos/screenpipe-enterprise.mobileconfig` through the device channel,
then deploy the matching `-persistent.pkg`. The same `.mobileconfig` works with
Intune, Jamf Pro, Kandji, Mosyle, and other Apple MDM services.

Use the manifest's removal commands rather than deleting only the app bundle;
they remove the persistence jobs and forget the package receipt so MDM
detection does not leave a deleted device in an installed state.

The profile approves Accessibility, managed background services, and
MDM-managed update detection. Apple does not allow a PPPC profile to silently
grant Screen Recording, Input Monitoring, or Microphone access. Screen Recording
is configured so a standard user can approve it; Input Monitoring and Microphone
remain one-time user consents. The stable bundle identifier, Team ID, and
designated requirement preserve the approvals across in-place Screenpipe
updates.

This profile is the production path for macOS 13 through 26. Apple removes the
PPPC Accessibility grant in macOS 27 in favor of declarative App Settings
Privacy. Intune's current App Settings catalog documents binary execution
controls but not the Privacy keys, so the dashboard must flag macOS 27
Accessibility as unsupported until Intune exposes that setting. Do not present
the legacy profile as a managed Accessibility grant on macOS 27.

## Windows

Upload the matching persistent `.intunewin` as a system-context Win32 app. Use
the install and uninstall commands in the manifest and upload the rendered
`windows/detect-screenpipe-enterprise.ps1` as the custom detection script.
Set app-update supersedence to keep the prior version installed; the Screenpipe
installer owns its in-place service-aware upgrade.

Windows has no Screenpipe-specific screen-capture or Accessibility consent.
Microphone access for this unpackaged Win32 app follows the user's desktop-app
privacy setting; do not broaden it to every desktop app through MDM.
