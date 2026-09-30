# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com

[CmdletBinding()]
param(
    [ValidateSet('x64', 'arm64')]
    [string]$Architecture = 'x64',
    [switch]$InstallSdk,
    [string]$StageRuntimeDirectory,
    [string]$SdkDirectory
)

$ErrorActionPreference = 'Stop'
$version = '1.4.357.0'
$isArm64 = $Architecture -eq 'arm64'
$sdk = if ($SdkDirectory) { $SdkDirectory } else { "C:\VulkanSDK\$version" }

function Test-CoffLibraryMachine {
    param(
        [Parameter(Mandatory)] [string]$Path,
        [Parameter(Mandatory)] [UInt16]$ExpectedMachine
    )

    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $archiveMagic = [System.Text.Encoding]::ASCII.GetBytes("!<arch>`n")
    if ($bytes.Length -lt $archiveMagic.Length) { return $false }
    for ($i = 0; $i -lt $archiveMagic.Length; $i++) {
        if ($bytes[$i] -ne $archiveMagic[$i]) { return $false }
    }

    $offset = 8
    while ($offset + 60 -le $bytes.Length) {
        $sizeText = [System.Text.Encoding]::ASCII.GetString($bytes, $offset + 48, 10).Trim()
        [UInt64]$memberSize = 0
        if (-not [UInt64]::TryParse($sizeText, [ref]$memberSize)) { return $false }
        if ($memberSize -gt [int]::MaxValue) { return $false }
        $dataOffset = $offset + 60
        if ($memberSize -ge 8 -and $dataOffset + $memberSize -le $bytes.Length) {
            # Import objects use 0000 FFFF followed by version and machine.
            if ($bytes[$dataOffset] -eq 0 -and $bytes[$dataOffset + 1] -eq 0 -and
                $bytes[$dataOffset + 2] -eq 0xff -and $bytes[$dataOffset + 3] -eq 0xff) {
                $machine = [BitConverter]::ToUInt16($bytes, $dataOffset + 6)
                if ($machine -eq $ExpectedMachine) { return $true }
            }
        }
        $offset = $dataOffset + [int]$memberSize + ([int]$memberSize % 2)
    }
    return $false
}

function Get-VulkanLibraryDirectory {
    param(
        [Parameter(Mandatory)] [string]$Sdk,
        [Parameter(Mandatory)] [string]$TargetArchitecture
    )

    [UInt16]$expectedMachine = if ($TargetArchitecture -eq 'arm64') { 0xaa64 } else { 0x8664 }
    $expectedName = if ($TargetArchitecture -eq 'arm64') { 'ARM64 (0xAA64)' } else { 'x64 (0x8664)' }
    $directories = if ($TargetArchitecture -eq 'arm64') { @('Lib', 'Lib-ARM64') } else { @('Lib') }
    $wrongMachine = @()
    foreach ($directory in $directories) {
        $library = Join-Path $Sdk "$directory\vulkan-1.lib"
        if (Test-Path -LiteralPath $library) {
            if (Test-CoffLibraryMachine -Path $library -ExpectedMachine $expectedMachine) {
                return (Split-Path -Parent $library)
            }
            $wrongMachine += $library
        }
    }
    if ($wrongMachine.Count -gt 0) {
        throw "Vulkan SDK has no $expectedName vulkan-1.lib; wrong-architecture library found at: $($wrongMachine -join ', ')"
    }
    $checked = $directories | ForEach-Object { Join-Path (Join-Path $Sdk $_) 'vulkan-1.lib' }
    throw "Vulkan SDK $expectedName import library missing; checked: $($checked -join ', ')"
}

if ($InstallSdk) {
    if (-not (Test-Path -LiteralPath "$sdk\Include\vulkan\vulkan.h")) {
        $sdkUri = if ($isArm64) {
            "https://sdk.lunarg.com/sdk/download/$version/warm/vulkan_sdk.exe"
        } else {
            "https://sdk.lunarg.com/sdk/download/$version/windows/vulkan_sdk.exe"
        }
        $sdkSha = if ($isArm64) {
            'c10f18a9085018f66e1f50bd60623f17b7081faca165248de54f78728120f334'
        } else {
            '81f474711e9042f4cd22b31b2f7a8870db2e428b21586fb43dd80150be97310d'
        }
        if (-not (Test-Path -LiteralPath vulkan_sdk.exe)) {
            Invoke-WebRequest -Uri $sdkUri -OutFile vulkan_sdk.exe
        }
        if ((Get-FileHash vulkan_sdk.exe -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sdkSha) {
            throw 'Vulkan SDK installer hash mismatch'
        }
        & .\vulkan_sdk.exe --accept-licenses --default-answer --confirm-command install copy_only=1
        if ($LASTEXITCODE -ne 0) { throw "Vulkan SDK install failed: $LASTEXITCODE" }
        if (-not (Test-Path -LiteralPath "$sdk\Include\vulkan\vulkan.h")) {
            throw "Vulkan SDK headers missing at $sdk"
        }
    }

    $vulkanLibraryDirectory = Get-VulkanLibraryDirectory -Sdk $sdk -TargetArchitecture $Architecture
    $updatedLib = if ($env:LIB) { "$vulkanLibraryDirectory;$env:LIB" } else { $vulkanLibraryDirectory }
    "VULKAN_SDK=$sdk" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
    "LIB=$updatedLib" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
    "$sdk\Bin" | Out-File -FilePath $env:GITHUB_PATH -Append -Encoding utf8
    Write-Host "Validated $Architecture Vulkan import library and added to LIB: $vulkanLibraryDirectory"
}

if ($StageRuntimeDirectory) {
    $runtimeUri = if ($isArm64) {
        "https://sdk.lunarg.com/sdk/download/$version/warm/VulkanRT-ARM64-$version-Components.zip"
    } else {
        "https://sdk.lunarg.com/sdk/download/$version/windows/VulkanRT-X64-$version-Components.zip"
    }
    $runtimeSha = if ($isArm64) {
        '0a51a619525e0c7a156125c4f80c4f591c494cef9ff59dc4481735779a9a280c'
    } else {
        'a14672efed15aafc7f5a16572d35cd3a3416eadf670aeee3cdf50ee32d5fbf83'
    }
    $component = if ($isArm64) { "VulkanRT-ARM64-$version-Components" } else { "VulkanRT-X64-$version-Components" }
    $loader = if ($isArm64) { "$component/vulkan-1.dll" } else { "$component/x64/vulkan-1.dll" }
    if (-not (Test-Path -LiteralPath vulkan-runtime.zip)) {
        Invoke-WebRequest -Uri $runtimeUri -OutFile vulkan-runtime.zip
    }
    if ((Get-FileHash vulkan-runtime.zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $runtimeSha) {
        throw 'Vulkan runtime archive hash mismatch'
    }
    if (Test-Path -LiteralPath vulkan-runtime) { Remove-Item -LiteralPath vulkan-runtime -Recurse -Force }
    7z x vulkan-runtime.zip -ovulkan-runtime -y
    if ($LASTEXITCODE -ne 0) { throw "Vulkan runtime extraction failed: $LASTEXITCODE" }
    New-Item -ItemType Directory -Force -Path $StageRuntimeDirectory | Out-Null
    Copy-Item -LiteralPath "vulkan-runtime/$loader" -Destination "$StageRuntimeDirectory/vulkan-1.dll"
    Copy-Item -LiteralPath "vulkan-runtime/$component/VulkanRT-License.txt" -Destination "$StageRuntimeDirectory/VulkanRT-License.txt"
}
