# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com
#
# Converts the enterprise NSIS setup .exe to .intunewin for Microsoft Intune (Win32 app).
# The generated package uses an install wrapper that writes a registry marker
# so the app can detect Intune/MDM-managed updates and avoid self-updating.
# Usage:
#   .\exe-to-intunewin.ps1
#     (uses default: src-tauri\target\x86_64-pc-windows-msvc\release\bundle\nsis\*setup*.exe)
#   .\exe-to-intunewin.ps1 -SetupExe "C:\path\to\screenpipe-2.50.3-setup.exe"
#   .\exe-to-intunewin.ps1 -SetupExe "C:\path\to\screenpipe-2.50.3-setup.exe" -OutDir "C:\intunewin\out"
#
# Run from: apps/screenpipe-app-tauri (or pass full path to -SetupExe).

param(
    [string]$SetupExe = "",
    [string]$OutDir = ""
)

$ErrorActionPreference = "Stop"
$scriptRoot = $PSScriptRoot
$appRoot = Split-Path $scriptRoot -Parent

# Resolve setup exe
if ($SetupExe -eq "") {
    $nsisDir = Join-Path $appRoot "src-tauri\target\x86_64-pc-windows-msvc\release\bundle\nsis"
    $exe = Get-ChildItem (Join-Path $nsisDir "*setup*.exe") -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $exe) {
        Write-Error "No *setup*.exe found in $nsisDir. Build the enterprise installer first or pass -SetupExe <path>."
    }
    $SetupExe = $exe.FullName
} else {
    if (-not (Test-Path $SetupExe)) { Write-Error "Setup exe not found: $SetupExe" }
    $SetupExe = (Resolve-Path $SetupExe).Path
}

$setupName = Split-Path $SetupExe -Leaf
$isPersistent = $setupName -like "*-persistent.exe"
$persistenceMode = if ($isPersistent) { 1 } else { 0 }
Write-Host "=== Converting to .intunewin: $setupName ==="

# Working dir: script dir / intunewin (so we don't pollute src)
$workDir = Join-Path $scriptRoot "intunewin"
$packageDir = Join-Path $workDir "package"
$toolDir = Join-Path $workDir "tool"
if ($OutDir -eq "") { $OutDir = Join-Path $workDir "out" }

if (Test-Path $packageDir) { Remove-Item $packageDir -Recurse -Force }
if (Test-Path $OutDir) { Remove-Item $OutDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $packageDir | Out-Null
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# Package: setup exe + install wrapper. Intune runs the wrapper, which runs the
# signed installer silently and then stamps the update-manager metadata.
Copy-Item $SetupExe -Destination (Join-Path $packageDir $setupName) -Force
$cargoToml = Join-Path $appRoot "src-tauri\Cargo.toml"
$version = "unknown"
if (Test-Path $cargoToml) {
    $match = Select-String -Path $cargoToml -Pattern '^version = "(.*)"' | Select-Object -First 1
    if ($match) { $version = $match.Matches[0].Groups[1].Value }
}

$uninstallScript = Join-Path $packageDir "uninstall-screenpipe-enterprise.ps1"
@'
# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com

$ErrorActionPreference = "Stop"
$programFiles64 = [Environment]::GetEnvironmentVariable("ProgramW6432")
if ([string]::IsNullOrWhiteSpace($programFiles64)) {
    $programFiles64 = [Environment]::GetEnvironmentVariable("ProgramFiles")
}
$uninstaller = Join-Path $programFiles64 "screenpipe\uninstall.exe"
if (Test-Path -LiteralPath $uninstaller) {
    $proc = Start-Process -FilePath $uninstaller -ArgumentList "/S" -Wait -PassThru
    if ($proc.ExitCode -ne 0) {
        throw "screenpipe uninstaller failed with exit code $($proc.ExitCode)"
    }
}

$base = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
    [Microsoft.Win32.RegistryHive]::LocalMachine,
    [Microsoft.Win32.RegistryView]::Registry64
)
$base.DeleteSubKeyTree("SOFTWARE\screenpipe", $false)
$base.Close()

