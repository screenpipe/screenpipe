# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com

<#
.SYNOPSIS
Focused disposable-VM acceptance test for windows-migrate-enterprise-to-user.ps1.

.DESCRIPTION
Run elevated in PowerShell 7 after building fixtures with
apps/screenpipe-app-tauri/scripts/windows-enterprise-installer.integration.ps1
and signing them with a disposable test code-signing certificate whose subject
is Mediar, Inc. The standard TargetUser must be signed in normally. This test
never enables an unsigned-fixture bypass in the production migration tool.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $TargetUser,
  [Parameter(Mandatory)] [string] $LegacyInstallerA,
  [Parameter(Mandatory)] [string] $InstallerB,
  [Parameter(Mandatory)] [string] $InstallerC,
  [Parameter(Mandatory)] [string] $ResultsDir
)

$ErrorActionPreference = 'Stop'
$migration = Join-Path $PSScriptRoot 'windows-migrate-enterprise-to-user.ps1'
$target = (New-Object Security.Principal.NTAccount($TargetUser)).Translate([Security.Principal.SecurityIdentifier])
$profile = [Environment]::ExpandEnvironmentVariables([string](Get-ItemPropertyValue "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$target" ProfileImagePath))
$machineDir = Join-Path $env:ProgramData 'Screenpipe migration legacy A space'
$userDir = Join-Path $profile 'AppData\Local\Screenpipe migrated path with spaces'
$sentinel = Join-Path $profile '.screenpipe\migration-sentinel.txt'
$key = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\screenpipe enterprise'
New-Item -ItemType Directory -Force -Path $ResultsDir,(Split-Path -Parent $sentinel) | Out-Null
Set-Content -LiteralPath $sentinel -Value 'preserve-me'

function Invoke-Setup([string]$Path,[string[]]$Arguments) {
  $p = Start-Process -FilePath $Path -ArgumentList $Arguments -Wait -PassThru
  if ($p.ExitCode) { throw "$Path exited $($p.ExitCode)" }
}
function Assert([bool]$Condition,[string]$Message) { if (-not $Condition) { throw $Message } }
function Target-Uninstall {
  Get-ItemProperty "Registry::HKEY_USERS\$target\$key" -ErrorAction SilentlyContinue
}

function Invoke-MigrationPs51([string]$Installer,[string]$Hash) {
  $command = "`$ConfirmPreference='None'; & '$migration' -TargetUser '$TargetUser' -InstallerPath '$Installer' -InstallerSha256 '$Hash' -InstallDirectory '$userDir'"
  & "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command $command
  if ($LASTEXITCODE) { throw "migration PowerShell 5.1 process exited $LASTEXITCODE" }
}

