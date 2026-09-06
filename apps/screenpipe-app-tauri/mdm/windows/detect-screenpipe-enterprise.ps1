# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com

# The enterprise dashboard replaces this token with the selected build version.
$expectedVersion = "{{VERSION}}"
$base = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
    [Microsoft.Win32.RegistryHive]::LocalMachine,
    [Microsoft.Win32.RegistryView]::Registry64
)
$key = $base.OpenSubKey("SOFTWARE\screenpipe")
if (-not $key) {
    $base.Close()
    exit 1
}
$version = $key.GetValue("Version", "")
$persistenceMode = $key.GetValue("PersistenceMode", 0)
$key.Close()
$base.Close()

$programFiles64 = [Environment]::GetEnvironmentVariable("ProgramW6432")
if ([string]::IsNullOrWhiteSpace($programFiles64)) {
    $programFiles64 = [Environment]::GetEnvironmentVariable("ProgramFiles")
}
$app = Join-Path $programFiles64 "screenpipe\screenpipe-app.exe"
$service = Get-Service -Name "ScreenpipeEnterprisePersistence" -ErrorAction SilentlyContinue

if (
    $version -eq $expectedVersion -and
    $persistenceMode -eq 1 -and
    (Test-Path -LiteralPath $app -PathType Leaf) -and
    $service
) {
    Write-Output "Screenpipe Enterprise $version persistent"
    exit 0
}
exit 1