$mdmRoot = Join-Path $env:ProgramData "screenpipe\mdm"
Remove-Item -LiteralPath $mdmRoot -Recurse -Force -ErrorAction SilentlyContinue
'@ | Set-Content -Path $uninstallScript -Encoding UTF8

$installScript = Join-Path $packageDir "install-screenpipe-enterprise.ps1"
@"
# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com

`$ErrorActionPreference = "Stop"
`$setup = Join-Path `$PSScriptRoot "$setupName"
`$proc = Start-Process -FilePath `$setup -ArgumentList "/S" -Wait -PassThru
if (`$proc.ExitCode -ne 0) {
    throw "screenpipe installer failed with exit code `$(`$proc.ExitCode)"
}
`$base = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
    [Microsoft.Win32.RegistryHive]::LocalMachine,
    [Microsoft.Win32.RegistryView]::Registry64
)
`$key = `$base.CreateSubKey("SOFTWARE\screenpipe")
`$key.SetValue("InstallSource", "Intune", [Microsoft.Win32.RegistryValueKind]::String)
`$key.SetValue("UpdateManager", "mdm", [Microsoft.Win32.RegistryValueKind]::String)
`$key.SetValue("Version", "$version", [Microsoft.Win32.RegistryValueKind]::String)
`$key.SetValue("PersistenceMode", $persistenceMode, [Microsoft.Win32.RegistryValueKind]::DWord)
`$key.Close()
`$base.Close()

`$mdmRoot = Join-Path `$env:ProgramData "screenpipe\mdm"
New-Item -ItemType Directory -Force -Path `$mdmRoot | Out-Null
Copy-Item -LiteralPath (Join-Path `$PSScriptRoot "uninstall-screenpipe-enterprise.ps1") -Destination `$mdmRoot -Force
& icacls.exe `$mdmRoot /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' | Out-Null
if (`$LASTEXITCODE -ne 0) { throw "failed to protect screenpipe MDM helper directory" }
"@ | Set-Content -Path $installScript -Encoding UTF8
Write-Host "Package folder: $packageDir (installer + Intune install/uninstall wrappers)"

# Download IntuneWinAppUtil if needed
$utilExe = Get-ChildItem (Join-Path $toolDir "*.exe") -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq "IntuneWinAppUtil.exe" } | Select-Object -First 1
if (-not $utilExe) {
    Write-Host "Downloading Microsoft Win32 Content Prep Tool..."
    New-Item -ItemType Directory -Force -Path $toolDir | Out-Null
    # Download from official Microsoft GitHub repo (the go.microsoft.com redirect can return non-zip content in CI)
    $zipUrl = "https://github.com/microsoft/Microsoft-Win32-Content-Prep-Tool/archive/refs/heads/master.zip"
    $utilZip = Join-Path $env:TEMP "IntuneWinAppUtil.zip"
    Invoke-WebRequest -Uri $zipUrl -OutFile $utilZip -UseBasicParsing
    Expand-Archive -Path $utilZip -DestinationPath $toolDir -Force
    $utilExe = Get-ChildItem (Join-Path $toolDir "*.exe") -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq "IntuneWinAppUtil.exe" } | Select-Object -First 1
    if (-not $utilExe) { Write-Error "IntuneWinAppUtil.exe not found after extract in $toolDir" }
}

# Run the tool
$sourceFolder = $packageDir
$setupPathInPackage = $installScript
& $utilExe.FullName -c $sourceFolder -s $setupPathInPackage -o $OutDir -q

$intunewin = Get-ChildItem (Join-Path $OutDir "*.intunewin") -ErrorAction SilentlyContinue | Select-Object -First 1
if ($intunewin) {
    $flavor = if ($isPersistent) { "-persistent" } else { "" }
    $publishedName = "screenpipe-enterprise-$version-x64$flavor.intunewin"
    $publishedPath = Join-Path $OutDir $publishedName
    if ($intunewin.FullName -ne $publishedPath) {
        Move-Item -LiteralPath $intunewin.FullName -Destination $publishedPath -Force
        $intunewin = Get-Item -LiteralPath $publishedPath
    }
    Write-Host "=== Done ==="
    Write-Host "  .intunewin: $($intunewin.FullName)"
} else {
    Write-Error "No .intunewin produced in $OutDir"
}
