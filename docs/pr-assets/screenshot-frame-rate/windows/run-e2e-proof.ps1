# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com

$ErrorActionPreference = 'Stop'
$evidence = 'C:\screenpipe-worker\results\capture-fps-recovery-c6c2'
$cyan = Start-Process 'C:\spdev\release\examples\windows_privacy_fixture.exe' -ArgumentList @('allowed', 20, 300) -PassThru
$magenta = Start-Process 'C:\spdev\release\examples\windows_privacy_fixture.exe' -ArgumentList @('blocked', 480, 300) -PassThru
try {
    Push-Location 'C:\src\screenpipe\apps\screenpipe-app-tauri'
    $env:SCREENPIPE_E2E_SEED = 'onboarding,no-audio,cloud-authenticated,windows-privacy-fixture'
    $env:SCREENPIPE_E2E_DATA_DIR = Join-Path $evidence 'e2e-app-data'
    $env:SCREENPIPE_E2E_PERSIST_APP_LOGS = 'true'
    $env:SCREENPIPE_E2E_QUIET_APP_LOGS = 'true'
    $env:SCREENPIPE_PORT = '3048'
    $env:SCREENPIPE_FOCUS_PORT = '11448'
    $env:SCREENPIPE_E2E_WEBDRIVER_PORT = '4448'
    $env:SCREENPIPE_E2E_APP_PATH = 'C:\spdev\debug-dev\screenpipe-app.exe'
    bun run wdio run e2e/wdio.conf.ts --spec e2e/specs/screenshot-frame-rate-windows.spec.ts 2>&1 |
        Tee-Object (Join-Path $evidence 'e2e-app-proof.log')
    $exitCode = $LASTEXITCODE
} finally {
    Pop-Location
    Stop-Process -Id $cyan.Id -Force -ErrorAction SilentlyContinue
    Stop-Process -Id $magenta.Id -Force -ErrorAction SilentlyContinue
}
"exit_code=$exitCode" | Set-Content -Encoding ascii (Join-Path $evidence 'e2e-app-proof.exit.txt')
exit $exitCode
