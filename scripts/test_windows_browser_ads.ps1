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
  [string]$OutputJson,
  [string]$EvidenceDirectory,
  [switch]$PrepareOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

function Save-DesktopScreenshot([string]$Path) {
  if (-not $Path) { return }
  $bounds = [Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bitmap = [Drawing.Bitmap]::new($bounds.Width, $bounds.Height)
  $graphics = [Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($bounds.Location, [Drawing.Point]::Empty, $bounds.Size)
    $bitmap.Save($Path)
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
}

function Wait-AutomationElement([Windows.Automation.ControlType]$Type, [string]$Name, [int]$Seconds = 60) {
  $rootElement = [Windows.Automation.AutomationElement]::RootElement
  $typeCondition = [Windows.Automation.PropertyCondition]::new(
    [Windows.Automation.AutomationElement]::ControlTypeProperty, $Type)
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    $elements = $rootElement.FindAll([Windows.Automation.TreeScope]::Descendants, $typeCondition)
    foreach ($element in $elements) {
      if ($element.Current.Name -like $Name) { return $element }
    }
    Start-Sleep -Milliseconds 250
  }
  throw "Edge UI element did not appear: $Type $Name"
}

function Invoke-AutomationElement([Windows.Automation.AutomationElement]$Element) {
  $pattern = $Element.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern)
  $pattern.Invoke()
}

