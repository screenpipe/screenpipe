# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com

$ErrorActionPreference = 'Stop'
$script = (Resolve-Path "$PSScriptRoot\..\setup-vulkan-windows.ps1").Path
$kits = 'C:\Program Files (x86)\Windows Kits\10\Lib'
$version = Get-ChildItem -LiteralPath $kits -Directory | Sort-Object Name -Descending | Select-Object -First 1
$armLibrary = Join-Path $version.FullName 'um\arm64\kernel32.lib'
$x64Library = Join-Path $version.FullName 'um\x64\kernel32.lib'
if (-not (Test-Path $armLibrary) -or -not (Test-Path $x64Library)) {
    throw 'Windows SDK ARM64 and x64 import libraries are required for this test'
}

$root = Join-Path $env:TEMP "screenpipe-vulkan-test-$PID"
New-Item -ItemType Directory -Path $root | Out-Null
try {
    function Invoke-Case {
        param([string]$Name, [string]$Architecture, [hashtable]$Libraries, [string]$ExpectedDirectory, [string]$ExpectedError)
        $sdk = Join-Path $root $Name
        New-Item -ItemType Directory -Path "$sdk\Include\vulkan", "$sdk\Bin" -Force | Out-Null
        Set-Content -LiteralPath "$sdk\Include\vulkan\vulkan.h" -Value '// test fixture'
        foreach ($entry in $Libraries.GetEnumerator()) {
            New-Item -ItemType Directory -Path "$sdk\$($entry.Key)" -Force | Out-Null
            Copy-Item -LiteralPath $entry.Value -Destination "$sdk\$($entry.Key)\vulkan-1.lib"
        }
        $githubEnv = Join-Path $sdk 'github.env'
        $githubPath = Join-Path $sdk 'github.path'
        $oldLib = $env:LIB
        $env:LIB = 'C:\preserved-lib'
        $env:GITHUB_ENV = $githubEnv
        $env:GITHUB_PATH = $githubPath
        try {
            & $script -Architecture $Architecture -InstallSdk -SdkDirectory $sdk 2>&1 | Out-Null
            if ($ExpectedError) { throw "$Name unexpectedly succeeded" }
            $expected = "LIB=$sdk\$ExpectedDirectory;C:\preserved-lib"
            if ((Get-Content -LiteralPath $githubEnv) -notcontains $expected) {
                throw "$Name did not export expected LIB value: $expected"
            }
        } catch {
            if (-not $ExpectedError -or $_.Exception.Message -notmatch $ExpectedError) { throw }
        } finally {
            $env:LIB = $oldLib
        }
        Write-Host "PASS $Name"
    }

    Invoke-Case native-arm arm64 @{ Lib = $armLibrary } Lib
    Invoke-Case cross-arm arm64 @{ Lib = $x64Library; 'Lib-ARM64' = $armLibrary } 'Lib-ARM64'
    Invoke-Case native-x64 x64 @{ Lib = $x64Library } Lib
    Invoke-Case wrong-arm arm64 @{ Lib = $x64Library } '' 'wrong-architecture'
    Invoke-Case missing-arm arm64 @{} '' 'import library missing'
} finally {
    if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
