# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com

<#
.SYNOPSIS
Migrates an ordinary Screenpipe Enterprise machine installation to one user.

.DESCRIPTION
Run elevated. The target user must be signed in. The installer must be a
published, Authenticode-valid Mediar, Inc. ordinary Enterprise installer.
State is retained under ProgramData so a failed user phase can be resumed.
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = "High")]
param(
  [Parameter(Mandatory)] [string] $TargetUser,
  [Parameter(Mandatory)] [string] $InstallerPath,
  [Parameter(Mandatory)]
  [ValidatePattern('^[0-9A-Fa-f]{64}$')]
  [string] $InstallerSha256,
  [string] $InstallDirectory
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2
$productKey = "Software\Microsoft\Windows\CurrentVersion\Uninstall\screenpipe enterprise"
$runKey = "Software\Microsoft\Windows\CurrentVersion\Run"
$productName = "screenpipe enterprise"
$publisher = "Mediar, Inc."
$stateRoot = Join-Path ([Environment]::GetFolderPath("CommonApplicationData")) "ScreenpipeMigration"

function Fail([string] $Message) { throw "Screenpipe migration: $Message" }
function Quote([string] $Value) { '"' + $Value.Replace('"', '\"') + '"' }
function Canonical([string] $Path) { [IO.Path]::GetFullPath($Path).TrimEnd('\') }
function Hash-File([string] $Path) {
  $stream = [IO.File]::OpenRead($Path)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '') }
  finally { $sha.Dispose(); $stream.Dispose() }
}
function Is-Within([string] $Path, [string] $Parent) {
  $p = (Canonical $Path) + '\'
  $root = (Canonical $Parent) + '\'
  $p.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)
}
function Open-Registry([Microsoft.Win32.RegistryHive] $Hive, [Microsoft.Win32.RegistryView] $View) {
  [Microsoft.Win32.RegistryKey]::OpenBaseKey($Hive, $View)
}
function Read-Uninstall([Microsoft.Win32.RegistryHive] $Hive, [Microsoft.Win32.RegistryView] $View, [string] $SubKey) {
  $base = Open-Registry $Hive $View
  try {
    $key = $base.OpenSubKey($SubKey)
    if (-not $key) { return $null }
    try {
      [pscustomobject]@{
        Hive = $Hive.ToString(); View = $View.ToString(); Key = $SubKey
        DisplayName = [string]$key.GetValue("DisplayName", "")
        Publisher = [string]$key.GetValue("Publisher", "")
        Version = [string]$key.GetValue("DisplayVersion", "")
        WindowsInstaller = [int]$key.GetValue("WindowsInstaller", 0)
        Location = ([string]$key.GetValue("InstallLocation", "")).Trim('"')
        Uninstall = ([string]$key.GetValue("UninstallString", "")).Trim('"')
      }
    } finally { $key.Dispose() }
  } finally { $base.Dispose() }
}
function Find-ScreenpipeRegistrations([Microsoft.Win32.RegistryHive] $Hive, [Microsoft.Win32.RegistryView] $View, [string] $Prefix) {
  $rootPath = "$Prefix\Software\Microsoft\Windows\CurrentVersion\Uninstall".TrimStart('\')
  $base = Open-Registry $Hive $View
  try {
    $root = $base.OpenSubKey($rootPath)
    if (-not $root) { return @() }
    try {
      $found = @()
      foreach ($name in $root.GetSubKeyNames()) {
        $entry = Read-Uninstall $Hive $View "$rootPath\$name"
        if ($entry -and ($entry.DisplayName -match '(?i)screenpipe' -or $entry.Publisher -eq $publisher)) { $found += $entry }
      }
      $found
    } finally { $root.Dispose() }
  } finally { $base.Dispose() }
}
function Read-RegistryValue([Microsoft.Win32.RegistryHive] $Hive, [Microsoft.Win32.RegistryView] $View, [string] $SubKey, [string] $Name) {
  $base = Open-Registry $Hive $View
  try {
    $key = $base.OpenSubKey($SubKey)
    if (-not $key) { return $null }
    try { $key.GetValue($Name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
    finally { $key.Dispose() }
  } finally { $base.Dispose() }
}
function Get-Signature([string] $Path) {
  $signature = Get-AuthenticodeSignature -LiteralPath $Path
  if ($signature.Status -ne [Management.Automation.SignatureStatus]::Valid -or -not $signature.SignerCertificate) {
    Fail "installer Authenticode signature is not valid (status $($signature.Status)); the machine copy was not changed"
  }
  $cert = $signature.SignerCertificate
  $organization = $cert.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
  if ($organization -ne $publisher -and $cert.Subject -notmatch '(^|,\s*)(O|CN)="?Mediar, Inc\.?"?($|,)') {
    Fail "installer signer is '$($cert.Subject)', not $publisher; the machine copy was not changed"
  }
  $cert.Thumbprint
}
function Assert-MediarSignature([string] $Path, [string] $Label) {
  $signature = Get-AuthenticodeSignature -LiteralPath $Path
  if ($Label -eq 'machine uninstaller' -and $signature.Status -eq [Management.Automation.SignatureStatus]::NotSigned) {
    return
  }
  if ($signature.Status -ne [Management.Automation.SignatureStatus]::Valid -or -not $signature.SignerCertificate) {
    Fail "$Label Authenticode signature is not valid (status $($signature.Status))"
  }
  $organization = $signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
  if ($organization -ne $publisher -and $signature.SignerCertificate.Subject -notmatch '(^|,\s*)(O|CN)="?Mediar, Inc\.?"?($|,)') {
    Fail "$Label signer is '$($signature.SignerCertificate.Subject)', not $publisher"
  }
}
function Get-Target([string] $Name) {
  try {
    $account = New-Object Security.Principal.NTAccount($Name)
    $sid = $account.Translate([Security.Principal.SecurityIdentifier])
  } catch {
    try { $sid = New-Object Security.Principal.SecurityIdentifier($Name); $account = $sid.Translate([Security.Principal.NTAccount]) }
    catch { Fail "cannot resolve TargetUser '$Name' to a Windows account" }
  }
  if (-not $sid.IsAccountSid() -or $sid.Value -match '^S-1-5-(18|19|20)$') { Fail "TargetUser must be an ordinary local or domain user" }
  $profileKey = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$($sid.Value)"
  if (-not (Test-Path -LiteralPath $profileKey)) { Fail "TargetUser has no local Windows profile" }
  $profile = [Environment]::ExpandEnvironmentVariables([string](Get-ItemPropertyValue -LiteralPath $profileKey -Name ProfileImagePath))
  if (-not (Test-Path -LiteralPath $profile -PathType Container)) { Fail "TargetUser profile does not exist at $profile" }
  [pscustomobject]@{ Sid = $sid.Value; Account = $account.Value; Profile = (Canonical $profile) }
}
function Assert-Admin {
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Fail "run this script from an elevated Windows PowerShell" }
}
function Get-ProcessOwnerSid([uint32] $Id) {
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$Id" -ErrorAction SilentlyContinue
  if (-not $p) { return $null }
  try { (Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid -ErrorAction Stop -WhatIf:$false).Sid } catch { $null }
}
function Assert-Interactive([string] $Sid) {
  $interactiveSessions = @(Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty SessionId -Unique)
  $targetInteractive = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -in $interactiveSessions -and (Get-ProcessOwnerSid $_.ProcessId) -eq $Sid })
  if (-not $targetInteractive) {
    Fail "TargetUser must be signed in with an interactive desktop (an unlocked or locked session is acceptable)"
  }
  if (-not (Test-Path -LiteralPath "Registry::HKEY_USERS\$Sid")) { Fail "TargetUser registry hive is not loaded" }
}
function Assert-NoReparseAncestors([string] $Path) {
  $cursor = Canonical $Path
  while ($cursor) {
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -LiteralPath $cursor -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Fail "unsafe reparse point in path at $cursor" }
    }
    $parent = Split-Path -Parent $cursor
    if (-not $parent -or $parent -eq $cursor) { break }
    $cursor = $parent
  }
}
function Get-Sid($Identity) {
  if ($Identity -is [Security.Principal.SecurityIdentifier]) { return $Identity.Value }
  if ($Identity -isnot [Security.Principal.IdentityReference]) { $Identity = New-Object Security.Principal.NTAccount([string]$Identity) }
  $Identity.Translate([Security.Principal.SecurityIdentifier]).Value
}
function Assert-AdminControlled([string] $Path, [string] $Label) {
  Assert-NoReparseAncestors $Path
  $item = Get-Item -LiteralPath $Path -Force
  $security = Get-Acl -LiteralPath $item.FullName
  $ownerSid = Get-Sid $security.Owner
  $trusted = @('S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
  if ($ownerSid -notin $trusted) { Fail "$Label is not owned by SYSTEM, Administrators, or TrustedInstaller: $Path (owner $ownerSid)" }
  $dangerous = [Security.AccessControl.FileSystemRights]::WriteData -bor
    [Security.AccessControl.FileSystemRights]::CreateDirectories -bor [Security.AccessControl.FileSystemRights]::AppendData -bor
    [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor [Security.AccessControl.FileSystemRights]::WriteAttributes -bor
    [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
    [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
  foreach ($rule in $security.Access) {
    if (($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
    $ruleSid = Get-Sid $rule.IdentityReference
    if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and ($rule.FileSystemRights -band $dangerous) -ne 0 -and $ruleSid -notin $trusted) {
      Fail "$Label grants write/delete/permission access to untrusted SID $ruleSid`: $Path"
    }
  }
}
function Assert-TrustedOwner([string] $Path, [string] $Label) {
  Assert-NoReparseAncestors $Path
  $ownerSid = Get-Sid (Get-Acl -LiteralPath $Path).Owner
  if ($ownerSid -notin @('S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')) {
    Fail "$Label was not created under a trusted owner: $Path (owner $ownerSid)"
  }
}
function Assert-SafeNamespaceParent([string] $Path, [string] $Label) {
  Assert-NoReparseAncestors $Path
  $security = Get-Acl -LiteralPath $Path
  $ownerSid = Get-Sid $security.Owner
  $trusted = @('S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
  if ($ownerSid -notin $trusted) { Fail "$Label has an untrusted owner $ownerSid`: $Path" }
  $namespaceDanger = [Security.AccessControl.FileSystemRights]::Delete -bor
    [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
    [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
  foreach ($rule in $security.Access) {
    if (($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
    $ruleSid = Get-Sid $rule.IdentityReference
    if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and ($rule.FileSystemRights -band $namespaceDanger) -ne 0 -and $ruleSid -notin $trusted) {
      Fail "$Label grants delete-child/delete/permission access to untrusted SID $ruleSid`: $Path"
    }
  }
}
function New-ProtectedDirectory([string] $Path, [string] $TargetSid, [string] $Label) {
  $parent = Split-Path -Parent $Path
  Assert-SafeNamespaceParent $parent "$Label parent"
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetSecurityDescriptorSddlForm("O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;GRGX;;;$TargetSid)")
  if (Test-Path -LiteralPath $Path) { Assert-AdminControlled $Path "existing $Label" }
  else { [IO.Directory]::CreateDirectory($Path, $acl) | Out-Null; Assert-TrustedOwner $Path "new $Label" }
  Assert-AdminControlled $Path $Label
}
function Initialize-Staging([string] $Root, [string] $Directory, [string] $TargetSid) {
  New-ProtectedDirectory $Root $TargetSid 'migration staging root'
  New-ProtectedDirectory $Directory $TargetSid 'migration target staging directory'
}
function New-ResultDirectory([string] $Path, [string] $TargetSid) {
  Assert-NoReparseAncestors (Split-Path -Parent $Path)
  if (-not (Test-Path -LiteralPath $Path)) { New-Item -ItemType Directory -Path $Path | Out-Null }
  $item = Get-Item -LiteralPath $Path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Fail "unsafe result-directory reparse point at $Path" }
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetSecurityDescriptorSddlForm("O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1301bf;;;$TargetSid)")
  Set-Acl -LiteralPath $Path -AclObject $acl
}
function Save-State($State, [string] $Path) {
  Assert-AdminControlled (Split-Path -Parent $Path) 'migration state directory'
  $tmp = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
  $State | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $tmp -Encoding UTF8
  Move-Item -LiteralPath $tmp -Destination $Path -Force
}

Assert-Admin
$target = Get-Target $TargetUser
$sourceInstaller = Canonical $InstallerPath
if (-not (Test-Path -LiteralPath $sourceInstaller -PathType Leaf)) { Fail "InstallerPath is not a file" }
$actualHash = Hash-File $sourceInstaller
if ($actualHash -ne $InstallerSha256.ToUpperInvariant()) { Fail "installer SHA-256 does not match; the machine copy was not changed" }
$signerThumbprint = Get-Signature $sourceInstaller
$sourceVersionInfo = [Diagnostics.FileVersionInfo]::GetVersionInfo($sourceInstaller)
if ($sourceVersionInfo.ProductName -ne $productName) { Fail "signed installer product is '$($sourceVersionInfo.ProductName)', not $productName; the machine copy was not changed" }
Assert-Interactive $target.Sid

$profileLocal = Canonical (Join-Path $target.Profile "AppData\Local")
$destination = if ($InstallDirectory) { Canonical $InstallDirectory } else { Canonical (Join-Path $profileLocal "screenpipe enterprise") }
$dataDirectory = Canonical (Join-Path $target.Profile ".screenpipe")
if (-not (Is-Within $destination $target.Profile)) { Fail "InstallDirectory must be inside TargetUser's profile" }
if (-not (Is-Within $destination $profileLocal)) { Fail "InstallDirectory must be inside TargetUser's LocalAppData" }
if ((Is-Within $destination $dataDirectory) -or (Is-Within $dataDirectory $destination)) { Fail "InstallDirectory cannot contain, or be inside, the Screenpipe data directory" }

$machine = @()
$machineRelated = @()
foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
  $machineRelated += Find-ScreenpipeRegistrations LocalMachine $view ''
  $entry = Read-Uninstall LocalMachine $view $productKey
  if ($entry) { $machine += $entry }
}
$machine = @($machine | Sort-Object Location -Unique)
$user = @()
$userRelated = @()
foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
  $userRelated += Find-ScreenpipeRegistrations Users $view $target.Sid
  $entry = Read-Uninstall Users $view "$($target.Sid)\$productKey"
  if ($entry) { $user += $entry }
}
$user = @($user | Sort-Object Location -Unique)
if (@($machineRelated | Where-Object { $_.Key -ne $productKey -or $_.WindowsInstaller -ne 0 }).Count) { Fail "unsupported or MSI Screenpipe machine registration found; uninstall it with its owning deployment system" }
if (@($userRelated | Where-Object { $_.Key -ne "$($target.Sid)\$productKey" -or $_.WindowsInstaller -ne 0 }).Count) { Fail "unsupported Screenpipe registration exists in TargetUser's hive" }
if ($machine.Count -gt 1 -or $user.Count -gt 1) { Fail "ambiguous duplicate Screenpipe registrations; remove duplicates manually" }
if (Get-Service -Name "ScreenpipeEnterprisePersistence" -ErrorAction SilentlyContinue) { Fail "persistent Enterprise service is installed; this tool supports only ordinary Enterprise" }
if (Get-ChildItem -LiteralPath (Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'screenpipe') -Filter '*persistence*' -Force -ErrorAction SilentlyContinue) { Fail "persistence state/helper is present; this tool supports only ordinary Enterprise" }
if ($user.Count -and $machine.Count) { Fail "machine and target-user Screenpipe registrations coexist; resolve this ambiguous state manually" }

$machineEntry = if ($machine.Count) { $machine[0] } else { $null }
$migrationId = $target.Sid.Replace('-', '_')
$migrationDir = Join-Path $stateRoot $migrationId
$statePath = Join-Path $migrationDir "result.json"
if (Test-Path -LiteralPath $stateRoot) { Assert-AdminControlled $stateRoot 'existing migration staging root' }
if (Test-Path -LiteralPath $migrationDir) { Assert-AdminControlled $migrationDir 'existing migration state directory' }
if (Test-Path -LiteralPath $statePath) { Assert-AdminControlled $statePath 'existing migration state file' }
$existingState = if (Test-Path -LiteralPath $statePath) { Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json } else { $null }
if ($existingState) {
  if ($existingState.TargetSid -ne $target.Sid -or (Canonical $existingState.Destination) -ne $destination -or $existingState.InstallerSha256 -ne $actualHash -or $existingState.SignerThumbprint -ne $signerThumbprint) {
    Fail "existing recovery state is bound to a different target, destination, or installer hash"
  }
}
if ($user.Count -eq 1 -and -not $machineEntry) {
  $expectedExe = Canonical (Join-Path $destination "screenpipe-app.exe")
  $verifiedComplete = $existingState -and $existingState.Phase -eq 'verified-complete' -and
    (Canonical $user[0].Location) -eq $destination -and (Test-Path -LiteralPath $expectedExe) -and
    $user[0].Version -eq $existingState.InstalledVersion -and
    (Hash-File $expectedExe) -eq $existingState.PayloadSha256
  if ($verifiedComplete) {
    Write-Host "Already migrated and administrator-verified: $($target.Account) owns version $($user[0].Version) at $destination"
    return
  }
  if (-not $existingState -or $existingState.Phase -notin @('uninstalling-machine','removed-pending-user-install','user-install-failed')) {
    Fail "TargetUser has a per-user installation without matching recovery state; refusing to claim it is already migrated"
  }
}
$removedKnown = -not $machineEntry -and $existingState -and $existingState.Phase -in @('removed-pending-user-install','user-install-failed')
if (-not $machineEntry -and $existingState -and $existingState.Phase -eq 'uninstalling-machine') {
  $recordedOldExe = [string]$existingState.OldExe
  if ($recordedOldExe -and -not (Test-Path -LiteralPath $recordedOldExe) -and
      -not (Read-Uninstall LocalMachine Registry64 $productKey) -and -not (Read-Uninstall LocalMachine Registry32 $productKey)) {
    $removedKnown = $true
  }
}
if (-not $machineEntry -and -not $removedKnown) {
  Fail "no supported machine-wide Screenpipe Enterprise registration was found"
}
if ($machineEntry) {
  if ($machineEntry.DisplayName -ne $productName -or $machineEntry.Publisher -ne $publisher) { Fail "machine registration is not the expected ordinary Screenpipe Enterprise product" }
  $oldDir = Canonical $machineEntry.Location
  $oldExe = Canonical (Join-Path $oldDir "screenpipe-app.exe")
  $canonicalUninstaller = Canonical (Join-Path $oldDir "uninstall.exe")
  if (-not (Test-Path -LiteralPath $oldExe) -or -not (Test-Path -LiteralPath $canonicalUninstaller)) { Fail "machine installation is incomplete" }
  if ((Canonical $machineEntry.Uninstall) -ne $canonicalUninstaller) { Fail "machine UninstallString is not the canonical installer-owned uninstaller" }
  Assert-AdminControlled $oldDir 'machine installation directory'
  Assert-AdminControlled $canonicalUninstaller 'machine uninstaller'
  Assert-MediarSignature $canonicalUninstaller 'machine uninstaller'
  $installerProductVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($sourceInstaller).ProductVersion
  try {
    $oldVersion = [version]$machineEntry.Version
    $newVersion = [version](([string]$installerProductVersion -split '[+\-]')[0])
    if ($newVersion -lt $oldVersion) { Fail "installer version $newVersion would downgrade machine version $oldVersion" }
  } catch [Management.Automation.RuntimeException] { throw }
    catch { Fail "could not compare installer version '$installerProductVersion' with installed version '$($machineEntry.Version)'" }
  if ((Is-Within $destination $oldDir) -or (Is-Within $oldDir $destination)) { Fail "InstallDirectory cannot be inside, or contain, the machine installation" }
  $foreign = @()
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -in @('screenpipe.exe','screenpipe-app.exe') -or ($_.ExecutablePath -and (Is-Within $_.ExecutablePath $oldDir))
  } | ForEach-Object {
    $owner = Get-ProcessOwnerSid $_.ProcessId
    if (-not $owner) { $foreign += "$($_.Name) pid $($_.ProcessId) owner unknown" }
    elseif ($owner -ne $target.Sid) { $foreign += "$($_.Name) pid $($_.ProcessId) owner $owner" }
  }
  if ($foreign.Count) { Fail "another user is running the machine copy. Ask them to exit Screenpipe, then retry. Processes: $($foreign -join '; ')" }
}
$oldAutostart = Read-RegistryValue Users Registry64 "$($target.Sid)\$runKey" $productName
$autostartArguments = ''
if ($oldAutostart -and $machineEntry) {
  $match = [regex]::Match([string]$oldAutostart, '^\s*(?:"([^"]+)"|(\S+))(.*)$')
  $oldAutostartExe = if ($match.Groups[1].Success) { $match.Groups[1].Value } else { $match.Groups[2].Value }
  $autostartArguments = $match.Groups[3].Value
  if ((Canonical $oldAutostartExe) -ne $oldExe) { Fail "target autostart entry does not point to the registered machine executable" }
}
$restoreAutostart = if ($machineEntry) { $null -ne $oldAutostart } else { [bool]$existingState.AutostartEnabled }
if (-not $machineEntry -and $existingState) { $autostartArguments = [string]$existingState.AutostartArguments }

Write-Host "Migration plan:"
Write-Host "  target:      $($target.Account) [$($target.Sid)]"
Write-Host "  profile:     $($target.Profile)"
Write-Host "  destination: $destination"
Write-Host "  installer:   $sourceInstaller"
Write-Host "  sha256:      $actualHash"
Write-Host "  action:      validate target token, remove machine copy, install and launch as target"
if ($WhatIfPreference) { Write-Host "WhatIf complete: no files, tasks, processes, or registry values were changed."; return }
if (-not $PSCmdlet.ShouldProcess($target.Account, "migrate Screenpipe Enterprise machine installation to per-user")) { return }

Initialize-Staging $stateRoot $migrationDir $target.Sid
$lockPath = Join-Path $migrationDir 'migration.lock'
if (Test-Path -LiteralPath $lockPath) { Assert-AdminControlled $lockPath 'existing migration lock file' }
try { $migrationLock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
catch [IO.IOException] { Fail "another migration for this target is already running" }
try {
$stagedInstaller = Join-Path $migrationDir ("installer-" + [guid]::NewGuid().ToString('N') + '.exe')
$sourceStream = [IO.File]::Open($sourceInstaller, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
$stagedStream = [IO.File]::Open($stagedInstaller, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try { $sourceStream.CopyTo($stagedStream); $stagedStream.Flush($true) } finally { $stagedStream.Dispose(); $sourceStream.Dispose() }
Assert-AdminControlled $stagedInstaller 'staged installer'
if ((Hash-File $stagedInstaller) -ne $actualHash) { Fail "staged installer hash changed" }
$null = Get-Signature $stagedInstaller
$runner = Join-Path $migrationDir ("runner-" + [guid]::NewGuid().ToString('N') + '.ps1')
$runnerTemplate = @'
# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com
[CmdletBinding()] param([Parameter(Mandatory)][string]$ConfigPath,[switch]$ProbeOnly)
$ErrorActionPreference = "Stop"
$config = Get-Content -Raw -LiteralPath $ConfigPath | ConvertFrom-Json
$expectedSid = [string]$config.ExpectedSid; $expectedProfile = [string]$config.ExpectedProfile; $destination = [string]$config.Destination
$restoreAutostart = [bool]$config.RestoreAutostart; $autostartArguments = [string]$config.AutostartArguments
$installer = [string]$config.Installer; $expectedHash = [string]$config.ExpectedHash; $result = [string]$config.ResultPath
$invocationId = [string]$config.InvocationId; $supportLog = Join-Path $expectedProfile '.screenpipe\update-install.log'
function Finish([string]$phase,[string]$cause,[string]$version = '',[string]$payloadHash = '') {
  $value = @{ InvocationId=$invocationId; Phase=$phase; Cause=$cause; Version=$version; PayloadSha256=$payloadHash; Sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; Utc=[DateTime]::UtcNow.ToString('o') }
  $tmp = "$result.$([guid]::NewGuid().ToString('N')).tmp"
  $value | ConvertTo-Json | Set-Content -LiteralPath $tmp -Encoding UTF8
  Move-Item -LiteralPath $tmp -Destination $result
  if ($phase -notin @('probe-complete','verified-complete')) { exit 1 }
}
try {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  if ($identity.User.Value -ne $expectedSid) { throw 'scheduled task ran as the wrong SID' }
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'target token is an administrator token' }
  $elevation = 0; $definition = '[DllImport("advapi32.dll",SetLastError=true)] public static extern bool GetTokenInformation(IntPtr h,int c,out int v,int n,out int r);'
  $native = Add-Type -MemberDefinition $definition -Name TokenProbe -Namespace ScreenpipeMigration -PassThru
  $size = 0; $tokenRead = $native::GetTokenInformation($identity.Token,20,[ref]$elevation,4,[ref]$size)
  if (-not $tokenRead) { throw "could not inspect target token elevation (Win32 $([Runtime.InteropServices.Marshal]::GetLastWin32Error()))" }
  if ($elevation -ne 0) { throw 'target token is elevated' }
  $profile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
  if ([IO.Path]::GetFullPath($profile).TrimEnd('\') -ne $expectedProfile) { throw 'target token loaded an unexpected profile' }
  if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash -ne $expectedHash) { throw 'staged installer hash changed' }
  $signature = Get-AuthenticodeSignature -LiteralPath $installer
  $signerName = $signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
  if ($signature.Status -ne 'Valid' -or ($signerName -ne 'Mediar, Inc.' -and $signature.SignerCertificate.Subject -notmatch '(^|,\s*)(O|CN)="?Mediar, Inc\.?"?($|,)')) { throw 'staged installer signature/publisher is invalid' }
  $parent = Split-Path -Parent $destination; New-Item -ItemType Directory -Force -Path $parent | Out-Null
  New-Item -ItemType Directory -Force -Path $destination | Out-Null
  $probe = Join-Path $destination ('.screenpipe-migration-' + [guid]::NewGuid().ToString('N')); [IO.File]::WriteAllText($probe,'probe'); Remove-Item -LiteralPath $probe
  if ($ProbeOnly) { Finish 'probe-complete' 'identity, limited token, profile, trust, and destination write probe passed'; return }
  $p = Start-Process -FilePath $installer -ArgumentList @('/S',('/D=' + $destination)) -Wait -PassThru
  if ($p.ExitCode -ne 0) { throw "installer exited $($p.ExitCode)" }
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall\screenpipe enterprise')
  if (-not $key) { throw 'target HKCU registration missing' }
  try { $location = ([string]$key.GetValue('InstallLocation','')).Trim('"'); $version = [string]$key.GetValue('DisplayVersion','') } finally { $key.Dispose() }
  if ([IO.Path]::GetFullPath($location).TrimEnd('\') -ne $destination) { throw 'target registration path mismatch' }
  $exe = Join-Path $destination 'screenpipe-app.exe'; if (-not (Test-Path -LiteralPath $exe)) { throw 'installed executable missing' }
  if ($restoreAutostart) { New-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'screenpipe enterprise' -Value ('"' + $exe + '"' + $autostartArguments) -PropertyType String -Force | Out-Null }
  $payloadHash = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $supportLog) | Out-Null
  Add-Content -LiteralPath $supportLog -Value (([DateTime]::UtcNow.ToString('o')) + ' enterprise machine-to-user migration verified; version=' + $version)
  Start-Process -FilePath $exe
  Finish 'verified-complete' ("installed version " + $version + "; payload sha256 " + $payloadHash) $version $payloadHash
} catch {
  $cause = $_.Exception.Message -replace '[\r\n]',' '
  try { New-Item -ItemType Directory -Force -Path (Split-Path -Parent $supportLog) | Out-Null; Add-Content -LiteralPath $supportLog -Value (([DateTime]::UtcNow.ToString('o')) + ' enterprise machine-to-user migration failed; phase=' + $(if($ProbeOnly){'preflight'}else{'install'}) + '; cause=' + $cause) } catch {}
  if ($ProbeOnly) { Finish 'preflight-failed' $cause } else { Finish 'user-install-failed' $cause }
}
'@
$runnerStream = [IO.File]::Open($runner, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try { $runnerWriter = New-Object IO.StreamWriter($runnerStream, ([Text.UTF8Encoding]::new($true))); $runnerWriter.Write($runnerTemplate); $runnerWriter.Flush(); $runnerStream.Flush($true) } finally { if ($runnerWriter) { $runnerWriter.Dispose() } else { $runnerStream.Dispose() } }
Assert-AdminControlled $runner 'migration runner'
$state = [ordered]@{ Phase=if($removedKnown){'removed-pending-user-install'}else{'preflight-complete'}; TargetSid=$target.Sid; TargetAccount=$target.Account; Destination=$destination; Installer=$stagedInstaller; InstallerSha256=$actualHash; SignerThumbprint=$signerThumbprint; AutostartEnabled=$restoreAutostart; AutostartArguments=$autostartArguments; MachineVersion=if($machineEntry){$machineEntry.Version}else{$existingState.MachineVersion}; OldExe=if($machineEntry){$oldExe}else{[string]$existingState.OldExe}; UpdatedUtc=[DateTime]::UtcNow.ToString('o') }
Save-State $state $statePath

$taskPath = "\Screenpipe\"
$principal = New-ScheduledTaskPrincipal -UserId $target.Sid -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
function Invoke-UserPhase([bool] $ProbeOnly) {
  $invocationId = [guid]::NewGuid().ToString('N')
  $invocationDir = Join-Path $migrationDir ("output\" + $invocationId)
  New-ResultDirectory $invocationDir $target.Sid
  $taskResult = Join-Path $invocationDir 'user-result.json'
  $configPath = Join-Path $migrationDir ("invocation-" + $invocationId + '.json')
    $configJson = [ordered]@{
      InvocationId=$invocationId; ExpectedSid=$target.Sid; ExpectedProfile=$target.Profile; Destination=$destination
      RestoreAutostart=$restoreAutostart; AutostartArguments=$autostartArguments; Installer=$stagedInstaller
      ExpectedHash=$actualHash; ResultPath=$taskResult
    } | ConvertTo-Json
    $configStream = [IO.File]::Open($configPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $configWriter = New-Object IO.StreamWriter($configStream, ([Text.UTF8Encoding]::new($true))); $configWriter.Write($configJson); $configWriter.Flush(); $configStream.Flush($true) } finally { if ($configWriter) { $configWriter.Dispose() } else { $configStream.Dispose() } }
    Assert-AdminControlled $configPath 'migration invocation input'
  $taskName = "Screenpipe user migration $invocationId"
  $arguments = "-NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File $(Quote $runner) -ConfigPath $(Quote $configPath)"
  if ($ProbeOnly) { $arguments += ' -ProbeOnly' }
  $action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument $arguments
  $task = New-ScheduledTask -Action $action -Principal $principal -Settings $settings
  Register-ScheduledTask -TaskName $taskName -TaskPath $taskPath -InputObject $task | Out-Null
  try {
    Start-ScheduledTask -TaskName $taskName -TaskPath $taskPath
    $observedRunning = $false
    while (-not (Test-Path -LiteralPath $taskResult)) {
      Start-Sleep -Milliseconds 250
      $scheduled = Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath
      $info = Get-ScheduledTaskInfo -TaskName $taskName -TaskPath $taskPath
      if ($scheduled.State -eq 'Running') { $observedRunning = $true; continue }
      if ($info.LastTaskResult -eq 267011) { Fail "TargetUser has no Task Scheduler interactive token; sign the user in normally, then retry" }
      if ($scheduled.State -eq 'Ready' -and ($observedRunning -or $info.LastRunTime.Year -gt 2000) -and $info.LastTaskResult -notin @(267008,267009)) {
        Start-Sleep -Milliseconds 100
        if (Test-Path -LiteralPath $taskResult) { continue }
        Fail "target-user task ended without an atomic result (Windows result $($info.LastTaskResult))"
      }
    }
    $value = Get-Content -Raw -LiteralPath $taskResult | ConvertFrom-Json
    if ($value.InvocationId -ne $invocationId -or $value.Sid -ne $target.Sid) { Fail 'target-user task returned stale or mismatched result data' }
    $value
  } finally {
    Unregister-ScheduledTask -TaskName $taskName -TaskPath $taskPath -Confirm:$false -ErrorAction SilentlyContinue
  }
}
try {
  $probeResult = Invoke-UserPhase $true
  if ($probeResult.Phase -ne 'probe-complete') { Fail "target-token preflight failed: $($probeResult.Cause)" }
} catch {
  $state.Phase=if($removedKnown){'user-install-failed'}else{'failed-before-uninstall'}; $state.Cause=$_.Exception.Message; $state.UpdatedUtc=[DateTime]::UtcNow.ToString('o'); Save-State $state $statePath
  throw
}

if ($machineEntry) {
  $state.Phase='uninstalling-machine'; $state.UpdatedUtc=[DateTime]::UtcNow.ToString('o'); Save-State $state $statePath
  $uninstall = Start-Process -FilePath $canonicalUninstaller -ArgumentList @('/S',("_?=" + $oldDir)) -Wait -PassThru
  if ($uninstall.ExitCode -ne 0) { $state.Phase='machine-uninstall-failed'; $state.Cause="uninstaller exited $($uninstall.ExitCode)"; Save-State $state $statePath; Fail $state.Cause }
  if ((Test-Path -LiteralPath $oldExe) -or (Read-Uninstall LocalMachine Registry64 $productKey) -or (Read-Uninstall LocalMachine Registry32 $productKey)) { $state.Phase='machine-uninstall-failed'; $state.Cause='registration or executable remains'; Save-State $state $statePath; Fail $state.Cause }
}
$state.Phase='removed-pending-user-install'; $state.UpdatedUtc=[DateTime]::UtcNow.ToString('o'); Save-State $state $statePath
try {
  Write-Host "Waiting for the target-user installer phase. Leave the target session signed in."
  $result = Invoke-UserPhase $false
  if ($result.Phase -ne 'verified-complete') { $state.Phase='user-install-failed'; $state.Cause=[string]$result.Cause; Save-State $state $statePath; Fail "per-user install failed after machine removal: $($result.Cause). Rerun the identical command to resume." }
  if ((Read-Uninstall LocalMachine Registry64 $productKey) -or (Read-Uninstall LocalMachine Registry32 $productKey)) { Fail "machine registration reappeared after user install" }
  $verifiedUser = Read-Uninstall Users Registry64 "$($target.Sid)\$productKey"
  if (-not $verifiedUser) { $verifiedUser = Read-Uninstall Users Registry32 "$($target.Sid)\$productKey" }
  $verifiedExe = Join-Path $destination 'screenpipe-app.exe'
  if (-not $verifiedUser -or (Canonical $verifiedUser.Location) -ne $destination -or -not (Test-Path -LiteralPath $verifiedExe)) { Fail "administrator verification of target registration/path failed" }
  $verifiedPayloadHash = (Get-FileHash -LiteralPath $verifiedExe -Algorithm SHA256).Hash
  if ($verifiedUser.Version -ne $result.Version -or $verifiedPayloadHash -ne $result.PayloadSha256) { Fail 'administrator verification of installed version/payload hash failed' }
  $state.Phase='verified-complete'; $state.Cause=[string]$result.Cause; $state.InstalledVersion=$verifiedUser.Version; $state.PayloadSha256=$verifiedPayloadHash; $state.UpdatedUtc=[DateTime]::UtcNow.ToString('o'); Save-State $state $statePath
  Write-Host "Migration verified complete: $($target.Account) -> $destination"
  Write-Host "Result: $statePath"
} catch {
  if ($state.Phase -ne 'verified-complete') { $state.Phase='user-install-failed'; $state.Cause=$_.Exception.Message; $state.UpdatedUtc=[DateTime]::UtcNow.ToString('o'); Save-State $state $statePath }
  throw
}
} finally {
  $migrationLock.Dispose()
}
