# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com

param(
    [Parameter(Mandatory = $true)][string]$ToolPath,
    [Parameter(Mandatory = $true)][string]$TrustedJavaHome
)
$ErrorActionPreference = 'Stop'

# CodeSignTool 1.3.2 ships Java 11.0.2 roots, which predate SSL.com's 2022
# root used by cs.ssl.com since September 2026. Refresh from maintained
# Temurin, never from an unverified server chain. Keep this in the workflow
# revision so recovery builds of older app SHAs use the same repair.
$javaFiles = @(Get-ChildItem -LiteralPath $ToolPath -Recurse -File -Filter java.exe)
if ($javaFiles.Count -ne 1) { throw 'Expected exactly one bundled signing JVM' }
$java = $javaFiles[0].FullName
$javaHome = Split-Path (Split-Path $java -Parent) -Parent
$trustStore = Join-Path $javaHome 'lib/security/cacerts'
$sourceStore = Join-Path $TrustedJavaHome 'lib/security/cacerts'
foreach ($path in @($trustStore, $sourceStore)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing Java CA store: $path" }
}
# JSSE prefers jssecacerts over cacerts. Do not silently refresh an unused file.
if (Test-Path -LiteralPath (Join-Path $javaHome 'lib/security/jssecacerts')) {
    throw 'Unexpected jssecacerts override in bundled signing JVM'
}
Copy-Item -LiteralPath $sourceStore -Destination $trustStore -Force
if ((Get-FileHash $sourceStore).Hash -ne (Get-FileHash $trustStore).Hash) {
    throw 'Bundled signing CA store does not match maintained Temurin roots'
}

$probeDir = Join-Path ([System.IO.Path]::GetTempPath()) ("signing-tls-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $probeDir | Out-Null
try {
    & (Join-Path $TrustedJavaHome 'bin/javac.exe') --release 11 -d $probeDir (Join-Path $PSScriptRoot 'SigningTlsProbe.java')
    if ($LASTEXITCODE -ne 0) { throw 'Could not compile signing TLS preflight' }
    # Use the exact executable and default trust store selected by sign-ssl.ps1.
    & $java -cp $probeDir SigningTlsProbe https://login.ssl.com/ https://cs.ssl.com/
    if ($LASTEXITCODE -ne 0) { throw 'Bundled signing JVM cannot validate SSL.com TLS' }
} finally {
    Remove-Item -LiteralPath $probeDir -Recurse -Force
}
