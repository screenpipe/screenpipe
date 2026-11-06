# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com

<#
.SYNOPSIS
Exercises Screenpipe app-data deletion through genuine compiled NSIS UIs.

.DESCRIPTION
Run on the disposable Windows development VM after compiling the small fixture
installers with windows-enterprise-installer.integration.ps1 -CompileOnly.
This drives the real checkbox with Windows UI Automation and uses fixture data
only. It does not build or exercise the Screenpipe engine.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $ResultsDir,
  [ValidateSet("custom", "upstream")] [string] $Package,
  [switch] $FailureCase
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient

$fixtureDir = Join-Path $ResultsDir "fixture"
$installerA = if ($Package -eq "custom") {
  Join-Path $fixtureDir "screenpipe-enterprise-A.exe"
} else {
  Join-Path $fixtureDir "screenpipe-enterprise-legacy-machine-A.exe"
}
$installerB = if ($Package -eq "custom") {
  Join-Path $fixtureDir "screenpipe-enterprise-B.exe"
} else {
  Join-Path $fixtureDir "screenpipe-enterprise-legacy-machine-B.exe"
}
$installDir = if ($Package -eq "custom") {
  Join-Path $env:LOCALAPPDATA "Screenpipe uninstall proof $Package ü space"
} else {
  Join-Path $env:ProgramData "Screenpipe uninstall proof $Package ü space"
}
$dataRoot = Join-Path $env:USERPROFILE ".screenpipe"
$nested = Join-Path $dataRoot "recordings\nested ü space"
$fixtureFile = Join-Path $nested "recording 文 fixture.txt"
$sibling = Join-Path $env:USERPROFILE "screenpipe-uninstall-sibling-$Package.txt"

function Invoke-Installer([string] $Path, [string[]] $Arguments) {
  $process = Start-Process -FilePath $Path -ArgumentList $Arguments -Wait -PassThru
  if ($process.ExitCode) { throw "installer exited $($process.ExitCode): $Path" }
}