function Confirm-UncommonDownload([string]$Filename, [string]$EvidenceRoot, [string]$Label) {
  $warning = Wait-AutomationElement ([Windows.Automation.ControlType]::ListItem) `
    "$Filename isn't commonly downloaded*"
  $warningPath = $null
  if ($EvidenceRoot) { $warningPath = Join-Path $EvidenceRoot "$Label-warning.png" }
  Save-DesktopScreenshot $warningPath
  $warning.SetFocus()
  [Windows.Forms.SendKeys]::SendWait('+{F10}')
  Invoke-AutomationElement (Wait-AutomationElement ([Windows.Automation.ControlType]::MenuItem) 'Keep' 10)

  $confirmation = Wait-AutomationElement ([Windows.Automation.ControlType]::Window) `
    "Make sure you trust $Filename before you open it" 10
  $confirmationPath = $null
  if ($EvidenceRoot) { $confirmationPath = Join-Path $EvidenceRoot "$Label-confirmation.png" }
  Save-DesktopScreenshot $confirmationPath
  $deleteMenu = Wait-AutomationElement ([Windows.Automation.ControlType]::Button) 'Delete Open menu' 10
  $deleteMenu.SetFocus()
  [Windows.Forms.SendKeys]::SendWait('%{DOWN}')
  Invoke-AutomationElement (Wait-AutomationElement ([Windows.Automation.ControlType]::MenuItem) 'Keep anyway' 10)
}

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
$secondGrant = [guid]::NewGuid().ToString().ToLowerInvariant()
$filename = "screenpipe-$grant.exe"
$secondFilename = "screenpipe-$secondGrant.exe"
$downloaded = Join-Path $download $filename
$secondDownloaded = Join-Path $download $secondFilename
$existingPartials = @(Get-ChildItem -LiteralPath $download -Filter 'Unconfirmed *.crdownload' `
  -ErrorAction SilentlyContinue | ForEach-Object FullName)
$renamed = Join-Path $root 'renamed-installer.exe'
$secondRoot = Join-Path $root 'second-rename'
$secondRenamed = Join-Path $secondRoot 'renamed-installer.exe'
$port = Get-Random -Minimum 41000 -Maximum 49000
$fixtureHost = 'screenpipe-download.127.0.0.1.nip.io'
$ticket = 'eyJhbGciOiJFUzI1NiIsImtpZCI6ImZpeHR1cmUifQ.eyJwdXJwb3NlIjoiZG93bmxvYWQifQ.fixture-signature'
$url = "https://$fixtureHost`:$port/download/$ticket/$filename"
$secondUrl = "https://$fixtureHost`:$port/download/$ticket/$secondFilename"
$ordinaryUrl = "https://$fixtureHost`:$port/download?ticket=$ticket"
$appid = '{' + [guid]::NewGuid().ToString() + '}'
$serverCert = $null
$signingCert = $null
$serverJob = $null
$edgeProcess = $null
$recorder = $null
$urlAcl = "https://$fixtureHost`:$port/"

try {
  New-Item -ItemType Directory -Path $root,$profile,$install,$secondRoot -Force | Out-Null
  if ($EvidenceDirectory) { New-Item -ItemType Directory -Path $EvidenceDirectory -Force | Out-Null }
  Remove-Item -LiteralPath $downloaded,$secondDownloaded -Force -ErrorAction SilentlyContinue

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
VIProductVersion "2.7.135.0"
VIAddVersionKey /LANG=1033 "ProductVersion" "2.7.135"
VIAddVersionKey /LANG=1033 "FileVersion" "2.7.135"
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

  $serverCert = New-SelfSignedCertificate -DnsName $fixtureHost -CertStoreLocation 'Cert:\LocalMachine\My' `
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
  if ($EvidenceDirectory) {
    Copy-Item -LiteralPath (Join-Path $root 'fixture.exe') -Destination (Join-Path $EvidenceDirectory 'screenpipe_2.7.135_x64-setup.exe') -Force
  }
  $python = Resolve-Tool @('python.exe')
  $packager = (Resolve-Path (Join-Path $PSScriptRoot 'package-attribution-carrier.py')).Path
  $firstArtifact = Join-Path $root 'fixture-first.exe'
  $secondArtifact = Join-Path $root 'fixture-second.exe'
  $prepareScript = @'
import importlib.util, pathlib, struct, sys
spec = importlib.util.spec_from_file_location('carrier', sys.argv[1])
carrier = importlib.util.module_from_spec(spec); spec.loader.exec_module(carrier)
source_path = pathlib.Path(sys.argv[2])
with source_path.open('rb') as source:
    cert_offset, size_offset, certificate, relative_offset = carrier._prepare_windows_certificate(source, source_path.stat().st_size)
    source.seek(0); data = bytearray(source.read(cert_offset))
struct.pack_into('<I', data, size_offset, len(certificate))
data += certificate
offset = cert_offset + relative_offset
for grant, output in ((sys.argv[3], sys.argv[4]), (sys.argv[5], sys.argv[6])):
    patched = bytearray(data); patched[offset:offset+36] = grant.encode('ascii')
    pathlib.Path(output).write_bytes(patched)
'@
  & $python -c $prepareScript $packager (Join-Path $root 'fixture.exe') $grant $firstArtifact $secondGrant $secondArtifact
  if ($LASTEXITCODE -ne 0) { throw 'failed to prepare embedded certificate fixtures' }
  $fixtureHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $firstArtifact).Hash.ToLowerInvariant()
  $secondFixtureHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $secondArtifact).Hash.ToLowerInvariant()
  if ($EvidenceDirectory) {
    Copy-Item -LiteralPath $firstArtifact -Destination (Join-Path $EvidenceDirectory 'signed-carrier-template.exe') -Force
    Copy-Item -LiteralPath $secondArtifact -Destination (Join-Path $EvidenceDirectory 'signed-carrier-second.exe') -Force
  }
  if ($PrepareOnly) { return }

  & netsh.exe http add urlacl url=$urlAcl 'user=Everyone' | Out-Null
  & netsh.exe http add sslcert "ipport=0.0.0.0:$port" "certhash=$($serverCert.Thumbprint)" "appid=$appid" | Out-Null
  $serverJob = Start-Job -ArgumentList $urlAcl,$firstArtifact,$secondArtifact,$ordinaryUrl,$url,$secondUrl,$filename,$secondFilename -ScriptBlock {
    param($Prefix, $FirstArtifact, $SecondArtifact, $OrdinaryUrl, $FinalUrl, $SecondUrl, $Filename, $SecondFilename)
    $listener = [Net.HttpListener]::new()
    $listener.Prefixes.Add($Prefix)
    $listener.Start()
    try {
      foreach ($expected in @($OrdinaryUrl, $FinalUrl, $SecondUrl)) {
        $context = $listener.GetContext()
        if ($context.Request.Url.AbsoluteUri -ne $expected) {
          $context.Response.StatusCode = 404
          $context.Response.Close()
          throw "unexpected browser request path"
        }
        if ($expected -eq $OrdinaryUrl) {
          $context.Response.StatusCode = 302
          $context.Response.RedirectLocation = $FinalUrl
          $context.Response.Close()
          continue
        }
        $artifact = if ($expected -eq $FinalUrl) { $FirstArtifact } else { $SecondArtifact }
        $bytes = [IO.File]::ReadAllBytes($artifact)
        $servedFilename = if ($expected -eq $FinalUrl) { $Filename } else { $SecondFilename }
        $context.Response.StatusCode = 200
        $context.Response.ContentType = 'application/vnd.microsoft.portable-executable'
        $context.Response.Headers['Content-Disposition'] = "attachment; filename=`"$servedFilename`""
        $context.Response.ContentLength64 = $bytes.Length
        $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
        $context.Response.OutputStream.Close()
      }
    } finally {
      $listener.Stop()
    }
  }
  Start-Sleep -Seconds 2

  if ($EvidenceDirectory) {
    $recorderInfo = [Diagnostics.ProcessStartInfo]::new()
    $recorderInfo.FileName = 'ffmpeg.exe'
    $recorderInfo.Arguments = "-y -loglevel error -f gdigrab -framerate 15 -draw_mouse 1 -i desktop -c:v libx264 -preset ultrafast -pix_fmt yuv420p `"$(Join-Path $EvidenceDirectory 'edge-acceptance.mp4')`""
    $recorderInfo.UseShellExecute = $false
    $recorderInfo.RedirectStandardInput = $true
    $recorderInfo.CreateNoWindow = $true
    $recorder = [Diagnostics.Process]::new()
    $recorder.StartInfo = $recorderInfo
    if (-not $recorder.Start()) { throw 'short evidence recorder did not start' }
    Start-Sleep -Seconds 2
  }

  $edgeProcess = Start-Process -FilePath $edge -ArgumentList @(
    "--user-data-dir=$profile", '--no-first-run', '--disable-features=msEdgeFirstRunExperience', $ordinaryUrl
  ) -PassThru
  [void](Wait-AutomationElement ([Windows.Automation.ControlType]::ListItem) "$filename isn't commonly downloaded*" 60)
  Confirm-UncommonDownload $filename $EvidenceDirectory 'redirect-download'
  $deadline = (Get-Date).AddSeconds(90)
  while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath $downloaded)) {
    Start-Sleep -Milliseconds 500
  }
  if (-not (Test-Path -LiteralPath $downloaded)) {
    throw 'Edge did not complete the fixture download after normal visible confirmation'
  }
  $downloadHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $downloaded).Hash.ToLowerInvariant()
  if ($downloadHash -ne $fixtureHash) { throw 'Edge download SHA-256 differs from the signed fixture' }
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
  if ([IO.File]::ReadAllText("$renamed`:Zone.Identifier") -ne $zone) {
    throw 'Zone.Identifier changed during same-volume rename'
  }
  if ($EvidenceDirectory) {
    [ordered]@{
      edge_version = [Diagnostics.FileVersionInfo]::GetVersionInfo($edge).ProductVersion
      architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
      entry_url = $ordinaryUrl
      redirect_status = 302
      final_source = $url
      completed_filename = $filename
      fixture_sha256 = $fixtureHash
      edge_download_sha256 = $downloadHash
      authenticode_before = [string]$signatureBefore.Status
      authenticode_after_rename = [string]$signatureAfter.Status
      zone_id = $zoneId
      same_volume_ntfs_rename_preserved_zone_identifier = $true
      policies_changed = $false
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $EvidenceDirectory 'preinstall-facts.json') -Encoding utf8
  }
  $installer = Start-Process -FilePath $renamed -ArgumentList @('/S', "/D=$install") -Wait -PassThru
  if ($installer.ExitCode -ne 0) { throw "fixture installer exited $($installer.ExitCode)" }
  $zonePresentAfterExecution = Test-Path -LiteralPath "$renamed`:Zone.Identifier"
  $grantPath = Join-Path $install 'acquisition-grant'
  if (-not (Test-Path -LiteralPath $grantPath)) {
    $diagnosticPath = Join-Path $install 'acquisition-grant-diagnostic'
    $diagnostic = if (Test-Path -LiteralPath $diagnosticPath) { [IO.File]::ReadAllText($diagnosticPath) } else { 'missing' }
    throw "normal Windows execution consumed Zone.Identifier and the embedded certificate carrier did not preserve attribution: $diagnostic"
  }
  $received = [IO.File]::ReadAllText($grantPath)
  if ($received -ne $grant) { throw 'installed grant did not match the Edge HostUrl suffix' }

  Start-Process -FilePath $edge -ArgumentList @("--user-data-dir=$profile", $secondUrl) | Out-Null
  [void](Wait-AutomationElement ([Windows.Automation.ControlType]::ListItem) "$secondFilename isn't commonly downloaded*" 60)
  Confirm-UncommonDownload $secondFilename $EvidenceDirectory 'direct-download'
  $deadline = (Get-Date).AddSeconds(90)
  while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath $secondDownloaded)) {
    Start-Sleep -Milliseconds 500
  }
  if (-not (Test-Path -LiteralPath $secondDownloaded)) {
    throw 'Edge did not complete the direct final-URL fixture download after confirmation'
  }
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $secondDownloaded).Hash.ToLowerInvariant() -ne $secondFixtureHash) {
    throw 'second Edge download SHA-256 differs from the signed fixture'
  }
  $secondZone = [IO.File]::ReadAllText("$secondDownloaded`:Zone.Identifier")
  $secondHostUrl = ($secondZone -split "`r?`n" | Where-Object { $_ -like 'HostUrl=*' } | Select-Object -First 1) -replace '^HostUrl=', ''
  if ($secondHostUrl -ne $secondUrl) { throw 'second Edge HostUrl did not preserve the direct final URL' }
  Move-Item -LiteralPath $secondDownloaded -Destination $secondRenamed
  $secondSignature = Get-AuthenticodeSignature -LiteralPath $secondRenamed
  if ($secondSignature.Status -ne 'Valid') { throw "second renamed signature is $($secondSignature.Status)" }
  $secondInstaller = Start-Process -FilePath $secondRenamed -ArgumentList @('/S', "/D=$install") -Wait -PassThru
  if ($secondInstaller.ExitCode -ne 0) { throw "second fixture installer exited $($secondInstaller.ExitCode)" }
  if ([IO.File]::ReadAllText((Join-Path $install 'acquisition-grant')) -ne $grant) {
    throw 'a later valid browser grant replaced the installed first grant'
  }
  $readback = (& pwsh.exe -NoProfile -Command "[IO.File]::ReadAllText('$($install.Replace("'", "''"))\acquisition-grant')")
  if ($LASTEXITCODE -ne 0 -or $readback -ne $grant) { throw 'fresh-process grant readback failed' }
  $installedScreenshot = $null
  if ($EvidenceDirectory) { $installedScreenshot = Join-Path $EvidenceDirectory 'installed-first-grant.png' }
  Save-DesktopScreenshot $installedScreenshot

  $result = [ordered]@{
    edge_version = [Diagnostics.FileVersionInfo]::GetVersionInfo($edge).ProductVersion
    windows = [Environment]::OSVersion.VersionString
    architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    filesystem = (Get-Volume -DriveLetter ([IO.Path]::GetPathRoot($root).Substring(0,1))).FileSystem
    entry_redirect_status = 302
    redirect_final_host_url_preserved = $true
    direct_final_host_url_preserved = $true
    completed_filename = $filename
    fixture_sha256 = $fixtureHash
    edge_download_sha256 = $downloadHash
    zone_stream = 'Zone.Identifier'
    zone_id = $zoneId
    host_url_preserved = $true
    same_volume_rename_preserved_stream = $true
    renamed_to_noncanonical_filename = ($renamed -notlike "*$filename")
    zone_identifier_present_after_normal_execution = $zonePresentAfterExecution
    embedded_certificate_carrier_after_execution = (-not $zonePresentAfterExecution)
    authenticode_before = [string]$signatureBefore.Status
    authenticode_after_rename = [string]$signatureAfter.Status
    installed_grant_matches_url_suffix = $true
    later_valid_grant_preserved_first = $true
    fresh_process_readback_preserved_first = $true
    visible_uncommon_download_confirmations = 2
    smartscreen_or_attachment_policy_disabled = $false
  }
  $json = $result | ConvertTo-Json -Depth 3
  if ($OutputJson) { $json | Set-Content -LiteralPath $OutputJson -Encoding utf8 }
  $json
} finally {
  if ($recorder -and -not $recorder.HasExited) {
    $recorder.StandardInput.WriteLine('q')
    if (-not $recorder.WaitForExit(10000)) { $recorder.Kill() }
    $recorder.Dispose()
  }
  if ($edgeProcess -and -not $edgeProcess.HasExited) {
    Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*$profile*" } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  }
  if ($serverJob) { Remove-Job $serverJob -Force -ErrorAction SilentlyContinue }
  & netsh.exe http delete sslcert "ipport=0.0.0.0:$port" 2>$null | Out-Null
  & netsh.exe http delete urlacl url=$urlAcl 2>$null | Out-Null
  foreach ($pair in @(@('TrustedPublisher',$signingCert), @('Root',$signingCert), @('Root',$serverCert), @('My',$signingCert), @('My',$serverCert))) {
    if ($pair[1]) {
      $store = [Security.Cryptography.X509Certificates.X509Store]::new($pair[0], 'LocalMachine')
      $store.Open('ReadWrite'); $store.Remove($pair[1]); $store.Close()
    }
  }
  Remove-Item -LiteralPath $downloaded,$secondDownloaded -Force -ErrorAction SilentlyContinue
  Get-ChildItem -LiteralPath $download -Filter 'Unconfirmed *.crdownload' -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notin $existingPartials } |
    Remove-Item -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
