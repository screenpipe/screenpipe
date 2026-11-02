# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com
<#
.SYNOPSIS
Runs the Windows browser attribution acceptance path with actual Microsoft Edge.

.DESCRIPTION
Creates trusted, VM-local HTTPS and Authenticode fixture certificates, serves a
signed NSIS installer at the personalized download path, lets Edge download it,
renames it on NTFS, installs it, and verifies the acquisition grant. It does not
disable SmartScreen, attachment services, or zone metadata. Test certificates,
HTTP.sys bindings, browser data, downloads, and fixture files are removed.
#>
[CmdletBinding()]
param(
  [string]$OutputJson
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Resolve-Tool([string[]]$Candidates) {
  foreach ($candidate in $Candidates) {
    $command = Get-Command $candidate -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  throw "required tool not found: $($Candidates -join ', ')"
}

$edge = Resolve-Tool @('C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe')
$makensis = Resolve-Tool @('makensis.exe', 'C:\Program Files (x86)\NSIS\makensis.exe')
$signtool = Resolve-Tool @(
  'signtool.exe',
  'C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe'
)
$root = Join-Path ([IO.Path]::GetTempPath()) ("screenpipe-edge-ads-" + [guid]::NewGuid())
$profile = Join-Path $root 'edge-profile'
$install = Join-Path $root 'installed'
$download = Join-Path ([Environment]::GetFolderPath('UserProfile')) 'Downloads'
$grant = [guid]::NewGuid().ToString().ToLowerInvariant()
$filename = "screenpipe-$grant.exe"
$downloaded = Join-Path $download $filename
$existingPartials = @(Get-ChildItem -LiteralPath $download -Filter 'Unconfirmed *.crdownload' `
  -ErrorAction SilentlyContinue | ForEach-Object FullName)
$renamed = Join-Path $root 'renamed-installer.exe'
$port = Get-Random -Minimum 41000 -Maximum 49000
$url = "https://localhost:$port/download/fixture-ticket/$filename"
$appid = '{' + [guid]::NewGuid().ToString() + '}'
$serverCert = $null
$signingCert = $null
$serverJob = $null
$edgeProcess = $null
$urlAcl = "https://localhost:$port/"

try {
  New-Item -ItemType Directory -Path $root,$profile,$install -Force | Out-Null
  Remove-Item -LiteralPath $downloaded -Force -ErrorAction SilentlyContinue

  $fixture = Join-Path $root 'fixture.nsi'
  $hooks = (Resolve-Path (Join-Path $PSScriptRoot '..\apps\screenpipe-app-tauri\src-tauri\windows\hooks.nsh')).Path
  @"
; screenpipe — AI that knows everything you've seen, said, or heard
; https://screenpipe.com
Unicode true
SilentInstall silent
RequestExecutionLevel user
!include "$hooks"
Name "Screenpipe browser ADS fixture"
OutFile "fixture.exe"
InstallDir "`$TEMP\screenpipe-browser-ads-fixture"
Section
  CreateDirectory "`$INSTDIR"
  FileOpen `$0 "`$INSTDIR\installed" w
  FileWrite `$0 "ok"
  FileClose `$0
  !insertmacro _SP_SaveAcquisitionGrant
SectionEnd
"@ | Set-Content -LiteralPath $fixture -Encoding utf8
  & $makensis '/V2' $fixture | Out-Null

  $serverCert = New-SelfSignedCertificate -DnsName 'localhost' -CertStoreLocation 'Cert:\LocalMachine\My' `
    -FriendlyName 'Screenpipe browser ADS HTTPS fixture' -NotAfter (Get-Date).AddDays(1) `
    -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.1')
  $signingCert = New-SelfSignedCertificate -Subject 'CN=Screenpipe browser ADS fixture' `
    -CertStoreLocation 'Cert:\LocalMachine\My' -FriendlyName 'Screenpipe browser ADS signing fixture' `
    -NotAfter (Get-Date).AddDays(1) -Type CodeSigningCert
  foreach ($cert in @($serverCert, $signingCert)) {
    $store = [Security.Cryptography.X509Certificates.X509Store]::new('Root', 'LocalMachine')
    $store.Open('ReadWrite'); $store.Add($cert); $store.Close()
  }
  $publisher = [Security.Cryptography.X509Certificates.X509Store]::new('TrustedPublisher', 'LocalMachine')
  $publisher.Open('ReadWrite'); $publisher.Add($signingCert); $publisher.Close()
  & $signtool sign /fd sha256 /sm /s My /sha1 $signingCert.Thumbprint (Join-Path $root 'fixture.exe') | Out-Null
  $signatureBefore = Get-AuthenticodeSignature -LiteralPath (Join-Path $root 'fixture.exe')
  if ($signatureBefore.Status -ne 'Valid') { throw "fixture signature is $($signatureBefore.Status)" }

  & netsh.exe http add urlacl url=$urlAcl 'user=Everyone' | Out-Null
  & netsh.exe http add sslcert "ipport=[::]:$port" "certhash=$($serverCert.Thumbprint)" "appid=$appid" | Out-Null
  $serverJob = Start-Job -ArgumentList $urlAcl,(Join-Path $root 'fixture.exe'),$filename -ScriptBlock {
    param($Prefix, $Artifact, $Filename)
    $listener = [Net.HttpListener]::new()
    $listener.Prefixes.Add($Prefix)
    $listener.Start()
    try {
      $context = $listener.GetContext()
      $bytes = [IO.File]::ReadAllBytes($Artifact)
      $context.Response.StatusCode = 200
      $context.Response.ContentType = 'application/vnd.microsoft.portable-executable'
      $context.Response.Headers['Content-Disposition'] = "attachment; filename=`"$Filename`""
      $context.Response.ContentLength64 = $bytes.Length
      $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
      $context.Response.OutputStream.Close()
    } finally {
      $listener.Stop()
    }
  }
  Start-Sleep -Seconds 2

  $edgeProcess = Start-Process -FilePath $edge -ArgumentList @(
    "--user-data-dir=$profile", '--no-first-run', '--disable-features=msEdgeFirstRunExperience', $url
  ) -PassThru
  $deadline = (Get-Date).AddSeconds(90)
  while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath $downloaded)) {
    Start-Sleep -Milliseconds 500
  }
  if (-not (Test-Path -LiteralPath $downloaded)) {
    throw 'Edge did not complete the fixture download without a security override'
  }
  $zonePath = "$downloaded`:Zone.Identifier"
  if (-not (Test-Path -LiteralPath $zonePath)) { throw 'Edge download has no Zone.Identifier stream' }
  $zone = [IO.File]::ReadAllText($zonePath)
  $hostUrl = ($zone -split "`r?`n" | Where-Object { $_ -like 'HostUrl=*' } | Select-Object -First 1) -replace '^HostUrl=', ''
  if ($hostUrl -ne $url) { throw 'Edge HostUrl did not preserve the requested personalized URL' }
  $zoneId = ($zone -split "`r?`n" | Where-Object { $_ -like 'ZoneId=*' } | Select-Object -First 1) -replace '^ZoneId=', ''

  Move-Item -LiteralPath $downloaded -Destination $renamed
  if (-not (Test-Path -LiteralPath "$renamed`:Zone.Identifier")) {
    throw 'Zone.Identifier did not survive same-volume rename'
  }
  $signatureAfter = Get-AuthenticodeSignature -LiteralPath $renamed
  if ($signatureAfter.Status -ne 'Valid') { throw "renamed signature is $($signatureAfter.Status)" }
  $installer = Start-Process -FilePath $renamed -ArgumentList @('/S', "/D=$install") -Wait -PassThru
  if ($installer.ExitCode -ne 0) { throw "fixture installer exited $($installer.ExitCode)" }
  $received = [IO.File]::ReadAllText((Join-Path $install 'acquisition-grant'))
  if ($received -ne $grant) { throw 'installed grant did not match the Edge HostUrl suffix' }

  $result = [ordered]@{
    edge_version = [Diagnostics.FileVersionInfo]::GetVersionInfo($edge).ProductVersion
    windows = [Environment]::OSVersion.VersionString
    architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    filesystem = (Get-Volume -DriveLetter ([IO.Path]::GetPathRoot($root).Substring(0,1))).FileSystem
    zone_stream = 'Zone.Identifier'
    zone_id = $zoneId
    host_url_preserved = $true
    same_volume_rename_preserved_stream = $true
    authenticode_before = [string]$signatureBefore.Status
    authenticode_after_rename = [string]$signatureAfter.Status
    installed_grant_matches_url_suffix = $true
    smartscreen_or_attachment_policy_disabled = $false
  }
  $json = $result | ConvertTo-Json -Depth 3
  if ($OutputJson) { $json | Set-Content -LiteralPath $OutputJson -Encoding utf8 }
  $json
} finally {
  if ($edgeProcess -and -not $edgeProcess.HasExited) {
    Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*$profile*" } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  }
  if ($serverJob) { Remove-Job $serverJob -Force -ErrorAction SilentlyContinue }
  & netsh.exe http delete sslcert "ipport=[::]:$port" 2>$null | Out-Null
  & netsh.exe http delete urlacl url=$urlAcl 2>$null | Out-Null
  foreach ($pair in @(@('TrustedPublisher',$signingCert), @('Root',$signingCert), @('Root',$serverCert), @('My',$signingCert), @('My',$serverCert))) {
    if ($pair[1]) {
      $store = [Security.Cryptography.X509Certificates.X509Store]::new($pair[0], 'LocalMachine')
      $store.Open('ReadWrite'); $store.Remove($pair[1]); $store.Close()
    }
  }
  Remove-Item -LiteralPath $downloaded -Force -ErrorAction SilentlyContinue
  Get-ChildItem -LiteralPath $download -Filter 'Unconfirmed *.crdownload' -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notin $existingPartials } |
    Remove-Item -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