function Reset-Fixture([string] $Value) {
  New-Item -ItemType Directory -Force -Path $nested | Out-Null
  [IO.File]::WriteAllText($fixtureFile, $Value, [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText($sibling, "must remain", [Text.UTF8Encoding]::new($false))
}

function Invoke-UninstallUi([bool] $DeleteData) {
  $uninstaller = Join-Path $installDir "uninstall.exe"
  $process = Start-Process -FilePath $uninstaller -PassThru
  $window = $null
  $checkbox = $null
  foreach ($attempt in 1..100) {
    Start-Sleep -Milliseconds 100
    $condition = New-Object Windows.Automation.PropertyCondition(
      [Windows.Automation.AutomationElement]::NameProperty,
      "screenpipe enterprise Uninstall ")
    $windows = [Windows.Automation.AutomationElement]::RootElement.FindAll(
      [Windows.Automation.TreeScope]::Children, $condition)
    foreach ($candidate in $windows) {
      $checkboxCondition = New-Object Windows.Automation.PropertyCondition(
        [Windows.Automation.AutomationElement]::ControlTypeProperty,
        [Windows.Automation.ControlType]::CheckBox)
      $candidateCheckbox = $candidate.FindFirst(
        [Windows.Automation.TreeScope]::Descendants, $checkboxCondition)
      if ($candidateCheckbox) {
        $window = $candidate
        $checkbox = $candidateCheckbox
        break
      }
    }
    if ($checkbox) { break }
  }
  if (-not $window) { throw "real NSIS uninstall window did not appear" }
  if (-not $checkbox) { throw "Delete application data checkbox was not found" }
  $toggle = $checkbox.GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern)
  if ($DeleteData -and $toggle.Current.ToggleState -ne [Windows.Automation.ToggleState]::On) {
    $toggle.Toggle()
  }

  $buttonCondition = New-Object Windows.Automation.AndCondition(
    (New-Object Windows.Automation.PropertyCondition(
      [Windows.Automation.AutomationElement]::ControlTypeProperty,
      [Windows.Automation.ControlType]::Button)),
    (New-Object Windows.Automation.PropertyCondition(
      [Windows.Automation.AutomationElement]::NameProperty, "Uninstall")))
  $button = $window.FindFirst([Windows.Automation.TreeScope]::Descendants, $buttonCondition)
  $button.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
  foreach ($attempt in 1..100) {
    Start-Sleep -Milliseconds 100
    $windows = [Windows.Automation.AutomationElement]::RootElement.FindAll(
      [Windows.Automation.TreeScope]::Children, [Windows.Automation.Condition]::TrueCondition)
    foreach ($candidate in $windows) {
      $okCondition = New-Object Windows.Automation.PropertyCondition(
        [Windows.Automation.AutomationElement]::NameProperty, "OK")
      $ok = $candidate.FindFirst([Windows.Automation.TreeScope]::Descendants, $okCondition)
      if ($ok -and $candidate.Current.Name -like "screenpipe enterprise*") {
        $ok.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
      }
      $closeCondition = New-Object Windows.Automation.PropertyCondition(
        [Windows.Automation.AutomationElement]::NameProperty, "Close")
      $close = $candidate.FindFirst([Windows.Automation.TreeScope]::Descendants, $closeCondition)
      if ($close -and $close.Current.IsEnabled -and
          $candidate.Current.Name -like "screenpipe enterprise*") {
        $close.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
        break
      }
    }
    if ($close) { break }
  }
  $process.WaitForExit()
  foreach ($attempt in 1..100) {
    if (-not (Test-Path -LiteralPath $uninstaller)) { break }
    Start-Sleep -Milliseconds 100
  }
}

if (-not (Test-Path -LiteralPath $installerA) -or -not (Test-Path -LiteralPath $installerB)) {
  throw "compiled $Package fixture installers are missing from $fixtureDir"
}

Reset-Fixture "update-preserve"
Invoke-Installer $installerA @("/S", "/D=$installDir")
Invoke-Installer $installerB @("/S", "/P", "/UPDATE")
if (-not (Test-Path -LiteralPath $fixtureFile)) { throw "/UPDATE deleted current-user data" }

Invoke-UninstallUi $false
if (-not (Test-Path -LiteralPath $fixtureFile)) { throw "unchecked uninstall deleted current-user data" }

Invoke-Installer $installerB @("/S", "/D=$installDir")
Reset-Fixture "checked-delete"
Invoke-UninstallUi $true
if (Test-Path -LiteralPath $dataRoot) { throw "checked uninstall retained $dataRoot" }
if (-not (Test-Path -LiteralPath $sibling)) { throw "checked uninstall deleted unrelated sibling" }

$failureReported = $null
if ($FailureCase) {
  Invoke-Installer $installerB @("/S", "/D=$installDir")
  Reset-Fixture "locked-delete-failure"
  $ready = Join-Path $ResultsDir "$Package-lock-ready-$([Guid]::NewGuid()).txt"
  $lockJob = Start-Job -ArgumentList $fixtureFile, $ready -ScriptBlock {
    param($Path, $Ready)
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
    Set-Content -LiteralPath $Ready -Value "locked"
    try { Start-Sleep -Seconds 120 } finally { $stream.Dispose() }
  }
  try {
    foreach ($attempt in 1..100) {
      if (Test-Path -LiteralPath $ready) { break }
      Start-Sleep -Milliseconds 100
    }
    if (-not (Test-Path -LiteralPath $ready)) { throw "locked-file fixture did not become ready" }
    Invoke-UninstallUi $true
    $supportLog = Join-Path $dataRoot "update-install.log"
    $failureReported = Test-Path -LiteralPath $supportLog
    if (-not $failureReported -or
        (Get-Content -LiteralPath $supportLog -Raw) -notmatch "uninstaller_app_data_cleanup_failed:.*outcome=data_retained") {
      throw "locked cleanup failure did not retain support evidence"
    }
    [IO.File]::WriteAllText(
      (Join-Path $ResultsDir "$Package-cleanup-failure.log"),
      (Get-Content -LiteralPath $supportLog -Raw),
      [Text.UTF8Encoding]::new($false))
  } finally {
    Stop-Job $lockJob -ErrorAction SilentlyContinue
    Remove-Job $lockJob -Force -ErrorAction SilentlyContinue
  }
}

[pscustomobject]@{
  Package = $Package
  InstallerProof = $true
  UpdatePreserved = $true
  UncheckedPreserved = $true
  CheckedDeletedNestedData = $true
  UnrelatedSiblingPreserved = $true
  LockedFailureReported = $failureReported
  Identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  Profile = $env:USERPROFILE
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $ResultsDir "$Package-uninstall-data.json") -Encoding utf8NoBOM
