# Migrate ordinary Enterprise to a per-user installation

This administrator tool migrates one existing, ordinary machine-wide Screenpipe
Enterprise installation. It does not support the persistence-service edition,
MSI installs, or older packages that cannot install per-user.

Use a released ordinary Enterprise installer that includes the per-user install
support. A merged source change is not a published installer. Obtain the exact
SHA-256 through your approved artifact channel; the script also requires a valid
Windows Authenticode signature from `Mediar, Inc.`. The target standard user must
already be signed in interactively.

From elevated Windows PowerShell 5.1, inspect the complete plan first:

```powershell
$installer = 'C:\Admin\screenpipe enterprise_1.2.3_x64-setup.exe'
$sha256 = 'THE_64_CHARACTER_SHA256_FROM_YOUR_APPROVED_CHANNEL'
.\scripts\windows-migrate-enterprise-to-user.ps1 `
  -TargetUser 'CONTOSO\alice' -InstallerPath $installer `
  -InstallerSha256 $sha256 -WhatIf
```

Then repeat without `-WhatIf`. You may specify `-InstallDirectory`, but it must
be inside that target user's `AppData\Local`; otherwise the default is
`AppData\Local\screenpipe enterprise`. Do not use `%LOCALAPPDATA%` from the
administrator's prompt.

The script validates all obtainable state before uninstalling, rejects active
copies owned by other users, preserves `.screenpipe` recordings/settings, runs
the new installer with the target user's limited interactive token, verifies
the target hive/path, and only then launches it. A process launch proves only
launch—not resumed recording.

The registered machine directory and canonical uninstaller must be owned by
Windows administrators and not writable by ordinary users. A signed old
uninstaller may use a different valid Mediar certificate than the new installer
(for certificate renewal), but both must have OS-valid Mediar publisher trust.
The script refuses an insecure/custom legacy directory rather than
executing its contents elevated. The new signed file must also identify itself
as the ordinary `screenpipe enterprise` product.

Durable status and the trusted staged installer remain under
`%ProgramData%\ScreenpipeMigration\<target-sid>`. If removal succeeded but the
target signed out or setup failed, sign the target in and rerun the identical
command (same target, destination, installer hash, and signer). Give that
target's `result.json` to Screenpipe support when requested; it contains
migration state and technical causes, not user content or secrets. This
administrator-owned file is not automatically included in the app support
bundle, so copy it explicitly when support requests it.

For disposable-image validation, build real NSIS payload fixtures with the
existing `windows-enterprise-installer.integration.ps1 -CompileOnly` flow and
the `enterprise-bundle` native queue, sign fixture installers with a temporary
locally trusted Mediar test publisher certificate, and run
`windows-migrate-enterprise-to-user.integration.ps1`. Its parameters make the
signed A/B/C inputs and the genuinely signed-in standard target explicit. Test
certificates and accounts are VM fixtures and must not be committed or reused.
