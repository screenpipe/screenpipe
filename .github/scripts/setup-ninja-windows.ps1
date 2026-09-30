# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com

[CmdletBinding()]
param(
    [string]$TargetDirectory = $env:CARGO_TARGET_DIR
)

$ErrorActionPreference = 'Stop'

$ninja = Get-Command ninja.exe -ErrorAction SilentlyContinue
if (-not $ninja) {
    $knownPaths = @('C:\Program Files\Ninja', 'C:\Tools\Ninja')
    $ninjaDirectory = $knownPaths |
        Where-Object { Test-Path -LiteralPath "$_\ninja.exe" } |
        Select-Object -First 1

    if (-not $ninjaDirectory) {
        if (Get-Command winget.exe -ErrorAction SilentlyContinue) {
            winget install Ninja-build.Ninja --accept-package-agreements --accept-source-agreements --silent
            $ninjaDirectory = $knownPaths |
                Where-Object { Test-Path -LiteralPath "$_\ninja.exe" } |
                Select-Object -First 1
        }

        if (-not $ninjaDirectory) {
            $archive = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'ninja-winarm64.zip' } else { 'ninja-win.zip' }
            $zip = Join-Path $env:RUNNER_TEMP $archive
            $ninjaDirectory = 'C:\Tools\Ninja'
            Invoke-WebRequest "https://github.com/ninja-build/ninja/releases/latest/download/$archive" -OutFile $zip
            New-Item -ItemType Directory -Force -Path $ninjaDirectory | Out-Null
            Expand-Archive -LiteralPath $zip -DestinationPath $ninjaDirectory -Force
        }
    }

    $ninjaDirectory | Out-File -FilePath $env:GITHUB_PATH -Append -Encoding utf8
    $env:Path = "$ninjaDirectory;$env:Path"
    $ninja = Get-Command ninja.exe -ErrorAction Stop
}

"CMAKE_GENERATOR=Ninja" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
$env:CMAKE_GENERATOR = 'Ninja'
Write-Host "Using Ninja $(& $ninja.Source --version) at $($ninja.Source)"

if ($TargetDirectory -and (Test-Path -LiteralPath $TargetDirectory)) {
    $targetRoot = (Get-Item -LiteralPath $TargetDirectory).FullName.TrimEnd('\')
    Get-ChildItem -LiteralPath $targetRoot -Filter CMakeCache.txt -File -Recurse -ErrorAction SilentlyContinue |
        ForEach-Object {
            $generator = Select-String -LiteralPath $_.FullName -Pattern '^CMAKE_GENERATOR:(?:INTERNAL|UNINITIALIZED)=(.+)$' |
                Select-Object -First 1
            if ($generator -and $generator.Matches[0].Groups[1].Value -ne 'Ninja') {
                $buildDirectory = (Get-Item -LiteralPath $_.Directory.FullName).FullName
                if (-not $buildDirectory.StartsWith("$targetRoot\", [StringComparison]::OrdinalIgnoreCase)) {
                    throw "Refusing to remove CMake cache outside target directory: $buildDirectory"
                }
                Write-Host "Removing stale $($generator.Matches[0].Groups[1].Value) CMake build directory: $buildDirectory"
                Remove-Item -LiteralPath $buildDirectory -Recurse -Force
            }
        }
}