function Invoke-AsTarget([string]$Executable,[string]$Arguments) {
  $name = 'Screenpipe migration integration ' + [guid]::NewGuid().ToString('N')
  $principal = New-ScheduledTaskPrincipal -UserId $target.Value -LogonType Interactive -RunLevel Limited
  $action = if ($Arguments) { New-ScheduledTaskAction -Execute $Executable -Argument $Arguments } else { New-ScheduledTaskAction -Execute $Executable }
  $task = New-ScheduledTask -Action $action -Principal $principal -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero))
  Register-ScheduledTask -TaskName $name -TaskPath '\Screenpipe\' -InputObject $task | Out-Null
  try {
    Start-ScheduledTask -TaskName $name -TaskPath '\Screenpipe\'
    do { Start-Sleep -Milliseconds 250; $registered = Get-ScheduledTask -TaskName $name -TaskPath '\Screenpipe\'; $info = Get-ScheduledTaskInfo -TaskName $name -TaskPath '\Screenpipe\' } while ($registered.State -ne 'Ready')
    Assert ($info.LastTaskResult -eq 0) "target task exited $($info.LastTaskResult)"
  } finally { Unregister-ScheduledTask -TaskName $name -TaskPath '\Screenpipe\' -Confirm:$false -ErrorAction SilentlyContinue }
}

Invoke-Setup $LegacyInstallerA @('/S',('/D=' + $machineDir))
# ProgramData permits users to create children by default. A supported machine
# deployment must protect its owned install directory before it can be trusted.
$machineAcl = New-Object Security.AccessControl.DirectorySecurity
$machineAcl.SetSecurityDescriptorSddlForm('O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;GRGX;;;BU)')
Set-Acl -LiteralPath $machineDir -AclObject $machineAcl
$oldUninstaller = Join-Path $machineDir 'uninstall.exe'
$signedOld = Get-AuthenticodeSignature -LiteralPath $oldUninstaller
$newSigner = (Get-AuthenticodeSignature -LiteralPath $InstallerB).SignerCertificate
Assert ($signedOld.Status -eq 'Valid') 'old uninstaller certificate A is not OS-valid'
Assert ($newSigner -and $newSigner.Thumbprint -ne $signedOld.SignerCertificate.Thumbprint) 'old uninstaller certificate A and new installer certificate B must differ'
$before = Get-ItemProperty 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\screenpipe enterprise'
$hashA = (Get-FileHash (Join-Path $machineDir 'screenpipe-app.exe')).Hash
$hashBInstaller = (Get-FileHash $InstallerB).Hash

$badHashRejected = $false
try { & $migration -TargetUser $TargetUser -InstallerPath $InstallerB -InstallerSha256 ('0' * 64) -InstallDirectory $userDir -Confirm:$false }
catch { $badHashRejected = $_.Exception.Message -match 'SHA-256' }
Assert $badHashRejected 'bad hash was not rejected'
Assert ((Get-ItemProperty 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\screenpipe enterprise').DisplayVersion -eq $before.DisplayVersion) 'bad hash changed machine install'

# An explicit target write ACE is unsafe even when owner and broad-group ACLs
# otherwise look correct. Ordinary Users read/execute remains supported.
$uninstallerAcl = Get-Acl -LiteralPath $oldUninstaller
$targetWrite = New-Object Security.AccessControl.FileSystemAccessRule($target,'Write','Allow')
$uninstallerAcl.AddAccessRule($targetWrite)
Set-Acl -LiteralPath $oldUninstaller -AclObject $uninstallerAcl
$explicitTargetWriteRejected = $false
try { & $migration -TargetUser $TargetUser -InstallerPath $InstallerB -InstallerSha256 $hashBInstaller -InstallDirectory $userDir -Confirm:$false }
catch { $explicitTargetWriteRejected = $_.Exception.Message -match 'untrusted SID' }
Assert $explicitTargetWriteRejected 'explicit target-write ACE on old uninstaller was not rejected'
Assert (Test-Path -LiteralPath $oldUninstaller) 'unsafe uninstaller ACL test removed the app'
$uninstallerAcl.RemoveAccessRuleAll($targetWrite)
Set-Acl -LiteralPath $oldUninstaller -AclObject $uninstallerAcl

# A target-created staging junction must be rejected without following it or
# overwriting an administrator canary.
$stageRoot = Join-Path $env:ProgramData 'ScreenpipeMigration'
Assert (-not (Test-Path -LiteralPath $stageRoot)) 'security fixture requires an absent migration staging root'
$canaryDir = Join-Path $ResultsDir 'staging-junction-canary'
New-Item -ItemType Directory -Force -Path $canaryDir | Out-Null
$canary = Join-Path $canaryDir 'user-phase.ps1'
Set-Content -LiteralPath $canary -Value 'ADMIN-CANARY'
Invoke-AsTarget "$env:WINDIR\System32\cmd.exe" ("/d /c mklink /J `"$stageRoot`" `"$canaryDir`"")
$junctionRejected = $false
try { & $migration -TargetUser $TargetUser -InstallerPath $InstallerB -InstallerSha256 $hashBInstaller -InstallDirectory $userDir -Confirm:$false }
catch { $junctionRejected = $_.Exception.Message -match 'reparse point' }
Assert $junctionRejected 'target-created staging junction was not rejected'
Assert ((Get-Content -Raw -LiteralPath $canary).Trim() -eq 'ADMIN-CANARY') 'staging junction overwrote the admin canary'
[IO.Directory]::Delete($stageRoot)

# Establish the same protected namespace production creates, then prove the
# same-target lock returns immediately and explicitly.
$rootAcl = New-Object Security.AccessControl.DirectorySecurity
$rootAcl.SetSecurityDescriptorSddlForm("O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;GRGX;;;$($target.Value))")
New-Item -ItemType Directory -Path $stageRoot | Out-Null; Set-Acl -LiteralPath $stageRoot -AclObject $rootAcl
$targetStage = Join-Path $stageRoot $target.Value.Replace('-','_')
New-Item -ItemType Directory -Path $targetStage | Out-Null; Set-Acl -LiteralPath $targetStage -AclObject $rootAcl
$heldLock = [IO.File]::Open((Join-Path $targetStage 'migration.lock'),'OpenOrCreate','ReadWrite','None')
$alreadyRunningRejected = $false
try {
  try { & $migration -TargetUser $TargetUser -InstallerPath $InstallerB -InstallerSha256 $hashBInstaller -InstallDirectory $userDir -Confirm:$false }
  catch { $alreadyRunningRejected = $_.Exception.Message -match 'already running' }
} finally { $heldLock.Dispose() }
Assert $alreadyRunningRejected 'same-target concurrent run did not return already-running'

$blockedDestinationAcl = New-Object Security.AccessControl.DirectorySecurity
$blockedDestinationAcl.SetSecurityDescriptorSddlForm('O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)')
New-Item -ItemType Directory -Force -Path $userDir | Out-Null
Set-Acl -LiteralPath $userDir -AclObject $blockedDestinationAcl
$destinationRejectedBeforeRemoval = $false
try { & $migration -TargetUser $TargetUser -InstallerPath $InstallerB -InstallerSha256 $hashBInstaller -InstallDirectory $userDir -Confirm:$false }
catch { $destinationRejectedBeforeRemoval = $true }
Assert $destinationRejectedBeforeRemoval 'pre-existing unwritable destination was not rejected'
Assert (Test-Path -LiteralPath $oldUninstaller) 'destination preflight failure removed the old app'
$sameHostLockProbe = [IO.File]::Open((Join-Path $targetStage 'migration.lock'),'Open','ReadWrite','None')
$sameHostLockProbe.Dispose()
[IO.Directory]::Delete($userDir)

$tasksBefore = @(Get-ScheduledTask -TaskPath '\Screenpipe\' -ErrorAction SilentlyContinue).Count
& $migration -TargetUser $TargetUser -InstallerPath $InstallerB -InstallerSha256 $hashBInstaller -InstallDirectory $userDir -WhatIf
Assert (@(Get-ScheduledTask -TaskPath '\Screenpipe\' -ErrorAction SilentlyContinue).Count -eq $tasksBefore) 'WhatIf changed scheduled tasks'
Assert ((Get-ItemProperty 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\screenpipe enterprise').DisplayVersion -eq $before.DisplayVersion) 'WhatIf changed machine install'

$runKey = "Registry::HKEY_USERS\$target\Software\Microsoft\Windows\CurrentVersion\Run"
New-Item -Path $runKey -Force | Out-Null
$startupArguments = ' --autostart --migration-fixture-argument'
New-ItemProperty -Path $runKey -Name 'screenpipe enterprise' -Value ('"' + (Join-Path $machineDir 'screenpipe-app.exe') + '"' + $startupArguments) -PropertyType String -Force | Out-Null

# Inject a real post-uninstall OS failure by revoking destination writes only
# after the limited-token probe has passed and machine removal has begun.
$statePath = Join-Path $env:ProgramData ("ScreenpipeMigration\" + $target.Value.Replace('-','_') + '\result.json')
$fault = Start-Job -ArgumentList $statePath,$userDir -ScriptBlock {
  param($statePath,$userDir)
  while ($true) {
    if (Test-Path $statePath) {
      try { $phase = (Get-Content -Raw $statePath | ConvertFrom-Json).Phase } catch { $phase = '' }
      if ($phase -eq 'uninstalling-machine') {
        New-Item -ItemType Directory -Force $userDir | Out-Null
        $acl = New-Object Security.AccessControl.DirectorySecurity
        $acl.SetSecurityDescriptorSddlForm('O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)')
        Set-Acl -LiteralPath $userDir -AclObject $acl
        return
      }
    }
    Start-Sleep -Milliseconds 20
  }
}
$failedAfterRemoval = $false
try { Invoke-MigrationPs51 $InstallerB $hashBInstaller }
catch { $failedAfterRemoval = $_.Exception.Message -match 'exited' }
finally { Wait-Job $fault -Timeout 10 | Out-Null; Remove-Job $fault -Force }
Assert $failedAfterRemoval 'representative post-removal failure did not surface'
Assert (-not (Test-Path 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\screenpipe enterprise')) 'machine registration remained after removal failure'
Assert ((Get-Content -Raw $statePath | ConvertFrom-Json).Phase -eq 'user-install-failed') 'durable recovery phase/cause missing'

$userAcl = New-Object Security.AccessControl.DirectorySecurity
$userAcl.SetSecurityDescriptorSddlForm("O:$($target.Value)G:$($target.Value)D:P(A;OICI;FA;;;$($target.Value))(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)")
Set-Acl -LiteralPath $userDir -AclObject $userAcl
# Simulate restart after the uninstaller completed but before the durable phase
# advanced. Absence of both recorded old exe and HKLM registration must recover.
$interrupted = Get-Content -Raw $statePath | ConvertFrom-Json
$interrupted.Phase = 'uninstalling-machine'
$interrupted | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $statePath -Encoding UTF8
Invoke-MigrationPs51 $InstallerB $hashBInstaller
$registeredB = Target-Uninstall
Assert ($null -ne $registeredB) 'target HKU registration missing after migration'
Assert ($registeredB.InstallLocation.Trim('"') -eq $userDir) 'target install path mismatch'
Assert (-not (Test-Path 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\screenpipe enterprise')) 'HKLM registration remains'
Assert (Test-Path $sentinel) 'data sentinel was removed'
$hashB = (Get-FileHash (Join-Path $userDir 'screenpipe-app.exe')).Hash
Assert ($hashA -ne $hashB) 'payload A was not replaced by B'
Assert ((Get-ItemProperty $runKey).'screenpipe enterprise' -eq ('"' + (Join-Path $userDir 'screenpipe-app.exe') + '"' + $startupArguments)) 'startup path/arguments were not preserved'
$markerB = Join-Path $profile '.screenpipe\installer-proof-launch-B.txt'
$markerBText = Get-Content -Raw $markerB
Assert ($markerBText -match ('sid=' + [regex]::Escape($target.Value)) -and $markerBText -match 'elevated=0' -and $markerBText -match 'is_admin=False') 'B did not launch with the target limited token'

# An interrupted finalization with the exact expected per-user installation
# must retry verification/launch, then a completed rerun is a verified no-op.
$retryState = Get-Content -Raw $statePath | ConvertFrom-Json
$retryState.Phase = 'user-install-failed'
$retryState | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $statePath -Encoding UTF8
Remove-Item -LiteralPath $markerB -Force
Invoke-MigrationPs51 $InstallerB $hashBInstaller
Assert (Test-Path -LiteralPath $markerB) 'interrupted finalization did not retry target launch'
Invoke-MigrationPs51 $InstallerB $hashBInstaller

# A normal B -> C update stays in the target's limited token and retains scope/path.
Invoke-AsTarget $InstallerC '/S /P /UPDATE'
$registeredC = Target-Uninstall
$hashC = (Get-FileHash (Join-Path $userDir 'screenpipe-app.exe')).Hash
Assert ($registeredC.DisplayVersion -ne $registeredB.DisplayVersion -and $hashC -ne $hashB) 'C did not replace B with a distinct version/hash'
Assert ($registeredC.InstallLocation.Trim('"') -eq $userDir) 'C changed the per-user update path'
Assert (-not (Test-Path 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\screenpipe enterprise')) 'C update created machine registration'
$userExe = Join-Path $userDir 'screenpipe-app.exe'
$markerCPath = Join-Path $profile '.screenpipe\installer-proof-launch-C.txt'
Remove-Item -LiteralPath $markerCPath -Force -ErrorAction SilentlyContinue
Invoke-AsTarget "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" ("-NoProfile -NonInteractive -Command `"Start-Process -FilePath '" + $userExe.Replace("'","''") + "'`"")
for ($i=0; $i -lt 40 -and -not (Test-Path -LiteralPath $markerCPath); $i++) { Start-Sleep -Milliseconds 250 }
$markerC = Get-Content -Raw $markerCPath
Assert ($markerC -match 'elevated=0' -and $markerC -match 'is_admin=False') 'C did not launch non-elevated as target'
Get-CimInstance Win32_Process -Filter "Name='screenpipe-app.exe'" | Where-Object { $_.ExecutablePath -eq $userExe } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

[pscustomobject]@{
  TargetSid = $target.Value
  MachineVersionA = $before.DisplayVersion
  UserVersionB = $registeredB.DisplayVersion
  UserVersionC = $registeredC.DisplayVersion
  PayloadHashA = $hashA
  PayloadHashB = $hashB
  PayloadHashC = $hashC
  SentinelPreserved = Test-Path $sentinel
  BadHashRejectedBeforeMutation = $badHashRejected
  ExplicitTargetWriteRejected = $explicitTargetWriteRejected
  StagingJunctionRejected = $junctionRejected
  StagingCanaryPreserved = $true
  AlreadyRunningRejected = $alreadyRunningRejected
  UnwritableDestinationRejectedBeforeRemoval = $destinationRejectedBeforeRemoval
  OldAndNewSignerThumbprintsDiffer = $true
  FailedAfterRemoval = $failedAfterRemoval
  RecoveryPhase = (Get-Content -Raw $statePath | ConvertFrom-Json).Phase
  AutostartArgumentsPreserved = $true
  TargetLaunchB = Get-Content -Raw $markerB
  TargetLaunchC = $markerC
} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $ResultsDir 'migration-integration-result.json') -Encoding UTF8
